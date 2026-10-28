// P2 验收：revert 的全部限制、move / delete、update_config；失败时 HEAD 与已发布版本没有部分变化。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startService, setupMembers, key, cleanupAll, makeRemote, git, gitEnv, tmp } from './helpers.js';

after(cleanupAll);

test('revert：干净撤回、三方合并、冲突拒绝、只收服务认证的内容提交', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice', 'bob']);
  const { alice: a, bob: b, admin } = m;
  const c = await a.call('write_page', { path: 'r.md', mode: 'create', content: 'L1\nL2\nL3\nL4\nL5\n', message: '新建', idempotency_key: key() });
  const p1 = await b.call('write_page', { path: 'r.md', mode: 'patch', edits: [{ old: 'L2', new: 'L2-bob' }], base_rev: c.data.blob_rev, message: 'bob 改第二行', idempotency_key: key() });
  const p2 = await a.call('write_page', { path: 'r.md', mode: 'patch', edits: [{ old: 'L5', new: 'L5-alice' }], base_rev: p1.data.blob_rev, message: 'alice 改第五行', idempotency_key: key() });
  // 撤回 bob 的修改（之后 alice 改了不相干的行）→ 三方合并成功
  const rv = await a.call('revert_change', { commit_rev: p1.data.commit_rev, message: '撤回 bob 的第二行修改', idempotency_key: key() });
  assert.equal(rv.data.status, 'accepted', rv.text);
  const r = await a.call('read_page', { path: 'r.md' });
  assert.match(r.text, /L1\nL2\nL3\nL4\nL5-alice\n/);
  const hist = await a.call('page_history', { path: 'r.md', limit: 1 });
  assert.equal(hist.data.history[0].reverts, p1.data.commit_rev);
  assert.equal(hist.data.history[0].member_id, 'm-alice');
  // 再撤回同一个 → NO_CHANGE
  assert.equal((await a.call('revert_change', { commit_rev: p1.data.commit_rev, message: 'again', idempotency_key: key() })).data.code, 'NO_CHANGE');
  // 冲突：撤回 alice 第五行修改之前，有人又改了同一行
  await b.call('write_page', { path: 'r.md', mode: 'patch', edits: [{ old: 'L5-alice', new: 'L5-bob' }], base_rev: (await b.call('read_page', { path: 'r.md' })).data.blob_rev, message: '再改', idempotency_key: key() });
  const before = s.svc.ctx.engine.published();
  assert.equal((await a.call('revert_change', { commit_rev: p2.data.commit_rev, message: 'x', idempotency_key: key() })).data.code, 'CONFLICT');
  assert.equal(s.svc.ctx.engine.published(), before);
  // 普通成员撤回 admin 的配置提交 → 失败
  const cfg = await admin.call('read_page', { path: '_commons/config.yaml' });
  const u = await admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\ndisplay_name: 改名\n', base_rev: cfg.data.blob_rev, message: '改显示名', idempotency_key: key() });
  assert.equal((await a.call('revert_change', { commit_rev: u.data.commit_rev, message: 'x', idempotency_key: key() })).data.code, 'FORBIDDEN');
  // 初始化提交、不存在的提交、短 SHA
  const init = (await a.call('changes', { from: 'start', limit: 1 })).data.changes[0].commit_rev;
  assert.equal((await a.call('revert_change', { commit_rev: init, message: 'x', idempotency_key: key() })).data.code, 'INVALID_ARGUMENT');
  assert.equal((await a.call('revert_change', { commit_rev: '0'.repeat(40), message: 'x', idempotency_key: key() })).data.code, 'NOT_FOUND');
  assert.equal(s.svc.ctx.engine.published(), u.data.commit_rev);
  // 撤回“新建” = 删除（页面未被后续修改时）；撤回删除 = 恢复
  const n = await a.call('write_page', { path: 'tmp.md', mode: 'create', content: 'x\n', message: '新建临时页', idempotency_key: key() });
  const rd = await b.call('revert_change', { commit_rev: n.data.commit_rev, message: '撤回新建', idempotency_key: key() });
  assert.equal(rd.data.blob_revs['tmp.md'], null);
  const rr = await b.call('revert_change', { commit_rev: rd.data.commit_rev, message: '撤回删除', idempotency_key: key() });
  assert.equal(rr.data.status, 'accepted');
  assert.equal((await a.call('read_page', { path: 'tmp.md' })).data.blob_rev, n.data.blob_rev);
  await s.close();
});

