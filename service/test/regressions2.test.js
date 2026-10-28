// Codex 实现评审第二轮的回归测试（R2-1 至 R2-7）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { renameSync, cpSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService, setupMembers, connect, enroll, key, cleanupAll, makeRemote, git, tmp, BOOT_CODE } from './helpers.js';
import { callAdmin, socketPathFor } from '../src/admin-socket.js';
import { parseConfig } from '../src/instance-config.js';
import { validateEntries } from '../src/pagetypes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const children = new Set();
after(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } } cleanupAll(); });

const mcpStatus = async (url, token) => (await fetch(`${url}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
})).status;
const remoteEpoch = (remote) => Number(git(remote, 'show', 'refs/commons/auth-watermark:epoch').split(' ')[1]);
const wait = async (cond, ms = 5000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 25)); } };

test('R2-1：授权变更在返回前推上远端见证；远端见证只能快进，不会被回滚的 volume 降低', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-r21-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice', 'bob']);
  const backup = tmp('commons-r21-bak-');
  await s.close();
  cpSync(dataDir, backup, { recursive: true });
  const s1 = await startService({ dataDir, repoUrl: remote });
  const bob = await connect(s1.url, m.bobToken);
  const tid = (await bob.call('my_tokens')).data.tokens[0].token_id;
  await bob.call('token_revoke', { token_id: tid });
  assert.equal(remoteEpoch(remote), s1.svc.ctx.members.authEpoch()); // 接口返回时远端已经记下
  const highEpoch = remoteEpoch(remote);
  await s1.close();
  // 整个 volume 回滚到吊销之前；启动时远端暂时读不到 → 认证闸门保持关闭，吊销的 bob 不会复活
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(backup, dataDir, { recursive: true });
  renameSync(remote, `${remote}.away`);
  const s2 = await startService({ dataDir, repoUrl: remote, gateRetryMs: 100 });
  assert.equal(s2.svc.gate.open, false);
  assert.equal(await mcpStatus(s2.url, m.bobToken), 503);
  assert.equal((await enroll(s2.url, BOOT_CODE)).status, 503);
  // 远端恢复可读 → 核实发现状态库落后 → 维护模式并作废全部凭据
  renameSync(`${remote}.away`, remote);
  await wait(() => s2.svc.gate.open);
  assert.equal(s2.svc.ctx.sync.mode().reason, 'auth_stale');
  assert.equal(await mcpStatus(s2.url, m.bobToken), 503);
  assert.ok(s2.svc.ctx.db.all('SELECT revoked_at FROM tokens').every((t) => t.revoked_at != null));
  assert.ok(remoteEpoch(remote) >= highEpoch); // 远端见证没有被降低
  await s2.close();
});

test('R2-1：远端见证只能快进——回滚后的旧链推送会被拒绝并触发维护', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-r21b-');
  const s = await startService({ dataDir, repoUrl: remote });
  await setupMembers(s.url, ['alice']);
  const backup = tmp('commons-r21b-bak-');
  await s.close();
  cpSync(dataDir, backup, { recursive: true });
  const s1 = await startService({ dataDir, repoUrl: remote });
  s1.svc.ctx.members.createMember({ member_id: 'm-carol', display_name: 'Carol' });
  await s1.svc.ctx.watermark.flush();
  const high = remoteEpoch(remote);
  await s1.close();
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(backup, dataDir, { recursive: true });
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.equal(s2.svc.ctx.sync.mode().reason, 'auth_stale');
  assert.ok(remoteEpoch(remote) >= high);
  await s2.close();
});

test('R2-2：被拒请求里的凭据不会出现在回显、幂等记录或审计里', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const token = `sbk_${'ab'.repeat(24)}`;
  for (const p of [`${token}?.md`, `${token}.txt`, `a/${token}/../x.md`]) {
    const r = await m.alice.call('write_page', { path: p, mode: 'create', content: '普通文本\n', message: '新建', idempotency_key: key() });
    assert.equal(r.isError, true);
    assert.ok(!r.text.includes(token), r.text);
  }
  const r2 = await m.alice.call('write_page', { path: 'ok.md', mode: 'append', content: 'x', message: `说明 ${token}`, idempotency_key: key() });
  assert.ok(!r2.text.includes(token));
  const rows = s.svc.ctx.db.all('SELECT result FROM idempotency');
  assert.ok(rows.length > 0 && rows.every((x) => !x.result.includes('sbk_')));
  assert.ok(!(await import('node:fs')).readFileSync(path.join(s.dataDir, 'audit.log'), 'utf8').includes(token));
  await s.close();
});

test('R2-3：维护命令与进行中的写事务互斥（经 admin socket 在单写者队列里执行）', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  await s.svc.startAdmin();
  const repo = s.svc.ctx.repo;
  const realHash = repo.hashObject.bind(repo);
  let releaseWrite; const gate = new Promise((r) => { releaseWrite = r; });
  let paused = false;
  repo.hashObject = async (c) => { if (!paused && String(c).includes('slow-write')) { paused = true; await gate; } return realHash(c); };
  const write = m.alice.call('write_page', { path: 'slow.md', mode: 'create', content: 'slow-write\n', message: 'm', idempotency_key: key() });
  await wait(() => paused);
  const maint = callAdmin(socketPathFor(s.dataDir), 'enter-maintenance', { reason: 'test' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal'); // 维护在排队，等写事务做完
  releaseWrite();
  const w = await write;
  assert.equal(w.data.status, 'accepted');
  await maint;
  assert.equal(s.svc.ctx.sync.mode().mode, 'maintenance');
  assert.equal(s.svc.ctx.db.all("SELECT * FROM journal WHERE status = 'pending'").length, 0);
  assert.ok(s.svc.ctx.db.get('SELECT 1 AS x FROM ledger WHERE commit_sha = ?', w.data.commit_rev));
  repo.hashObject = realHash;
  await s.close();
});

test('R2-3：独立 CLI 进程经 socket 做分叉恢复，期间并发写入不会留下不一致', async () => {
  const dataDir = tmp('commons-r23-');
  const remote = makeRemote();
  const child = spawn(process.execPath, [path.join(here, 'fixtures', 'child-server.mjs')], { env: { ...process.env, DATA_DIR: dataDir, REPO_URL: remote }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  let buf = '';
  const info = await new Promise((resolve) => child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); }));
  const url = `http://127.0.0.1:${info.port}`;
  const m = await setupMembers(url, ['alice']);
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: 'a\n', message: 'm', idempotency_key: key() });
  const work = path.join(tmp('commons-ext-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'X'); git(work, 'config', 'user.email', 'x@example.invalid');
  writeFileSync(path.join(work, 'ext.md'), 'ext\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'ext'); git(work, 'push', '-q', 'origin', 'main');
  // 触发分叉冻结
  await m.alice.call('write_page', { path: 'b.md', mode: 'create', content: 'b\n', message: 'm', idempotency_key: key() });
  // 一边并发写（都会因冻结被拒），一边用独立进程跑维护 CLI
  const writes = Promise.all(Array.from({ length: 8 }, (_, i) => m.alice.call('write_page', { path: `c${i}.md`, mode: 'create', content: `${i}\n`, message: 'm', idempotency_key: key() })));
  const cli = execFileSync(process.execPath, [path.join(here, '..', 'src', 'cli.js'), 'fork-recover', '--admin', 'm-owner', '--import', 'all', '--yes'], { env: { ...process.env, DATA_DIR: dataDir, REPO_URL: remote, INSTANCE_NAME: 'test-instance' }, encoding: 'utf8' });
  const res = JSON.parse(cli);
  assert.equal(res.via, 'server');
  assert.equal(res.result.imported.length, 1);
  await writes;
  const st = JSON.parse(execFileSync(process.execPath, [path.join(here, '..', 'src', 'cli.js'), 'status'], { env: { ...process.env, DATA_DIR: dataDir, INSTANCE_NAME: 'test-instance' }, encoding: 'utf8' }));
  assert.equal(st.result.sync.mode, 'normal');
  assert.equal(st.result.published, git(remote, 'rev-parse', 'main'));
  const after1 = await m.alice.call('write_page', { path: 'd.md', mode: 'create', content: 'd\n', message: '恢复后写入', idempotency_key: key() });
  assert.equal(after1.data.status, 'accepted');
  const ch = await m.alice.call('changes', { from: 'start', limit: 50 });
  assert.ok(ch.data.changes.every((c) => c.attribution !== 'unverified'));
  child.kill('SIGTERM'); await once(child, 'exit');
});

test('R2-4：异步准入检查不会把更强的分叉冻结降级成 pending_limit', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote, pushImpl: async () => ({ ok: false, output: 'Connection timed out' }), maxPending: 1, syncWaitMs: 100 });
  const m = await setupMembers(s.url, ['alice']);
  const repo = s.svc.ctx.repo;
  const real = repo.revList.bind(repo);
  let release; const g = new Promise((r) => { release = r; });
  let paused = false;
  repo.revList = async (a) => { if (!paused) { paused = true; await g; } return real(a); };
  const w = m.alice.call('write_page', { path: 'x.md', mode: 'create', content: 'x\n', message: 'm', idempotency_key: key() });
  await wait(() => paused);
  s.svc.ctx.sync.setMode('frozen', 'fork', { message: 'test' });
  release();
  assert.equal((await w).data.code, 'FROZEN');
  assert.equal(s.svc.ctx.sync.mode().reason, 'fork');
  repo.revList = real;
  await s.close();
});

