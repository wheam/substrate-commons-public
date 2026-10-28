// P1 验收 7：超过 50 条分页不漏；过滤查询不推进已读位置；ack 不倒退、不能越过已返回位置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startService, setupMembers, key, cleanupAll } from './helpers.js';

after(cleanupAll);

test('验收 7：changes 分页、过滤与 ack', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice', 'bob']);
  const a = m.alice; const b = m.bob;
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\nrate_limits:\n  writes_per_minute_token: 1000\n  writes_per_minute_member: 1000\n  reads_per_minute_token: 5000\n', base_rev: cfg.data.blob_rev, message: '测试放宽速率', idempotency_key: key() });
  await a.call('changes_ack', { cursor: (await a.call('changes')).data.next_cursor });
  await b.call('changes_ack', { cursor: (await b.call('changes')).data.next_cursor });
  // 新 token 的已读位置 = 兑换时的已发布版本：此前的骨架提交不算未读
  assert.equal((await a.call('changes')).data.changes.length, 0);
  let blob = (await a.call('write_page', { path: 'log.md', mode: 'create', content: '0\n', message: 'c0', idempotency_key: key() })).data.blob_rev;
  for (let i = 1; i < 60; i++) {
    const who = i % 3 === 0 ? b : a;
    const path = i % 5 === 0 ? 'other/x.md' : 'log.md';
    if (path === 'other/x.md') {
      const exist = await who.call('read_page', { path });
      const r = exist.isError
        ? await who.call('write_page', { path, mode: 'create', content: `${i}\n`, message: `c${i}`, idempotency_key: key() })
        : await who.call('write_page', { path, mode: 'append', content: `${i}\n`, message: `c${i}`, idempotency_key: key() });
      assert.equal(r.data.status, 'accepted', r.text);
    } else {
      const r = await who.call('write_page', { path, mode: 'patch', edits: [{ old: `${i - 1}\n`, new: `${i}\n` }], base_rev: blob, message: `c${i}`, idempotency_key: key() });
      if (r.data.code === 'CONFLICT' || r.data.code === 'PATCH_NOT_FOUND') {
        const cur = await who.call('read_page', { path });
        const last = cur.text.split('----- 页面正文开始')[1].split('\n')[1];
        const r2 = await who.call('write_page', { path, mode: 'replace', content: `${i}\n`, base_rev: cur.data.blob_rev, message: `c${i}`, idempotency_key: key() });
        assert.equal(r2.data.status, 'accepted', `${last} ${r2.text}`);
        blob = r2.data.blob_rev;
      } else {
        assert.equal(r.data.status, 'accepted', r.text);
        blob = r.data.blob_rev;
      }
    }
  }
  // bob 从头未读：60 条，分两页
  const p1 = await b.call('changes', { limit: 50 });
  assert.equal(p1.data.changes.length, 50);
  assert.equal(p1.data.has_more, true);
  const p2 = await b.call('changes', { cursor: p1.data.next_cursor, limit: 50 });
  assert.equal(p2.data.changes.length, 10);
  assert.equal(p2.data.has_more, false);
  const msgs = [...p1.data.changes, ...p2.data.changes].map((c) => c.summary.split(': ').pop());
  assert.deepEqual(msgs, Array.from({ length: 60 }, (_, i) => `c${i}`));
  // 翻页上界固定：期间的新写入不会混进本轮
  await a.call('write_page', { path: 'late.md', mode: 'create', content: 'x\n', message: 'late', idempotency_key: key() });
  const p2again = await b.call('changes', { cursor: p1.data.next_cursor, limit: 50 });
  assert.equal(p2again.data.changes.length, 10);
  // 读取不推进已读位置
  assert.equal((await b.call('changes', { limit: 5 })).data.changes[0].summary.split(': ').pop(), 'c0');
  // 带过滤条件：只看 bob 的 / 只看 other/；不能用来 ack
  const fb = await b.call('changes', { member: 'm-bob', limit: 50 });
  assert.ok(fb.data.changes.every((c) => c.member_id === 'm-bob'));
  assert.equal(fb.data.changes.length, 19); // i = 3, 6, …, 57
  const fp = await b.call('changes', { path_prefix: 'other/', limit: 50 });
  assert.ok(fp.data.changes.every((c) => c.paths.some((p) => p.startsWith('other/'))));
  assert.equal((await b.call('changes_ack', { cursor: fb.data.next_cursor })).data.code, 'INVALID_CURSOR');
  // 翻页时过滤条件不能被替换
  assert.equal((await b.call('changes', { cursor: fb.data.next_cursor, member: 'm-alice' })).data.code, 'INVALID_ARGUMENT');
  // ack 第一页 → 再查从第 51 条开始；ack 不能越过已返回位置
  assert.equal((await b.call('changes_ack', { cursor: p1.data.next_cursor })).data.acked, p1.data.changes[49].commit_rev);
  const after1 = await b.call('changes', { limit: 50 });
  assert.equal(after1.data.changes[0].summary.split(': ').pop(), 'c50');
  // ack 不倒退：再 ack 第一页的旧 cursor 没有效果
  await b.call('changes_ack', { cursor: after1.data.next_cursor });
  const back = await b.call('changes_ack', { cursor: p1.data.next_cursor });
  assert.equal(back.data.unchanged, true);
  assert.equal((await b.call('changes')).data.changes.length, 0);
  // 篡改 cursor、用别人的 cursor 都被拒
  const forged = `${p1.data.next_cursor.slice(0, -2)}xx`;
  assert.equal((await b.call('changes_ack', { cursor: forged })).data.code, 'INVALID_CURSOR');
  assert.equal((await a.call('changes_ack', { cursor: after1.data.next_cursor })).data.code, 'INVALID_CURSOR');
  // from=start 从头
  assert.equal((await a.call('changes', { from: 'start', limit: 1 })).data.changes[0].op, 'init');
  await s.close();
});

