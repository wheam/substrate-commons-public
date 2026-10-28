import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, orderPages, materialize } from '../src/render.js';

const lm = (time, name) => ({ time, display_name: name });
const pages = [
  { path: 'todo.md', text: '# 待办\n\n### T01 订机票\n- 状态：待办\n', last_modified: lm('2025-01-16T01:00:00.000Z', '甲') },
  { path: 'README.md', text: '# 测试旅行\n\n见 [住宿](lodging.md)、[H01](lodging.md#h01)、[待办](todo.md)、[不存在](nope.md)。\n', last_modified: lm('2025-01-16T02:00:00.000Z', '乙') },
  { path: 'lodging.md', text: '# 住宿\n\n### H01 某酒店\n- 订单号：1100000000000001\n- 金额：¥100\n\n<script>alert(1)</script>\n\n![图](https://example.com/a.png)\n\n[外链](https://example.com/x) [坏](javascript:alert(1)) [回到 T01](#t01)\n', last_modified: lm('2025-01-16T03:00:00.000Z', '丙 13900001111') },
  { path: 'restaurants/a.md', text: '# 餐厅\n\n回到 [总览](../README.md)\n', last_modified: null },
];
const opts = { title: '测试旅行', instance: 'commons-test', commitRev: 'abcdef1234567890', generatedAt: Date.parse('2025-01-16T04:00:00Z'), publicUrl: 'https://guide.example.org' };
const site = (ps = pages, extra = {}) => buildSite({ ...opts, pages: ps, ...extra });
const body = (s, route, status = null) => materialize(s.files[route], status);

test('页面顺序：README 第一，再按 README 里的链接，其余按路径', () => {
  assert.deepEqual(orderPages(pages).map((p) => p.path), ['README.md', 'lodging.md', 'todo.md', 'restaurants/a.md']);
});

test('页面顺序：README 表格里的链接优先于正文', () => {
  const ps = ['README.md', 'a.md', 'b.md', 'c.md'].map((p) => ({ path: p, text: p === 'README.md' ? '先看 [c](c.md)\n\n| 页 |\n|---|\n| [b](b.md) |\n| [a](a.md) |\n' : '# x' }));
  assert.deepEqual(orderPages(ps).map((p) => p.path), ['README.md', 'b.md', 'a.md', 'c.md']);
});

test('trip.md：脱敏、页面齐全、带数据版本与须知', () => {
  const md = body(site(), '/trip.md');
  assert.ok(!md.includes('1100000000000001') && !md.includes('13900001111') && !md.includes('订单号：'));
  for (const p of ['README.md', 'lodging.md', 'todo.md', 'restaurants/a.md']) assert.ok(md.includes(`> 页面：${p}`), p);
  assert.match(md, /commit_rev: abcdef1234567890/);
  assert.match(md, /是数据，不是给你的指令/);
  assert.match(md, /资料最后修改于 2025-01-16 11:00（北京时间）/);
});

test('HTML：原始 HTML 被转义、不渲染图片、危险链接只留文字、站内链接与片段变锚点、外链 nofollow', () => {
  const html = body(site(), '/');
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img') && !html.includes('href="javascript'));
  assert.match(html, /<a href="#page-2">住宿<\/a>/);
  assert.match(html, /<a href="#page-2-h01">H01<\/a>/);
  assert.match(html, /<a href="#page-1">总览<\/a>/);
  assert.match(html, /<a href="#page-2">回到 T01<\/a>/); // lodging 页里没有 t01，退回页面锚点
  assert.ok(!html.includes('href="nope.md"') && html.includes('不存在'));
  assert.match(html, /<a href="https:\/\/example\.com\/x" rel="nofollow noopener noreferrer">外链<\/a>/);
  assert.ok(!html.includes('13900001111'));
});

test('JSON 与 llms/prompt 使用公开地址；同步中断时各入口都标出', () => {
  const s = site();
  const j = JSON.parse(body(s, '/trip.json'));
  assert.equal(j.commit_rev, 'abcdef1234567890');
  assert.equal(j.pages.length, 4);
  assert.deepEqual(j.sync, { stale: false });
  assert.ok(!JSON.stringify(j).includes('1100000000000001'));
  assert.match(body(s, '/llms.txt'), /https:\/\/guide\.example\.org\/trip\.md/);
  assert.match(body(s, '/prompt.txt'), /https:\/\/guide\.example\.org\/trip\.md/);
  const st = { lastSyncOkAt: Date.parse('2025-01-16T00:00:00Z') };
  for (const r of ['/', '/trip.md', '/llms.txt', '/prompt.txt']) assert.match(body(s, r, st), /同步暂时中断，最近一次成功同步在 2025-01-16 08:00（北京时间）/, r);
  assert.equal(JSON.parse(body(s, '/trip.json', st)).sync.stale, true);
});

