// P1 验收 3（远端被直推 → 冻结 → 分叉恢复）与 4（断网 pending、超限冻结、权限被拒立即冻结）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startService, setupMembers, key, cleanupAll, makeRemote, git, tmp } from './helpers.js';
import { openContext, forkRecover, forkStatus } from '../src/maintenance.js';
import { classifyPushError } from '../src/sync.js';

after(cleanupAll);

test('push 错误分类', () => {
  assert.equal(classifyPushError('ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights'), 'transient');
  assert.equal(classifyPushError('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'rejected');
  assert.equal(classifyPushError('remote: error: GH006: Protected branch update failed for refs/heads/main.'), 'rejected');
  assert.equal(classifyPushError('!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)'), 'diverged');
  assert.equal(classifyPushError('ERROR: Repository not found.'), 'rejected');
});

test('验收 3：远端被直推 → 冻结写入与补推，不自动合并；分叉恢复后远端、已发布版本、账本一致', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  const c = await m.alice.call('write_page', { path: 'plan.md', mode: 'create', content: '第一行\n第二行\n', message: '新建', idempotency_key: key() });
  assert.equal(c.data.sync, 'synced');
  const servicePublished = c.data.commit_rev;
  // 有人绕过服务直推
  const work = path.join(tmp('commons-ext-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'Owner Laptop'); git(work, 'config', 'user.email', 'owner@example.invalid');
  writeFileSync(path.join(work, 'plan.md'), '第一行（外部修改）\n第二行\n');
  writeFileSync(path.join(work, 'extra.md'), '# 外部新页\n');
  git(work, 'commit', '-qam', 'external edit'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'external add');
  git(work, 'push', '-q', 'origin', 'main');
  const externalHead = git(remote, 'rev-parse', 'main');
  // 服务写入：本地接受，push 发现分叉 → 冻结
  const w = await m.alice.call('write_page', { path: 'plan.md', mode: 'append', content: '服务侧追加\n', message: '追加', idempotency_key: key() });
  assert.equal(w.data.status, 'accepted');
  assert.equal(w.data.sync, 'pending_sync');
  const st = await m.admin.call('admin_status');
  assert.equal(st.data.sync.mode, 'frozen');
  assert.equal(st.data.sync.reason, 'fork');
  const blocked = await m.alice.call('write_page', { path: 'n.md', mode: 'create', content: 'x\n', message: 'm', idempotency_key: key() });
  assert.equal(blocked.data.code, 'FROZEN');
  // 不自动合并：远端仍是外部链，已发布的服务提交不变
  assert.equal(git(remote, 'rev-parse', 'main'), externalHead);
  const pub = s.svc.ctx.engine.published();
  assert.equal(pub, w.data.commit_rev);
  assert.equal(git(s.dataDir + '/instance.git', 'merge-base', '--is-ancestor', servicePublished, pub), '');
  // 冻结期间补推也停：再触发一次 push 不改变远端
  await s.svc.ctx.sync.pushNow();
  assert.equal(git(remote, 'rev-parse', 'main'), externalHead);
  // 线下分叉恢复（维护 CLI 的库函数）
  const ctx = openContext({ dataDir: s.dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  const fs = await forkStatus(ctx);
  assert.equal(fs.external.length, 2);
  const rep = await forkRecover(ctx, { adminMember: 'm-owner', importShas: 'all' });
  ctx.close();
  assert.equal(rep.imported.length, 2);
  assert.match(git(remote, 'branch', '--list', 'quarantine/*'), /quarantine\//);
  assert.equal(git(remote, 'rev-parse', rep.quarantine), externalHead);
  const head = git(remote, 'rev-parse', 'main');
  assert.equal(head, s.svc.ctx.engine.published());
  assert.ok(s.svc.ctx.db.get('SELECT 1 AS x FROM ledger WHERE commit_sha = ?', head));
  // 此前发布的服务提交一个都没变
  git(remote, 'merge-base', '--is-ancestor', w.data.commit_rev, head);
  // 外部修改经守卫重新应用，作者是执行导入的 admin，标注 maintenance_import
  const r = await m.alice.call('read_page', { path: 'plan.md' });
  assert.match(r.text, /第一行（外部修改）\n第二行\n服务侧追加/);
  assert.equal((await m.alice.call('read_page', { path: 'extra.md' })).data.last_modified.attribution, 'maintenance_import');
  const ch = await m.alice.call('changes', { from: 'start', limit: 50 });
  const imports = ch.data.changes.filter((x) => x.attribution === 'maintenance_import');
  assert.equal(imports.length, 2);
  assert.ok(imports.every((x) => x.import_of && x.member_id === 'm-owner'));
  // 解冻后写入恢复，并能推送
  const after1 = await m.alice.call('write_page', { path: 'n.md', mode: 'create', content: 'x\n', message: '恢复后写入', idempotency_key: key() });
  assert.equal(after1.data.sync, 'synced', after1.text);
  await s.close();
});

test('分叉恢复可以只隔离、不导入外部提交', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: 'a\n', message: 'm', idempotency_key: key() });
  const work = path.join(tmp('commons-ext-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'X'); git(work, 'config', 'user.email', 'x@example.invalid');
  writeFileSync(path.join(work, 'evil.md'), 'bad\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'x'); git(work, 'push', '-q', 'origin', 'main');
  await s.svc.ctx.sync.checkRemote();
  assert.equal(s.svc.ctx.sync.mode().reason, 'fork');
  const ctx = openContext({ dataDir: s.dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  const rep = await forkRecover(ctx, { adminMember: 'm-owner', importShas: 'none' });
  ctx.close();
  assert.equal(rep.imported.length, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), s.svc.ctx.engine.published());
  assert.equal((await m.alice.call('read_page', { path: 'evil.md' })).data.code, 'NOT_FOUND');
  await s.close();
});

test('验收 4：断网时 accepted + pending_sync，恢复后自动补推；到上限前就停止接受；权限被拒立即冻结', async () => {
  const remote = makeRemote();
  const net = { fail: null };
  let svcRef = null;
  const pushImpl = async (main) => {
    if (net.fail) return { ok: false, output: net.fail };
    const r = await svcRef.ctx.repo.run(['push', '--porcelain', 'origin', `${main}:refs/heads/main`], { okCodes: [0, 1, 128] });
    return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}` };
  };
  const s = await startService({ repoUrl: remote, pushImpl, maxPending: 3, syncWaitMs: 1000 });
  svcRef = s.svc;
  const m = await setupMembers(s.url, ['alice']);
  assert.equal((await s.svc.ctx.sync.pushNow()).status, 'synced'); // 先推上骨架提交
  net.fail = 'ssh: connect to host github.com port 22: Connection timed out';
  const w1 = await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'm1', idempotency_key: key() });
  assert.equal(w1.data.status, 'accepted');
  assert.equal(w1.data.sync, 'pending_sync');
  for (let i = 2; i <= 3; i++) {
    const w = await m.alice.call('write_page', { path: 'a.md', mode: 'append', content: `${i}\n`, message: `m${i}`, idempotency_key: key() });
    assert.equal(w.data.status, 'accepted', w.text);
  }
  // 已有 3 个未推送提交：第 4 个在接受之前就被拒，不会越过上限
  const w4 = await m.alice.call('write_page', { path: 'b.md', mode: 'create', content: 'x', message: 'm', idempotency_key: key() });
  assert.equal(w4.data.code, 'FROZEN');
  assert.equal(s.svc.ctx.sync.mode().reason, 'pending_limit');
  assert.equal(Number(git(s.dataDir + '/instance.git', 'rev-list', '--count', `${git(remote, 'rev-parse', 'main')}..main`)), 3);
  // 网络恢复 → 补推成功 → 自动解冻；被冻结拒绝的写入可以用同一个键重试
  net.fail = null;
  await s.svc.ctx.sync.pushNow();
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  assert.equal(git(remote, 'rev-parse', 'main'), s.svc.ctx.engine.published());
  assert.equal((await m.alice.call('request_status', { request_id: w1.data.request_id })).data.sync, 'synced');
  // 权限被拒 → 立即冻结，后台不重试
  net.fail = 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.';
  const w5 = await m.alice.call('write_page', { path: 'c.md', mode: 'create', content: 'x\n', message: 'm5', idempotency_key: key() });
  assert.equal(w5.data.status, 'accepted');
  assert.equal(s.svc.ctx.sync.mode().reason, 'push_rejected');
  net.fail = null;
  const auto = await s.svc.ctx.sync.pushNow();
  assert.equal(auto.status, 'skipped');
  assert.equal(s.svc.ctx.sync.mode().reason, 'push_rejected');
  const retry = await m.admin.call('sync_retry');
  assert.equal(retry.data.status, 'synced');
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  await s.close();
});

test('并发写入时未推送提交也不会越过上限', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote, pushImpl: async () => ({ ok: false, output: 'Connection timed out' }), maxPending: 3, syncWaitMs: 200 });
  const m = await setupMembers(s.url, ['alice']);
  // 骨架提交本身就是 1 个未推送提交（pushImpl 一直失败），所以还能再接受 2 个
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => m.alice.call('write_page', { path: `p${i}.md`, mode: 'create', content: `${i}\n`, message: 'm', idempotency_key: key() })));
  const accepted = results.filter((r) => r.data.status === 'accepted').length;
  assert.equal(accepted, 2);
  assert.ok(results.filter((r) => r.data.code === 'FROZEN').length === 8);
  await s.close();
});

test('收到 non-fast-forward 但无法拉取确认 → fork_suspected 冻结；确认没有分叉后解冻', async () => {
  const remote = makeRemote();
  let mode = 'nonff';
  const s = await startService({ repoUrl: remote, syncWaitMs: 500, pushImpl: async () => (mode === 'nonff' ? { ok: false, output: '!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)' } : { ok: true, output: '' }) });
  const m = await setupMembers(s.url, ['alice']);
  const repo = s.svc.ctx.repo;
  const realFetch = repo.fetch.bind(repo);
  repo.fetch = async () => { throw new Error('Could not resolve host: github.com'); };
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'm', idempotency_key: key() });
  assert.equal(s.svc.ctx.sync.mode().reason, 'fork_suspected');
  assert.equal((await m.alice.call('write_page', { path: 'b.md', mode: 'create', content: '1\n', message: 'm', idempotency_key: key() })).data.code, 'FROZEN');
  assert.equal((await s.svc.ctx.sync.pushNow()).status, 'skipped'); // 冻结期间不自动补推
  // 网络恢复：远端其实没有分叉（远端为空 / 是祖先）→ 解冻
  repo.fetch = realFetch;
  mode = 'ok';
  const inst = `${s.dataDir}/instance.git`;
  git(inst, '--git-dir', inst, 'push', '-q', remote, `${git(inst, '--git-dir', inst, 'rev-list', '--max-parents=0', 'main')}:refs/heads/main`);
  await s.svc.ctx.sync.checkRemote();
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  await s.close();
});

test('后台远端检查的旧结果不会覆盖维护 CLI 的处置', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'm', idempotency_key: key() });
  // 外部直推，让远端出现服务没有的提交
  const work = path.join(tmp('commons-ext-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'X'); git(work, 'config', 'user.email', 'x@example.invalid');
  writeFileSync(path.join(work, 'x.md'), 'x\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'x'); git(work, 'push', '-q', 'origin', 'main');
  // 后台检查在 fetch 里“卡住”；期间维护 CLI 完成分叉恢复并解冻
  const repo = s.svc.ctx.repo;
  const realFetch = repo.fetch.bind(repo);
  let release;
  repo.fetch = async () => { await realFetch(); await new Promise((r) => { release = r; }); };
  const pending = s.svc.ctx.sync.checkRemote();
  while (!release) await new Promise((r) => setTimeout(r, 10));
  const ctx = openContext({ dataDir: s.dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  s.svc.ctx.sync.setMode('frozen', 'fork', { message: 'test' });
  await forkRecover(ctx, { adminMember: 'm-owner', importShas: 'none' });
  await ctx.close();
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  release();
  const r = await pending;
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal', JSON.stringify(r)); // 旧检查看到的外部头已作废，不能重新冻结
  repo.fetch = realFetch;
  await s.close();
});

test('pending 超过时间上限也冻结', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote, pushImpl: async () => ({ ok: false, output: 'Could not resolve hostname github.com' }), maxPendingAgeMs: 1, syncWaitMs: 500 });
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'm', idempotency_key: key() });
  await new Promise((r) => setTimeout(r, 20));
  await s.svc.ctx.sync.pushNow();
  assert.equal(s.svc.ctx.sync.mode().reason, 'pending_limit');
  await s.close();
});
