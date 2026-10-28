// 守卫模块与 /enroll 端点的单元测试。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkPath } from '../src/paths.js';
import { containsCredential } from '../src/secrets.js';
import { scanPii } from '../src/pii.js';
import { lintPage } from '../src/lint.js';
import { parseConfig, globToRegex } from '../src/instance-config.js';
import { parseEntries } from '../src/pagetypes.js';
import { clientIp } from '../src/net.js';
import { parseTrailers } from '../src/git.js';
import { startService, setupMembers, enroll, connect, cleanupAll } from './helpers.js';

after(cleanupAll);

test('路径策略', () => {
  for (const ok of ['a.md', 'restaurants/示例城市甲.md', 'a-b_c.d.md', 'x/y/z.md', '餐厅·示例城市甲.md']) assert.equal(checkPath(ok), ok);
  for (const bad of ['', 'a', 'a.MD', '../a.md', 'a/../b.md', '/a.md', 'a//b.md', '.a.md', 'a/.b/c.md', 'a\\b.md', 'a\u0000.md', 'a\u202e.md', 'a b.md', `${'x/'.repeat(7)}a.md`, `${'x'.repeat(201)}.md`]) {
    assert.throws(() => checkPath(bad), /INVALID_PATH|path|路径|只允许|不能|层级|过长/, bad);
  }
  assert.throws(() => checkPath('_commons/conventions.md'), (e) => e.code === 'FORBIDDEN');
  assert.equal(checkPath('_commons/conventions.md', { kind: 'any' }), '_commons/conventions.md');
  assert.throws(() => checkPath('e\u0301.md'), (e) => e.code === 'INVALID_PATH'); // 非 NFC
});

test('凭据识别', () => {
  // 合成凭据：只验证格式识别，不使用任何真实服务的凭据。
  const fakeAwsId = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const fakeJwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"test-subject"}').toString('base64url'), 'a'.repeat(43)].join('.');
  for (const s of [`sbk_${'a'.repeat(48)}`, `sbe_${'b'.repeat(32)}`, 'sk-ant-api03-abcdefgh', fakeAwsId, '-----BEGIN OPENSSH PRIVATE KEY-----', 'Bearer abcdefghijklmnopqrstuvwxyz012345', fakeJwt, 'password: hunter2026', 's b k _ 0123456789abcdef0123']) {
    assert.ok(containsCredential(s), s);
  }
  for (const s of ['酒店 WiFi 密码：hotel2026', '密码：一律不要写进来', '订单号 1000000000000001', 'sbk_ 开头的密钥只放在配置里', '人均 ¥80']) assert.ok(!containsCredential(s), s);
});

test('个人信息检测', () => {
  const pol = { email: 'warn', phone: 'warn', id_number: 'reject', bank_card: 'warn' };
  assert.equal(scanPii('a@b.com 13812345678', pol).warnings.length, 2);
  assert.equal(scanPii('11010519491231002X', pol).rejections.length, 1);
  assert.equal(scanPii('110105194912310021', pol).rejections.length, 0); // 校验位不对
  assert.equal(scanPii('4111111111111111', pol).warnings.length, 1); // Luhn 通过
  assert.equal(scanPii('a@b.com', { email: 'allow' }).warnings.length, 0);
});

test('lint：frontmatter 与断链', () => {
  assert.deepEqual(lintPage('a.md', '---\ntitle: x\n---\nbody', new Set()).errors, []);
  assert.equal(lintPage('a.md', '---\ntitle: [x\n---\n', new Set()).errors.length, 1);
  assert.equal(lintPage('a.md', '---\nno end', new Set()).errors.length, 1);
  const w = lintPage('d/a.md', '[x](b.md) [y](../c.md) [z](https://e.com/x.md)', new Set(['d/b.md']));
  assert.deepEqual(w.warnings, ['链接指向的页面不存在：../c.md']);
});

