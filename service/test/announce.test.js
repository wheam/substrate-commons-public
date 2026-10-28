// 全员通知邮件：announce 工具、收件人、改动清单、幂等、限频、失败处理，以及 Gmail 发信模块。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startService, setupMembers, key, cleanupAll, enroll, connect } from './helpers.js';
import { buildMessage, createGmailMailer } from '../src/mailer.js';
import { CommonsError } from '../src/util.js';

after(cleanupAll);

function fakeMailer() {
  const sent = [];
  let failNext = null;
  return {
    sent,
    failWith(code) { failNext = code; },
    async send(m) {
      if (failNext) { const c = failNext; failNext = null; throw new CommonsError(c, c === 'MAIL_UNKNOWN' ? '超时' : 'Gmail 拒绝发信（HTTP 500）'); }
      sent.push(m);
      return { message_id: `msg-${sent.length}` };
    },
  };
}

// 结构化通知参数：summary 作为一句话结论和一段说明
const msg = (subject, summary, idempotency_key, extra = {}) => ({
  subject, headline: summary, action: '不用做什么', sections: [{ title: '详情', note: summary }], idempotency_key, ...extra,
});

async function setup(opts = {}) {
  const mailer = opts.mailer === undefined ? fakeMailer() : opts.mailer;
  const s = await startService({ mailer, announce: { guideUrl: 'https://guide.example/', ...(opts.announce ?? {}) } });
  const m = await setupMembers(s.url, ['alice', 'bob']);
  return { s, m, mailer };
}

test('没配置发信时没有 announce 工具，写入回执也不带提示', async () => {
  const { s, m } = await setup({ mailer: null });
  const tools = (await m.alice.client.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.includes('announce') && !tools.includes('announcements'));
  const w = await m.alice.call('write_page', { path: 'a.md', mode: 'create', content: 'x\n', message: '新建', idempotency_key: key() });
  assert.equal(w.data.announce_hint, undefined);
  assert.doesNotMatch((await m.alice.call('conventions')).text, /announce/);
  await s.close();
});

