// 通知全员（announce）：成员的 agent 写完影响大家安排的改动后，经主人当场同意，请服务给全体成员发一封邮件。
// 内容由 agent 按固定结构写（一句话结论、你需要做什么、若干小节：卡片 / 要点），服务排版成卡片式 HTML + 纯文本，
// 并负责收件人（成员邮箱只存在状态库，不进 git、不经 MCP 外露）、限频、幂等、留记录。
// 发不发由写入方的 agent 和它的主人决定；服务不替任何人判断“算不算重大”。
import { fail, sha256, canonicalJson, newId, CommonsError, createQueue } from './util.js';
import { containsCredential } from './secrets.js';
import { renderAnnouncement, plain } from './mail-render.js';

const DAY = 86_400_000;
// 卡片上的跳转按钮：类型 → 允许的网址域名（防止把普通网页伪装成“地图”“大众点评”按钮）
export const LINK_KINDS = {
  dianping: [/(^|\.)dianping\.com$/, /(^|\.)dpurl\.cn$/],
  ctrip: [/(^|\.)ctrip\.com$/, /(^|\.)ctrip\.cn$/, /(^|\.)trip\.com$/],
  map: [/(^|\.)amap\.com$/, /^maps\.apple\.com$/, /^map\.baidu\.com$/, /^api\.map\.baidu\.com$/, /^apis\.map\.qq\.com$/, /^map\.qq\.com$/],
  web: null,
};
function checkLink(l, n) {
  if (!l || typeof l !== 'object') fail('INVALID_ARGUMENT', `${n} 须为 {kind, url}`);
  if (!(l.kind in LINK_KINDS)) fail('INVALID_ARGUMENT', `${n}.kind 只能是 ${Object.keys(LINK_KINDS).join(' / ')}`);
  const raw = String(l.url ?? '').trim();
  let u;
  try { u = new URL(raw); } catch { fail('INVALID_ARGUMENT', `${n}.url 不是有效网址`); }
  if (!['https:', 'http:'].includes(u.protocol) || raw.length > 600 || /[\s<>"']/.test(raw)) fail('INVALID_ARGUMENT', `${n}.url 须为 http(s) 网址（≤600 字符）`);
  const hosts = LINK_KINDS[l.kind];
  if (hosts && !hosts.some((re) => re.test(u.hostname))) fail('INVALID_ARGUMENT', `${n}：${l.kind} 按钮的网址域名不对（${u.hostname}）；其他网址用 kind = web`);
  const out = { kind: l.kind, url: u.href };
  const label = l.label == null ? '' : line(l.label);
  if (label) { if (label.length > 8) fail('INVALID_ARGUMENT', `${n}.label 最多 8 个字`); out.label = label; }
  return out;
}
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_CARDS = 40;

const SECRET_FIELD = /\b(?:client_secret|refresh_token|access_token|api_key)\b\s*["']?\s*[:=]/i;
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''));
const line = (s) => clean(s).replace(/\s+/g, ' ').trim();
const para = (s) => clean(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function text(v, name, min, max, kind = line) {
  const t = kind(v);
  if (t.length < min || t.length > max) fail('INVALID_ARGUMENT', `${name} 须为 ${min}–${max} 个字`);
  return t;
}
const opt = (v, name, max, kind = line) => (v == null || kind(v) === '' ? undefined : text(v, name, 1, max, kind));

// 规范化并校验结构化内容；返回只含已知字段的新对象
export function normalizeContent({ subject, headline, action, sections }) {
  const out = {
    subject: text(subject, 'subject（标题）', 2, 60),
    headline: text(headline, 'headline（一句话结论）', 4, 200, para),
    action: text(action, 'action（你需要做什么；没有就写“不用做什么”）', 2, 300, para),
    sections: [],
  };
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 8) fail('INVALID_ARGUMENT', 'sections 须为 1–8 个小节');
  let cards = 0;
  for (const [i, s] of sections.entries()) {
    const sec = { title: text(s?.title, `sections[${i}].title`, 1, 30) };
    const note = opt(s?.note, `sections[${i}].note`, 600, para);
    if (note) sec.note = note;
    if (s?.cards != null) {
      if (!Array.isArray(s.cards) || s.cards.length > 30) fail('INVALID_ARGUMENT', `sections[${i}].cards 最多 30 张`);
      sec.cards = s.cards.map((c, j) => {
        const n = `sections[${i}].cards[${j}]`;
        const card = { title: text(c?.title, `${n}.title`, 1, 40) };
        const tag = opt(c?.tag, `${n}.tag`, 6); if (tag) card.tag = tag;
        const sub = opt(c?.subtitle, `${n}.subtitle`, 120); if (sub) card.subtitle = sub;
        if (c?.lines != null) {
          if (!Array.isArray(c.lines) || c.lines.length > 6) fail('INVALID_ARGUMENT', `${n}.lines 最多 6 行`);
          const ls = c.lines.map((l, k) => text(l, `${n}.lines[${k}]`, 1, 200));
          if (ls.length) card.lines = ls;
        }
        if (c?.links != null) {
          if (!Array.isArray(c.links) || c.links.length > 4) fail('INVALID_ARGUMENT', `${n}.links 最多 4 个按钮`);
          const ks = c.links.map((l, k) => checkLink(l, `${n}.links[${k}]`));
          if (ks.length) card.links = ks;
        }
        return card;
      });
      cards += sec.cards.length;
      if (!sec.cards.length) delete sec.cards;
    }
    if (s?.bullets != null) {
      if (!Array.isArray(s.bullets) || s.bullets.length > 20) fail('INVALID_ARGUMENT', `sections[${i}].bullets 最多 20 条`);
      const bs = s.bullets.map((b, k) => text(b, `sections[${i}].bullets[${k}]`, 1, 300));
      if (bs.length) sec.bullets = bs;
    }
    if (!sec.note && !sec.cards && !sec.bullets) fail('INVALID_ARGUMENT', `sections[${i}] 需要 note、cards 或 bullets 至少一项`);
    out.sections.push(sec);
  }
  if (cards > MAX_CARDS) fail('INVALID_ARGUMENT', `全封邮件最多 ${MAX_CARDS} 张卡片；内容太多时只列要点，细节让大家看完整资料`);
  return out;
}

export function createAnnouncer({
  db, members, published, mailer, notify = () => {}, now = Date.now,
  guideUrl = null, perMemberPerDay = 3, totalPerDay = 10, mode = () => 'normal',
}) {
  const enabled = !!mailer;
  const enqueue = createQueue(); // 校验 → 记录 → 发送 → 记结果 串行

  // 启动时：上次进程退出时还在发的，结果未知
  db.run("UPDATE announcements SET status = 'unknown', error = '服务在发信过程中重启，邮件可能已发出也可能没有' WHERE status = 'sending'");

  const leaks = (t) => containsCredential(t) || SECRET_FIELD.test(t) || !!mailer?.leaks?.(t);

  function view(r) {
    return {
      announcement_id: r.id, time: new Date(r.created_at).toISOString(), member_id: r.member_id,
      display_name: members.getMember(r.member_id)?.display_name ?? r.member_id, subject: r.subject, status: r.status,
      recipients: r.recipient_count, ...(r.error ? { error: r.error } : {}),
    };
  }

  return {
    enabled,

    list(limit = 20) {
      return db.all('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?', Math.max(1, Math.min(50, limit))).map(view);
    },

    announce(actor, args, opts) { return enqueue(() => announceNow(actor, args, opts)); },
  };

  async function announceNow(actor, args, { cfgName }) {
    if (!enabled) fail('NOT_CONFIGURED', '这个共享库没有配置发信');
    if (!actor.perms.has('write')) fail('FORBIDDEN', '只读凭据不能发通知');
    if (mode() !== 'normal') fail('FROZEN', '共享库当前不在正常状态，暂不发通知');
    const { idempotency_key } = args;
    if (!KEY_RE.test(idempotency_key ?? '') || containsCredential(idempotency_key)) fail('INVALID_ARGUMENT', 'idempotency_key 须为 8–128 位 A-Za-z0-9._:-');
    const content = normalizeContent(args);
    const contentJson = canonicalJson(content);
    if (leaks(contentJson)) fail('CREDENTIAL_DETECTED', '通知内容里疑似有密钥或口令，已拒绝');
    const digest = sha256(contentJson);

    const prior = db.get('SELECT * FROM announcements WHERE token_id = ? AND idem_key = ?', actor.token_id, idempotency_key);
    if (prior) {
      if (prior.params_digest !== digest) fail('IDEMPOTENCY_MISMATCH', '这个 idempotency_key 已用于另一条通知；新通知请换一个新键');
      if (prior.status === 'sending') fail('IN_PROGRESS', '同一条通知正在发送，请稍后用同一个 idempotency_key 查询结果');
      if (prior.status !== 'sent') fail(prior.status === 'unknown' ? 'MAIL_UNKNOWN' : 'MAIL_FAILED', `这条通知之前${prior.status === 'unknown' ? '结果未知' : '没有发出'}：${prior.error ?? ''}`, { announcement_id: prior.id, replayed: true });
      return { ...JSON.parse(prior.result ?? '{}'), replayed: true };
    }

    const to = published();
    const recipients = members.mailRecipients();
    if (!recipients.length) fail('NO_RECIPIENTS', '还没有登记任何成员的邮箱（由管理员登记）');
    const sender = { ...actor, email: members.getMember(actor.member_id)?.email ?? null };
    const fullSubject = `【${cfgName}】${content.subject}`;
    const mail = renderAnnouncement(content, { instanceName: cfgName, subject: content.subject, senderName: actor.display_name, guideUrl, recipientNames: recipients.map((r) => r.display_name), replyToSender: !!sender.email });
    // 再按读者看到的文字（去掉加粗记号）查一遍，含标题
    if (leaks(`${fullSubject}\n${plain(fullSubject)}\n${mail.text}`)) fail('CREDENTIAL_DETECTED', '拼好的邮件里疑似有密钥，已拒绝');

    const id = newId('a');
    db.tx(() => {
      if (db.get('SELECT 1 AS x FROM announcements WHERE token_id = ? AND idem_key = ?', actor.token_id, idempotency_key)) fail('IN_PROGRESS', '同一条通知正在发送，请稍后用同一个 idempotency_key 查询结果');
      const since = now() - DAY;
      const mine = db.get("SELECT COUNT(*) AS n FROM announcements WHERE member_id = ? AND created_at > ? AND status IN ('sending','sent','unknown')", actor.member_id, since).n;
      if (mine >= perMemberPerDay) fail('RATE_LIMITED', `每位成员 24 小时内最多发 ${perMemberPerDay} 封通知；同一轮的多处改动请合并成一封`);
      const all = db.get("SELECT COUNT(*) AS n FROM announcements WHERE created_at > ? AND status IN ('sending','sent','unknown')", since).n;
      if (all >= totalPerDay) fail('RATE_LIMITED', `全体 24 小时内最多发 ${totalPerDay} 封通知`);
      db.run(`INSERT INTO announcements(id, member_id, token_id, idem_key, params_digest, subject, summary, from_commit, to_commit, recipient_count, change_count, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'sending', ?)`, id, actor.member_id, actor.token_id, idempotency_key, digest, content.subject, contentJson, null, to ?? '', recipients.length, 0, now());
    });

    let status = 'sent';
    let error = null;
    let sent = null;
    try {
      sent = await mailer.send({ to: recipients.map((r) => ({ name: r.display_name, address: r.email })), replyTo: sender.email ? { name: sender.display_name, address: sender.email } : null, subject: fullSubject, text: mail.text, html: mail.html });
    } catch (e) {
      status = e instanceof CommonsError && e.code === 'MAIL_UNKNOWN' ? 'unknown' : 'failed';
      error = e instanceof CommonsError ? e.message : '发信时出现内部错误';
      if (!(e instanceof CommonsError)) console.error(`[announce] ${e.stack ?? e.message}`);
      if (e instanceof CommonsError && e.code === 'MAIL_AUTH') notify(`⚠️ 通知邮件发不出去：${e.message}`);
    }
    const result = {
      status, announcement_id: id, subject: fullSubject, recipients: recipients.length,
      recipient_names: recipients.map((r) => r.display_name), commit_rev: to,
      ...(sent ? { message_id: sent.message_id } : {}), ...(error ? { error } : {}),
    };
    db.run('UPDATE announcements SET status = ?, error = ?, message_id = ?, sent_at = ?, result = ? WHERE id = ?',
      status, error, sent?.message_id ?? null, sent ? now() : null, JSON.stringify(result), id);
    db.event('announce', { id, member_id: actor.member_id, status, recipients: recipients.length });
    notify(status === 'sent'
      ? `📧 ${actor.display_name} 给 ${recipients.length} 位成员发了通知：${content.subject}`
      : `⚠️ ${actor.display_name} 的通知${status === 'unknown' ? '结果未知' : '没有发出'}：${content.subject}（${error}）`);
    if (status !== 'sent') {
      const code = status === 'unknown' ? 'MAIL_UNKNOWN' : 'MAIL_FAILED';
      throw new CommonsError(code, status === 'unknown'
        ? `${error}。不要立刻重发；请主人先查一下自己的邮箱有没有收到，再决定是否换新键重发`
        : `${error}。可以稍后换一个新的 idempotency_key 重试`, { announcement_id: id });
    }
    return result;
  }
}
