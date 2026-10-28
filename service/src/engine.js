// 写事务引擎。
//
// 一次写入 = 一个串行事务：
//   读取已发布版本 → 校验 base_rev → 生成新内容 → 对最终内容执行全部守卫 → 生成 git 对象
//   → 在事务日志里记下意图（含预期提交）→ update-ref main（带旧值校验）
//   → 一个 SQLite 事务里写提交账本 + 幂等结果 + 标记意图完成 + 推进“已发布版本”指针 → 尝试 push。
// 进程在任何一步被杀，重启时先依据事务意图补齐或作废，之后才开放服务（recover()）。
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommonsError, fail, sha256, newId, canonicalJson, utf8Bytes, oneLine, createQueue } from './util.js';
import { checkPath, checkConfigPath, CONFIG_PATH, CONVENTIONS_PATH, treeConflicts, isContentPath } from './paths.js';
import { containsCredential, maskCredentials } from './secrets.js';
import { scanPii } from './pii.js';
import { lintPage } from './lint.js';
import { parseConfig, pageTypeFor } from './instance-config.js';
import { parseEntries, validateEntries } from './pagetypes.js';

export const IDEMPOTENCY_TTL_MS = 7 * 86_400_000;
// 由请求本身决定的拒绝：同一个幂等键重试必须拿到同样的结果。
// 冻结、维护、限流、配置损坏这类“服务当前状态”导致的拒绝不占用幂等键，状态恢复后同一个键可以重试。
const DETERMINISTIC = new Set(['CONFLICT', 'NOT_FOUND', 'ALREADY_EXISTS', 'PATCH_NOT_FOUND', 'PATCH_AMBIGUOUS', 'SCHEMA_VIOLATION',
  'CREDENTIAL_DETECTED', 'PII_REJECTED', 'LINT_FAILED', 'TOO_LARGE', 'INVALID_PATH', 'INVALID_CONTENT', 'INVALID_ARGUMENT', 'INVALID_CONFIG', 'NO_CHANGE', 'FORBIDDEN']);
const IDEM_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const CONVENTIONS_MAX = 32 * 1024;

