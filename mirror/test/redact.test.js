import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactAll, urlAllowed, findLeaks, isSensitiveField, normalize, MASK, LINK_HIDDEN, BARE_LINK_MASK, TOPIC_HIDDEN } from '../src/redact.js';

// 测试数据全是虚构的号码与地址
const hidden = (input, ...secrets) => {
  const out = redactText(input);
  if (out === null) return; // 复查不过、整段不发布，也算藏住了
  for (const s of secrets) assert.ok(!out.includes(s), `${JSON.stringify(input)} → ${JSON.stringify(out)} 仍含 ${s}`);
};

test('结构化条目里的敏感字段整行去掉，其余字段保留', () => {
  const src = [
    '### H09 某酒店（05/01–05/04）',
    '- 入住：2025-05-01',
    '- 金额：¥1,234.56（含税）',
    '- 订单号：1100000000000001',
    '- **确认号**：AB12CD',
    '- 电话：0888-1234567 / 13900001111',
    '- 酒店电话：0888-7654321',
    '- 付款：延期至 2025-04-28 自动扣款',
    '- 取车要带：驾驶员身份证、驾照',
    '- 护照：有效期需六个月以上',
    '- 手机：带充电器与移动电源',
    '- 邮箱：someone@example.com',
  ].join('\n');
  const out = redactText(src);
  for (const keep of ['入住：2025-05-01', '金额：¥1,234.56', '付款：延期至 2025-04-28 自动扣款', '取车要带：驾驶员身份证、驾照', '护照：有效期需六个月以上', '手机：带充电器与移动电源']) assert.ok(out.includes(keep), keep);
  for (const s of ['订单号', '确认号', '电话', '邮箱', '1100000000000001', 'AB12CD', '13900001111', '7654321', 'someone@']) assert.ok(!out.includes(s), s);
});

test('Codex R1-1：列表续行、引用表格、纵向表格、代码块、字段名变体', () => {
  hidden('- 确认号：\n  AB12CD\n- 入住：05/01', 'AB12CD');
  hidden('- 确认号：AB\n12CD', 'AB', '12CD');
  hidden('> | 酒店 | 确认号 |\n> | --- | --- |\n> | A | AB12CD |', 'AB12CD');
  hidden('| 字段 | 值 |\n|---|---|\n| 确认号 | AB12CD |\n| 入住 | 05/01 |', 'AB12CD');
  hidden('```yaml\n确认号:\n  AB12CD\n```', 'AB12CD');
  hidden('Booking reference: ZX8Q2M', 'ZX8Q2M');
  hidden('确认编号：AB12CD', 'AB12CD');
  hidden('| 酒店 | 订单号（酒店） |\n|---|---|\n| A | 1100000000000001 |', '1100000000000001');
  hidden('入住出示确认号 ABCDEF', 'ABCDEF');
  hidden('入住出示确认码 1234', '1234');
  hidden('登录账户 aliceguest', 'aliceguest');
  hidden('联系 (408) 555-0123', '555-0123');
  hidden('联系 139.0000.1111', '0000.1111');
  hidden('车辆 8ABC123', '8ABC123');
  assert.ok(redactText('| 字段 | 值 |\n|---|---|\n| 入住 | 05/01 |').includes('05/01'));
  assert.ok(redactText('- 确认号：\n  AB12CD\n- 入住：05/01').includes('入住：05/01'));
});

test('Codex R1-2：实体、格式字符、强调拆分、全角、换行拆分都不能还原号码', () => {
  hidden('alice&#64;example.com', 'alice@example.com', 'alice');
  hidden('&#49;&#51;&#57;&#48;&#48;&#48;&#48;&#49;&#49;&#49;&#49;', '13900001111');
  hidden('云&#65;12345', '云A12345');
  hidden('入住出示确认号 AB**12**CD', 'AB12CD', '12');
  hidden('代码 `AB`12CD9X', 'AB12CD9X');
  hidden('１３９００００１１１１', '13900001111', '１３９');
  hidden('139\u200B0000\u200B1111', '1111');
  hidden('1390\n001\n1111', '1111');
  hidden('1\u03013900001111', '3900001111');
  hidden('a\uFF20example.com', 'example.com');
  assert.equal(normalize('示例城市甲 &amp; 示例城市乙'), '示例城市甲 & 示例城市乙');
});

