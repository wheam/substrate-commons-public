// /enroll：公开的接入协议说明 + 凭一次性码兑换专属凭据。
// 两条兑换路径：agent 自助 POST /enroll（JSON），或人在浏览器里打开 /enroll 手动兑换（凭据只显示一次）。
// 限速只对失败计数；有效码的兑换不受全局失败桶影响（码有 128 位熵，枚举不可行），攻击者无法借此阻断合法接入。
import { CommonsError } from './util.js';
import { clientIp } from './net.js';

const WINDOW_MS = 900_000;
const PER_IP = 10;
const GLOBAL = 200;

export function setupSnippets({ name, url, token }) {
  const t = token ?? '<TOKEN>';
  return {
    claude_code: `claude mcp add --transport http --scope user ${name} ${url} --header "Authorization: Bearer ${t}"`,
    codex_config_toml: `[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${t}" }`,
    hermes_config_yaml: `mcp_servers:\n  ${name}:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${t}"`,
    openclaw_json: JSON.stringify({ mcp: { servers: { [name]: { transport: 'streamable-http', url, headers: { Authorization: `Bearer ${t}` } } } } }, null, 2),
  };
}

export function protocolText({ baseUrl, name, displayName }) {
  const s = setupSnippets({ name, url: `${baseUrl}/mcp` });
  return [
    `共享资料库「${displayName}」接入协议（给 agent 读）`,
    '',
    '你会从主人那里拿到一个一次性码（sbe_ 开头，只能用一次）。按下面三步接入：',
    '',
    '1. 兑换专属凭据：',
    `   curl -sS -X POST ${baseUrl}/enroll -H 'Content-Type: application/json' -d '{"code":"sbe_..."}'`,
    '   成功返回 JSON：token（sbk_ 开头，只返回这一次）、mcp_url、server_name、setup（各客户端的配置写法）。',
    '   失败：401 码无效 / 410 码已用过或已过期 / 429 尝试过于频繁。码已用过而不是你用的，请立即告诉主人。',
    '',
    '2. 把凭据写进你自己的 MCP 配置（Streamable HTTP + Authorization: Bearer 请求头）。不要把 token 写进任何页面、聊天记录或代码仓库：',
    `   - Claude Code：${s.claude_code}`,
    `   - Codex（CLI 与桌面 App 共用 ~/.codex/config.toml）：\n${s.codex_config_toml.replace(/^/gm, '       ')}`,
    `   - Hermes（config.yaml）：\n${s.hermes_config_yaml.replace(/^/gm, '       ')}`,
    `   - OpenClaw：在配置的 mcp.servers 下加入\n${s.openclaw_json.replace(/^/gm, '       ')}`,
    '   多数客户端需要重启或新开会话才会加载新的 MCP 服务器。',
    '',
    '3. 验证：调用 whoami，确认返回的成员是你的主人；再调 conventions 读一遍共享契约和写作约定。',
    '',
    '人工兑换：在浏览器打开本页面（/enroll），输入一次性码，页面只显示一次凭据。',
  ].join('\n');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:760px;margin:2em auto;padding:0 1em;color:#222}pre{background:#f5f5f5;padding:.8em;overflow-x:auto;white-space:pre-wrap;word-break:break-all}input{font:inherit;padding:.4em;width:24em;max-width:100%}button{font:inherit;padding:.4em 1em}.warn{color:#a40}</style></head><body>${body}</body></html>`;

export function mountEnroll(app, { members, audit, notify, publicUrlFor, name, displayName, trustedHops, ipHeader, baseline, isMaintenance, closedNow = () => null, afterAuthChange = async () => {} }) {
  const fails = new Map();
  let global = { start: 0, n: 0 };
  const count = (b, t) => (b && t - b.start < WINDOW_MS ? b.n : 0);
  const ipLimited = (ip) => count(fails.get(ip ?? 'unknown'), Date.now()) >= PER_IP;
  const globalLimited = () => count(global, Date.now()) >= GLOBAL;
  const recordFail = (ip) => {
    const t = Date.now(); const k = ip ?? 'unknown';
    let b = fails.get(k);
    if (!b || t - b.start >= WINDOW_MS) { b = { start: t, n: 0 }; fails.set(k, b); }
    b.n++;
    if (t - global.start >= WINDOW_MS) global = { start: t, n: 0 };
    global.n++;
    if (fails.size > 2000) for (const [key, v] of fails) if (t - v.start >= WINDOW_MS) fails.delete(key);
  };

  async function redeem(req, code) {
    const ip = clientIp(req, { trustedHops, header: ipHeader });
    if (isMaintenance()) return { status: 503, body: { ok: false, error: '服务处于维护模式，暂不接受兑换' } };
    if (closedNow()) return { status: 503, body: { ok: false, error: closedNow() } };
    if (ipLimited(ip)) { audit({ event: 'enroll_rejected', reason: 'rate_limited', ip }); return { status: 429, body: { ok: false, error: '兑换尝试过于频繁，请稍后再试' } }; }
    if (typeof code !== 'string' || !/^sbe_[0-9a-f]{32}$/.test(code.trim())) {
      recordFail(ip);
      audit({ event: 'enroll_rejected', reason: 'malformed', ip });
      return { status: globalLimited() ? 429 : 400, body: { ok: false, error: '缺少或格式不对的一次性码（应为 sbe_ 加 32 位十六进制）' } };
    }
    try {
      const r = members.redeem({ code: code.trim(), ip, baselineCommit: await baseline() });
      await afterAuthChange(); // 先让库外见证记下这次授权变化，再把凭据交出去
      audit({ event: 'enroll_redeemed', member_id: r.member_id, token_id: r.token_id, client_label: r.client_label, ip, kind: r.kind });
      notify(`✅ 新 agent 接入：${r.display_name}（${r.member_id}）的 ${r.client_label}，scope=${r.scope}${ip ? `，来源 ${ip}` : ''}`);
      const base = publicUrlFor(req);
      const mcpUrl = `${base}/mcp`;
      return {
        status: 200,
        body: {
          ok: true, token: r.token, token_id: r.token_id, member_id: r.member_id, display_name: r.display_name,
          client_label: r.client_label, scope: r.scope, mcp_url: mcpUrl, server_name: name,
          setup: setupSnippets({ name, url: mcpUrl, token: r.token }),
          next: '把 token 写进你自己的 MCP 配置（见 setup），重启或新开会话后调用 whoami 验证；token 只返回这一次，不要写进任何页面或聊天记录',
        },
      };
    } catch (e) {
      recordFail(ip);
      const code2 = e instanceof CommonsError ? e.code : 'INVALID_CODE';
      audit({ event: 'enroll_rejected', reason: code2, ip });
      if (code2 === 'CODE_USED') notify('⚠️ 有人用一枚已经兑换过的一次性码再次兑换（可能是抢注或重放）。如果不是你在接入新 agent，请吊销对应凭据');
      if (globalLimited()) return { status: 429, body: { ok: false, error: '兑换尝试过于频繁，请稍后再试' } };
      const status = code2 === 'CODE_USED' || code2 === 'CODE_EXPIRED' ? 410 : (code2 === 'MEMBER_DISABLED' ? 403 : 401);
      return { status, body: { ok: false, code: code2, error: e instanceof CommonsError ? e.message : '一次性码无效' } };
    }
  }

  app.get('/enroll', (req, res) => {
    const base = publicUrlFor(req);
    const text = protocolText({ baseUrl: base, name, displayName });
    if ((req.headers.accept ?? '').includes('text/html')) {
      return res.type('html').send(page(`接入 · ${displayName}`, `<h1>接入共享资料库「${esc(displayName)}」</h1>
<p>在这里输入管理员私聊发给你的一次性码（sbe_ 开头）。兑换成功后，凭据<strong>只显示一次</strong>，请立刻写进你的 agent 配置。</p>
<form method="post" action="/enroll/redeem"><input name="code" autocomplete="off" placeholder="sbe_..." required> <button>兑换</button></form>
<h2>给 agent 的协议</h2><pre>${esc(text)}</pre>`));
    }
    return res.type('text/plain; charset=utf-8').send(text);
  });

  app.post('/enroll', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = await redeem(req, req.body?.code);
    res.status(r.status).json(r.body);
  });

  app.post('/enroll/redeem', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const r = await redeem(req, req.body?.code);
    if (!r.body.ok) return res.status(r.status).type('html').send(page('兑换失败', `<h1>兑换失败</h1><p class="warn">${esc(r.body.error)}</p><p><a href="/enroll">返回</a></p>`));
    const b = r.body;
    return res.type('html').send(page('兑换成功', `<h1>兑换成功：${esc(b.display_name)} · ${esc(b.client_label)}</h1>
<p class="warn">下面的凭据只显示这一次，离开或刷新页面后无法再次查看。请立即写进你的 agent 配置；不要发到群里或写进任何页面。</p>
<p>凭据：</p><pre>${esc(b.token)}</pre>
<p>MCP 地址：</p><pre>${esc(b.mcp_url)}</pre>
<h2>配置写法</h2>
<p>Claude Code：</p><pre>${esc(b.setup.claude_code)}</pre>
<p>Codex（~/.codex/config.toml）：</p><pre>${esc(b.setup.codex_config_toml)}</pre>
<p>Hermes（config.yaml）：</p><pre>${esc(b.setup.hermes_config_yaml)}</pre>
<p>OpenClaw：</p><pre>${esc(b.setup.openclaw_json)}</pre>
<p>配置后新开一个会话，让 agent 调用 whoami 验证。</p>`));
  });
}