test('announce：发给登记了邮箱的成员（不含只读成员），附改动清单与链接，回复给发起人', async () => {
  const { s, m, mailer } = await setup();
  const { admin, alice, bob } = m;
  // 只读成员
  await admin.call('member_create', { member_id: 'm-carol', display_name: 'Carol', role: 'reader' });
  const inv = await admin.call('invite_create', { member_id: 'm-carol', client_label: 'carol-reader', scope: 'read' });
  const carol = await connect(s.url, (await enroll(s.url, inv.data.code)).body.token);
  for (const [id, e] of [['m-owner', 'owner@example.com'], ['m-alice', 'alice@example.com'], ['m-bob', 'bob@example.com'], ['m-carol', 'carol@example.com']]) {
    const r = await admin.call('member_set_email', { member_id: id, email: e });
    assert.equal(r.isError, false, r.text);
  }
  assert.equal((await admin.call('member_set_email', { member_id: 'm-bob', email: 'not-an-email' })).data.code, 'INVALID_ARGUMENT');
  // 成员列表不外露邮箱；只读成员看不到 announce
  assert.doesNotMatch((await alice.call('members')).text, /@example\.com/);
  const carolTools = (await carol.client.listTools()).tools.map((t) => t.name);
  assert.ok(!carolTools.includes('announce') && carolTools.includes('announcements'));
  assert.match((await alice.call('conventions')).text, /10\. 写完影响大家安排的改动后/);

  const w = await alice.call('write_page', { path: 'lodging.md', mode: 'create', content: '# 住宿\n\n示例酒店\n', message: '示例城市乙第二晚改住示例酒店\n\n依据：订单详情', idempotency_key: key() });
  assert.match(w.data.announce_hint, /announce/);
  await bob.call('write_page', { path: 'budget.md', mode: 'create', content: '# 预算\n', message: '预算页', idempotency_key: key() });
  const k = key();
  const a = await alice.call('announce', msg('示例城市乙第二晚改住示例酒店', '第二晚从旧城区换到示例酒店，每组多 300 元，请在 05-20 前回复。', k));
  assert.equal(a.isError, false, a.text);
  assert.equal(a.data.status, 'sent');
  assert.equal(a.data.recipients, 3);
  assert.equal(mailer.sent.length, 1);
  const mail = mailer.sent[0];
  assert.deepEqual(mail.to.map((t) => t.address), ['owner@example.com', 'alice@example.com', 'bob@example.com']);
  assert.deepEqual(mail.replyTo, { name: 'Alice', address: 'alice@example.com' });
  assert.equal(mail.subject, '【测试实例】示例城市乙第二晚改住示例酒店');
  assert.match(mail.text, /^第二晚从旧城区换到示例酒店/);
  assert.match(mail.text, /你需要做：不用做什么/);
  assert.match(mail.text, /由 Alice 的 AI 在 Alice 确认后/);
  assert.match(mail.text, /完整资料：https:\/\/guide\.example\//);
  assert.doesNotMatch(mail.text, /lodging\.md|budget\.md|预算页/, '不再附系统修改记录');
  assert.match(mail.html, /<strong>你需要做：<\/strong>不用做什么/);
  assert.match(mail.html, /href="https:\/\/guide\.example\/"/);
  assert.doesNotMatch(mail.text + mail.html, /carol@/);

  // 同键同参数 → 原结果，不重发；同键不同参数 → 拒绝
  const again = await alice.call('announce', msg('示例城市乙第二晚改住示例酒店', '第二晚从旧城区换到示例酒店，每组多 300 元，请在 05-20 前回复。', k));
  assert.equal(again.data.replayed, true);
  assert.equal(mailer.sent.length, 1);
  assert.equal((await alice.call('announce', msg('别的', '另一条完全不同的通知内容。', k))).data.code, 'IDEMPOTENCY_MISMATCH');
  // 补发 / 另一封：不要求期间有新改动
  const b2 = await bob.call('announce', msg('补发：预算加了租车', '租车费用 3000 元已经写进预算页，三组平摊。', key()));
  assert.equal(b2.data.status, 'sent', b2.text);
  assert.equal(mailer.sent[1].subject, '【测试实例】补发：预算加了租车');
  const list = await carol.call('announcements');
  assert.deepEqual(list.data.announcements.map((x) => x.status), ['sent', 'sent']);
  assert.doesNotMatch(list.text, /@example\.com/);
  // 管理员能看到收件名单
  const roster = await admin.call('mail_roster');
  assert.deepEqual(roster.data.members.filter((x) => x.receives).map((x) => x.member_id), ['m-owner', 'm-alice', 'm-bob']);
  await s.close();
});

test('announce：参数校验、凭据拦截、限频、发信失败可换键重试', async () => {
  const { s, m, mailer } = await setup({ announce: { perMemberPerDay: 2 } });
  const { admin, alice } = m;
  await admin.call('member_set_email', { member_id: 'm-alice', email: 'alice@example.com' });
  const write = async (n) => alice.call('write_page', { path: `p${n}.md`, mode: 'create', content: `${n}\n`, message: `第 ${n} 页`, idempotency_key: key() });
  await write(1);
  assert.equal((await alice.call('announce', msg('换行\n注入', '正常的正文内容在这里。', key()))).isError, false);
  assert.equal(mailer.sent[0].subject, '【测试实例】换行 注入');
  await write(2);
  assert.equal((await alice.call('announce', msg('x', '标题太短的通知。', key()))).data.code, 'INVALID_ARGUMENT');
  assert.equal((await alice.call('announce', msg('有凭据', `看这个 sbk_${'ab'.repeat(24)}`, key()))).data.code, 'CREDENTIAL_DETECTED');
  // 发信失败：可以换新键重试
  mailer.failWith('MAIL_FAILED');
  const f = await alice.call('announce', msg('第二页', '第二页已经写好了，请大家看看。', key()));
  assert.equal(f.data.code, 'MAIL_FAILED');
  const ok = await alice.call('announce', msg('第二页', '第二页已经写好了，请大家看看。', key()));
  assert.equal(ok.data.status, 'sent', ok.text);
  assert.match(mailer.sent[1].text, /第二页已经写好了/);
  // 限频：失败的不计数，成功两封后第三封被拒
  await write(3);
  assert.equal((await alice.call('announce', msg('第三页', '第三页已经写好了，请大家看看。', key()))).data.code, 'RATE_LIMITED');
  await s.close();
});

test('结果未知的通知：重放同键报未知，重启后正在发送的记录标为未知', async () => {
  const { s, m, mailer } = await setup();
  const { admin, alice } = m;
  await admin.call('member_set_email', { member_id: 'm-alice', email: 'alice@example.com' });
  await alice.call('write_page', { path: 'a.md', mode: 'create', content: 'a\n', message: 'a', idempotency_key: key() });
  mailer.failWith('MAIL_UNKNOWN');
  const k = key();
  const u = await alice.call('announce', msg('结果未知', '这一封的结果会是未知。', k));
  assert.equal(u.data.code, 'MAIL_UNKNOWN');
  assert.match(u.data.message, /不要立刻重发/);
  assert.equal((await alice.call('announce', msg('结果未知', '这一封的结果会是未知。', k))).data.code, 'MAIL_UNKNOWN');
  // 模拟进程在发信途中退出
  s.svc.ctx.db.run("UPDATE announcements SET status = 'sending'");
  const dataDir = s.dataDir;
  await s.close();
  const s2 = await startService({ dataDir, mailer: fakeMailer() });
  assert.equal(s2.svc.ctx.db.get('SELECT status FROM announcements').status, 'unknown');
  await s2.close();
});

test('邮件组装：中文头部按 RFC 2047 编码，头部不能被换行注入，正文 base64 可还原', () => {
  const raw = buildMessage({
    from: { name: '示例共享库', address: 'me@example.com' },
    to: [{ name: '测试乙', address: 'a@example.com' }, { name: 'Bob', address: 'b@example.com' }],
    replyTo: { name: 'leila', address: 'l@example.com' },
    subject: '【示例共享库】示例城市乙第二晚改住示例酒店，每组多 300 元，请在 5 月 20 日前回复\r\nBcc: evil@example.com',
    text: '第一行\n第二行',
  });
  const [head, body] = raw.split('\r\n\r\n');
  assert.doesNotMatch(head, /^Bcc:/m);
  for (const line of head.split('\r\n')) assert.ok(line.length <= 998);
  assert.match(head, /^From: =\?UTF-8\?B\?[^?]+\?= <me@example\.com>$/m);
  assert.match(head, /^Reply-To: "leila" <l@example\.com>$/m);
  const subj = head.split('\r\n').filter((l, i, a) => l.startsWith('Subject:') || (a.slice(0, i).some((x) => x.startsWith('Subject:')) && l.startsWith(' ') && !a.slice(0, i).some((x) => x.startsWith('Date:'))));
  const decoded = subj.join('').replace(/^Subject: /, '').split(/\s+/).map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString()).join('');
  assert.equal(decoded, '【示例共享库】示例城市乙第二晚改住示例酒店，每组多 300 元，请在 5 月 20 日前回复 Bcc: evil@example.com');
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), '第一行\r\n第二行');
  assert.throws(() => buildMessage({ from: { address: 'me@example.com' }, to: [{ address: 'a@example.com>\r\nBcc: x@y.z' }], subject: 's', text: 't' }), /邮箱格式/);
});