test('Codex R1-3：链接 title 丢掉；链接里的证件号；整行去掉的值出现在链接里', () => {
  assert.equal(redactText('[地图](https://example.com/ "alice@example.com 13900001111 云A12345")'), '[地图](https://example.com/)');
  assert.equal(redactText('[资料](https://example.com/files/11010519491231002X.pdf)'), `资料${LINK_HIDDEN}`);
  const { texts } = redactAll(['- 确认号：AB12CD', '[附件](https://example.com/view/AB12CD)']);
  assert.equal(texts[1], `附件${LINK_HIDDEN}`);
  const t = redactAll(['| 项 | 邮箱 |\n|---|---|\n| a | x9@ex.com |', 'https://example.org/u/x9%40ex.com']).texts;
  assert.ok(!t[0].includes('x9'));
  assert.equal(t[1], BARE_LINK_MASK);
});

test('Codex R1-4：私人文档主机的尾点、百分号编码、实体写法、引用定义；不透明编号的私人链接', () => {
  for (const u of ['https://docs.google.com./document/d/AB12CD/edit', 'https://docs.google.com%2e/document/d/AB12CD/edit', 'https://tenant.example.com/doc/AB12CD']) {
    assert.equal(urlAllowed(u), false, u);
  }
  for (const s of ['[附件](https&#58;//docs&#46;google&#46;com/document/d/AB12CD/edit)', '[x]: https&#58;//docs&#46;google&#46;com/document/d/AB12CD/edit']) {
    const out = redactText(s);
    assert.ok(out === null || (!out.includes('docs.google') && !out.includes('AB12CD')), out);
  }
});

test('健康等个人话题整行不公开', () => {
  const out = redactText('- 甲：有糖尿病，正在服用二甲双胍\n- 乙：05/01 到');
  assert.ok(out.includes(TOPIC_HIDDEN) && !out.includes('糖尿病') && out.includes('乙：05/01 到'));
  const t = redactText('| 人 | 备注 |\n|---|---|\n| 甲 | 花生过敏 |\n| 乙 | 无 |');
  assert.ok(!t.includes('过敏') && t.includes('| 乙 | 无 |'));
});

test('正文里的电话、邮箱、证件号、卡号、车牌、长数字、凭据都隐藏', () => {
  const cases = [
    '酒店电话 13900001111；', '电话 139 0000 1111', '+86 888 1234567', '(0888)1234567', '0888-1234567',
    '联系 a.b+c@mail.example.cn', '证件 11010519491231002X', '卡 6222 0000 1111 2222', '车牌 云PF00000，',
    '订单 1100000000000001', '确认号 12345678、', 'sbk_0123456789abcdef', '尾号 1234', '1000 0000 0000 0001', '100000 0000 000001',
  ];
  for (const c of cases) {
    const out = redactText(c);
    assert.ok(out === null || out.includes(MASK), `${c} → ${out}`);
    if (out !== null) assert.deepEqual(findLeaks(out), [], c);
  }
});

test('不误伤：金额、日期、时间、邮编、内部编号、航班号、海拔、普通说法', () => {
  for (const s of [
    '¥12,345.67（每晚 ¥4,115.22）；2025-05-01 15:00 取车；邮编 100000',
    'R35、H01-B3、T05、Q11、IMG-44；海拔 1,234 米；+ 05/08 ¥123 × 3；问界 M9',
    '可电话预订，航班 MU1234',
    '全部订单在 测试甲 账号下，2025-01-15 / 01-16 登录核验；可电话预订；订单号见 H01-B1、IMG-03；车牌待分配。',
    '2025-05-01 2025-05-04；05/01 05/02 05/03；7–10 人',
    '[景点门票](https://example.com/tickets)',
    '格式见 page_template；snake_case 不动',
    '见 [people.md](people.md) 与 [R01](restaurants/example-city.md#r01)',
  ]) assert.equal(redactText(s), s);
});

