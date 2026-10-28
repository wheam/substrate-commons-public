// 启动顺序：先恢复仓库与同步状态、补齐未完成事务，再判断能否开放服务。
//
// 首次初始化 = git 外状态不存在，并且仓库里没有任何服务提交。初始化分阶段记录，中途退出后重启会幂等补完。
// 状态缺失、但仓库里已有服务提交 → 状态丢失，只能以维护模式启动（不能当成新库，否则谁都能重新引导 admin）。
// 账本落后于仓库，或授权代数落后于库外见证（状态库是旧快照）→ 维护模式，并先持久化作废全部凭据与一次性码。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomHex } from './util.js';

export async function hasServiceCommits(repo, range) {
  if (!range) return false;
  const out = await repo.run(['log', '-E', '--grep=^Commons-Request: r-', '-1', '--format=%H', ...[].concat(range)]);
  return !!out.trim();
}

export function readTemplate(dir, vars = {}) {
  const files = {};
  const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  const walk = (d, rel = '') => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name); const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r); else files[r] = fill(readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

export async function boot({ db, repo, members, engine, sync, watermark, remoteUrl = null, bootstrap = {}, templateDir, templateVars = {}, log = console }) {
  const report = { actions: [] };
  const enterMaintenance = async (reason, message, { resetAuth = false } = {}) => {
    if (resetAuth) {
      const w = watermark ? await watermark.witnesses() : { floor: 0 };
      report.reset = members.resetAuth(reason, { floor: w.floor });
    }
    sync.setMode('maintenance', reason, { message });
    report.actions.push(`maintenance:${reason}`);
    log.error?.(`[startup] 进入维护模式（${reason}）：${message}`);
    return report;
  };

  if (!(await repo.exists())) { await repo.init(); report.actions.push('repo_init'); } else if (remoteUrl) await repo.setRemote(remoteUrl);

  let fetched = false;
  if (remoteUrl) {
    try { await repo.fetch(); fetched = true; } catch (e) { log.warn?.(`[startup] 拉取远端失败（继续启动，稍后重试）：${e.message}`); }
  }
  let main = await repo.revParse('refs/heads/main');
  const om = fetched ? await repo.revParse('refs/remotes/origin/main') : null;
  if (!main && om) { await repo.updateRef('refs/heads/main', om, null, 'commons: adopt remote main'); main = om; report.actions.push('adopt_remote_main'); }

  // 手动恢复备份前设置一个新的 RESTORE_NONCE：服务会以维护模式启动并作废全部凭据（每个值只生效一次）
  if (bootstrap.restoreNonce && db.meta.get('restore_nonce_consumed') !== bootstrap.restoreNonce) {
    await enterMaintenance('restore', '按 RESTORE_NONCE 以维护模式启动：已作废全部凭据与未兑换的一次性码，请用 resolve-maintenance 处置', { resetAuth: true });
    db.meta.set('restore_nonce_consumed', bootstrap.restoreNonce);
    return report;
  }
  if ((db.meta.get('mode') ?? 'normal') === 'maintenance') {
    report.actions.push('stay_maintenance');
    return report;
  }

  const phase = db.meta.get('init_phase') ?? (db.meta.get('initialized_at') ? 'complete' : null);
  if (phase !== 'complete') {
    if (!phase) {
      if (await hasServiceCommits(repo, main)) {
        return enterMaintenance('state_lost', '服务状态（账本、成员、凭据）缺失，但仓库里已有服务提交；不能当作首次初始化。请按运维手册用 cli.js resolve-maintenance 处理');
      }
      const v = await engine.validateTree(main);
      if (v.errors.length) return enterMaintenance('adopt_rejected', `已有仓库的内容未通过发布前校验：${v.errors.slice(0, 5).join('；')}`);
      if (v.warnings.length) report.warnings = v.warnings;
      db.tx(() => {
        db.meta.set('init_phase', 'started');
        db.meta.set('instance_id', randomHex(8));
        db.meta.set('cursor_secret', randomHex(32));
        db.meta.set('mode', 'normal');
        if (main) db.meta.set('published_commit', main);
        if (main && om === main) db.meta.set('remote_main', om);
      });
    } else {
      const rec = await engine.recover();
      if (rec.inconsistent.length) return enterMaintenance('journal_inconsistent', `事务日志与仓库对不上（${rec.inconsistent.join(', ')}）`);
      report.actions.push('resume_init');
    }
    const tpl = readTemplate(templateDir, templateVars);
    const tree = await repo.lsTree(engine.published() ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904').catch(() => new Map());
    const missing = Object.fromEntries(Object.entries(tpl).filter(([p]) => !tree.has(p)));
    if (Object.keys(missing).length) {
      await engine.initSkeleton(missing, '初始化共享实例骨架（README、_commons/config.yaml、_commons/conventions.md）');
      report.actions.push('init_skeleton');
    }
    if (bootstrap.code) {
      const r = members.registerBootstrap({ code: bootstrap.code, member_id: bootstrap.member, display_name: bootstrap.name, reason: 'first_init' });
      report.actions.push(r.registered ? 'bootstrap_registered' : 'bootstrap_already_registered');
    } else log.warn?.('[startup] 首次初始化但没有 BOOTSTRAP_ADMIN_CODE：暂时没有任何人能成为 admin');
    db.tx(() => {
      db.meta.set('init_phase', 'complete');
      db.meta.set('initialized_at', String(Date.now()));
    });
    watermark?.record(members.authEpoch());
    return report;
  }

  // 已初始化：先补齐或作废未完成事务
  const rec = await engine.recover();
  if (rec.completed.length || rec.failed.length) report.actions.push(`recovered:${rec.completed.length}/failed:${rec.failed.length}`);
  if (rec.inconsistent.length) return enterMaintenance('journal_inconsistent', `事务日志与仓库对不上（${rec.inconsistent.join(', ')}）`);
  main = await repo.revParse('refs/heads/main');
  const P = engine.published();
  if (main !== P) {
    const ahead = P && main && (await repo.isAncestor(P, main));
    if (ahead && (await hasServiceCommits(repo, `${P}..${main}`))) {
      return enterMaintenance('ledger_stale', '仓库里有账本没有记录的服务提交：账本可能是从旧快照恢复的。已作废全部 token 与未兑换的一次性码', { resetAuth: true });
    }
    return enterMaintenance('published_mismatch', '本地 main 与已发布版本不一致');
  }
  // 授权代数与库外见证比较：状态库被旧快照替换时，即使 git 没变也能发现
  if (watermark) {
    const w = await watermark.witnesses();
    if (w.remoteError) log.warn?.(`[startup] 读取远端授权水位失败（只用本地见证）：${w.remoteError}`);
    if (w.floor > members.authEpoch()) {
      return enterMaintenance('auth_stale', `状态库的授权代数（${members.authEpoch()}）落后于库外见证（${w.floor}）：状态库可能是从旧快照恢复的。已作废全部 token 与未兑换的一次性码`, { resetAuth: true });
    }
  }
  if (om && main && om !== main) {
    if (await repo.isAncestor(om, main)) { db.meta.set('remote_main', om); } else if (await repo.isAncestor(main, om)) {
      if (await hasServiceCommits(repo, `${main}..${om}`)) {
        return enterMaintenance('ledger_stale', '远端有本地账本没有记录的服务提交：本地状态可能是从旧快照恢复的。已作废全部 token 与未兑换的一次性码', { resetAuth: true });
      }
      sync.setMode('frozen', 'fork', { remote: om, local: main, message: '远端 main 出现了不经服务的提交，已冻结写入；需要 admin 在维护窗口执行分叉恢复' });
      report.actions.push('frozen:fork');
    } else {
      sync.setMode('frozen', 'fork', { remote: om, local: main, message: '远端 main 与本地分叉，已冻结写入；需要 admin 在维护窗口执行分叉恢复' });
      report.actions.push('frozen:fork');
    }
  } else if (om && om === main) db.meta.set('remote_main', om);

  // BOOTSTRAP_FORCE 是一次授权变更：必须等认证闸门核实过库外见证之后再处理（R3-1），这里只做标记
  if (bootstrap.force && bootstrap.code) report.pendingForce = true;
  return report;
}