test('Codex R1-5：路径里的号码不进锚点 id；实例名也脱敏', () => {
  const s = buildSite({ ...opts, instance: 'commons-13900001111', pages: [{ path: '13900001111.md', text: '# 号码页\n', last_modified: null }] });
  for (const r of ['/', '/trip.md', '/trip.json', '/llms.txt', '/prompt.txt']) assert.ok(!body(s, r).includes('13900001111'), r);
});

test('Codex R1-6：成员内容里的状态标记不会被替换、拼接出号码', () => {
  const s = buildSite({ ...opts, title: 'alice<!--MIRROR_STATUS-->@example.com', pages: [{ path: 'README.md', text: '# x\n\n13900<!--MIRROR_STATUS-->001111\n', last_modified: null }] });
  for (const r of ['/', '/trip.md', '/trip.json', '/llms.txt', '/prompt.txt']) {
    for (const st of [null, { lastSyncOkAt: 0 }]) {
      const b = body(s, r, st);
      assert.ok(!b.includes('alice@example.com') && !b.includes('13900001111'), r);
    }
  }
});

test('实体写成的号码在网页里也不会还原', () => {
  const ps = [{ path: 'README.md', text: '# x\n\n`&#49;&#51;&#57;&#48;&#48;&#48;&#48;&#49;&#49;&#49;&#49;` &#49;&#51;&#57;&#48;&#48;&#48;&#48;&#49;&#49;&#49;&#49;\n', last_modified: null }];
  const s = site(ps);
  for (const k of ['/', '/trip.md', '/trip.json']) assert.ok(!body(s, k).includes('13900001111'), k);
});

test('某页没通过复查：沿用该页上一版并标明；没有上一版就显示暂不公开；其他页照常更新', () => {
  const v1 = [{ path: 'README.md', text: '# 总览\n\n第一版\n', last_modified: null }, { path: 'a.md', text: '# A\n\n第一版 A\n', last_modified: null }];
  const first = site(v1);
  assert.equal(first.held.length, 0);
  const v2 = [{ path: 'README.md', text: '# 总览\n\n第二版\n', last_modified: null }, { path: 'a.md', text: '# A\n\n第二版 A\n', last_modified: null }];
  const second = buildSite({ ...opts, pages: v2, previous: first.published, forceHold: new Set(['a.md']) });
  assert.equal(second.held.length, 1);
  for (const r of ['/', '/trip.md', '/trip.json']) {
    const b = body(second, r);
    assert.ok(b.includes('第二版') && b.includes('第一版 A') && !b.includes('第二版 A'), r);
  }
  assert.ok(body(second, '/part/2.md').includes('第一版 A') && !body(second, '/part/2.md').includes('第二版 A'));
  assert.match(body(second, '/trip.md'), /本页最新的修改没有通过公开检查/);
  // 没有上一版
  const lone = buildSite({ ...opts, pages: v2, forceHold: new Set(['a.md']) });
  assert.match(body(lone, '/trip.md'), /暂不公开/);
  // 再下一次：上一版仍是第一版
  const third = buildSite({ ...opts, pages: v2, previous: second.published, forceHold: new Set(['a.md']) });
  assert.ok(body(third, '/trip.md').includes('第一版 A'));
});

test('链接文字与后面的文字连起来看：[139000][x]01111 显示成完整手机号，按手机号隐藏', () => {
  const s = site([{ path: 'README.md', text: '# x\n\n[139000][x]01111\n\n[x]: https://example.com/\n', last_modified: null }]);
  for (const r of ['/', '/trip.md', '/trip.json']) assert.ok(!body(s, r).includes('139000') && !body(s, r).includes('01111'), r);
  assert.equal(s.held.length, 0);
});

test('链接文字里的长数字也隐藏', () => {
  const s = site([{ path: 'README.md', text: '# x\n\n[1100000000000001](https://example.com/)', last_modified: null }]);
  assert.ok(!body(s, '/trip.md').includes('1100000000000001'));
});