test('私人文档、订单页、带敏感参数的链接隐藏；公开资料链接保留', () => {
  const src = [
    '原始行程表：[Google Sheets 行程](https://docs.google.com/spreadsheets/d/abcDEF/edit?gid=1)。',
    '参考：[中国天气网](https://www.weather.com.cn/forecast/today.shtml)',
    '[携程酒店页](https://hotels.ctrip.com/hotels/48868831.html)',
    '[订单详情](https://m.ctrip.com/webapp/hotel/orderdetail?x=1)',
    '[带令牌](https://example.com/a?token=xyz)',
    '[邮件](mailto:a@example.com) [脚本](javascript:alert(1))',
    '裸链接 https://docs.qq.com/sheet/XYZ 和 https://www.nps.gov/articles/000/winterhikingtips.htm。',
    '无协议：drive.google.com/file/d/abc/view',
  ].join('\n');
  const out = redactText(src);
  assert.ok(out.includes(`Google Sheets 行程${LINK_HIDDEN}`));
  assert.ok(out.includes('[中国天气网](https://www.weather.com.cn/forecast/today.shtml)'));
  assert.ok(out.includes('[携程酒店页](https://hotels.ctrip.com/hotels/48868831.html)'));
  assert.ok(out.includes(`订单详情${LINK_HIDDEN}`) && out.includes(`带令牌${LINK_HIDDEN}`));
  assert.ok(!out.includes('mailto') && !/(?<!\\)\]\(javascript/.test(out)); // javascript: 不会被解析成链接，只剩转义后的文字
  assert.ok(out.includes(`裸链接 ${BARE_LINK_MASK} 和 https://www.nps.gov/articles/000/winterhikingtips.htm。`), out);
  assert.ok(!out.includes('drive.google.com') && !out.includes('abcDEF') && !out.includes('XYZ'));
});

test('urlAllowed：协议、IP、用户信息、主机后缀、路径词、参数名', () => {
  assert.equal(urlAllowed('https://you.ctrip.com/food/106/454268.html'), true);
  for (const u of ['http://127.0.0.1/x', 'https://user:pw@example.com/', 'https://x.feishu.cn/docx/abc', 'https://a.up.railway.app/enroll',
    'https://example.com/my/booking/1', 'https://example.com/p?share_id=1', 'ftp://example.com/', 'https://example.com/13900001111', 'https://intranet/x']) {
    assert.equal(urlAllowed(u), false, u);
  }
  assert.equal(urlAllowed('https://commons.example.org/x', { extraDenyHosts: ['commons.example.org'] }), false);
});

test('字段名判断', () => {
  for (const n of ['订单号', '**确认号**', '酒店电话', '邮箱', '车牌号', '证件号码', 'Email', '确认编号', '订单号（酒店）', 'Booking reference', 'Tel']) assert.ok(isSensitiveField(n), n);
  for (const n of ['订单', '付款', '付款状态', '所需证件说明', '地址', '来源', '金额', '取车要带', '护照', '手机', 'Hotel', '全部订单在 测试甲 账号下的情况说明']) assert.ok(!isSensitiveField(n), n);
});

test('复查：能检出漏网的邮箱、手机号、长数字、编号、凭据、车牌、私人文档地址', () => {
  assert.deepEqual(findLeaks('a@example.com 13900001111').sort(), ['电话', '邮箱', '长数字'].sort());
  assert.deepEqual(findLeaks('sbk_abcdefgh 云A12345 docs.google.com/x').sort(), ['凭据', '车牌', '私人文档地址'].sort());
  assert.deepEqual(findLeaks('确认号 ZX8Q2M'), ['编号']);
  assert.deepEqual(findLeaks('¥12,345.67 2025-05-01 15:00 MU1234 R35'), []);
});

