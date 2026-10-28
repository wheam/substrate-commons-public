// 线下维护：只由 admin 在维护窗口经 cli.js 执行，MCP 不提供这些操作。
//   forkRecover        —— 远端被直推导致分叉：外部链隔离到 quarantine 分支，认可的修改经守卫重新应用为
//                         maintenance_import，再用 --force-with-lease 把远端 main 对齐到服务链；已发布提交不改写。
//   resolveMaintenance —— 状态丢失 / 账本落后（从旧快照恢复）：作废全部凭据，以服务链为准重新发布，
//                         用新的 bootstrap code 重建 admin，之后给大家重新发码。
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { openDb } from './db.js';
import { GitRepo } from './git.js';
import { createMembers } from './members.js';
import { createContent } from './content.js';
import { createSync, acquireMaintenanceLock, releaseMaintenanceLock } from './sync.js';
import { createWatermark } from './watermark.js';
import { createEngine } from './engine.js';
import { checkPath, CONFIG_PATH, CONVENTIONS_PATH } from './paths.js';
import { oneLine, randomHex, fail } from './util.js';

export function openContext({ dataDir, repoUrl = null, sshCommand = null, slug, displayName, pushImpl = null }) {
  const db = openDb(path.join(dataDir, 'state', 'commons.db'));
  const repo = new GitRepo(path.join(dataDir, 'instance.git'), { sshCommand, remoteUrl: repoUrl });
  const members = createMembers({ db });
  const content = createContent({ repo, displayName });
  const sync = createSync({ db, repo, hasRemote: !!repoUrl, pushImpl });
  const engine = createEngine({ db, repo, content, sync, slug, syncWaitMs: 0 });
  const watermark = createWatermark({ db, repo, dir: path.join(dataDir, 'state'), hasRemote: !!repoUrl, ref: process.env.WATERMARK_REF || undefined });
  members.onAuthChange = (epoch) => watermark.record(epoch);
  return { db, repo, members, content, sync, engine, watermark, close: async () => { await watermark.flush(); db.close(); } };
}

function mergeFile(ours, base, theirs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'commons-import-'));
  const f = (n, s) => { const fp = path.join(dir, n); writeFileSync(fp, s); return fp; };
  const [o, b, t] = [f('ours', ours), f('base', base), f('theirs', theirs)];
  return new Promise((resolve) => {
    execFile('git', ['merge-file', '-p', '-q', o, b, t], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
      (err, stdout) => { rmSync(dir, { recursive: true, force: true }); resolve({ ok: !err, text: stdout }); });
  });
}

export async function forkStatus(ctx) {
  const { repo, engine, sync } = ctx;
  await repo.fetch();
  const local = await repo.revParse('refs/heads/main');
  const remote = await repo.revParse('refs/remotes/origin/main');
  const external = remote ? await repo.revList(['--reverse', local ? `${local}..${remote}` : remote]) : [];
  const infos = await repo.commitInfos(external);
  return {
    mode: sync.mode(), local, published: engine.published(), remote,
    merge_base: local && remote ? await repo.mergeBase(local, remote) : null,
    external: await Promise.all(infos.map(async (c) => ({
      sha: c.sha, author: c.authorName, time: new Date(c.time).toISOString(), summary: oneLine(c.message, 100),
      paths: (await repo.diffTreeBetween(c.parents[0] ?? null, c.sha)).map((d) => d.path),
    }))),
  };
}

// importShas: 'all' | 'none' | [sha...]
// 下面两个 *Locked 函数是维护操作本体，调用方负责互斥：
//   服务运行时 → 经 admin socket 由服务进程在单写者队列里执行（server.js）；
//   服务没运行 → CLI 直接调用带锁的包装（forkRecover / resolveMaintenance）。
export async function forkRecover(ctx, opts) {
  acquireMaintenanceLock(ctx.db, { holder: 'cli:fork-recover' });
  try { return await forkRecoverLocked(ctx, opts); } finally { releaseMaintenanceLock(ctx.db); }
}