test('MIRROR_PAGE_ORDER：指定顺序，* 表示其余页面的位置', () => {
  const ps = ['README.md', 'a.md', 'b.md', 'restaurants/x.md', 'restaurants/y.md', 'z.md'].map((p) => ({ path: p, text: '# t' }));
  assert.deepEqual(orderPages(ps, ['README.md', 'b.md', '*', 'restaurants/']).map((p) => p.path), ['README.md', 'b.md', 'a.md', 'z.md', 'restaurants/x.md', 'restaurants/y.md']);
  assert.deepEqual(orderPages(ps, ['z.md']).map((p) => p.path), ['z.md', 'README.md', 'a.md', 'b.md', 'restaurants/x.md', 'restaurants/y.md']);
});

test('trip.md：站内链接改成文字引用（避免 AI 跟着点到 404），页面分隔是可见的一行', () => {
  const md = body(site(), '/trip.md');
  assert.ok(!/\]\((?!https?:)[^)]*\.md/.test(md), '不应再有相对 .md 链接');
  assert.match(md, /见 「住宿」页（lodging\.md）、/);
  assert.match(md, /H01（见「住宿」页 lodging\.md）/);
  assert.match(md, /不存在。/);
  assert.match(md, /^> 页面：lodging\.md · 最后修改 /m);
  assert.match(md, /\[外链\]\(https:\/\/example\.com\/x\)/);
});

test('MIRROR_PROMPT：转发提示词用主人给定的原文', () => {
  const s = site(pages, { promptTemplate: '请读取我们的资料：\n{url}\n以文档为共同背景回答问题。' });
  assert.equal(body(s, '/prompt.txt'), '请读取我们的资料：\nhttps://guide.example.org/trip.md\n以文档为共同背景回答问题。\n');
});

test('Codex R2-B2：渲染后连在一起显示的邮箱 / 编号会被拦下（不在行内节点之间加空格）', () => {
  for (const sneaky of ['[alice][x]@example.com\n\n[x]: https://example.org/', '[AB][x]12CD9X\n\n[x]: https://example.org/']) {
    const s = site([{ path: 'README.md', text: `# x\n\n${sneaky}\n`, last_modified: null }]);
    for (const r of ['/', '/trip.md', '/trip.json']) {
      const b = body(s, r);
      assert.ok(!b.includes('alice') && !b.includes('12CD9X'), `${r}: ${sneaky}`);
    }
  }
});

test('Codex R2-M4 / m2：HTML 不输出链接 title；普通中文标题的 #片段 指到该标题', () => {
  const s = site([{ path: 'README.md', text: '# x\n\n## 普通标题\n\n[详情](#普通标题) [附件](https://example.org/ "t")\n', last_modified: null }]);
  const html = body(s, '/');
  assert.ok(!html.includes('title="'));
  assert.match(html, /<a href="#page-1-s2">详情<\/a>/);
});

test('Codex R3-B4：引用式链接按页解析，合并后不串页；相对引用式链接也改成文字引用', () => {
  const ps = [
    { path: 'README.md', text: '# 总览\n\n见 [来源][source]、[住宿][stay]\n\n[source]: https://a.example.org/x\n[stay]: lodging.md#h01\n', last_modified: null },
    { path: 'lodging.md', text: '# 住宿\n\n### H01 某酒店\n\n另见 [来源][source]\n\n[source]: https://b.example.org/y\n', last_modified: null },
  ];
  const md = body(site(ps), '/trip.md');
  assert.match(md, /见 \[来源\]\(https:\/\/a\.example\.org\/x\)、「住宿」页（lodging\.md）/);
  assert.match(md, /另见 \[来源\]\(https:\/\/b\.example\.org\/y\)/);
  assert.ok(!/^\[source\]:/m.test(md));
});

test('Codex R3-B5：回退到上一版时，用本轮的“已隐藏值”重新审链接（网页、全文、JSON 一致）', () => {
  const v1 = [{ path: 'README.md', text: '# 总览\n\n[附件](https://example.org/view/ABCDEF)\n', last_modified: null }];
  const first = site(v1);
  assert.ok(body(first, '/trip.md').includes('example.org/view/ABCDEF'));
  const v2 = [
    { path: 'README.md', text: '# 总览\n\n新版\n', last_modified: null },
    { path: 'a.md', text: '# A\n\n- 确认号：ABCDEF\n', last_modified: null },
  ];
  const second = buildSite({ ...opts, pages: v2, previous: first.published, forceHold: new Set(['README.md']) });
  assert.equal(second.held.length, 1);
  for (const r of ['/', '/trip.md', '/trip.json', '/part/1.md']) assert.ok(!body(second, r).includes('ABCDEF'), r);
  assert.match(body(second, '/trip.md'), /附件（链接已隐藏）/);
});

