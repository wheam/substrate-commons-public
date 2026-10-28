// Codex 实现评审第一轮的回归测试（#2 性能、#8 事务、#10 幂等、#15 并发 ack、#6 损坏配置 fail-closed、#17 配置类型）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { startService, setupMembers, key, cleanupAll, tmp, gitEnv } from './helpers.js';
import { openDb } from '../src/db.js';
import { parseConfig } from '../src/instance-config.js';

after(cleanupAll);

test('#10 被拒绝的写入也记入幂等：同键同参数重放原拒绝，同键不同参数报冲突；状态类拒绝不占用键', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice', 'bob']);
  const k = key();
  const args = { path: 'later.md', mode: 'append', content: 'x\n', message: '追加', idempotency_key: k };
  assert.equal((await m.alice.call('write_page', args)).data.code, 'NOT_FOUND');
  await m.bob.call('write_page', { path: 'later.md', mode: 'create', content: 'base\n', message: '新建', idempotency_key: key() });
  const replay = await m.alice.call('write_page', args);
  assert.equal(replay.data.code, 'NOT_FOUND');
  assert.equal(replay.data.details.replayed, true);
  assert.equal((await m.alice.call('write_page', { ...args, content: 'y\n' })).data.code, 'IDEMPOTENCY_MISMATCH');
  // 不同 token 的同一个键互不影响
  assert.equal((await m.bob.call('write_page', args)).data.status, 'accepted');
  // 7 天后同一个键视为新请求
  s.svc.ctx.db.run('UPDATE idempotency SET created_at = ? WHERE idem_key = ?', Date.now() - 8 * 86_400_000, k);
  assert.equal((await m.alice.call('write_page', args)).data.status, 'accepted');
  // 冻结导致的拒绝不占用键：解冻后同一个键可以成功
  const k2 = key();
  s.svc.ctx.sync.setMode('frozen', 'push_rejected', { message: 'test' });
  assert.equal((await m.alice.call('write_page', { path: 'n.md', mode: 'create', content: 'n\n', message: 'm', idempotency_key: k2 })).data.code, 'FROZEN');
  s.svc.ctx.sync.setMode('normal', 'test');
  assert.equal((await m.alice.call('write_page', { path: 'n.md', mode: 'create', content: 'n\n', message: 'm', idempotency_key: k2 })).data.status, 'accepted');
  await s.close();
});

test('#15 并发 changes_ack 不会让已读位置倒退', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const a = m.alice;
  for (let i = 0; i < 3; i++) await a.call('write_page', { path: `p${i}.md`, mode: 'create', content: `${i}\n`, message: `c${i}`, idempotency_key: key() });
  const p1 = await a.call('changes', { limit: 1 });
  const all = await a.call('changes', { limit: 50 });
  // 让“较早位置”的 ack 在祖先检查上卡住，期间“较新位置”的 ack 先完成
  const repo = s.svc.ctx.repo;
  const real = repo.isAncestor.bind(repo);
  let gate; const gated = new Promise((r) => { gate = r; });
  let first = true;
  repo.isAncestor = async (x, y) => {
    if (first && x === p1.data.changes[0].commit_rev) { first = false; await gated; }
    return real(x, y);
  };
  const slow = a.call('changes_ack', { cursor: p1.data.next_cursor });
  await new Promise((r) => setTimeout(r, 50));
  const fast = await a.call('changes_ack', { cursor: all.data.next_cursor });
  assert.equal(fast.data.acked, all.data.changes.at(-1).commit_rev);
  gate();
  await slow;
  repo.isAncestor = real;
  assert.equal(s.svc.ctx.members.getAck(m.alice.tokenId ?? (await a.call('whoami')).data.token.token_id), all.data.changes.at(-1).commit_rev);
  assert.equal((await a.call('changes')).data.changes.length, 0);
  await s.close();
});

