// P1 验收 12（从旧快照恢复账本 → 维护模式、凭据全部作废且重启后仍作废；账本缺失 ≠ 首次初始化）
// 与 13（BOOTSTRAP_FORCE 只生效一次）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import path from 'node:path';
import { startService, setupMembers, connect, enroll, key, cleanupAll, makeRemote, git, tmp, BOOT_CODE } from './helpers.js';
import { backupDb } from '../src/db.js';
import { openContext, resolveMaintenance } from '../src/maintenance.js';
import { DatabaseSync } from 'node:sqlite';

after(cleanupAll);

const status = async (url, token) => (await fetch(`${url}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
})).status;

const dbFile = (dataDir) => path.join(dataDir, 'state', 'commons.db');
function replaceDb(dataDir, snapshot) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile(dataDir) + suffix, { force: true });
  if (snapshot) copyFileSync(snapshot, dbFile(dataDir));
}
const query = (dataDir, sql) => { const d = new DatabaseSync(dbFile(dataDir)); try { return d.prepare(sql).all(); } finally { d.close(); } };

test('验收 12：从旧快照恢复账本 → 维护模式；恢复出的凭据与未兑换邀请码全部作废，重启后仍作废', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-restore-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice', 'bob']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'c1', idempotency_key: key() });
  const pendingInvite = await m.admin.call('invite_create', { member_id: 'm-alice', client_label: 'alice-codex' });
  const snap = path.join(tmp('commons-snap-'), 'snap.db');
  backupDb(s.svc.ctx.db, snap);
  // 快照之后：兑换邀请码、吊销 bob、再写一次（服务提交）
  const later = await enroll(s.url, pendingInvite.data.code);
  assert.equal(later.status, 200);
  const bobTok = (await m.bob.call('my_tokens')).data.tokens[0].token_id;
  await m.bob.call('token_revoke', { token_id: bobTok });
  const c2 = await m.alice.call('write_page', { path: 'a.md', mode: 'append', content: '2\n', message: 'c2', idempotency_key: key() });
  assert.equal(c2.data.sync, 'synced');
  await s.close();
  // 用旧快照替换状态库后启动
  replaceDb(dataDir, snap);
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.ok(s2.svc.report.actions.includes('maintenance:ledger_stale'), JSON.stringify(s2.svc.report));
  assert.equal(await status(s2.url, m.aliceToken), 503);
  assert.equal(await status(s2.url, m.bobToken), 503);
  assert.equal((await enroll(s2.url, pendingInvite.data.code)).status, 503);
  await s2.close();
  // 作废结果已持久化：快照里“还活着”的 bob token、未兑换的邀请码都失效了
  assert.ok(query(dataDir, 'SELECT revoked_at FROM tokens').every((t) => t.revoked_at != null));
  assert.ok(query(dataDir, "SELECT status FROM invites WHERE status = 'pending'").length === 0);
  // 再重启：仍在维护模式
  const s3 = await startService({ dataDir, repoUrl: remote });
  assert.deepEqual(s3.svc.report.actions, ['stay_maintenance']);
  assert.equal(await status(s3.url, m.aliceToken), 503);
  await s3.close();
  // 维护窗口：以服务链为准重新发布，用新的 bootstrap code 重建 admin
  const ctx = openContext({ dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  const newCode = `sbe_${'b2'.repeat(16)}`;
  const rep = await resolveMaintenance(ctx, { bootstrapCode: newCode });
  ctx.close();
  assert.equal(rep.head, c2.data.commit_rev);
  const s4 = await startService({ dataDir, repoUrl: remote });
  assert.equal(await status(s4.url, m.aliceToken), 401);
  assert.equal(await status(s4.url, m.bobToken), 401);
  assert.equal(await status(s4.url, later.body.token), 401);
  assert.equal((await enroll(s4.url, BOOT_CODE)).status, 410);
  const admin2 = await enroll(s4.url, newCode);
  assert.equal(admin2.status, 200);
  const a2 = await connect(s4.url, admin2.body.token);
  const ch = await a2.call('changes', { from: 'start', limit: 50 });
  const c2item = ch.data.changes.find((x) => x.commit_rev === c2.data.commit_rev);
  assert.equal(c2item.attribution, 'unverified'); // 快照之后的提交没有账本记录，不会凭 trailer 补成已认证
  assert.ok(c2item.note);
  await s4.close();
});

test('验收 12：账本缺失但仓库已有服务提交 → 不当作首次初始化', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-lost-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'c1', idempotency_key: key() });
  const head = git(remote, 'rev-parse', 'main');
  await s.close();
  replaceDb(dataDir, null);
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.ok(s2.svc.report.actions.includes('maintenance:state_lost'), JSON.stringify(s2.svc.report));
  assert.equal((await enroll(s2.url, BOOT_CODE)).status, 503);
  assert.equal(git(remote, 'rev-parse', 'main'), head);
  await s2.close();
  // 整个 volume 丢失（仓库也没了），从远端重新 clone：同样不当作首次初始化
  const fresh = tmp('commons-fresh-');
  const s3 = await startService({ dataDir: fresh, repoUrl: remote });
  assert.ok(s3.svc.report.actions.includes('maintenance:state_lost'), JSON.stringify(s3.svc.report));
  assert.equal(query(fresh, 'SELECT * FROM invites').length, 0);
  await s3.close();
});

test('只有 trailer、没有意图记录的提交不会被补成 service_authenticated', async () => {
  const dataDir = tmp('commons-forge-');
  const s = await startService({ dataDir });
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'c1', idempotency_key: key() });
  await s.close();
  // 直接在本地仓库上伪造一个带完整 trailer 的提交并移动 main（模拟卷被篡改）
  const repo = path.join(dataDir, 'instance.git');
  const env = { GIT_DIR: repo };
  const tree = git(repo, '--git-dir', repo, 'rev-parse', 'main^{tree}');
  const parent = git(repo, '--git-dir', repo, 'rev-parse', 'main');
  const forged = (await import('node:child_process')).execFileSync('git', ['--git-dir', repo, 'commit-tree', tree, '-p', parent, '-m', '[patch] a.md: forged\n\nforged\n\nCommons-Member: m-alice\nCommons-Token: t-x\nCommons-Op: patch\nCommons-Request: r-forged'], {
    env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'm-alice@x.invalid', GIT_COMMITTER_NAME: 'substrate-commons', GIT_COMMITTER_EMAIL: 'bot@x.invalid' }, encoding: 'utf8',
  }).trim();
  git(repo, '--git-dir', repo, 'update-ref', 'refs/heads/main', forged);
  const s2 = await startService({ dataDir });
  assert.ok(s2.svc.report.actions.includes('maintenance:ledger_stale'), JSON.stringify(s2.svc.report));
  assert.equal(s2.svc.ctx.db.get('SELECT 1 AS x FROM ledger WHERE commit_sha = ?', forged), undefined);
  await s2.close();
  assert.ok(existsSync(repo));
});

test('验收 13：BOOTSTRAP_FORCE 用过一次后，重启不会再追加 admin', async () => {
  const dataDir = tmp('commons-force-');
  const s = await startService({ dataDir });
  await setupMembers(s.url, []);
  await s.close();
  const forceCode = `sbe_${'c3'.repeat(16)}`;
  const s2 = await startService({ dataDir, bootstrap: { code: forceCode, force: true, member: 'm-owner', name: 'Owner' } });
  assert.ok(s2.svc.report.actions.includes('bootstrap_force_registered'));
  assert.equal((await enroll(s2.url, forceCode)).status, 200);
  await s2.close();
  const s3 = await startService({ dataDir, bootstrap: { code: forceCode, force: true, member: 'm-owner', name: 'Owner' } });
  assert.ok(s3.svc.report.actions.includes('bootstrap_force_ignored_already_used'));
  assert.equal((await enroll(s3.url, forceCode)).status, 410);
  const adminTokens = s3.svc.ctx.db.all("SELECT * FROM tokens WHERE scope = 'admin'");
  assert.equal(adminTokens.length, 2);
  // 非 FORCE 时，首次初始化之后的 BOOTSTRAP_ADMIN_CODE 一律忽略
  await s3.close();
  const other = `sbe_${'d4'.repeat(16)}`;
  const s4 = await startService({ dataDir, bootstrap: { code: other, member: 'm-owner', name: 'Owner' } });
  assert.equal((await enroll(s4.url, other)).status, 401);
  await s4.close();
});

test('Codex #1：快照之后只有授权变化、没有任何提交，恢复旧状态库也会进入维护模式并作废凭据', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-authonly-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice', 'bob']);
  const inv = await m.admin.call('invite_create', { member_id: 'm-alice', client_label: 'alice-codex' });
  await s.svc.ctx.sync.pushNow();
  const snap = path.join(tmp('commons-snap-'), 'snap.db');
  backupDb(s.svc.ctx.db, snap);
  // 快照之后：兑换邀请码、吊销 bob —— 都没有 git 提交
  assert.equal((await enroll(s.url, inv.data.code)).status, 200);
  await m.bob.call('token_revoke', { token_id: (await m.bob.call('my_tokens')).data.tokens[0].token_id });
  const headBefore = git(remote, 'rev-parse', 'main');
  await s.close();
  replaceDb(dataDir, snap);
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.ok(s2.svc.report.actions.includes('maintenance:auth_stale'), JSON.stringify(s2.svc.report));
  assert.equal(await status(s2.url, m.bobToken), 503);
  assert.equal((await enroll(s2.url, inv.data.code)).status, 503);
  await s2.close();
  assert.ok(query(dataDir, 'SELECT revoked_at FROM tokens').every((t) => t.revoked_at != null));
  assert.equal(query(dataDir, "SELECT * FROM invites WHERE status = 'pending'").length, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), headBefore);
  // 维护处置后：被吊销的 bob 不会复活，新的 admin 引导码可用，且不会再次判为落后
  const ctx = openContext({ dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  await resolveMaintenance(ctx, { bootstrapCode: `sbe_${'e5'.repeat(16)}` });
  await ctx.close();
  const s3 = await startService({ dataDir, repoUrl: remote });
  assert.ok(!s3.svc.report.actions.some((a) => a.startsWith('maintenance')), JSON.stringify(s3.svc.report));
  assert.equal(await status(s3.url, m.bobToken), 401);
  assert.equal((await enroll(s3.url, `sbe_${'e5'.repeat(16)}`)).status, 200);
  await s3.close();
});

test('Codex #1：整个 volume 回滚到旧快照（状态库和水位文件一起回滚）→ 远端水位发现落后', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-volume-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await s.svc.ctx.watermark.flush();
  const backup = tmp('commons-volsnap-');
  await s.close();
  cpSync(dataDir, backup, { recursive: true });
  const s1 = await startService({ dataDir, repoUrl: remote });
  const admin = await connect(s1.url, m.adminToken);
  await admin.call('member_disable', { member_id: 'm-alice' });
  await s1.svc.ctx.watermark.flush();
  await s1.close();
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(backup, dataDir, { recursive: true });
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.ok(s2.svc.report.actions.includes('maintenance:auth_stale'), JSON.stringify(s2.svc.report));
  assert.equal(await status(s2.url, m.aliceToken), 503);
  await s2.close();
});