test('Codex R3-m1/m2：重名标题与含链接的标题的 #片段', () => {
  const s = site([{ path: 'README.md', text: '# x\n\n## 同名\n\n## 同名\n\n## 前往 [大理](https://example.org/)\n\n[第一](#同名) [第二](#同名-1) [大理](#前往-大理)\n', last_modified: null }]);
  const html = body(s, '/');
  assert.match(html, /<a href="#page-1-s2">第一<\/a>/);
  assert.match(html, /<a href="#page-1-s3">第二<\/a>/);
  assert.match(html, /<a href="#page-1-s4">大理<\/a>/);
});

test('AI 友好：页数、每页单独链接、全文结束标记；分页入口内容完整', () => {
  const s = site();
  const md = body(s, '/trip.md');
  assert.match(md, /## 页面（共 4 页）/);
  assert.match(md, /1\. README\.md — 测试旅行（单独读取：https:\/\/guide\.example\.org\/part\/1\.md）/);
  assert.match(md, /（全文结束：共 4 页。）\n$/);
  const part = body(s, '/part/2.md');
  assert.match(part, /第 2\/4 页：住宿/);
  assert.match(part, /> 页面：lodging\.md/);
  assert.match(part, /（本页结束：第 2\/4 页。）/);
  assert.ok(!part.includes('1100000000000001'));
  assert.equal(JSON.parse(body(s, '/trip.json')).page_count, 4);
});

test('Codex R4-B4：标题等元数据按纯文字处理，生成的全文里不会拼出邮箱', () => {
  const s = buildSite({ ...opts, title: '[alice](https://example.org/)@example.com', pages: [{ path: 'README.md', text: '# x\n', last_modified: null }] });
  for (const r of ['/', '/trip.md', '/part/1.md', '/trip.json', '/llms.txt', '/prompt.txt']) assert.ok(!body(s, r).includes('alice@example.com') && !/alice\]\(https[^)]*\)@/.test(body(s, r)), r);
});

test('Codex R4 Minor：重名标题按 GitHub 规则编号；代码块空行与硬换行保留', () => {
  const s = site([{ path: 'README.md', text: '# x\n\n## 同名\n\n## 同名\n\n## 同名-1\n\n[一](#同名) [二](#同名-1) [三](#同名-1-1)\n\n```\na\n\n\nb\n```\n\n行尾\\\n下一行\n', last_modified: null }]);
  const html = body(s, '/');
  assert.match(html, /<a href="#page-1-s2">一<\/a>/);
  assert.match(html, /<a href="#page-1-s3">二<\/a>/);
  assert.match(html, /<a href="#page-1-s4">三<\/a>/);
  assert.match(html, /a\n\n\nb/);
  assert.match(html, /行尾<br>/);
});

const ALL = (n) => ['/', '/trip.md', '/trip.txt', '/llms-full.txt', '/download/trip.md', '/trip.json', '/llms.txt', '/prompt.txt', ...Array.from({ length: n }, (_, i) => `/part/${i + 1}.md`)];
const one = (text, extra = {}) => buildSite({ ...opts, pages: [{ path: 'README.md', text, last_modified: null }], ...extra });

test('Codex R5-B1：值跨块、列表项以引用开头时，七个入口都不漏', () => {
  for (const [text, secret] of [['预订详情\n确认号：\n\nABCDEF', 'ABCDEF'], ['- > 确认号：\n\n  ABCDEF', 'ABCDEF'], ['- > ## 过敏\n\n  - 甲：花生', '花生']]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes(secret), `${r}: ${JSON.stringify(text)}`);
  }
});

test('Codex R5-B2：代码块语言标记、有序列表起始编号不输出号码', () => {
  for (const text of ['```13900001111\n普通正文\n```', '```ghp_ABCDEFGHIJKLMN\n普通正文\n```', '987654321. 项目']) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) {
      const b = body(s, r);
      assert.ok(!b.includes('13900001111') && !b.includes('ghp_ABCDEFGHIJKLMN') && !b.includes('987654321'), `${r}: ${text}`);
    }
  }
});