test('Codex R1-12：没有超线性耗时（256 KB 的恶意输入）', () => {
  const big = 256 * 1024;
  for (const s of ['a'.repeat(big), '1'.repeat(big), '['.repeat(big), 'a.'.repeat(big / 2), '@'.repeat(big), 'http://'.repeat(big / 7),
    '确认号 '.repeat(big / 4), '1 '.repeat(big / 2), 'aB1'.repeat(big / 3), '- 确认号：\n'.repeat(big / 8)]) {
    const t0 = Date.now();
    redactText(s);
    assert.ok(Date.now() - t0 < 3000, `${JSON.stringify(s.slice(0, 12))}… 用时 ${Date.now() - t0} ms`);
  }
});

test('Codex R2-B1：确认号后的形似航班号、加粗的值、英文纵向表格', () => {
  hidden('入住出示确认号 AB1234', 'AB1234');
  hidden('入住出示确认号 **ABCDEF**', 'ABCDEF');
  hidden('| Field | Value |\n|---|---|\n| Booking reference | ABCDEF |', 'ABCDEF');
  assert.equal(redactText('可电话预订，航班 MU1234'), '可电话预订，航班 MU1234');
});

test('Codex R2-B3：网址的 #片段、主机、解码后的车牌', () => {
  for (const u of ['https://example.org/#13900001111', 'https://13900001111.example.org/', 'https://example.org/files/%E4%BA%91A12345.pdf', 'https://example.org/#AB12CD9X']) {
    assert.equal(urlAllowed(u), false, u);
  }
  assert.equal(urlAllowed('https://www.weather.com.cn/forecast/today.shtml#top'), true);
});

test('Codex R2-B4：纯字母的确认号被去掉后，出现在链接里也隐藏', () => {
  const t = redactAll(['- 确认号：ABCDEF\n\n[附件](https://example.org/view/ABCDEF)']).texts[0];
  assert.ok(!t.includes('ABCDEF'), t);
});

test('Codex R2-B5：健康词在表头 → 整列隐藏；在小标题 / 字段名 → 整节 / 整项隐藏', () => {
  const t = redactText('| 姓名 | 过敏 |\n|---|---|\n| 甲 | 花生 |');
  assert.ok(!t.includes('花生') && !t.includes('过敏'), t);
  const s = redactText('## 过敏\n- 甲：花生\n- 乙：海鲜\n\n## 行程\n- 05/01 到示例城市甲');
  assert.ok(!s.includes('花生') && !s.includes('海鲜') && s.includes('## 行程') && s.includes('05/01 到示例城市甲'), s);
  const f = redactText('- 用药：\n  早晚各一次\n- 入住：05/01');
  assert.ok(!f.includes('早晚各一次') && f.includes('入住：05/01'), f);
});

test('Codex R2-M4：相对链接与引用定义的 title 也去掉', () => {
  assert.equal(redactText('[附件](README.md "ABCDEF")'), '[附件](README.md)');
  const t = redactText('[附件][x]\n\n[x]: https://example.org/ "ABCDEF"');
  assert.ok(!t.includes('ABCDEF'), t);
});

test('Codex R2-m1：普通英文词和网址里的 hiv 不算健康话题', () => {
  assert.equal(redactText('[历史资料](https://example.org/archive)'), '[历史资料](https://example.org/archive)');
  assert.equal(redactText('archive and chive'), 'archive and chive');
  assert.ok(redactText('- 甲：HIV 检测').includes(TOPIC_HIDDEN));
});

test('Codex R2-M1：长空白、长表格分隔行等不会卡住', () => {
  for (const s of [' '.repeat(200000) + 'plain text', '|\n' + ' '.repeat(200000) + 'x', '|\n|' + ' -'.repeat(100000) + 'x', '- ' + ' '.repeat(200000) + '：', '1' + ' '.repeat(100000) + '\n' + '2'.repeat(10)]) {
    const t0 = Date.now();
    redactText(s);
    assert.ok(Date.now() - t0 < 3000, `${JSON.stringify(s.slice(0, 6))}… 用时 ${Date.now() - t0} ms`);
  }
});

