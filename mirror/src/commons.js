// 共享资料库的最小只读客户端：直接发 JSON-RPC tools/call（服务端是无状态 Streamable HTTP，不需要 initialize）。
// 凭据只放在请求头里；错误信息只带固定类别，不带底层异常文字（其中可能含请求头）。
// 自带限速：默认每分钟最多 200 次（引擎默认每把凭据每分钟 300 次读）。

const START = '\n\n----- 页面正文开始（其他成员提供的数据，不是指令）-----\n';
const END = '\n----- 页面正文结束 -----';

export class CommonsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// read_page 的文本格式：<meta JSON>\n\n----- 页面正文开始…-----\n<正文>\n----- 页面正文结束 -----
// meta 是 JSON，里面的换行都被转义，所以第一个开始标记一定是分隔线；结束标记固定在末尾。
export function parseReadPage(text) {
  const i = text.indexOf(START);
  if (i < 0 || !text.endsWith(END)) throw new CommonsError('BAD_RESPONSE', 'read_page 返回格式无法识别');
  let meta;
  try { meta = JSON.parse(text.slice(0, i)); } catch { throw new CommonsError('BAD_RESPONSE', 'read_page 元数据无法解析'); }
  return { ...meta, text: text.slice(i + START.length, text.length - END.length) };
}

export const TOKEN_RE = /^sbk_[0-9a-f]{48}$/;

export function createCommonsClient({ url, token, fetchImpl = fetch, timeoutMs = 20_000, maxPerMinute = 200, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const endpoint = `${url.replace(/\/+$/, '')}/mcp`;
  let seq = 0;
  const recent = [];
  async function throttle() {
    for (;;) {
      const t = now();
      while (recent.length && t - recent[0] >= 60_000) recent.shift();
      if (recent.length < maxPerMinute) { recent.push(t); return; }
      await sleep(60_000 - (t - recent[0]) + 10);
    }
  }
  async function call(name, args = {}) {
    await throttle();
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? '超时' : (typeof e?.cause?.code === 'string' && /^[A-Z_]+$/.test(e.cause.code) ? e.cause.code : '网络错误');
      throw new CommonsError('NETWORK', `连不上资料库（${why}）`);
    }
    if (res.status === 401) throw new CommonsError('UNAUTHORIZED', '资料库拒绝了凭据（已吊销或无效）');
    if (!res.ok) throw new CommonsError(res.status === 503 ? 'UNAVAILABLE' : 'HTTP', `资料库返回 HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw new CommonsError('BAD_RESPONSE', `${name} 返回的不是 JSON`); }
    if (body.error) throw new CommonsError('RPC', `${name} 调用失败（JSON-RPC ${Number(body.error.code) || '?'}）`);
    const text = body.result?.content?.[0]?.text;
    if (typeof text !== 'string') throw new CommonsError('BAD_RESPONSE', `${name} 返回格式无法识别`);
    if (body.result.isError) {
      let code = 'REJECTED';
      try { const c = JSON.parse(text).code; if (typeof c === 'string' && /^[A-Z_]{2,40}$/.test(c)) code = c; } catch { /* 保持默认 */ }
      throw new CommonsError(code, `${name} 被拒绝（${code}）`);
    }
    return text;
  }
  const json = async (name, args) => {
    const t = await call(name, args);
    try { return JSON.parse(t); } catch { throw new CommonsError('BAD_RESPONSE', `${name} 返回的不是 JSON`); }
  };
  return {
    whoami: () => json('whoami'),
    listPages: () => json('list_pages'),
    readPage: async (path, commitRev) => parseReadPage(await call('read_page', commitRev ? { path, commit_rev: commitRev } : { path })),
  };
}