test('page_history 跟随改名；show_change 截断提示；request_status', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const a = m.alice;
  const c = await a.call('write_page', { path: 'old.md', mode: 'create', content: `${'长内容\n'.repeat(4000)}`, message: '新建', idempotency_key: key() });
  const mv = await a.call('move_page', { from: 'old.md', to: 'new/name.md', base_rev: c.data.blob_rev, message: '改名', idempotency_key: key() });
  assert.equal(mv.data.status, 'accepted', mv.text);
  const r = await a.call('read_page', { path: 'new/name.md' });
  await a.call('write_page', { path: 'new/name.md', mode: 'append', content: '尾巴\n', base_rev: r.data.blob_rev, message: '追加', idempotency_key: key() });
  const h = await a.call('page_history', { path: 'new/name.md' });
  assert.deepEqual(h.data.history.map((x) => x.op), ['append', 'move', 'create']);
  const h1 = await a.call('page_history', { path: 'new/name.md', limit: 1 });
  assert.equal(h1.data.has_more, true);
  const h2 = await a.call('page_history', { path: 'new/name.md', limit: 1, cursor: h1.data.next_cursor });
  assert.equal(h2.data.history[0].op, 'move');
  const sc = await a.call('show_change', { commit_rev: c.data.commit_rev, max_bytes: 3000 });
  assert.equal(sc.data.truncated, true);
  assert.ok(sc.data.truncated_hint);
  const rs = await a.call('request_status', { request_id: c.data.request_id });
  assert.equal(rs.data.commit_rev, c.data.commit_rev);
  assert.equal(rs.data.sync, 'local_only');
  assert.equal((await a.call('request_status', { request_id: 'r-nope' })).data.code, 'NOT_FOUND');
  // 读历史版本
  const old = await a.call('read_page', { path: 'old.md', commit_rev: c.data.commit_rev });
  assert.equal(old.data.blob_rev, c.data.blob_rev);
  await s.close();
});
