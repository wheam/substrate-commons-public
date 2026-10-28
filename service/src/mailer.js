// 发信：经 Gmail API（HTTPS）以管理员自己的 Gmail 发出纯文本邮件。
// Railway 的 Hobby 套餐封了出站 SMTP，所以不用 SMTP；凭据是 OAuth 刷新令牌（只授权 gmail.send）。
// 报错里绝不带客户端密钥、刷新令牌或访问令牌。
import crypto from 'node:crypto';
import { fail, CommonsError } from './util.js';

export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function checkEmail(s) {
  const v = String(s ?? '').trim();
  if (v.length > 254 || !EMAIL_RE.test(v)) fail('INVALID_ARGUMENT', '邮箱格式不对');
  return v;
}

// 头部里的非 ASCII 文本按 RFC 2047 编码；按字符切块，保证每个编码词不超过 75 字节、不切断 UTF-8 字符
function encodeWords(s) {
  const text = String(s).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const chunks = [];
  let cur = '';
  for (const ch of text) {
    if (Buffer.byteLength(cur + ch) > 45) { chunks.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join('\r\n ');
}

// 显示名：纯 ASCII 用带转义的 quoted-string（逗号、@ 等不会被拆成另一个地址），其余用 RFC 2047 编码词
function displayName(name) {
  const v = String(name).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return `"${v.replace(/[\\"]/g, '\\$&')}"`;
  return encodeWords(v);
}
const mailbox = ({ name, address }) => (name ? `${displayName(name)} <${checkEmail(address)}>` : `<${checkEmail(address)}>`);

// 组装 RFC 5322 邮件（UTF-8，各部分 base64）：只有 text 时为纯文本；同时给 html 时为 multipart/alternative（纯文本在前作备用）
const part = (s) => Buffer.from(String(s).replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
export function buildMessage({ from, to, replyTo = null, subject, text, html = null, date = new Date() }) {
  if (!to?.length) fail('INVALID_ARGUMENT', '没有收件人');
  const headers = [
    `From: ${mailbox(from)}`,
    `To: ${to.map(mailbox).join(',\r\n ')}`,
    ...(replyTo ? [`Reply-To: ${mailbox(replyTo)}`] : []),
    `Subject: ${encodeWords(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
  ];
  if (!html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${part(text)}\r\n`;
  }
  const b = `=_commons_${crypto.randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${b}"`);
  return [
    headers.join('\r\n'), '',
    `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', part(text),
    `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', part(html),
    `--${b}--`, '',
  ].join('\r\n');
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// fetchImpl 可注入，便于测试
export function createGmailMailer({ clientId, clientSecret, refreshToken, fromAddress, fromName = null, fetchImpl = fetch, now = Date.now, timeoutMs = 20_000 }) {
  if (!clientId || !clientSecret || !refreshToken || !fromAddress) throw new Error('Gmail 发信需要 GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET、GMAIL_REFRESH_TOKEN、MAIL_FROM_ADDRESS');
  checkEmail(fromAddress);
  let cached = null;
  const secrets = [clientSecret, refreshToken];
  const scrub = (s) => {
    let out = String(s ?? '');
    for (const v of [...secrets, cached?.token].filter(Boolean)) out = out.split(v).join('[已隐藏]');
    return out.replace(/ya29\.[A-Za-z0-9._-]+/g, '[已隐藏]').slice(0, 300);
  };

  async function accessToken() {
    if (cached && cached.expires > now() + 60_000) return cached.token;
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new CommonsError('MAIL_FAILED', `连不上 Google 授权服务：${scrub(e.message)}`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant' || data.error === 'invalid_client' || data.error === 'unauthorized_client') {
        throw new CommonsError('MAIL_AUTH', `Gmail 授权已失效（${scrub(data.error)}），需要管理员重新授权`);
      }
      throw new CommonsError('MAIL_FAILED', `取 Gmail 访问令牌失败（HTTP ${res.status}${data.error ? ` ${scrub(data.error)}` : ''}）`);
    }
    cached = { token: data.access_token, expires: now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  return {
    fromAddress,
    // 文本里是否出现了已配置的发信密钥（用于在发出前拦截误粘的配置）
    leaks: (text) => [...secrets, cached?.token].filter(Boolean).some((v) => String(text).includes(v)),
    async send({ to, replyTo = null, subject, text, html = null }) {
      const raw = buildMessage({ from: { name: fromName, address: fromAddress }, to, replyTo, subject, text, html });
      const token = await accessToken();
      let res;
      try {
        res = await fetchImpl(SEND_URL, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) { throw new CommonsError('MAIL_UNKNOWN', `发信请求没有得到回应，邮件可能已发出也可能没有：${scrub(e.message)}`); }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401) cached = null;
      // 2xx 却拿不到 message id、或 5xx：Gmail 可能已经发出，按结果未知处理；4xx 是明确拒绝
      if (res.ok && data?.id) return { message_id: data.id, thread_id: data.threadId ?? null };
      const detail = `HTTP ${res.status}${data?.error?.message ? ` ${scrub(data.error.message)}` : ''}`;
      if (res.ok || res.status >= 500) throw new CommonsError('MAIL_UNKNOWN', `Gmail 的回应不完整（${detail}），邮件可能已发出也可能没有`);
      throw new CommonsError('MAIL_FAILED', `Gmail 拒绝发信（${detail}）`);
    },
  };
}