export async function forkRecoverLocked(ctx, { adminMember, importShas = 'none', now = Date.now }) {
  const { repo, engine, sync, members, db } = ctx;
  const m = sync.mode();
  if (!(m.mode === 'frozen' && m.reason === 'fork')) fail('INVALID_STATE', `当前不是分叉冻结状态（${m.mode}/${m.reason ?? '-'}）`);
  const admin = members.getMember(adminMember);
  if (!admin || admin.role !== 'admin' || admin.status !== 'active') fail('FORBIDDEN', `${adminMember} 不是有效的 admin`);
  const st = await forkStatus(ctx);
  if (st.local !== st.published) fail('INVALID_STATE', '本地 main 与已发布版本不一致，请先处理维护模式');
  const report = { quarantine: null, imported: [], skipped: [], pushed: null };
  // 1. 隔离外部链
  if (st.remote) {
    const qname = `quarantine/${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    await repo.updateRef(`refs/heads/${qname}`, st.remote, null, 'commons: quarantine external chain');
    await repo.run(['push', 'origin', `refs/heads/${qname}:refs/heads/${qname}`]);
    report.quarantine = qname;
  }
  // 2. 认可的外部修改经守卫重新应用（作者 = 执行导入的 admin）
  const selected = importShas === 'all' ? st.external.map((e) => e.sha) : (importShas === 'none' ? [] : importShas);
  const actor = { member_id: admin.member_id, display_name: `${admin.display_name} (maintenance import)`, token_id: 'maintenance', client_label: 'maintenance-cli', perms: new Set(['read', 'write', 'admin']) };
  for (const sha of st.external.map((e) => e.sha)) {
    if (!selected.includes(sha)) { report.skipped.push(sha); continue; }
    const info = (await repo.commitInfos([sha]))[0];
    const diffs = await repo.diffTreeBetween(info.parents[0] ?? null, sha);
    const P = engine.published();
    const t = await ctx.content.tree(P);
    const files = new Map();
    for (const d of diffs) {
      if (d.path !== CONFIG_PATH) checkPath(d.path, { kind: 'any' });
      for (const mode of [d.srcMode, d.dstMode]) if (mode !== '000000' && mode !== '100644') fail('INVALID_CONTENT', `外部提交 ${sha.slice(0, 12)} 含非普通文件 ${d.path}（mode ${mode}），拒绝导入`);
      const base = d.srcMode === '000000' ? null : (await repo.catBlob(d.srcSha)).toString('utf8');
      const theirs = d.dstMode === '000000' ? null : (await repo.catBlob(d.dstSha)).toString('utf8');
      const e = t.pages.get(d.path);
      const ours = e ? await ctx.content.blobText(e.sha) : null;
      if (ours === theirs) continue;
      if (ours === base) { files.set(d.path, theirs); continue; }
      if (ours == null || base == null || theirs == null) fail('CONFLICT', `外部提交 ${sha.slice(0, 12)} 的 ${d.path} 与服务链冲突（新建/删除），请人工处理后再导入`);
      const mr = await mergeFile(ours, base, theirs);
      if (!mr.ok) fail('CONFLICT', `外部提交 ${sha.slice(0, 12)} 的 ${d.path} 与服务链冲突，请人工处理后再导入`);
      files.set(d.path, mr.text);
    }
    if (!files.size) { report.skipped.push(sha); continue; }
    const message = `维护导入外部提交 ${sha.slice(0, 12)}（原作者 ${info.authorName}）：${oneLine(info.message, 200)}`;
    const warnings = await engine.guardFinal(P, files, message, { allowConfig: true, actor, op: 'maintenance_import' });
    const paths = [...files.keys()];
    const { commit } = await engine.commitPlan(actor, {
      op: 'maintenance_import', paths, changes: paths.map((p) => ({ path: p, text: files.get(p) })), subjectPath: paths.length === 1 ? paths[0] : `${paths.length} 个页面`,
      message, warnings, extraTrailers: { 'Commons-Import-Of': sha }, ledgerExtra: { import_of: sha },
    }, { attribution: 'maintenance_import' });
    report.imported.push({ external: sha, commit });
  }
  // 3. --force-with-lease 对齐远端（只在远端仍是我们看到的旧值时才覆盖）
  const main = await repo.revParse('refs/heads/main');
  await repo.run(['push', '--porcelain', `--force-with-lease=refs/heads/main:${st.remote ?? ''}`, 'origin', `${main}:refs/heads/main`]);
  report.pushed = main;
  // 4. 三者一致才解冻
  const remoteNow = await repo.lsRemoteMain();
  const ledgerOk = !!db.get('SELECT 1 AS x FROM ledger WHERE commit_sha = ?', engine.published());
  if (remoteNow !== main || engine.published() !== main || !ledgerOk) fail('INVALID_STATE', `对齐后校验失败：remote=${remoteNow} local=${main} published=${engine.published()} ledger=${ledgerOk}`);
  await repo.fetch();
  db.meta.set('remote_main', main);
  sync.setMode('normal', 'fork_recovered', { quarantine: report.quarantine, imported: report.imported.length });
  return report;
}

export async function resolveMaintenance(ctx, opts) {
  acquireMaintenanceLock(ctx.db, { holder: 'cli:resolve-maintenance' });
  try { return await resolveMaintenanceLocked(ctx, opts); } finally { releaseMaintenanceLock(ctx.db); }
}

export async function resolveMaintenanceLocked(ctx, { bootstrapCode, member = 'm-owner', name = 'Owner' }) {
  const { repo, engine, sync, members, db, watermark } = ctx;
  const m = sync.mode();
  if (m.mode !== 'maintenance') fail('INVALID_STATE', `当前不在维护模式（${m.mode}）`);
  if (!bootstrapCode) fail('INVALID_ARGUMENT', '需要一个新的 bootstrap code（sbe_ + 32 位十六进制）用来重建 admin');
  const report = { reason: m.reason, head: null, failed_intents: 0 };
  let main = await repo.revParse('refs/heads/main');
  if (repo.remoteUrl) {
    await repo.fetch();
    const om = await repo.revParse('refs/remotes/origin/main');
    if (om && main && om !== main) {
      if (await repo.isAncestor(main, om)) { await repo.updateRef('refs/heads/main', om, main, 'commons: resolve maintenance, fast-forward to remote'); main = om; } else if (!(await repo.isAncestor(om, main))) {
        fail('INVALID_STATE', '本地与远端分叉；请先人工确认以哪条链为准（必要时把另一条隔离保存），再执行本命令');
      }
    } else if (om && !main) { await repo.updateRef('refs/heads/main', om, null, 'commons: adopt remote'); main = om; }
  }
  // 发布前整树校验：不把含凭据或配置损坏的树重新发布出去
  const v = await engine.validateTree(main);
  if (v.errors.length) fail('INVALID_STATE', `要恢复的版本未通过发布前校验：${v.errors.slice(0, 5).join('；')}。请先人工清理（见运维手册“误存敏感信息”）`);
  db.tx(() => {
    const r = db.run("UPDATE journal SET status = 'failed', finished_at = ?, note = 'abandoned during maintenance resolve' WHERE status = 'pending'", Date.now());
    report.failed_intents = Number(r.changes);
    if (db.meta.get('initialized_at') == null) {
      db.meta.set('init_phase', 'complete');
      db.meta.set('initialized_at', String(Date.now()));
      db.meta.set('instance_id', randomHex(8));
      db.meta.set('cursor_secret', randomHex(32));
    }
    db.meta.set('published_commit', main);
    db.meta.set('remote_main', null);
  });
  const w = watermark ? await watermark.witnesses() : { floor: 0 };
  report.auth_reset = members.resetAuth(`maintenance_resolve:${m.reason}`, { floor: w.floor });
  const reg = members.registerBootstrap({ code: bootstrapCode, member_id: member, display_name: name, reason: 'maintenance_resolve' });
  if (!reg.registered) fail('INVALID_ARGUMENT', '这个 bootstrap code 以前登记或用过，请生成一个新的');
  report.head = main;
  sync.setMode('normal', 'maintenance_resolved', { previous: m.reason });
  return report;
}

// 手动恢复备份之后（或怀疑状态库被替换时）由 admin 主动进入维护模式：作废全部凭据与未兑换的一次性码。
export async function enterMaintenanceLocked(ctx, { reason = 'manual' } = {}) {
  const { members, sync, watermark } = ctx;
  const w = watermark ? await watermark.witnesses() : { floor: 0 };
  const reset = members.resetAuth(`manual:${reason}`, { floor: w.floor });
  sync.setMode('maintenance', `manual_${reason}`, { message: '管理员手动进入维护模式，全部凭据已作废' });
  return { reset };
}

export async function statusOf(ctx) {
  return { sync: await ctx.sync.status(), published: ctx.engine.published(), members: ctx.members.listMembers(), auth_epoch: ctx.members.authEpoch() };
}