test('Gmail 发信：刷新令牌换访问令牌并缓存；授权失效报 MAIL_AUTH；报错不带密钥', async () => {
  const calls = [];
  let tokenReply = { status: 200, body: { access_token: 'ya29.access-token-value', expires_in: 3600 } };
  let sendReply = { status: 200, body: { id: 'm1', threadId: 't1' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = url.includes('oauth2') ? tokenReply : sendReply;
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const mailer = createGmailMailer({ clientId: 'cid', clientSecret: 'very-secret-client', refreshToken: '1//refresh-token-secret', fromAddress: 'me@example.com', fromName: '共享库', fetchImpl });
  const msg = { to: [{ name: 'A', address: 'a@example.com' }], subject: '测试', text: '正文' };
  assert.deepEqual(await mailer.send(msg), { message_id: 'm1', thread_id: 't1' });
  await mailer.send(msg);
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, '访问令牌应被缓存');
  const sendCall = calls.find((c) => c.url.includes('messages/send'));
  assert.equal(sendCall.init.headers.Authorization, 'Bearer ya29.access-token-value');
  assert.match(Buffer.from(JSON.parse(sendCall.init.body).raw, 'base64url').toString(), /^From: =\?UTF-8\?B\?/);
  sendReply = { status: 400, body: { error: { message: 'bad request with ya29.access-token-value and very-secret-client' } } };
  await assert.rejects(mailer.send(msg), (e) => e.code === 'MAIL_FAILED' && !/very-secret|ya29\.access/.test(e.message));
  const m2 = createGmailMailer({ clientId: 'cid', clientSecret: 'very-secret-client', refreshToken: '1//refresh-token-secret', fromAddress: 'me@example.com', fetchImpl });
  tokenReply = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
  await assert.rejects(m2.send(msg), (e) => e.code === 'MAIL_AUTH' && !/refresh-token-secret/.test(e.message));
});

test('评审 r1：显示名里的逗号和引号不会拆出额外收件人', () => {
  const raw = buildMessage({
    from: { name: 'Owner', address: 'me@example.com' },
    to: [{ name: 'Smith, Bob', address: 'bob@example.com' }, { name: 'friend@example.net, Alice "A" \\', address: 'alice@example.com' }],
    subject: 's', text: 't',
  });
  const head = raw.split('\r\n\r\n')[0];
  const to = /^To: ([\s\S]*?)\r\nSubject:/m.exec(head)[1];
  assert.equal(to, '"Smith, Bob" <bob@example.com>,\r\n "friend@example.net, Alice \\"A\\" \\\\" <alice@example.com>');
});

test('评审 r1：Gmail 回应不完整或 5xx 记为结果未知，4xx 记为失败', async () => {
  const mk = (reply) => createGmailMailer({
    clientId: 'cid', clientSecret: 's', refreshToken: 'r', fromAddress: 'me@example.com',
    fetchImpl: async (url) => (url.includes('oauth2') ? { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 3600 }) } : reply),
  });
  const msg = { to: [{ address: 'a@example.com' }], subject: 's', text: 't' };
  await assert.rejects(mk({ ok: true, status: 200, json: async () => { throw new Error('body timeout'); } }).send(msg), (e) => e.code === 'MAIL_UNKNOWN');
  await assert.rejects(mk({ ok: true, status: 200, json: async () => ({}) }).send(msg), (e) => e.code === 'MAIL_UNKNOWN');
  await assert.rejects(mk({ ok: false, status: 503, json: async () => ({}) }).send(msg), (e) => e.code === 'MAIL_UNKNOWN');
  await assert.rejects(mk({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid To header' } }) }).send(msg), (e) => e.code === 'MAIL_FAILED');
});

test('评审 r1：并发通知串行处理；Google 密钥与配置值被拦截', async () => {
  const mailer = fakeMailer();
  mailer.leaks = (t) => t.includes('configured-secret-value');
  const { s, m } = await setup({ mailer });
  const { admin, alice, bob } = m;
  for (const [id, e] of [['m-alice', 'alice@example.com'], ['m-bob', 'bob@example.com']]) await admin.call('member_set_email', { member_id: id, email: e });
  await alice.call('write_page', { path: 'c.md', mode: 'create', content: 'c\n', message: '并发前的改动', idempotency_key: key() });
  const [x, y] = await Promise.all([
    alice.call('announce', msg('alice 的通知', '并发的第一封通知内容。', key())),
    bob.call('announce', msg('bob 的通知', '并发的第二封通知内容。', key())),
  ]);
  assert.deepEqual([x.data.status, y.data.status], ['sent', 'sent']);
  assert.equal(mailer.sent.length, 2);
  await alice.call('write_page', { path: 'd.md', mode: 'create', content: 'd\n', message: '又一处改动', idempotency_key: key() });
  for (const bad of ['client_secret: GOCSPX-abcdefghijklmnopqrstuvwx', 'refresh_token = 1//0gabcdefghijklmnopqrstuvwxyz0123456789', '"client_secret": "xyz"', '配置是 configured-secret-value 这个']) {
    assert.equal((await alice.call('announce', msg('误粘配置', `看一下：${bad}`, key()))).data.code, 'CREDENTIAL_DETECTED', bad);
  }
  assert.equal((await alice.call('announce', msg('键里有凭据', '正常的通知正文内容。', `sbk_${'ab'.repeat(24)}`))).data.code, 'INVALID_ARGUMENT');
  assert.equal(s.svc.ctx.db.get('SELECT COUNT(*) AS n FROM announcements').n, 2);
  await s.close();
});

test('排版：卡片 / 要点 / 标签渲染成 HTML，内容全部转义，只认加粗和 http(s) 链接；纯文本版结构一致', async () => {
  const { renderAnnouncement } = await import('../src/mail-render.js');
  const { normalizeContent } = await import('../src/announce.js');
  const content = normalizeContent({
    subject: '示例城市甲吃饭候选多了 9 家',
    headline: '候选从 20 家加到 **29 家**，都还没订。',
    action: '不用做什么',
    sections: [
      { title: '新增', cards: [
        { title: '示例·餐厅 <script>alert(1)</script>', tag: '新增', subtitle: '中心街区 · 人均约¥93', lines: ['推荐：手抓饭', '订座 https://example.com/a?b=1&c=2 看看'] },
        { title: '"><img src=x onerror=alert(1)>', tag: '待确认' },
        { title: '链接', lines: ['javascript:alert(1)', '<a href="https://evil.example">点我</a>'] },
      ] },
      { title: '要点', bullets: ['**价格**是历史快照'], note: '第一行\n第二行' },
    ],
  });
  const { html, text } = renderAnnouncement(content, { instanceName: '示例共享库', subject: content.subject, senderName: '测试甲', guideUrl: 'https://guide.example/', recipientNames: ['测试甲', '测试乙'] });
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  // 原始 <a> 标签被转义；其中的 http(s) 网址按纯网址自动加链接，显示的就是网址本身
  assert.match(html, /&lt;a href=&quot;<a href="https:\/\/evil\.example"[^>]*>https:\/\/evil\.example<\/a>&quot;&gt;点我&lt;\/a&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>29 家<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(html, /background:#e7f6ec;color:#1a7f37[^>]*>新增</);
  assert.match(html, /background:#fff4dc;color:#9a6700[^>]*>待确认</);
  assert.match(html, /第一行<br>第二行/);
  assert.match(html, /查看完整资料/);
  assert.match(text, /^候选从 20 家加到 29 家，都还没订。\n你需要做：不用做什么\n\n【新增】\n1\. 示例·餐厅 <script>alert\(1\)<\/script>（新增）\n   中心街区 · 人均约¥93\n   推荐：手抓饭/);
  assert.match(text, /· 价格是历史快照/);
  assert.match(text, /收件人：测试甲、测试乙\n$/);
});

test('排版：结构校验（必填、长度、数量上限）', async () => {
  const { normalizeContent } = await import('../src/announce.js');
  const base = { subject: '标题', headline: '一句话结论', action: '不用做什么', sections: [{ title: '详情', note: '说明' }] };
  assert.deepEqual(normalizeContent(base).sections, [{ title: '详情', note: '说明' }]);
  const bad = (patch, re) => assert.throws(() => normalizeContent({ ...base, ...patch }), re);
  bad({ action: '' }, /action/);
  bad({ sections: [] }, /sections/);
  bad({ sections: [{ title: '空的' }] }, /至少一项/);
  bad({ sections: [{ title: '卡', cards: [{ title: 'x', tag: '这个标签实在太长了' }] }] }, /tag/);
  bad({ sections: [{ title: '卡', cards: [{ title: 'x', lines: ['1', '2', '3', '4', '5', '6', '7'] }] }] }, /最多 6 行/);
  const many = Array.from({ length: 2 }, () => ({ title: '多', cards: Array.from({ length: 21 }, (_, i) => ({ title: `店${i}` })) }));
  bad({ sections: many }, /最多 40 张卡片/);
});

test('邮件组装：给 html 时为 multipart/alternative，纯文本在前', () => {
  const raw = buildMessage({ from: { address: 'me@example.com' }, to: [{ address: 'a@example.com' }], subject: 's', text: '纯文本', html: '<p>网页</p>' });
  const b = /boundary="([^"]+)"/.exec(raw)[1];
  const parts = raw.split(`--${b}`);
  assert.equal(parts.length, 4);
  assert.match(parts[1], /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(parts[2], /Content-Type: text\/html; charset=UTF-8/);
  assert.equal(Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), '<p>网页</p>');
  assert.match(parts[3], /^--\r\n/);
});

test('评审 r2：加粗包住的网址链接目标正确；发起人没登记邮箱时页脚说明回复到发件邮箱；标题加粗拆开的凭据也被拦截', async () => {
  const { renderAnnouncement } = await import('../src/mail-render.js');
  const c = { headline: '请打开 **https://example.com/book** 订座', action: '不用做什么', sections: [{ title: 't', note: 'n' }] };
  const r = renderAnnouncement(c, { instanceName: 'i', subject: 's', senderName: 'Alice', guideUrl: null, recipientNames: ['a'], replyToSender: false });
  assert.match(r.html, /<strong><a href="https:\/\/example\.com\/book" [^>]*>https:\/\/example\.com\/book<\/a><\/strong> 订座/);
  assert.match(r.text, /请打开 https:\/\/example\.com\/book 订座/);
  assert.match(r.text, /直接回复会发到发件邮箱/);
  assert.doesNotMatch(r.text + r.html, /直接回复会发给 Alice/);

  const { s, m, mailer } = await setup();
  await m.admin.call('member_set_email', { member_id: 'm-bob', email: 'bob@example.com' });
  const ok = await m.alice.call('announce', msg('alice 没登记邮箱', '这封的回复应当发到发件邮箱。', key()));
  assert.equal(ok.data.status, 'sent', ok.text);
  assert.equal(mailer.sent[0].replyTo, null);
  assert.match(mailer.sent[0].text, /直接回复会发到发件邮箱/);
  const split = await m.alice.call('announce', msg(`**sbk_**${'ab'.repeat(24)}`, '标题里被加粗拆开的凭据。', key()));
  assert.equal(split.data.code, 'CREDENTIAL_DETECTED', split.text);
  await s.close();
});

test('卡片按钮：大众点评 / 携程 / 地图 / 网页按钮带图标渲染；域名与类型不符、非 http(s) 被拒', async () => {
  const { renderAnnouncement } = await import('../src/mail-render.js');
  const { normalizeContent } = await import('../src/announce.js');
  const base = { subject: '标题', headline: '一句话结论', action: '不用做什么' };
  const c = normalizeContent({ ...base, sections: [{ title: '店', cards: [{ title: '木屿', links: [
    { kind: 'dianping', url: 'https://www.dianping.com/shop/k1AbC2' },
    { kind: 'map', url: 'https://uri.amap.com/search?keyword=木屿&city=530700&callnative=1' },
    { kind: 'ctrip', url: 'https://hotels.ctrip.com/hotels/123456.html', label: '订房' },
    { kind: 'web', url: 'https://example.com/"a' .replace('"', '') },
  ] }] }] });
  const { html, text } = renderAnnouncement(c, { instanceName: 'i', subject: 's', senderName: 'w', guideUrl: null, recipientNames: ['a'] });
  assert.match(html, /<a href="https:\/\/www\.dianping\.com\/shop\/k1AbC2"[^>]*>🍴 大众点评<\/a>/);
  assert.match(html, /<a href="https:\/\/uri\.amap\.com\/search\?keyword=%E6%9C%A8%E5%B1%BF&amp;city=530700&amp;callnative=1"[^>]*>📍 地图<\/a>/);
  assert.match(html, />🏨 订房<\/a>/);
  assert.match(html, />🔗 链接<\/a>/);
  assert.match(text, /   🍴 大众点评：https:\/\/www\.dianping\.com\/shop\/k1AbC2\n   📍 地图：https:\/\/uri\.amap\.com\/search\?keyword=/);
  const bad = (link, re) => assert.throws(() => normalizeContent({ ...base, sections: [{ title: '店', cards: [{ title: 'x', links: [link] }] }] }), re);
  bad({ kind: 'map', url: 'https://evil.example/amap' }, /域名不对/);
  bad({ kind: 'dianping', url: 'https://dianping.com.evil.example/shop/1' }, /域名不对/);
  bad({ kind: 'web', url: 'javascript:alert(1)' }, /http\(s\)/);
  bad({ kind: 'web', url: 'https://example.com/a b' }, /有效网址|http\(s\)/);
  bad({ kind: 'phone', url: 'https://example.com' }, /kind 只能是/);
  bad({ kind: 'web', url: 'https://example.com', label: '这个按钮文字实在太长了' }, /最多 8 个字/);
  assert.throws(() => normalizeContent({ ...base, sections: [{ title: '店', cards: [{ title: 'x', links: Array(5).fill({ kind: 'web', url: 'https://example.com' }) }] }] }), /最多 4 个按钮/);
});