test('R2-5：收到 non-fast-forward 后立即冻结，等待拉取诊断期间不接受写入', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote, syncWaitMs: 100, pushImpl: async () => ({ ok: false, output: '!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)' }) });
  const m = await setupMembers(s.url, ['alice']);
  const repo = s.svc.ctx.repo;
  const realFetch = repo.fetch.bind(repo);
  let release; const g = new Promise((r) => { release = r; });
  let fetching = false;
  repo.fetch = async () => { fetching = true; await g; return realFetch(); };
  const push = s.svc.ctx.sync.pushNow();
  await wait(() => fetching);
  assert.equal(s.svc.ctx.sync.mode().reason, 'fork_suspected');
  assert.equal((await m.alice.call('write_page', { path: 'y.md', mode: 'create', content: 'y\n', message: 'm', idempotency_key: key() })).data.code, 'FROZEN');
  release();
  await push;
  repo.fetch = realFetch;
  await s.close();
});

function seedRemote(files, { modes = {} } = {}) {
  const remote = makeRemote();
  const work = path.join(tmp('commons-seed-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'Seed'); git(work, 'config', 'user.email', 'seed@example.invalid');
  git(work, 'checkout', '-q', '-b', 'main');
  for (const [p, text] of Object.entries(files)) {
    const f = path.join(work, p);
    execFileSync('mkdir', ['-p', path.dirname(f)]);
    writeFileSync(f, text);
    if (modes[p]) chmodSync(f, modes[p]);
  }
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'seed'); git(work, 'push', '-q', 'origin', 'main');
  return remote;
}

test('R2-6：采纳已有仓库时整树走完整守卫（个人信息策略、页面类型、路径冲突、配置文件类型）', async () => {
  const cfg = 'version: 1\npii:\n  email: reject\npage_types:\n  r:\n    paths: ["r/*.md"]\n    entry:\n      id: { pattern: "R\\\\d+" }\n      fields: [{ name: a, required: true }]\n';
  const cases = [
    { '_commons/config.yaml': cfg, 'a.md': '联系 x@example.com\n' },
    { '_commons/config.yaml': cfg, 'r/x.md': '### R1 店\n' },
  ];
  for (const files of cases) {
    const s = await startService({ repoUrl: seedRemote(files) });
    assert.ok(s.svc.report.actions.includes('maintenance:adopt_rejected'), JSON.stringify(s.svc.report));
    await s.close();
  }
  // 只差大小写的两个文件（macOS 工作区里建不出来，用 plumbing 直接造树）
  const r3 = seedRemote({ 'x.md': 'x\n' });
  const bare = tmp('commons-bare-');
  git(bare, 'clone', '-q', '--bare', r3, `${bare}/r.git`);
  const gd = `${bare}/r.git`;
  const env = { ...process.env, GIT_DIR: gd, GIT_INDEX_FILE: `${bare}/idx`, GIT_CONFIG_GLOBAL: '/dev/null' };
  const sh = (args, input) => execFileSync('git', args, { env, input, encoding: 'utf8' }).trim();
  const blob = sh(['hash-object', '-w', '--stdin'], 'x\n');
  sh(['read-tree', 'main']);
  sh(['update-index', '--add', '--cacheinfo', `100644,${blob},Foo.md`]);
  sh(['update-index', '--add', '--cacheinfo', `100644,${blob},foo.md`]);
  const tree = sh(['write-tree']);
  const c = execFileSync('git', ['commit-tree', tree, '-p', 'main', '-m', 'case'], { env: { ...env, GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@x.invalid', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@x.invalid' }, encoding: 'utf8' }).trim();
  sh(['push', '-q', r3, `${c}:refs/heads/main`]);
  const s3 = await startService({ repoUrl: r3 });
  assert.ok(s3.svc.report.actions.includes('maintenance:adopt_rejected'), JSON.stringify(s3.svc.report));
  await s3.close();
  // 配置文件不是普通文件（可执行位）→ 拒绝采纳，而不是当作“没有配置”
  const s2 = await startService({ repoUrl: seedRemote({ '_commons/config.yaml': 'version: 1\npermissions:\n  delete: admin\n' }, { modes: { '_commons/config.yaml': 0o755 } }) });
  assert.ok(s2.svc.report.actions.includes('maintenance:adopt_rejected'), JSON.stringify(s2.svc.report));
  await s2.close();
});

test('R2-7：引用块里不带空格的标题、带反引号 info 的“伪代码围栏”都不能绕过条目校验', () => {
  const t = parseConfig('version: 1\npage_types:\n  r:\n    paths: ["r/*.md"]\n    entry:\n      id: { pattern: "R\\\\d+" }\n      fields: [{ name: a, required: true }]\n').page_types.r;
  assert.match(validateEntries('>### R1 Place\n', t, [])[0], /顶格/);
  assert.match(validateEntries('```foo`bar\n### R1 Place\n', t, [])[0], /缺少必填字段/);
  assert.deepEqual(validateEntries('```js\n### R1 不是条目\n```\n', t, []), []);
  assert.match(validateEntries('1. ### R1 X\n', t, [])[0], /顶格/);
});

test('后台远端检查在“已读出旧远端头之后”暂停，期间完成的维护处置不会被它覆盖', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await s.svc.startAdmin();
  await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: '1\n', message: 'm', idempotency_key: key() });
  const work = path.join(tmp('commons-ext-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'X'); git(work, 'config', 'user.email', 'x@example.invalid');
  writeFileSync(path.join(work, 'x.md'), 'x\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'x'); git(work, 'push', '-q', 'origin', 'main');
  s.svc.ctx.sync.setMode('frozen', 'fork', { message: 'test' });
  const repo = s.svc.ctx.repo;
  const real = repo.isAncestor.bind(repo);
  let release; const g = new Promise((r) => { release = r; });
  let paused = false;
  repo.isAncestor = async (a, b) => { if (!paused) { paused = true; await g; } return real(a, b); };
  const check = s.svc.ctx.sync.checkRemote(); // 读出外部头 E 之后，在祖先检查处暂停
  await wait(() => paused);
  repo.isAncestor = real;
  await callAdmin(socketPathFor(s.dataDir), 'fork-recover', { adminMember: 'm-owner', importShas: 'none' });
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  release();
  await check;
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  await s.close();
});