// 白盒辅助：模拟“旧规则下已经被服务接受”的提交（直接写 git 对象并补账本），用来验证 revert 对最终内容的再校验。
function forgeServiceCommit(svc, { path: p, mode = '100644', content = '', objectSha = null }) {
  const inst = `${svc.ctx.repo.dir}`;
  const g = (...a) => git(inst, '--git-dir', inst, ...a);
  const parent = svc.ctx.engine.published();
  const sha = objectSha ?? execFileSync('git', ['--git-dir', inst, 'hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8', env: gitEnv }).trim();
  const idx = `${inst}/forge-index`;
  const env = { ...gitEnv, GIT_INDEX_FILE: idx };
  execFileSync('git', ['--git-dir', inst, 'read-tree', parent], { env });
  execFileSync('git', ['--git-dir', inst, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${p}`], { env });
  const tree = execFileSync('git', ['--git-dir', inst, 'write-tree'], { env, encoding: 'utf8' }).trim();
  rmSync(idx, { force: true });
  const commit = execFileSync('git', ['--git-dir', inst, 'commit-tree', tree, '-p', parent, '-m', `[create] ${p}: forged\n\nforged\n\nCommons-Member: m-alice\nCommons-Token: t-forged\nCommons-Op: create\nCommons-Request: r-forged-${Date.now()}`],
    { env: { ...gitEnv, GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'm-alice@x.invalid', GIT_COMMITTER_NAME: 'substrate-commons', GIT_COMMITTER_EMAIL: 'bot@x.invalid' }, encoding: 'utf8' }).trim();
  g('update-ref', 'refs/heads/main', commit, parent);
  const db = svc.ctx.db;
  db.tx(() => {
    const seq = (db.get('SELECT MAX(seq) AS s FROM ledger').s ?? 0) + 1;
    db.run("INSERT INTO ledger(commit_sha, seq, parent, member_id, token_id, client_label, request_id, op, paths, attribution, created_at) VALUES (?,?,?,?,?,?,?,?,?,'service_authenticated',?)",
      commit, seq, parent, 'm-alice', 't-forged', 'alice-claude-code', `r-forged-${seq}`, 'create', JSON.stringify([p]), Date.now());
    db.meta.set('published_commit', commit);
  });
  return commit;
}

test('revert 恢复出旧凭据、超限内容或非普通文件时失败，且 HEAD 与已发布版本没有部分变化', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  const a = m.alice;
  // 旧规则下被接受、含凭据的页面 → 删除 → 撤回删除会恢复出凭据 → 拒绝
  forgeServiceCommit(s.svc, { path: 'leak.md', content: `旧页面 sbk_${'cd'.repeat(24)}\n` });
  const leak = await a.call('read_page', { path: 'leak.md' });
  const del = await a.call('delete_page', { path: 'leak.md', base_rev: leak.data.blob_rev, message: '删除误存的凭据', idempotency_key: key() });
  assert.equal(del.data.status, 'accepted', del.text);
  const head = s.svc.ctx.engine.published();
  assert.equal((await a.call('revert_change', { commit_rev: del.data.commit_rev, message: '撤回', idempotency_key: key() })).data.code, 'CREDENTIAL_DETECTED');
  assert.equal(s.svc.ctx.engine.published(), head);
  assert.equal(git(`${s.dataDir}/instance.git`, '--git-dir', `${s.dataDir}/instance.git`, 'rev-parse', 'main'), head);
  // 超限：大页被缩小后，管理员调低上限，再撤回“缩小” → 拒绝
  const big = await a.call('write_page', { path: 'big.md', mode: 'create', content: `${'x'.repeat(5000)}\n`, message: '大页', idempotency_key: key() });
  const small = await a.call('write_page', { path: 'big.md', mode: 'replace', content: 'small\n', base_rev: big.data.blob_rev, message: '缩小', idempotency_key: key() });
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\nlimits:\n  page_max_bytes: 1000\n', base_rev: cfg.data.blob_rev, message: '调低单页上限', idempotency_key: key() });
  const head2 = s.svc.ctx.engine.published();
  assert.equal((await a.call('revert_change', { commit_rev: small.data.commit_rev, message: '撤回缩小', idempotency_key: key() })).data.code, 'TOO_LARGE');
  assert.equal(s.svc.ctx.engine.published(), head2);
  // 非普通文件：符号链接、gitlink、可执行位的服务提交都不能撤回，且读面看不到它们
  for (const [mode, extra] of [['120000', { content: 'target.md' }], ['160000', { objectSha: head2 }], ['100755', { content: '#!/bin/sh\n' }]]) {
    const c = forgeServiceCommit(s.svc, { path: `weird-${mode}.md`, mode, ...extra });
    assert.equal((await a.call('read_page', { path: `weird-${mode}.md` })).data.code, 'NOT_FOUND');
    const before = s.svc.ctx.engine.published();
    const r = await a.call('revert_change', { commit_rev: c, message: '撤回', idempotency_key: key() });
    assert.equal(r.data.code, 'INVALID_CONTENT', `${mode} ${r.text}`);
    assert.equal(s.svc.ctx.engine.published(), before);
  }
  await s.close();
});

test('不在账本里的普通提交不能 revert（走到账本检查，而不是父提交检查）；含凭据的已有仓库不会被采纳', async () => {
  const remote = makeRemote();
  const work = path.join(tmp('commons-seed-'), 'w');
  git(path.dirname(work), 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'Seed'); git(work, 'config', 'user.email', 'seed@example.invalid');
  git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(work, 'a.md'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'seed 1');
  writeFileSync(path.join(work, 'a.md'), 'two\n'); git(work, 'commit', '-qam', 'seed 2');
  writeFileSync(path.join(work, '.private.md'), 'hidden secret text\n');
  symlinkSync('a.md', path.join(work, 'link.md'));
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'seed 3 hidden');
  git(work, 'push', '-q', 'origin', 'main');
  const s = await startService({ repoUrl: remote });
  assert.ok(s.svc.report.warnings?.[0]?.includes('不在内容策略内'), JSON.stringify(s.svc.report));
  const m = await setupMembers(s.url, ['alice']);
  const seed2 = git(work, 'rev-parse', 'HEAD~1');
  const r = await m.alice.call('revert_change', { commit_rev: seed2, message: 'x', idempotency_key: key() });
  assert.equal(r.data.code, 'FORBIDDEN');
  assert.match(r.data.message, /service_authenticated/);
  // show_change 不带 path：隐藏文件和链接不出现在 diff 里
  const sc = await m.alice.call('show_change', { commit_rev: git(work, 'rev-parse', 'HEAD') });
  assert.ok(!sc.text.includes('hidden secret text'));
  assert.ok(!sc.text.includes('.private.md'));
  assert.equal(sc.data.hidden_files, 2);
  const ch = await m.alice.call('changes', { from: 'start', limit: 50 });
  assert.ok(ch.data.changes.every((c) => !c.paths.some((p) => p.includes('private') || p === 'link.md')));
  await s.close();
  // 已有仓库里有凭据 → 拒绝采纳（维护模式），不会发布
  const remote2 = makeRemote();
  const work2 = path.join(tmp('commons-seed-'), 'w');
  git(path.dirname(work2), 'clone', '-q', remote2, work2);
  git(work2, 'config', 'user.name', 'Seed'); git(work2, 'config', 'user.email', 'seed@example.invalid');
  git(work2, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(work2, 'leak.md'), `token sbk_${'ef'.repeat(24)}\n`);
  git(work2, 'add', '.'); git(work2, 'commit', '-qm', 'leak'); git(work2, 'push', '-q', 'origin', 'main');
  const s2 = await startService({ repoUrl: remote2 });
  assert.ok(s2.svc.report.actions.includes('maintenance:adopt_rejected'), JSON.stringify(s2.svc.report));
  await s2.close();
});

test('revert 也受删除权限、路径冲突约束；路径里的凭据进不了提交说明', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const a = m.alice;
  // 只有 admin 能删时，撤回别人的“新建”（= 删除）也要 admin
  const c = await a.call('write_page', { path: 'tmp.md', mode: 'create', content: 'x\n', message: '新建', idempotency_key: key() });
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\npermissions:\n  delete: admin\n', base_rev: cfg.data.blob_rev, message: '只有 admin 能删', idempotency_key: key() });
  assert.equal((await a.call('revert_change', { commit_rev: c.data.commit_rev, message: '撤回', idempotency_key: key() })).data.code, 'FORBIDDEN');
  const cfg2 = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\n', base_rev: cfg2.data.blob_rev, message: '恢复默认', idempotency_key: key() });
  // 大小写冲突：Foo.md → 删除 → foo.md → 撤回删除 → 两个只差大小写的文件 → 拒绝
  const foo = await a.call('write_page', { path: 'Foo.md', mode: 'create', content: 'F\n', message: 'm', idempotency_key: key() });
  const d = await a.call('delete_page', { path: 'Foo.md', base_rev: foo.data.blob_rev, message: 'm', idempotency_key: key() });
  assert.equal((await a.call('write_page', { path: 'foo.md', mode: 'create', content: 'f\n', message: 'm', idempotency_key: key() })).data.status, 'accepted');
  const rv = await a.call('revert_change', { commit_rev: d.data.commit_rev, message: '撤回删除', idempotency_key: key() });
  assert.equal(rv.data.code, 'INVALID_PATH', rv.text);
  // 目录与文件只差大小写
  await a.call('write_page', { path: 'docs/a.md', mode: 'create', content: 'a\n', message: 'm', idempotency_key: key() });
  assert.equal((await a.call('write_page', { path: 'Docs/b.md', mode: 'create', content: 'b\n', message: 'm', idempotency_key: key() })).data.code, 'INVALID_PATH');
  assert.equal((await a.call('write_page', { path: 'dir.md', mode: 'create', content: 'b\n', message: 'm', idempotency_key: key() })).data.status, 'accepted');
  assert.equal((await a.call('write_page', { path: 'Dir.md/child.md', mode: 'create', content: 'b\n', message: 'm', idempotency_key: key() })).data.code, 'INVALID_PATH');
  // 文件名里的凭据：路径与最终提交说明都会被拦下
  const r = await a.call('write_page', { path: `sbk_${'ab'.repeat(24)}.md`, mode: 'create', content: '普通文本\n', message: '新建', idempotency_key: key() });
  assert.equal(r.data.code, 'CREDENTIAL_DETECTED');
  assert.ok(!git(`${s.dataDir}/instance.git`, '--git-dir', `${s.dataDir}/instance.git`, 'log', '--format=%B', 'main').includes('sbk_'));
  await s.close();
});

test('move_page：源和目标在同一提交；目标已存在被拒；提示引用；delete_page 与删除权限配置', async () => {
  const remote = makeRemote();
  const s = await startService({ repoUrl: remote });
  const m = await setupMembers(s.url, ['alice']);
  const a = m.alice;
  const c = await a.call('write_page', { path: 'old.md', mode: 'create', content: '# old\n', message: '新建', idempotency_key: key() });
  await a.call('write_page', { path: 'index.md', mode: 'create', content: '见 [旧页](old.md)\n', message: '索引', idempotency_key: key() });
  await a.call('write_page', { path: 'taken.md', mode: 'create', content: 'x\n', message: '占位', idempotency_key: key() });
  assert.equal((await a.call('move_page', { from: 'old.md', to: 'taken.md', base_rev: c.data.blob_rev, message: 'm', idempotency_key: key() })).data.code, 'ALREADY_EXISTS');
  const mv = await a.call('move_page', { from: 'old.md', to: 'docs/new.md', base_rev: c.data.blob_rev, message: '移动', idempotency_key: key() });
  assert.equal(mv.data.status, 'accepted', mv.text);
  assert.match(mv.data.hints[0], /index\.md/);
  const files = git(remote, 'show', '--name-status', '--no-renames', '--format=', mv.data.commit_rev).split('\n').sort();
  assert.deepEqual(files, ['A\tdocs/new.md', 'D\told.md']);
  // 删除：需要 base_rev；可撤回
  const t = await a.call('read_page', { path: 'taken.md' });
  assert.equal((await a.call('delete_page', { path: 'taken.md', base_rev: 'wrong', message: 'm', idempotency_key: key() })).data.code, 'CONFLICT');
  const del = await a.call('delete_page', { path: 'taken.md', base_rev: t.data.blob_rev, message: '删除占位页', idempotency_key: key() });
  assert.equal(del.data.status, 'accepted');
  assert.equal((await a.call('read_page', { path: 'taken.md' })).data.code, 'NOT_FOUND');
  // 配置为只有 admin 能删
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  await m.admin.call('update_config', { path: '_commons/config.yaml', content: 'version: 1\npermissions:\n  delete: admin\n', base_rev: cfg.data.blob_rev, message: '只有 admin 能删', idempotency_key: key() });
  const idx = await a.call('read_page', { path: 'index.md' });
  assert.equal((await a.call('delete_page', { path: 'index.md', base_rev: idx.data.blob_rev, message: 'm', idempotency_key: key() })).data.code, 'FORBIDDEN');
  assert.equal((await m.admin.call('delete_page', { path: 'index.md', base_rev: idx.data.blob_rev, message: 'admin 删', idempotency_key: key() })).data.status, 'accepted');
  await s.close();
});

test('update_config：schema 校验、base_rev、新配置下现有页面不合规时提示', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  await m.alice.call('write_page', { path: 'todo/list.md', mode: 'create', content: '### T01 订机票\n- 状态：进行中\n', message: '待办', idempotency_key: key() });
  const cfg = await m.admin.call('read_page', { path: '_commons/config.yaml' });
  const typed = 'version: 1\npage_types:\n  todo:\n    paths: ["todo/*.md"]\n    entry:\n      id: { pattern: "T\\\\d{2}" }\n      fields:\n        - { name: 负责人, required: true }\n        - { name: 状态, required: true, enum: [待办, 进行中, 完成] }\n';
  assert.equal((await m.admin.call('update_config', { path: '_commons/config.yaml', content: typed, message: 'm', idempotency_key: key() })).data.code, 'INVALID_ARGUMENT');
  const u = await m.admin.call('update_config', { path: '_commons/config.yaml', content: typed, base_rev: cfg.data.blob_rev, message: '加待办类型', idempotency_key: key() });
  assert.equal(u.data.status, 'accepted', u.text);
  assert.match(u.data.warnings[0], /现有页面共有 1 处条目不合规/);
  for (const bad of ['version: 2\n', 'version: 1\npii:\n  email: maybe\n', 'version: 1\npage_types:\n  Bad Name:\n    paths: ["x.md"]\n', 'version: 1\npage_types:\n  t:\n    paths: ["x.md"]\n    entry:\n      id: { pattern: "(" }\n      fields: [{ name: a }]\n', '[1, 2]', 'version: 1\nlimits:\n  page_max_bytes: -1\n']) {
    const cur = await m.admin.call('read_page', { path: '_commons/config.yaml' });
    const r = await m.admin.call('update_config', { path: '_commons/config.yaml', content: bad, base_rev: cur.data.blob_rev, message: 'm', idempotency_key: key() });
    assert.equal(r.data.code, 'INVALID_CONFIG', `${bad} → ${r.text}`);
  }
  const conv = await m.admin.call('read_page', { path: '_commons/conventions.md' });
  assert.equal((await m.admin.call('update_config', { path: '_commons/conventions.md', content: 'x'.repeat(40_000), base_rev: conv.data.blob_rev, message: 'm', idempotency_key: key() })).data.code, 'TOO_LARGE');
  await s.close();
});
