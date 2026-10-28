// P1 验收 5（每个事务节点杀进程后重启恢复：不重复提交、无缺归属的服务提交、同键重试拿原结果）
// 与 6（重启后同步状态、账本、已读位置恢复；先恢复再开放服务）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, makeRemote, git, enroll, connect, BOOT_CODE, cleanupAll } from './helpers.js';

const children = new Set();
after(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } } cleanupAll(); });
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'child-server.mjs');

async function spawnServer(env) {
  const child = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  // 等待启动握手和退出事件期间保留事件循环引用；否则 Node 22 会在
  // 首条 stdout 消息到达前取消仍在等待的测试。after 钩子负责清理子进程。
  let buf = '';
  const info = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on('exit', (code) => reject(new Error(`子进程提前退出 ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${info.port}`, report: info.report };
}
const exited = (child) => (child.exitCode != null || child.signalCode != null ? Promise.resolve() : once(child, 'exit'));
const stop = async (c) => { if (c.child.exitCode == null && c.child.signalCode == null) { c.child.kill('SIGTERM'); await once(c.child, 'exit'); } };

async function setup(dataDir, remote) {
  const s = await spawnServer({ DATA_DIR: dataDir, REPO_URL: remote });
  const boot = await enroll(s.url, BOOT_CODE);
  const admin = await connect(s.url, boot.body.token);
  await admin.call('member_create', { member_id: 'm-alice', display_name: 'Alice' });
  const inv = await admin.call('invite_create', { member_id: 'm-alice', client_label: 'alice-cc' });
  const token = (await enroll(s.url, inv.data.code)).body.token;
  const alice = await connect(s.url, token);
  const c = await alice.call('write_page', { path: 'p.md', mode: 'create', content: 'base\n', message: '新建', idempotency_key: 'setup-create-0001' });
  assert.equal(c.data.status, 'accepted');
  const ch = await alice.call('changes');
  await alice.call('changes_ack', { cursor: ch.data.next_cursor });
  await alice.close(); await admin.close();
  await stop(s);
  return { token };
}

function serviceCommits(dataDir) {
  const repo = path.join(dataDir, 'instance.git');
  return git(repo, 'log', '--format=%H', '-E', '--grep=^Commons-Request: r-', 'main').split('\n').filter(Boolean);
}

for (const point of ['after_intent', 'after_ref', 'in_finalize', 'after_db', 'after_response']) {
  test(`验收 5 / 6：在 ${point} 杀进程，重启恢复后状态一致`, async () => {
    const dataDir = tmp('commons-crash-');
    const remote = makeRemote();
    const { token } = await setup(dataDir, remote);
    const s1 = await spawnServer({ DATA_DIR: dataDir, REPO_URL: remote, FAULT: point });
    const alice1 = await connect(s1.url, token);
    const args = { path: 'p.md', mode: 'append', content: `crash-${point}\n`, message: `崩溃测试 ${point}`, idempotency_key: `crash-key-${point}` };
    let first = null;
    try { first = await alice1.call('write_page', args); } catch { /* 进程被杀，连接断开 */ }
    await exited(s1.child);
    assert.equal(s1.child.signalCode, 'SIGKILL', `${point} 应该杀掉进程`);
    if (point === 'after_response') assert.equal(first?.data?.status, 'accepted');
    // 重启：先恢复再开放服务
    const s2 = await spawnServer({ DATA_DIR: dataDir, REPO_URL: remote });
    if (point === 'after_ref' || point === 'in_finalize') assert.ok(s2.report.actions.some((a) => a.startsWith('recovered:1')), JSON.stringify(s2.report));
    if (point === 'after_intent') assert.ok(s2.report.actions.some((a) => a.includes('failed:1')), JSON.stringify(s2.report));
    const alice2 = await connect(s2.url, token);
    const retry = await alice2.call('write_page', args);
    assert.equal(retry.data.status, 'accepted', retry.text);
    if (point === 'after_intent') assert.ok(!retry.data.replayed); else assert.equal(retry.data.replayed, true);
    // 不重复：内容只出现一次，提交只有一个
    const r = await alice2.call('read_page', { path: 'p.md' });
    assert.equal(r.text.split(`crash-${point}`).length - 1, 1);
    const repo = path.join(dataDir, 'instance.git');
    assert.equal(git(repo, 'log', '--format=%H', `--grep=崩溃测试 ${point}`, 'main').split('\n').filter(Boolean).length, 1);
    // 没有缺少认证归属的服务提交
    const ch = await alice2.call('changes', { from: 'start', limit: 50 });
    assert.ok(ch.data.changes.every((c) => c.attribution === 'service_authenticated'), JSON.stringify(ch.data.changes.map((c) => c.attribution)));
    const all = git(path.join(dataDir, 'instance.git'), 'rev-list', 'main').split('\n').filter(Boolean);
    assert.equal(serviceCommits(dataDir).length, all.length);
    assert.equal(ch.data.changes.length, all.length);
    // 验收 6：已读位置在重启后保留（setup 里 ack 过，之后只有这一次写入）
    const unread = await alice2.call('changes');
    assert.equal(unread.data.changes.length, 1);
    assert.equal(unread.data.changes[0].commit_rev, retry.data.commit_rev);
    // 同步状态恢复：后台补推后远端与已发布版本一致
    for (let i = 0; i < 50 && git(remote, 'rev-parse', 'main') !== retry.data.commit_rev; i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(git(remote, 'rev-parse', 'main'), retry.data.commit_rev);
    assert.equal((await alice2.call('request_status', { request_id: retry.data.request_id })).data.sync, 'synced');
    await alice2.close();
    await stop(s2);
  });
}

for (const point of ['after_ref', 'in_finalize']) {
  test(`首次初始化在 ${point} 被杀：重启后补完骨架与 bootstrap，不会卡在半初始化状态`, async () => {
    const dataDir = tmp('commons-initcrash-');
    const remote = makeRemote();
    await assert.rejects(spawnServer({ DATA_DIR: dataDir, REPO_URL: remote, FAULT: point }), /提前退出/);
    const s = await spawnServer({ DATA_DIR: dataDir, REPO_URL: remote });
    assert.ok(s.report.actions.includes('resume_init'), JSON.stringify(s.report));
    assert.ok(s.report.actions.includes('bootstrap_registered'), JSON.stringify(s.report));
    const boot = await enroll(s.url, BOOT_CODE);
    assert.equal(boot.status, 200);
    const admin = await connect(s.url, boot.body.token);
    const pages = await admin.call('list_pages');
    assert.deepEqual(pages.data.pages.map((p) => p.path).sort(), ['README.md', '_commons/config.yaml', '_commons/conventions.md']);
    const ch = await admin.call('changes', { from: 'start' });
    assert.equal(ch.data.changes.length, 1); // 骨架提交只有一个，且已认证
    assert.equal(ch.data.changes[0].attribution, 'service_authenticated');
    await admin.close();
    await stop(s);
  });
}