export function createEngine({ db, repo, content, sync, slug, now = Date.now, fault = () => {}, syncWaitMs = 4000, onPublished = () => {} }) {
  const enqueue = createQueue();
  const botIdentity = { name: 'substrate-commons', email: `bot@${slug}.invalid` };

  const published = () => db.meta.get('published_commit');

  function assertWritable() {
    if (sync.maintLock()) fail('MAINTENANCE', '管理员正在维护，暂停写入，请稍后再试');
    const m = sync.mode();
    if (m.mode === 'maintenance') fail('MAINTENANCE', '服务处于维护模式，暂不接受请求');
    if (m.mode === 'frozen') fail('FROZEN', `写入已冻结（${m.reason}）：${m.detail?.message ?? ''}`.trim(), { reason: m.reason });
  }

  // ---------- 校验小件 ----------
  function checkMessage(message) {
    if (typeof message !== 'string') fail('INVALID_ARGUMENT', 'message 必填：用人话写改了什么、为什么、依据是什么');
    const m = message.replace(/\r\n?/g, '\n').trim();
    if (m.length < 1 || m.length > 500) fail('INVALID_ARGUMENT', 'message 需要 1–500 个字符');
    if (/[\p{Cc}]/u.test(m.replace(/[\n\t]/g, ''))) fail('INVALID_ARGUMENT', 'message 不能含控制字符');
    if (containsCredential(m)) fail('CREDENTIAL_DETECTED', 'message 里疑似含有密钥或口令，已拒绝；请删掉后重试');
    return m;
  }
  function checkIdemKey(k) {
    if (typeof k !== 'string' || !IDEM_KEY_RE.test(k)) fail('INVALID_ARGUMENT', 'idempotency_key 必填：8–128 位 A-Za-z0-9._:-，每次新写入用新的，重试时沿用同一个');
    return k;
  }
  function checkText(text, label = 'content') {
    if (typeof text !== 'string') fail('INVALID_ARGUMENT', `${label} 必须是字符串`);
    if (text.includes('\0')) fail('INVALID_CONTENT', `${label} 不能含 NUL 字符`);
    return text.replace(/\r\n?/g, '\n');
  }

  // 冲突时附带的历史：带 read_commit_rev 就给那之后改过这一页的提交，否则给最近几条。
  async function conflictDetails(p, currentBlob, readCommitRev) {
    const P = published();
    let shas = await repo.pathLog(P, p);
    if (readCommitRev && /^[0-9a-f]{40}$/.test(readCommitRev) && (await repo.objectType(readCommitRev)) === 'commit' && (await repo.isAncestor(readCommitRev, P))) {
      const since = new Set(await repo.revList([`${readCommitRev}..${P}`]));
      shas = shas.filter((s) => since.has(s));
    } else shas = shas.slice(0, 5);
    const infos = await repo.commitInfos(shas.slice(0, 20));
    return {
      current_blob_rev: currentBlob,
      changes: infos.map((c) => {
        const l = db.get('SELECT member_id FROM ledger WHERE commit_sha = ?', c.sha);
        return { commit_rev: c.sha, time: new Date(c.time).toISOString(), member_id: l?.member_id ?? null, summary: oneLine(c.message, 100) };
      }),
      hint: '请先 read_page 重读最新内容，再基于新的 blob_rev 修改，并换一个新的 idempotency_key 提交；不要覆盖别人的修改',
    };
  }

  // 对最终文件集合执行全部守卫。files: Map(path → text|null)；返回 warnings。
  async function guardFinal(P, files, message, { allowConfig = false, actor = null, op = null } = {}) {
    const cfg = await content.config(P);
    const t = await content.tree(P);
    const warnings = [];
    if (cfg.invalid && !(files.has(CONFIG_PATH) && files.get(CONFIG_PATH) != null)) {
      fail('CONFIG_INVALID', '实例配置 _commons/config.yaml 当前无法解析，写入已暂停；请 admin 用 update_config 修好它');
    }
    // 每个变更路径都过统一路径策略（revert、维护导入也一样）
    for (const p of files.keys()) { if (p !== CONFIG_PATH) checkPath(p, { kind: 'any' }); }
    // 删除权限对所有入口生效：delete_page、revert 产生的删除、维护导入（move 保留内容，不算删除）
    const deletes = [...files].filter(([, text]) => text == null).map(([p]) => p);
    if (deletes.length && op !== 'move' && cfg.permissions.delete === 'admin' && !actor?.perms?.has('admin')) {
      fail('FORBIDDEN', `本实例只允许 admin 删除页面；这次操作会删除 ${deletes.join('、')}`);
    }
    // 最终树的路径冲突（大小写、文件 / 目录同名）
    const finalAll = new Set(t.all.keys());
    for (const [p, text] of files) { if (text == null) finalAll.delete(p); else finalAll.add(p); }
    const changed = new Set([...files].filter(([, text]) => text != null).map(([p]) => p));
    const conflicts = treeConflicts(finalAll, changed);
    if (conflicts.length) fail('INVALID_PATH', `路径冲突：${conflicts.map(([a, b, why]) => `${a} 与 ${b}（${why}）`).join('；')}`, { conflicts });
    const finalPaths = new Set(t.pages.keys());
    for (const [p, text] of files) { if (text == null) finalPaths.delete(p); else finalPaths.add(p); }
    let total = 0;
    for (const [p, e] of t.pages) if (!files.has(p)) total += e.size;
    for (const [p, text] of files) {
      if (text == null) continue;
      const size = utf8Bytes(text);
      total += size;
      const isCfg = p === CONFIG_PATH || p === CONVENTIONS_PATH;
      if (isCfg && !allowConfig) fail('FORBIDDEN', '_commons/ 下的文件只能由 admin 经 update_config 修改');
      if (size > cfg.limits.page_max_bytes) fail('TOO_LARGE', `${p} 超过单页上限 ${cfg.limits.page_max_bytes} 字节（当前 ${size}）`);
      if (text.includes('\0')) fail('INVALID_CONTENT', `${p} 含 NUL 字符`);
      if (containsCredential(text)) fail('CREDENTIAL_DETECTED', `${p} 的最终内容里疑似含有密钥、口令或本服务的凭据，已拒绝（内容未落盘）`);
      if (p === CONFIG_PATH) continue;
      const pii = scanPii(text, cfg.pii);
      if (pii.rejections.length) fail('PII_REJECTED', `${p}：${pii.rejections.join('；')}`);
      warnings.push(...pii.warnings.map((w) => `${p}：${w}`));
      const lint = lintPage(p, text, finalPaths);
      if (lint.errors.length) fail('LINT_FAILED', `${p}：${lint.errors.join('；')}`);
      warnings.push(...lint.warnings.map((w) => `${p}：${w}`));
    }
    if (total > cfg.limits.total_max_bytes) fail('TOO_LARGE', `实例总量将超过上限 ${cfg.limits.total_max_bytes} 字节`);
    // 页面类型校验：作用于最终完整页面；跨页编号与同名去重看最终状态
    const typeCfg = files.has(CONFIG_PATH) && files.get(CONFIG_PATH) != null ? parseConfig(files.get(CONFIG_PATH)) : cfg;
    const errors = [];
    for (const [p, text] of files) {
      if (text == null || !isContentPath(p)) continue;
      const type = pageTypeFor(typeCfg, p);
      if (!type?.entry) continue;
      const others = [];
      for (const [q, e] of t.pages) {
        if (q === p || files.has(q) || pageTypeFor(typeCfg, q) !== type) continue;
        for (const en of parseEntries(await content.blobText(e.sha), type.entry).entries) others.push({ id: en.id, title: en.title, where: q });
      }
      for (const [q, qt] of files) {
        if (q === p || qt == null || pageTypeFor(typeCfg, q) !== type) continue;
        for (const en of parseEntries(qt, type.entry).entries) others.push({ id: en.id, title: en.title, where: q });
      }
      for (const err of validateEntries(text, type, others)) errors.push(`${p}：${err}`);
    }
    if (errors.length) fail('SCHEMA_VIOLATION', `页面类型校验未通过（${errors.length} 处）。可先用 page_template 查看格式`, { errors: errors.slice(0, 50) });
    return warnings;
  }

  // ---------- 提交消息 ----------
  function escapeAgentMessage(m) {
    return m.split('\n').map((l) => (/^\s*Commons-[A-Za-z-]*\s*:/i.test(l) ? `> ${l}` : l)).join('\n');
  }
  function composeMessage({ op, subjectPath, message, trailers }) {
    const subject = `[${op}] ${subjectPath}: ${oneLine(message, 60)}`;
    const tl = Object.entries(trailers).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\n');
    return `${subject}\n\n${escapeAgentMessage(message)}\n\n${tl}\n`;
  }
  const authorFor = (actor) => (actor
    ? { name: `${actor.display_name} (via ${actor.client_label})`, email: `${actor.member_id}@members.${slug}.invalid` }
    : botIdentity);

  // ---------- 核心提交流程 ----------
  // plan: { op, paths, changes:[{path, text|null}], subjectPath, message, warnings, hints, extraTrailers, attribution, ledgerExtra }
  async function commitPlan(actor, plan, { idem = null, paramsDigest = null, attribution = 'service_authenticated', author = null } = {}) {
    const P = published();
    const main = await repo.revParse('refs/heads/main');
    if (main !== P) {
      sync.setMode('maintenance', 'published_mismatch', { message: '本地 main 与已发布版本不一致，已进入维护模式' });
      fail('MAINTENANCE', '内部状态不一致，服务已进入维护模式');
    }
    const blobRevs = {};
    const changes = [];
    for (const c of plan.changes) {
      const sha = c.text == null ? null : await repo.hashObject(c.text);
      changes.push({ path: c.path, sha });
      blobRevs[c.path] = sha;
    }
    const tree = await repo.buildTree(P, changes);
    if (P) {
      const parentTree = (await repo.run(['rev-parse', `${P}^{tree}`])).trim();
      if (parentTree === tree) fail('NO_CHANGE', '内容没有变化，未产生提交');
    }
    const request_id = newId('r');
    const message = composeMessage({
      op: plan.op, subjectPath: plan.subjectPath, message: plan.message,
      trailers: {
        'Commons-Member': actor?.member_id ?? 'system', 'Commons-Token': actor?.token_id ?? 'system',
        'Commons-Op': plan.op, 'Commons-Request': request_id, ...(plan.extraTrailers ?? {}),
      },
    });
    if (containsCredential(message)) fail('CREDENTIAL_DETECTED', '生成的提交说明里疑似含有密钥或凭据（可能来自路径或说明），已拒绝');
    const ts = now();
    const commit = await repo.commitTree({ tree, parents: P ? [P] : [], message, author: author ?? authorFor(actor), committer: botIdentity, date: ts });
    const result = {
      status: 'accepted', request_id, op: plan.op, commit_rev: commit, paths: plan.paths,
      blob_revs: blobRevs, ...(plan.paths.length === 1 ? { blob_rev: blobRevs[plan.paths[0]] } : {}),
      warnings: plan.warnings ?? [], hints: plan.hints ?? [],
    };
    db.run(`INSERT INTO journal(request_id, token_id, member_id, idem_key, params_digest, op, paths, parent, commit_sha, expected, result, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`, request_id, actor?.token_id ?? null, actor?.member_id ?? null, idem, paramsDigest,
    plan.op, JSON.stringify(plan.paths), P, commit, JSON.stringify({ blobs: blobRevs, attribution, client_label: actor?.client_label ?? null, extra: plan.ledgerExtra ?? null, ts }),
    JSON.stringify(result), ts);
    fault('after_intent');
    await repo.updateRef('refs/heads/main', commit, P, `commons ${plan.op} ${request_id}`);
    fault('after_ref');
    finalize(db.get('SELECT * FROM journal WHERE request_id = ?', request_id));
    fault('after_db');
    onPublished(commit);
    return { result, commit };
  }

  // 依据事务意图补齐账本、幂等结果与已发布指针（正常路径与崩溃恢复共用）
  function finalize(j) {
    const exp = JSON.parse(j.expected);
    db.tx(() => {
      const seq = (db.get('SELECT MAX(seq) AS s FROM ledger').s ?? 0) + 1;
      db.run(`INSERT INTO ledger(commit_sha, seq, parent, member_id, token_id, client_label, request_id, op, paths, attribution, extra, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, j.commit_sha, seq, j.parent, j.member_id, j.token_id, exp.client_label, j.request_id, j.op, j.paths,
      exp.attribution, exp.extra ? JSON.stringify(exp.extra) : null, exp.ts);
      fault('in_finalize'); // 测试用：SQLite 事务进行到一半
      if (j.idem_key && j.token_id) {
        db.run('INSERT OR REPLACE INTO idempotency(token_id, idem_key, params_digest, request_id, result, created_at) VALUES (?,?,?,?,?,?)',
          j.token_id, j.idem_key, j.params_digest, j.request_id, j.result, exp.ts);
      }
      db.run("UPDATE journal SET status = 'done', finished_at = ? WHERE request_id = ?", now(), j.request_id);
      db.meta.set('published_commit', j.commit_sha);
    });
  }

  // 启动时恢复未完成的事务；返回 {completed, failed, inconsistent}
  async function recover() {
    const out = { completed: [], failed: [], inconsistent: [] };
    const pending = db.all("SELECT * FROM journal WHERE status = 'pending' ORDER BY created_at");
    for (const j of pending) {
      const main = await repo.revParse('refs/heads/main');
      if (main && main === j.commit_sha) {
        const info = (await repo.commitInfos([main]))[0];
        const parentOk = (info.parents[0] ?? null) === (j.parent ?? null);
        if (!parentOk || !info.message.includes(`Commons-Request: ${j.request_id}`)) { out.inconsistent.push(j.request_id); continue; }
        finalize(j);
        out.completed.push(j.request_id);
      } else if ((main ?? null) === (j.parent ?? null)) {
        db.run("UPDATE journal SET status = 'failed', finished_at = ?, note = 'not committed before crash' WHERE request_id = ?", now(), j.request_id);
        out.failed.push(j.request_id);
      } else {
        out.inconsistent.push(j.request_id);
      }
    }
    return out;
  }

  // 幂等：同 token 同键 7 天内同参数返回原结果，不同参数拒绝
  async function idempotent(actor, key, digest) {
    const row = db.get('SELECT * FROM idempotency WHERE token_id = ? AND idem_key = ? AND created_at > ?', actor.token_id, key, now() - IDEMPOTENCY_TTL_MS);
    if (!row) return null;
    if (row.params_digest !== digest) fail('IDEMPOTENCY_MISMATCH', '这个 idempotency_key 已用于另一个不同的写入；新写入请换一个新键');
    const r = JSON.parse(row.result);
    return { ...r, replayed: true };
  }

  function recordRejection(actor, key, digest, e) {
    const result = maskCredentials({ status: 'rejected', code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
    db.run('INSERT OR REPLACE INTO idempotency(token_id, idem_key, params_digest, request_id, result, created_at) VALUES (?,?,?,?,?,?)',
      actor.token_id, key, digest, newId('r'), JSON.stringify(result), now());
  }

  async function withSync(result, commit) {
    let status = await sync.commitSyncStatus(commit);
    if (status === 'pending_sync' && syncWaitMs > 0) {
      const push = sync.pushNow();
      await Promise.race([push.catch(() => null), new Promise((r) => { setTimeout(r, syncWaitMs).unref?.(); })]);
      status = await sync.commitSyncStatus(commit);
    }
    return { ...result, sync: status };
  }

  // 通用外壳：权限、冻结、幂等、串行
  function writeOp(name, planner, { perm = 'write' } = {}) {
    return async (actor, params) => {
      if (!actor.perms.has(perm)) fail('FORBIDDEN', perm === 'admin' ? '需要 admin 权限' : '当前凭据没有写权限');
      const key = checkIdemKey(params.idempotency_key);
      const { idempotency_key: _k, ...rest } = params;
      const digest = sha256(canonicalJson({ op: name, ...rest }));
      const out = await enqueue(async () => {
        const prior = await idempotent(actor, key, digest);
        if (prior?.status === 'rejected') throw new CommonsError(prior.code, prior.message, { ...(prior.details ?? {}), replayed: true });
        if (prior) return { result: prior, commit: prior.commit_rev };
        assertWritable();
        const admitted = await sync.admit();
        assertWritable(); // 准入检查是异步的，期间状态可能变化：再确认一次
        if (!admitted) fail('FROZEN', '未推送到 GitHub 的提交已到上限，暂停写入；推送恢复后自动解冻', { reason: 'pending_limit' });
        try {
          const plan = await planner(actor, rest);
          return await commitPlan(actor, plan, { idem: key, paramsDigest: digest });
        } catch (e) {
          if (e instanceof CommonsError && DETERMINISTIC.has(e.code)) recordRejection(actor, key, digest, e);
          throw e;
        }
      });
      return withSync(out.result, out.commit);
    };
  }

  // ---------- 各操作的规划 ----------
  async function planWritePage(actor, { path: rawPath, mode, content: body, edits, base_rev, read_commit_rev, message }) {
    const p = checkPath(rawPath);
    const msg = checkMessage(message);
    if (!['create', 'append', 'patch', 'replace'].includes(mode)) fail('INVALID_ARGUMENT', 'mode 只能是 create / append / patch / replace');
    const P = published();
    const t = await content.tree(P);
    const cur = t.pages.get(p);
    const curText = cur ? await content.blobText(cur.sha) : null;
    if (mode !== 'patch' && edits != null) fail('INVALID_ARGUMENT', `${mode} 模式不接受 edits`);
    if (mode === 'patch' && body != null) fail('INVALID_ARGUMENT', 'patch 模式用 edits，不接受 content');
    let next;
    if (mode === 'create') {
      if (base_rev != null) fail('INVALID_ARGUMENT', 'create 模式不接受 base_rev');
      if (cur || t.all.has(p)) fail('ALREADY_EXISTS', `页面已存在：${p}（修改请先 read_page 拿 blob_rev，再用 patch 或 replace）`, { current_blob_rev: cur?.sha });
      next = checkText(body);
    } else {
      if (!cur) fail('NOT_FOUND', `页面不存在：${p}（新建请用 create）`);
      const needBase = mode === 'patch' || mode === 'replace';
      if (needBase && base_rev == null) fail('INVALID_ARGUMENT', `${mode} 模式必须带 base_rev（read_page 返回的 blob_rev）`);
      if (base_rev != null && base_rev !== cur.sha) fail('CONFLICT', '页面在你读取之后已被修改', await conflictDetails(p, cur.sha, read_commit_rev));
      if (mode === 'append') {
        const add = checkText(body);
        if (!add) fail('INVALID_ARGUMENT', 'append 的 content 不能为空');
        next = curText + (curText === '' || curText.endsWith('\n') ? '' : '\n') + add;
      } else if (mode === 'replace') {
        next = checkText(body);
      } else {
        if (!Array.isArray(edits) || !edits.length || edits.length > 50) fail('INVALID_ARGUMENT', 'edits 需要 1–50 条 {old, new}');
        next = curText;
        edits.forEach((e, i) => {
          if (!e || typeof e.old !== 'string' || typeof e.new !== 'string') fail('INVALID_ARGUMENT', `edits[${i}] 需要 old 与 new 两个字符串`);
          const o = checkText(e.old, `edits[${i}].old`); const n = checkText(e.new, `edits[${i}].new`);
          if (!o) fail('INVALID_ARGUMENT', `edits[${i}].old 不能为空`);
          const first = next.indexOf(o);
          if (first < 0) fail('PATCH_NOT_FOUND', `edits[${i}].old 在当前文本中找不到；请重读页面后再改`, { edit_index: i });
          if (next.indexOf(o, first + 1) >= 0) fail('PATCH_AMBIGUOUS', `edits[${i}].old 在当前文本中出现不止一次；请多带一些上下文让它唯一`, { edit_index: i });
          next = next.slice(0, first) + n + next.slice(first + o.length);
        });
      }
    }
    const files = new Map([[p, next]]);
    const warnings = await guardFinal(P, files, msg, { actor, op: mode });
    return { op: mode, paths: [p], changes: [{ path: p, text: next }], subjectPath: p, message: msg, warnings };
  }

  async function referencingPages(P, target) {
    const t = await content.tree(P);
    const base = path.posix.basename(target);
    const hits = [];
    for (const [q, e] of t.pages) {
      if (q === target) continue;
      const text = await content.blobText(e.sha);
      if (text.includes(target) || text.includes(`(${base})`) || text.includes(`[[${base.replace(/\.md$/, '')}]]`)) hits.push(q);
    }
    return hits;
  }

  async function planMovePage(actor, { from, to, base_rev, message }) {
    const a = checkPath(from); const b = checkPath(to);
    const msg = checkMessage(message);
    if (a === b) fail('INVALID_ARGUMENT', 'from 与 to 相同');
    if (base_rev == null) fail('INVALID_ARGUMENT', 'move_page 必须带 base_rev');
    const P = published();
    const t = await content.tree(P);
    const cur = t.pages.get(a) ?? fail('NOT_FOUND', `页面不存在：${a}`);
    if (cur.sha !== base_rev) fail('CONFLICT', '页面在你读取之后已被修改', await conflictDetails(a, cur.sha, null));
    if (t.all.has(b)) fail('ALREADY_EXISTS', `目标已存在：${b}`);
    const text = await content.blobText(cur.sha);
    const files = new Map([[a, null], [b, text]]);
    const warnings = await guardFinal(P, files, msg, { actor, op: 'move' });
    const refs = await referencingPages(P, a);
    const hints = refs.length ? [`以下页面可能引用了旧路径 ${a}，服务不会自动改链接：${refs.join('、')}`] : [];
    return { op: 'move', paths: [a, b], changes: [{ path: a, text: null }, { path: b, text }], subjectPath: `${a} → ${b}`, message: msg, warnings, hints };
  }

  async function planDeletePage(actor, { path: rawPath, base_rev, message }) {
    const p = checkPath(rawPath);
    const msg = checkMessage(message);
    const P = published();
    const cfg = await content.config(P);
    if (cfg.permissions.delete === 'admin' && !actor.perms.has('admin')) fail('FORBIDDEN', '本实例只允许 admin 删除页面');
    if (base_rev == null) fail('INVALID_ARGUMENT', 'delete_page 必须带 base_rev');
    const t = await content.tree(P);
    const cur = t.pages.get(p) ?? fail('NOT_FOUND', `页面不存在：${p}`);
    if (cur.sha !== base_rev) fail('CONFLICT', '页面在你读取之后已被修改', await conflictDetails(p, cur.sha, null));
    const warnings = await guardFinal(P, new Map([[p, null]]), msg, { actor, op: 'delete' });
    const refs = await referencingPages(P, p);
    const hints = [`删除可以用 revert_change 撤回`, ...(refs.length ? [`以下页面可能引用了被删页面：${refs.join('、')}`] : [])];
    return { op: 'delete', paths: [p], changes: [{ path: p, text: null }], subjectPath: p, message: msg, warnings, hints };
  }

  async function planUpdateConfig(actor, { path: rawPath, content: body, base_rev, message }) {
    const p = checkConfigPath(rawPath);
    const msg = checkMessage(message);
    const text = checkText(body);
    const P = published();
    const t = await content.tree(P);
    const cur = t.pages.get(p);
    if (cur && base_rev == null) fail('INVALID_ARGUMENT', 'update_config 修改已有文件必须带 base_rev');
    if (!cur && base_rev != null) fail('INVALID_ARGUMENT', '文件尚不存在，不能带 base_rev');
    if (cur && base_rev !== cur.sha) fail('CONFLICT', '配置在你读取之后已被修改', await conflictDetails(p, cur.sha, null));
    const extra = [];
    if (p === CONFIG_PATH) {
      const next = parseConfig(text);
      // 新配置下现有页面是否仍合规：只提示，不阻断（页面在下次修改时会被要求改好）
      let bad = 0;
      for (const [q, e] of t.pages) {
        const type = isContentPath(q) ? pageTypeFor(next, q) : null;
        if (type?.entry) bad += validateEntries(await content.blobText(e.sha), type, []).length;
      }
      if (bad) extra.push(`按新配置，现有页面共有 ${bad} 处条目不合规；这些页面下次修改时需要改好`);
    }
    if (p === CONVENTIONS_PATH && utf8Bytes(text) > CONVENTIONS_MAX) fail('TOO_LARGE', `conventions.md 会随 instructions 下发，上限 ${CONVENTIONS_MAX} 字节`);
    const files = new Map([[p, text]]);
    const warnings = [...extra, ...(await guardFinal(P, files, msg, { allowConfig: true, actor, op: 'config' }))];
    return { op: 'config', paths: [p], changes: [{ path: p, text }], subjectPath: p, message: msg, warnings };
  }

  async function mergeFile(ours, base, theirs) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'commons-merge-'));
    try {
      const f = (n, s) => { const fp = path.join(dir, n); writeFileSync(fp, s); return fp; };
      const [o, b, t] = [f('ours', ours), f('base', base), f('theirs', theirs)];
      return await new Promise((resolve) => {
        execFile('git', ['merge-file', '-p', '-q', o, b, t], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
          (err, stdout) => resolve({ ok: !err, text: stdout }));
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async function planRevert(actor, { commit_rev, message }) {
    const msg = checkMessage(message);
    if (typeof commit_rev !== 'string' || !/^[0-9a-f]{40}$/.test(commit_rev)) fail('INVALID_ARGUMENT', 'commit_rev 需要完整的 40 位提交 SHA');
    const P = published();
    if ((await repo.objectType(commit_rev)) !== 'commit' || !(await repo.isAncestor(commit_rev, P))) fail('NOT_FOUND', '这个提交不在已发布的主线上');
    const info = (await repo.commitInfos([commit_rev]))[0];
    if (info.parents.length !== 1) fail('INVALID_ARGUMENT', '只能回滚有且只有一个父提交的普通提交');
    const led = db.get('SELECT * FROM ledger WHERE commit_sha = ?', commit_rev);
    if (!led || led.attribution !== 'service_authenticated') fail('FORBIDDEN', '只能回滚经服务认证（service_authenticated）的提交');
    const raw = await repo.diffTreeRaw(commit_rev);
    const t = await content.tree(P);
    const files = new Map();
    for (const d of raw) {
      if (!isContentPath(d.path)) fail('FORBIDDEN', `该提交修改了 ${d.path}；_commons/ 的变更不能经 revert 撤回，请由 admin 用 update_config 修改`);
      checkPath(d.path);
      for (const mode of [d.srcMode, d.dstMode]) if (mode !== '000000' && mode !== '100644') fail('INVALID_CONTENT', `该提交涉及非普通文件（${d.path}，mode ${mode}），不能回滚`);
      const baseText = d.dstMode === '000000' ? null : await content.blobText(d.dstSha);
      const theirs = d.srcMode === '000000' ? null : await content.blobText(d.srcSha);
      const curE = t.pages.get(d.path);
      const ours = curE ? await content.blobText(curE.sha) : (t.all.has(d.path) ? fail('CONFLICT', `${d.path} 当前不是普通页面`) : null);
      if (ours === theirs) continue;
      if (baseText == null) { // 原提交删除了它 → 恢复
        if (ours != null) fail('CONFLICT', `${d.path} 在原提交删除之后又被重新创建，不能自动回滚`, { path: d.path });
        files.set(d.path, theirs);
      } else if (theirs == null) { // 原提交新建了它 → 删除
        if (ours !== baseText) fail('CONFLICT', `${d.path} 在原提交之后又被修改过，不能自动删除；请手动处理`, { path: d.path });
        files.set(d.path, null);
      } else if (ours == null) {
        fail('CONFLICT', `${d.path} 在原提交之后已被删除或移动，不能自动回滚`, { path: d.path });
      } else if (ours === baseText) {
        files.set(d.path, theirs);
      } else {
        const m = await mergeFile(ours, baseText, theirs);
        if (!m.ok) fail('CONFLICT', `${d.path} 在原提交之后又被修改过，回滚与后续修改冲突；请手动用 patch 修改`, { path: d.path });
        files.set(d.path, m.text);
      }
    }
    if (!files.size) fail('NO_CHANGE', '该提交的修改已经不在当前版本里，无需回滚');
    const warnings = await guardFinal(P, files, msg, { actor, op: 'revert' });
    const paths = [...files.keys()];
    return {
      op: 'revert', paths, changes: paths.map((p) => ({ path: p, text: files.get(p) })),
      subjectPath: `${commit_rev.slice(0, 12)}`, message: msg, warnings,
      extraTrailers: { 'Commons-Reverts': commit_rev }, ledgerExtra: { reverts: commit_rev },
    };
  }

  // 首次初始化：写入实例骨架（作者 = 服务本身）
  async function initSkeleton(files, message) {
    return enqueue(async () => {
      const plan = { op: 'init', paths: Object.keys(files), changes: Object.entries(files).map(([p, text]) => ({ path: p, text })), subjectPath: 'instance', message };
      return commitPlan(null, plan, {});
    });
  }

  // 采纳已有仓库或维护恢复之前，对整棵树做发布前校验（Codex 实现评审 #6 / R2-6）：
  // 把树里每个可发布页面都当作“本次写入”，走和普通写入完全相同的最终守卫（凭据、个人信息策略、大小、lint、页面类型、路径冲突、配置）。
  async function validateTree(commit) {
    const errors = []; const warnings = [];
    if (!commit) return { errors, warnings };
    const t = await content.tree(commit);
    const cfgAsDir = [...t.all.keys()].some((k) => k.startsWith(`${CONFIG_PATH}/`));
    if ((t.all.has(CONFIG_PATH) && !t.pages.has(CONFIG_PATH)) || cfgAsDir) errors.push('_commons/config.yaml 不是普通文件（链接、可执行文件或目录）');
    const files = new Map();
    for (const [p, e] of t.pages) files.set(p, await content.blobText(e.sha));
    try {
      await guardFinal(commit, files, 'validate', { allowConfig: true, actor: { perms: new Set(['admin']) }, op: 'validate' });
    } catch (e) {
      errors.push(e.details?.errors ? `${e.message}：${e.details.errors.slice(0, 5).join('；')}` : e.message);
    }
    const hidden = t.all.size - t.pages.size;
    if (hidden) warnings.push(`${hidden} 个文件不在内容策略内（隐藏文件、链接、非 .md 等），读接口不会显示`);
    return { errors, warnings };
  }

  return {
    enqueue, published, assertWritable, recover, finalize, commitPlan, guardFinal, validateTree,
    writePage: writeOp('write_page', planWritePage),
    movePage: writeOp('move_page', planMovePage),
    deletePage: writeOp('delete_page', planDeletePage),
    revertChange: writeOp('revert_change', planRevert),
    updateConfig: writeOp('update_config', planUpdateConfig, { perm: 'admin' }),
    initSkeleton,
  };
}
