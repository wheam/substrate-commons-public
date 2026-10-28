// Codex 实现评审第三轮的回归测试（R3-1 至 R3-4，以及恢复备份用的 RESTORE_NONCE）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService, setupMembers, connect, enroll, key, cleanupAll, makeRemote, git, tmp, BOOT_CODE } from './helpers.js';
import { runningServer, startAdminSocket, pidFileFor, socketPathFor } from '../src/admin-socket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
after(cleanupAll);
const mcpStatus = async (url, token) => (await fetch(`${url}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
})).status;
const wait = async (cond, ms = 5000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 25)); } };
const chainEpochs = (remote) => git(remote, 'log', '--first-parent', '--format=%H', 'refs/commons/auth-watermark').split('\n').filter(Boolean)
  .map((c) => Number(git(remote, 'show', `${c}:epoch`).split(' ')[1]));

for (const variant of ['已用过的码', '新的码']) {
  test(`R3-1：恢复旧快照 + 远端暂时读不到 + BOOTSTRAP_FORCE（${variant}）→ 不会在核实前改动代数，核实后进入维护`, async () => {
    const remote = makeRemote();
    const dataDir = tmp('commons-r31-');
    const forceCode = `sbe_${'f6'.repeat(16)}`;
    const s = await startService({ dataDir, repoUrl: remote });
    const m = await setupMembers(s.url, ['alice', 'bob']);
    if (variant === '已用过的码') {
      await s.close();
      const sf = await startService({ dataDir, repoUrl: remote, bootstrap: { code: forceCode, force: true, member: 'm-owner', name: 'Owner' } });
      assert.equal((await enroll(sf.url, forceCode)).status, 200);
      await sf.close();
    } else await s.close();
    const backup = tmp('commons-r31-bak-');
    cpSync(dataDir, backup, { recursive: true });
    const s1 = await startService({ dataDir, repoUrl: remote });
    const bob = await connect(s1.url, m.bobToken);
    await bob.call('token_revoke', { token_id: (await bob.call('my_tokens')).data.tokens[0].token_id });
    await s1.close();
    rmSync(dataDir, { recursive: true, force: true });
    cpSync(backup, dataDir, { recursive: true });
    renameSync(remote, `${remote}.away`);
    const code = variant === '已用过的码' ? forceCode : `sbe_${'a7'.repeat(16)}`;
    const s2 = await startService({ dataDir, repoUrl: remote, gateRetryMs: 100, bootstrap: { code, force: true, member: 'm-owner', name: 'Owner' } });
    const epochBefore = s2.svc.ctx.members.authEpoch();
    assert.equal(s2.svc.gate.open, false);
    assert.equal(await mcpStatus(s2.url, m.bobToken), 503);
    renameSync(`${remote}.away`, remote);
    await wait(() => s2.svc.gate.open);
    assert.equal(s2.svc.ctx.sync.mode().reason, 'auth_stale');
    assert.equal(await mcpStatus(s2.url, m.bobToken), 503);
    assert.ok(s2.svc.ctx.members.authEpoch() > epochBefore);
    assert.ok(!s2.svc.report.actions.includes('bootstrap_force_registered'));
    await s2.close();
  });
}

test('R3-2：回滚后补推见证时，远端链上的代数严格递增，不会出现更小的代数', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-r32-');
  const s = await startService({ dataDir, repoUrl: remote });
  await setupMembers(s.url, ['alice']);
  const backup = tmp('commons-r32-bak-');
  await s.close();
  cpSync(dataDir, backup, { recursive: true });
  const s1 = await startService({ dataDir, repoUrl: remote });
  for (let i = 0; i < 5; i++) s1.svc.ctx.members.createMember({ member_id: `m-x${i}`, display_name: `X${i}` });
  await s1.svc.ctx.watermark.flush();
  await s1.close();
  const high = Math.max(...chainEpochs(remote));
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(backup, dataDir, { recursive: true });
  const s2 = await startService({ dataDir, repoUrl: remote });
  assert.equal(s2.svc.ctx.sync.mode().reason, 'auth_stale');
  await s2.svc.ctx.watermark.flush();
  const epochs = chainEpochs(remote);
  assert.ok(epochs[0] > high, JSON.stringify(epochs)); // 新的链头高于回滚前见过的最大值
  for (let i = 0; i + 1 < epochs.length; i++) assert.ok(epochs[i] > epochs[i + 1], `链上代数必须严格递增：${JSON.stringify(epochs)}`);
  await s2.close();
});

test('R3-3：服务进程活着但维护通道不在时，CLI 拒绝直接操作；通道建不起来时服务启动失败', async () => {
  const dataDir = tmp('commons-r33-');
  mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  writeFileSync(pidFileFor(dataDir), JSON.stringify({ pid: process.pid, socket: path.join(dataDir, 'state', 'gone.sock'), at: Date.now() }));
  assert.throws(() => runningServer(dataDir), /拒绝直接操作/);
  let failed = false;
  try { execFileSync(process.execPath, [path.join(here, '..', 'src', 'cli.js'), 'enter-maintenance', '--yes'], { env: { ...process.env, DATA_DIR: dataDir, INSTANCE_NAME: 'test-instance' }, stdio: 'pipe' }); } catch (e) { failed = true; assert.match(String(e.stderr), /拒绝直接操作/); }
  assert.ok(failed);
  // 进程已不在 → 视为服务没在运行
  writeFileSync(pidFileFor(dataDir), JSON.stringify({ pid: 999999, socket: '/nonexistent.sock', at: Date.now() }));
  assert.equal(runningServer(dataDir), null);
  // socket 路径被占（是个目录）→ 建通道失败，不写 pid 文件
  const d2 = tmp('commons-r33b-');
  mkdirSync(path.join(d2, 'state'), { recursive: true });
  mkdirSync(socketPathFor(d2), { recursive: true });
  writeFileSync(path.join(socketPathFor(d2), 'x'), 'x');
  await assert.rejects(startAdminSocket({ dataDir: d2, handlers: {} }));
  assert.equal(runningServer(d2), null);
});

test('R3-4：配置路径是目录时按损坏处理——不会退回默认权限；采纳时拒绝', async () => {
  const remote = makeRemote();
  const work = path.join(tmp('commons-seed-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'S'); git(work, 'config', 'user.email', 's@x.invalid'); git(work, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(work, '_commons', 'config.yaml'), { recursive: true });
  writeFileSync(path.join(work, '_commons', 'config.yaml', 'saved.yaml'), 'version: 1\npermissions:\n  delete: admin\n');
  writeFileSync(path.join(work, 'trip.md'), 'x\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'seed'); git(work, 'push', '-q', 'origin', 'main');
  const s = await startService({ repoUrl: remote });
  assert.ok(s.svc.report.actions.includes('maintenance:adopt_rejected'), JSON.stringify(s.svc.report));
  const commit = git(remote, 'rev-parse', 'main');
  const cfg = await s.svc.ctx.content.config(commit);
  assert.ok(cfg.invalid);
  await s.close();
});

test('RESTORE_NONCE：以维护模式启动并作废全部凭据；同一个值只生效一次', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-nonce-');
  const s = await startService({ dataDir, repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  await s.close();
  const nonce = 'restore-2025-01-16-a';
  const s1 = await startService({ dataDir, repoUrl: remote, bootstrap: { code: BOOT_CODE, member: 'm-owner', name: 'Owner', restoreNonce: nonce } });
  assert.ok(s1.svc.report.actions.includes('maintenance:restore'), JSON.stringify(s1.svc.report));
  assert.equal(await mcpStatus(s1.url, m.aliceToken), 503);
  await s1.close();
  const { openContext, resolveMaintenance } = await import('../src/maintenance.js');
  const ctx = openContext({ dataDir, repoUrl: remote, slug: 'test-instance', displayName: '测试实例' });
  await resolveMaintenance(ctx, { bootstrapCode: `sbe_${'b8'.repeat(16)}` });
  await ctx.close();
  const s2 = await startService({ dataDir, repoUrl: remote, bootstrap: { code: BOOT_CODE, member: 'm-owner', name: 'Owner', restoreNonce: nonce } });
  assert.ok(!s2.svc.report.actions.some((a) => a.startsWith('maintenance')), JSON.stringify(s2.svc.report));
  assert.equal(await mcpStatus(s2.url, m.aliceToken), 401); // 旧凭据已作废
  assert.equal((await enroll(s2.url, `sbe_${'b8'.repeat(16)}`)).status, 200);
  await s2.close();
});

test('R4-1：经维护通道恢复后，若见证核实暂时失败，会自动重试并在网络恢复后开放', async () => {
  const remote = makeRemote();
  const dataDir = tmp('commons-r41-');
  const s = await startService({ dataDir, repoUrl: remote, gateRetryMs: 100 });
  await setupMembers(s.url, ['alice']);
  await s.svc.startAdmin();
  const { callAdmin } = await import('../src/admin-socket.js');
  await callAdmin(socketPathFor(dataDir), 'enter-maintenance', { reason: 'test' });
  // 恢复本身成功，紧接着的见证核实遇到一次临时故障
  const wm = s.svc.ctx.watermark;
  const realVerify = wm.verify;
  let failures = 1;
  wm.verify = async () => { if (failures-- > 0) return { ok: false, retry: '模拟网络故障' }; return realVerify(); };
  await callAdmin(socketPathFor(dataDir), 'resolve-maintenance', { bootstrapCode: `sbe_${'c9'.repeat(16)}` });
  assert.equal(s.svc.ctx.sync.mode().mode, 'normal');
  assert.equal(s.svc.gate.open, false);
  await wait(() => s.svc.gate.open); // 自动重试后开放
  wm.verify = realVerify;
  assert.equal((await enroll(s.url, `sbe_${'c9'.repeat(16)}`)).status, 200);
  await s.close();
});