test('Codex R3-B1：确认号写在链接文字里', () => {
  const t = redactText('入住出示确认号 [ABCDEF](https://example.org/)');
  assert.ok(t === null || !t.includes('ABCDEF'), t);
});

test('Codex R3-B2：网址里的各类凭据格式', () => {
  assert.equal(urlAllowed('https://example.org/files/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'), false);
  const fakeAwsId = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  assert.equal(urlAllowed(`https://example.org/x?k=${fakeAwsId}`), false);
});

test('Codex R3-B3：下划线式标题、列表项里隔空行的内容', () => {
  hidden('过敏\n----\n- 甲：花生\n\n# 行程\n- 05/01', '花生');
  hidden('- 过敏：\n\n  - 甲：花生\n- 乙：05/01 到', '花生');
  assert.ok(redactText('- 过敏：\n\n  - 甲：花生\n- 乙：05/01 到').includes('乙：05/01 到'));
});

test('Codex R3-M1：表格里大量括号不会卡住；整页构建耗时有上限', () => {
  for (const n of [65536, 131072]) {
    const s = '| ' + '('.repeat(n) + ' | 值 |\n|---|---|\n| a | b |';
    const t0 = Date.now();
    redactText(s);
    assert.ok(Date.now() - t0 < 2000, `n=${n} 用时 ${Date.now() - t0} ms`);
  }
});

test('Codex R3-M2：多行 title、网址带括号的 title 都去掉', () => {
  const a = redactText('[附件][x]\n\n[x]: https://example.org/\n  "ABCDEF"');
  assert.ok(!a.includes('ABCDEF'), a);
  const b = redactText('[附件](https://example.org/a(b) "ABCDEF")');
  assert.ok(!b.includes('ABCDEF'), b);
});

test('Codex R4-B1：嵌套结构里的敏感字段、健康标题', () => {
  hidden('- | 酒店 | 确认号 |\n  |---|---|\n  | 大理 | ABCDEF |', 'ABCDEF');
  assert.ok(redactText('- | 酒店 | 确认号 |\n  |---|---|\n  | 大理 | ABCDEF |').includes('大理'));
  hidden('- # 过敏\n\n  - 甲：花生\n- 乙', '花生');
  hidden('- > 确认号：\n  >\n  > ABCDEF', 'ABCDEF');
  hidden('> - 确认号：\n>   ABCDEF', 'ABCDEF');
});

test('Codex R4-B2：表格里网址中的 \\| 不会让列错位', () => {
  const t = redactText('| 链接 | 确认号 |\n|---|---|\n| https://example.org/a\\|b | ABCDEF |');
  assert.ok(t === null || !t.includes('ABCDEF'), t);
});

test('Codex R4-B3：网址里用粗体拆开的号码与凭据', () => {
  for (const s of ['https://example.org/139**0000**1111', 'https://example.org/ghp_ABC**DEF**GHIJKLMN']) hidden(s, '1111', 'GHIJKLMN');
});