test('配置解析与条目解析', () => {
  assert.ok(globToRegex('restaurants/*.md').test('restaurants/x.md'));
  assert.ok(!globToRegex('restaurants/*.md').test('restaurants/a/x.md'));
  assert.ok(globToRegex('**/x.md').test('a/b/x.md'));
  const cfg = parseConfig('version: 1\npage_types:\n  r:\n    paths: ["r/*.md"]\n    entry:\n      id: { pattern: "R\\\\d+" }\n      fields: [{ name: 片区, required: true }]\n');
  const { entries, errors } = parseEntries('---\na: 1\n---\n# 标题\n### R1 店\n- 片区：中心街区\n```\n### 不是条目\n```\n## 分节\n- 片区：不属于任何条目\n### R2 店二\n- 片区: 另一街区\n', cfg.page_types.r.entry);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.id, e.fields.get('片区')]), [['R1', '中心街区'], ['R2', '另一街区']]);
  assert.throws(() => parseConfig('version: 1\nx: &a [1]\ny: *a\n'));
});

test('可信代理链：只取最外层代理写入的来源', () => {
  const req = (xff, remote = '10.0.0.1') => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), { trustedHops: 1 }), '203.0.113.9');
  assert.equal(clientIp(req('not-an-ip'), { trustedHops: 1 }), null);
  assert.equal(clientIp(req('6.6.6.6', '::ffff:127.0.0.1'), { trustedHops: 0 }), '127.0.0.1');
  assert.equal(clientIp({ headers: { 'x-real-ip': '198.51.100.2' } }, { header: 'X-Real-IP' }), '198.51.100.2');
});

test('trailer 解析：重复或未知字段视为不可信', () => {
  assert.equal(parseTrailers('s\n\nbody\n\nCommons-Member: m-a\nCommons-Op: patch').valid, true);
  assert.equal(parseTrailers('s\n\nCommons-Member: m-a\nCommons-Member: m-b').valid, false);
  assert.equal(parseTrailers('s\n\nCommons-Evil: x').valid, false);
  assert.equal(parseTrailers('s\n\njust text').present, false);
});

test('/enroll：同一来源失败过多被限速；人工兑换页只显示一次且禁止缓存', async () => {
  const s = await startService();
  const m = await setupMembers(s.url, ['alice']);
  const inv = await m.admin.call('invite_create', { member_id: 'm-alice', client_label: 'alice-web' });
  for (let i = 0; i < 10; i++) await enroll(s.url, `sbe_${String(i).repeat(32).slice(0, 32)}`);
  assert.equal((await enroll(s.url, `sbe_${'9'.repeat(32)}`)).status, 429); // 同一来源失败过多
  const text = await (await fetch(`${s.url}/enroll`)).text();
  assert.match(text, /POST/);
  assert.ok(!/sbk_[0-9a-f]{48}/.test(text));
  const html = await (await fetch(`${s.url}/enroll`, { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /<form method="post" action="\/enroll\/redeem">/);
  // 换一个“来源”（直连测试里 IP 相同，限速桶已满）——重启服务清空进程内计数后再试人工兑换
  await s.close();
  const s2 = await startService({ dataDir: s.dataDir });
  const res = await fetch(`${s2.url}/enroll/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${inv.data.code}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.match(page, /sbk_[0-9a-f]{48}/);
  const again = await fetch(`${s2.url}/enroll/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${inv.data.code}` });
  assert.equal(again.status, 410);
  assert.ok(!/sbk_[0-9a-f]{48}/.test(await again.text()));
  // 健康检查不泄露信息；未认证的 /mcp 401；其他路由 404
  assert.deepEqual(await (await fetch(`${s2.url}/healthz`)).json(), { ok: true });
  assert.equal((await fetch(`${s2.url}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${s2.url}/README.md`)).status, 404);
  await s2.close();
});

test('/enroll：全局失败桶满了，有效码照样能兑换（攻击者无法阻断合法接入）', async () => {
  const s = await startService({ trustedHops: 1 });
  const post = (code, ip) => fetch(`${s.url}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ code }) });
  const boot = await post('sbe_' + 'a1'.repeat(16), '198.51.100.1');
  const admin = await connect(s.url, (await boot.json()).token);
  await admin.call('member_create', { member_id: 'm-alice', display_name: 'Alice' });
  const inv = await admin.call('invite_create', { member_id: 'm-alice', client_label: 'alice-x' });
  for (let i = 0; i < 210; i++) await post(`sbe_${'0'.repeat(31)}${i % 10}`, `203.0.113.${i % 250}`);
  assert.equal((await post(`sbe_${'0'.repeat(32)}`, '192.0.2.77')).status, 429); // 无效码：全局桶已满
  const ok = await post(inv.data.code, '192.0.2.88');
  assert.equal(ok.status, 200);
  await s.close();
});
