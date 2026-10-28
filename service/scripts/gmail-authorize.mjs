#!/usr/bin/env node
// 一次性：用管理员自己的 Gmail 授权共享库发通知邮件，拿到只含 gmail.send 权限的刷新令牌。
// 用法：node scripts/gmail-authorize.mjs <Google 下载的 client_secret_*.json> <输出文件> [--expect 邮箱] [--test-send]
// - 在跑这个脚本的电脑上的浏览器里完成授权（回调走 127.0.0.1 回环地址，PKCE）。
// - 输出文件权限 600，内容：client_id、client_secret、refresh_token、email。脚本不打印任何密钥。
// - --test-send：授权后用新令牌给授权账号自己发一封测试邮件。
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createGmailMailer } from '../src/mailer.js';

const [clientFile, outFile, ...rest] = process.argv.slice(2);
if (!clientFile || !outFile) {
  console.error('用法：node scripts/gmail-authorize.mjs <client_secret.json> <输出文件> [--expect 邮箱] [--test-send]');
  process.exit(2);
}
const expect = rest.includes('--expect') ? rest[rest.indexOf('--expect') + 1]?.toLowerCase() : null;
const testSend = rest.includes('--test-send');
const raw = JSON.parse(readFileSync(clientFile, 'utf8'));
const c = raw.installed ?? raw.web;
if (!c?.client_id || !c?.client_secret) { console.error('这个文件里没有 client_id / client_secret（应是“桌面应用”类型的 OAuth 客户端）'); process.exit(2); }

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirect = `http://127.0.0.1:${server.address().port}`;
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: c.client_id, redirect_uri: redirect, response_type: 'code',
  scope: 'openid email https://www.googleapis.com/auth/gmail.send',
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  ...(expect ? { login_hint: expect } : {}),
})}`;

console.log('在这台电脑的浏览器里完成授权（已尝试自动打开）：');
console.log(url);
execFile('open', [url], () => {});

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('10 分钟内没有完成授权')), 600_000);
  server.on('request', (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.get('state') && !q.get('error')) { res.writeHead(404).end(); return; }
    const ok = q.get('state') === state && q.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(ok ? '<p>授权完成，可以关掉这个页面了。</p>' : `<p>授权没有完成：${String(q.get('error') ?? 'state 不匹配').replace(/[<>&]/g, '')}</p>`);
    clearTimeout(timer);
    if (ok) resolve(q.get('code')); else reject(new Error(`授权没有完成：${q.get('error') ?? 'state 不匹配'}`));
  });
}).finally(() => server.close());

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }).toString(),
});
const tok = await res.json();
if (!res.ok || !tok.refresh_token) { console.error(`换取令牌失败：HTTP ${res.status} ${tok.error ?? ''}${tok.refresh_token ? '' : '（没有拿到刷新令牌）'}`); process.exit(1); }
const scopes = String(tok.scope ?? '').split(' ');
if (!scopes.includes('https://www.googleapis.com/auth/gmail.send')) { console.error('授权里没有勾选“代你发送邮件”，请重跑并勾选'); process.exit(1); }
// id_token 直接来自 Google 的 TLS 响应，这里只读其中的邮箱用于核对账号
const email = tok.id_token ? JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email?.toLowerCase() : null;
if (expect && email !== expect) { console.error(`授权的账号是 ${email ?? '未知'}，不是预期的 ${expect}；未保存`); process.exit(1); }

writeFileSync(outFile, JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: tok.refresh_token, email, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
chmodSync(outFile, 0o600);
console.log(`已保存到 ${outFile}（权限 600）。授权账号：${email}；权限：${scopes.filter((s) => s.includes('gmail')).join(' ')}`);

if (testSend) {
  const mailer = createGmailMailer({ clientId: c.client_id, clientSecret: c.client_secret, refreshToken: tok.refresh_token, fromAddress: email, fromName: '共享库发信测试' });
  const r = await mailer.send({ to: [{ address: email }], subject: '共享库发信测试', text: '这是一封测试邮件：共享库已经可以用这个 Gmail 发通知了。\n' });
  console.log(`测试邮件已发出，Gmail message id：${r.message_id}`);
}