test('#6 配置损坏时写入 fail-closed（读照常），admin 可以用 update_config 修好', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  // 模拟配置被损坏（白盒：直接改 git 对象并推进已发布指针）
  const inst = s.svc.ctx.repo.dir;
  const parent = s.svc.ctx.engine.published();
  const blob = execFileSync('git', ['--git-dir', inst, 'hash-object', '-w', '--stdin'], { input: 'version: [broken\n', encoding: 'utf8', env: gitEnv }).trim();
  const idx = `${inst}/t-index`; const env = { ...gitEnv, GIT_INDEX_FILE: idx };
  execFileSync('git', ['--git-dir', inst, 'read-tree', parent], { env });
  execFileSync('git', ['--git-dir', inst, 'update-index', '--cacheinfo', `100644,${blob},_commons/config.yaml`], { env });
  const tree = execFileSync('git', ['--git-dir', inst, 'write-tree'], { env, encoding: 'utf8' }).trim();
  rmSync(idx, { force: true });
  const commit = execFileSync('git', ['--git-dir', inst, 'commit-tree', tree, '-p', parent, '-m', 'broken'], { env: { ...gitEnv, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.invalid' }, encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', inst, 'update-ref', 'refs/heads/main', commit, parent], { env: gitEnv });
  s.svc.ctx.db.meta.set('published_commit', commit);
  assert.equal((await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: 'a\n', message: 'm', idempotency_key: key() })).data.code, 'CONFIG_INVALID');
  assert.equal((await m.alice.call('list_pages')).isError, false);
  const cur = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  const fix = await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\n', base_rev: cur.data.blob_rev, message: '修好配置', idempotency_key: key() });
  assert.equal(fix.data.status, 'accepted', fix.text);
  assert.equal((await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: 'a\n', message: 'm', idempotency_key: key() })).data.status, 'accepted');
  await s.close();
});

test('#8 BEGIN 失败后事务深度复位，下一次事务仍然原子', () => {
  const db = openDb(`${tmp('commons-db-')}/x.db`);
  const realExec = db.raw.exec.bind(db.raw);
  let failOnce = true;
  db.raw.exec = (sql) => { if (failOnce && sql === 'BEGIN IMMEDIATE') { failOnce = false; throw new Error('SQLITE_BUSY'); } return realExec(sql); };
  assert.throws(() => db.tx(() => {}), /SQLITE_BUSY/);
  assert.equal(db.inTx(), false);
  assert.throws(() => db.tx(() => { db.meta.set('k', 'v'); throw new Error('boom'); }), /boom/);
  assert.equal(db.meta.get('k'), null); // 已回滚
  db.close();
});

test('#2 最大合法页面的对抗性输入不会卡住服务（经完整写入路径）', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\nrate_limits:\n  writes_per_minute_token: 1000\n  writes_per_minute_member: 1000\npage_types:\n  r:\n    paths: ["r/*.md"]\n    entry:\n      id: { pattern: "R\\\\d+" }\n      fields: [{ name: a, required: true }]\n', base_rev: cfg.data.blob_rev, message: 'perf', idempotency_key: key() });
  const N = 250_000;
  const inputs = ['a'.repeat(N), 'a@'.repeat(N / 2), '1'.repeat(N), '](a'.repeat(N / 3), `# ${' #'.repeat(N / 2 - 2)}x`, `password: ${'a'.repeat(N - 20)}`, ' '.repeat(N)];
  const t0 = Date.now();
  let i = 0;
  for (const text of inputs) {
    for (const p of [`free${i}.md`, `r/s${i}.md`]) {
      const r = await m.alice.call('write_page', { path: p, mode: 'create', content: text, message: 'perf', idempotency_key: key() });
      assert.ok(r.data.status === 'accepted' || r.data.code, r.text.slice(0, 200));
    }
    i++;
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 15_000, `14 次 250KB 对抗写入耗时 ${ms}ms`);
  await s.close();
});

test('#17 #18 配置字段类型严格、glob 不误匹配、条目标题只能是 ### / ####', () => {
  const base = (fields, extra = '') => `version: 1\npage_types:\n  r:\n    paths: ["**/x.md"]\n    entry:\n${extra}      id: { pattern: "R\\\\d+" }\n      fields: ${fields}\n`;
  assert.throws(() => parseConfig(base('[{ name: a, required: "true" }]')), /required 必须是 true \/ false/);
  assert.throws(() => parseConfig(base('[{ name: a }, { name: " a " }]')), /字段名重复/);
  assert.throws(() => parseConfig(base('[{ name: a }]', '      heading: "##"\n')), /### 或 ####/);
  const re = parseConfig(base('[{ name: a }]')).page_types.r.pathRes[0];
  assert.deepEqual(['x.md', 'a/x.md', 'a/b/x.md', 'ax.md', 'a/bx.md'].map((p) => re.test(p)), [true, true, true, false, false]);
});