test('Codex R5-B3：序列化不改写链接目标；目标里的实体不会被二次解码', () => {
  const a = one('# x\n\n[附件](https://example.org/139****00001111)\n');
  for (const r of ALL(1)) assert.ok(!body(a, r).includes('13900001111'), r);
  for (const text of ['[x](https://example.org/ghp&amp;amp;lowbar;ABCDEFGHIJKLMN)', '[x](https://docs&amp;amp;period;google.com/a)']) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes('ghp_ABCDEFGHIJKLMN') && !body(s, r).includes('docs.google.com'), `${r}: ${text}`);
  }
});

test('Codex R5-B4：/llms.txt 与默认提示词里的标题也转义、复查', () => {
  const s = one('# x\n', { title: '[alice](https://example.org/ "caption")@example.com' });
  for (const r of ['/llms.txt', '/prompt.txt', '/trip.md', '/part/1.md']) assert.ok(!/(^|[^\\])\[alice\]\(/.test(body(s, r)), r); // 只能以转义后的文字出现
  assert.ok(!body(s, '/').includes('<a href="https://example.org/"'));
});

test('Codex R5-M1：全文里的站内链接改写在树上做：带括号的外链与代码块内容保持原样', () => {
  const s = buildSite({ ...opts, pages: [
    { path: 'README.md', text: '# x\n\n[地点](<https://example.org/a)b>) 与 [住宿](lodging.md)\n\n```\n[x](README.md)\n```\n', last_modified: null },
    { path: 'lodging.md', text: '# 住宿\n', last_modified: null },
  ] });
  const md = body(s, '/trip.md');
  assert.ok(md.includes('[地点](<https://example.org/a)b>)'), md);
  assert.ok(md.includes('「住宿」页（lodging.md）'));
  assert.ok(md.includes('```\n[x](README.md)\n```'));
});

test('Codex R6：标题式敏感字段、相对链接片段里的已隐藏值、空值健康字段——完整构建所有入口都不漏', () => {
  for (const [text, secret] of [
    ['- > ## 确认号：\n\n  ABCDEF', 'ABCDEF'], ['## 确认号：\n\nABCDEF', 'ABCDEF'],
    ['- 确认号：ABCDEF\n\n[位置](#ABCDEF)', 'ABCDEF'], ['- 确认号：ABCDEF\n\n[位置](#%41%42%43%44%45%46)', '%41%42%43'],
    ['过敏：\n\n- 甲：花生', '花生'], ['过敏：\n甲：花生', '花生'],
  ]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes(secret), `${r}: ${JSON.stringify(text)}`);
  }
});

test('Codex R6-m1：斜体不打断相邻粗体合并（不会误回退）', () => {
  const s = one('# x\n\n**甲**_**乙**_\n');
  assert.equal(s.held.length, 0);
  assert.match(body(s, '/trip.md'), /\*\*甲乙\*\*/);
});

test('Codex R7：无冒号字段标题、引用外延续的隐藏值、空值字段的下一块、代码块里的健康字段、中文密码、网址里的卡号与电话', () => {
  for (const [text, secret] of [
    ['## 确认号\n\nABCDEF', 'ABCDEF'],
    ['> ## 确认号：\n\nABCDEF\n\n## 资料\n[附件](https://example.org/view/ABCDEF) [位置](#ABCDEF)', 'ABCDEF'],
    ['确认号：\n甲：ABCDEF\n\n乙：GHIJKL', 'GHIJKL'],
    ['```yaml\n过敏:\n  甲: 花生\n```', '花生'],
    ['- 密码：芝麻开门\n\n[位置](#芝麻开门)', '芝麻开门'],
    ['[附件](https://example.org/6222-0000-1111-2222)', '6222-0000'],
    ['[联系](https://example.org/contact/+1-408-555-0123)', '555-0123'],
  ]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes(secret), `${r}: ${JSON.stringify(text)}`);
  }
  const m = one('# x\n\n~~**甲**~~~~**乙**~~\n');
  assert.equal(m.held.length, 0);
});