test('Codex R4-M1：统一写法往返后读者看到的文字与链接不变', async () => {
  const { md } = await import('../src/doc.js');
  const vis = (src) => md.render(src).replace(/<\/?(?:p|li|ul|ol|h[1-6]|tr|td|th|thead|tbody|table|blockquote|pre|hr|br)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const hrefs = (src) => [...md.render(src).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  for (const s of ['\\_强调\\_', '# 标题 \\#', '__甲__**乙**', '[地点](<https://example.org/a)b>)', '`https://example.org/[路线](https://maps.example.org/)`',
    '- a\n  - b\n\n  续', '> 引用\n> - 列表', '| a | b |\n|---|---|\n| 1 | 2 |', '```\na\n\n\nb\n```', '行尾\\\n下一行', '1\\. 不是列表', '\\- 也不是', '<https://example.org/x>']) {
    const out = redactText(s);
    assert.equal(vis(out), vis(s), `${JSON.stringify(s)} → ${JSON.stringify(out)}`);
    assert.deepEqual(hrefs(out), hrefs(s), s);
    assert.ok(!/[\uE000-\uF8FF]/.test(out), s);
  }
});

test('Codex R4-M3：超大代码块（反引号很多）不会让构建报错', () => {
  const s = '~~~\n' + '` '.repeat(130000) + '\n~~~';
  const t0 = Date.now();
  redactText(s);
  assert.ok(Date.now() - t0 < 5000);
});

test('Codex R5-m2：applyInlineEdits 支持在末尾插入', async () => {
  const { md, inlineView, applyInlineEdits } = await import('../src/doc.js');
  const tok = md.parse('a\nb', {})[1];
  const view = inlineView(tok.children);
  const out = applyInlineEdits(tok.children, view, [{ start: 3, end: 3, repl: 'X' }]);
  assert.equal(inlineView(out).s, 'a\nbX');
});

test('urlAllowed：公开的携程酒店 / 大众点评店铺 / 高德地图链接放行，其他检查照常', () => {
  for (const u of [
    'https://hotels.ctrip.com/hotels/133284805.html',
    'https://m.ctrip.com/html5/hotel/hoteldetail/123266722.html',
    'https://www.dianping.com/shop/H8KxQo1RbxnmpZ8h',
    'https://uri.amap.com/search?keyword=%E6%9C%A8%E5%B1%BF%E5%BA%9F%E5%A2%9F%E9%A4%90%E5%8E%85%20%E6%9D%9F%E6%B2%B3&city=%E4%B8%BD%E6%B1%9F&callnative=1',
    'https://uri.amap.com/search?keyword=Allpoints%E4%B9%9D%E9%A1%B6%E4%B8%8A%E6%88%BF&city=%E4%B8%BD%E6%B1%9F&callnative=1',
  ]) assert.equal(urlAllowed(u), true, u);
  for (const u of [
    'https://uri.amap.com/search?keyword=13368885976&city=x', // 手机号仍拦
    'https://uri.amap.com/search?keyword=x&token=abc', // 白名单外的参数仍按原规则
    'https://hotels.ctrip.com/hotels/133284805.html?orderid=1128151574533765',
    'https://hotels.ctrip.com/myctrip/orders/1128151574533765.html',
    'https://evil.example/hotels/133284805.html',
    'https://www.dianping.com/shop/abc#token=1',
  ]) assert.equal(urlAllowed(u), false, u);
  assert.equal(urlAllowed('https://hotels.ctrip.com/hotels/133284805.html', { secrets: new Set(['133284805']) }), false);
});

test('评审：高德链接的参数值照常检查订单号、确认码、卡号；整页脱敏不放过', () => {
  for (const u of [
    'https://uri.amap.com/search?keyword=1128151574533765&city=%E4%B8%BD%E6%B1%9F',
    'https://uri.amap.com/marker?position=100.23,26.87&name=%E9%85%92%E5%BA%97%EF%BC%88%E8%AE%A2%E5%8D%951128151574533765%EF%BC%89',
    'https://uri.amap.com/search?keyword=AB12CD&city=x',
    'https://uri.amap.com/search?keyword=4111111111111111&city=x',
  ]) assert.equal(urlAllowed(u), false, u);
  assert.equal(urlAllowed('https://uri.amap.com/marker?position=100.2323,26.9128&name=%E6%9C%A8%E5%B1%BF&callnative=1'), true);
  const r = redactAll([{ kind: 'md', text: '# 页\n\n- 地图：[高德地图](https://uri.amap.com/search?keyword=1128151574533765&city=x)\n- 携程：[携程酒店页](https://hotels.ctrip.com/hotels/134613098.html)\n' }]);
  assert.doesNotMatch(r.texts[0], /1128151574533765/);
  assert.match(r.texts[0], /https:\/\/hotels\.ctrip\.com\/hotels\/134613098\.html/);
});