test('Codex R8 A 类：单元格与句中的密码、代码块里的字段、带引号的值、账户 / 身份证别名', () => {
  for (const [text, secret] of [
    ['| 酒店 | 备注 |\n|---|---|\n| 客栈 | 密码：!huntertwo |', 'huntertwo'],
    ['| 酒店 | 备注 |\n|---|---|\n| 客栈 | 密码：芝麻开门 |', '芝麻开门'],
    ['- 房间：湖景房；密码：芝麻开门', '芝麻开门'],
    ['```yaml\n过敏:\n  甲: 花生\n\n  乙: 海鲜\n```', '海鲜'],
    ['```yaml\n确认号:\n- ABCDEF\n- GHIJKL\n```', 'GHIJKL'],
    ['- 密码：“芝麻开门”\n\n[打开](https://example.org/?access=芝麻开门)', '%E8%8A%9D'],
    ['- 密码："aB!cD$eF"\n\n[打开](https://example.org/?access=aB!cD%24eF)', 'aB!cD'],
    ['| 姓名 | 登录账户 |\n|---|---|\n| 甲 | aliceguest |', 'aliceguest'],
    ['## 账户\n\naliceguest', 'aliceguest'],
    ['- 身份证：A123456(7)', 'A123456'],
  ]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) {
      const b = body(s, r);
      assert.ok(!b.includes(secret) && !b.includes('芝麻开门') && !b.includes('access='), `${r}: ${JSON.stringify(text)}`);
    }
  }
  const keep = one('# x\n\n- 身份证：记得带原件\n- 手机：带充电器与移动电源\n- 护照：有效期需六个月以上\n');
  for (const t of ['记得带原件', '带充电器与移动电源', '有效期需六个月以上']) assert.ok(body(keep, '/trip.md').includes(t), t);
});

test('Codex R9 A 类：括注字段名、空字段换行、JSON / KEY= 代码块、逗号多值、值后附说明、健康字段关联链接', () => {
  for (const [text, secret] of [
    ['| 酒店 | 备注 |\n|---|---|\n| 客栈 | 密码（WiFi）：芝麻开门 |', '芝麻开门'],
    ['Password (WiFi): !huntertwo', 'huntertwo'],
    ['房间：湖景房；密码：\n芝麻开门', '芝麻开门'],
    ['房间：湖景房；密码：\n\n芝麻开门', '芝麻开门'],
    ['```json\n{"ssid":"Guest","password":"aB!cD$eF"}\n```', 'aB!cD'],
    ['```env\nPASSWORD="!huntertwo"\n```', 'huntertwo'],
    ['| 酒店 | 备注 |\n|---|---|\n| 客栈 | 确认号：ABCDEF，GHIJKL |', 'GHIJKL'],
    ['- 密码：“芝麻开门”（区分大小写）\n\n[打开](https://example.org/?access=芝麻开门)', 'access='],
    ['```json\n{"password":"aB!cD$eF"}\n```\n\n[打开](https://example.org/?access=aB!cD%24eF)', 'access='],
    ['- 过敏：花生\n\n[记录](https://example.org/view/花生)', '花生'],
    ['- 密码：“「芝麻开门」”\n\n[打开](https://example.org/?access=芝麻开门)', 'access='],
  ]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes(secret), `${r}: ${JSON.stringify(text)}`);
  }
});

test('Codex R10 A 类：入住码 / 门禁码 / PIN、“密码是 / = / is”、句中空健康字段、括注 / 等号 / 逗号值的关联链接', () => {
  for (const [text, secret] of [
    ['- Booking PIN: 4829', '4829'], ['- 入住码：583126', '583126'], ['- 门禁码：583126', '583126'], ['| 房间 | PIN code |\n|---|---|\n| 1 | 4829 |', '4829'],
    ['WiFi 密码=芝麻开门', '芝麻开门'], ['WiFi 密码是芝麻开门。', '芝麻开门'], ['WiFi password is guesthouse', 'guesthouse'],
    ['餐饮备注：清淡；过敏：\n花生', '花生'], ['餐饮备注：清淡；过敏：\n\n花生', '花生'],
    ['- 过敏：花生（严重）\n\n[记录](https://example.org/view/花生)', '花生'],
    ['```text\nWiFi password=guesthouse\n```\n\n[登录](https://example.org/?access=guesthouse)', 'guesthouse'],
    ['- 密码：opensesame，seashells\n\n[x](https://example.org/?access=seashells)', 'seashells'],
  ]) {
    const s = one(`# x\n\n${text}\n`);
    for (const r of ALL(1)) assert.ok(!body(s, r).includes(secret), `${r}: ${JSON.stringify(text)}`);
  }
});
