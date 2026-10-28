// 公开镜像服务：用一把只读凭据定时查共享资料库；版本变了就整批读取同一提交的全部页面、脱敏、生成站点并整体替换。
// - 授权检查（whoami）每 POLL_SECONDS 一次，和整批构建分开调度；构建按页面 blob 缓存，只重读改过的页，并限速。
// - 凭据必须是 scope=read、有效权限只有 read / self_tokens，否则撤下内容并停止。
// - 凭据被吊销（授权检查或构建中任何一次 401）→ 立即撤下全部内容。连续 AUTH_TTL_MINUTES 没能确认授权（资料库维护、网络中断）→ 也撤下，直到再次确认。
// - 其他失败继续提供上一版；超过 STALE_MINUTES 没有成功同步，各入口标出同步中断。
// - MIRROR_DISABLED=1：不访问资料库，所有内容入口返回 503（独立于资料库的停用开关）；/healthz 仍 200，部署能完成切换。
// - 构建在独立线程里跑，有时限（BUILD_TIMEOUT_SECONDS）和输入总量上限（MIRROR_MAX_MB）。
// - 只提供固定路由，不读文件系统。
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createCommonsClient, TOKEN_RE } from './commons.js';
import { materialize } from './render.js';

export function loadConfig(env = process.env) {
  const commonsUrl = (env.COMMONS_URL ?? '').replace(/\/+$/, '');
  if (!commonsUrl) throw new Error('缺少 COMMONS_URL');
  const u = new URL(commonsUrl);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('COMMONS_URL 必须是 https');
  const disabled = env.MIRROR_DISABLED === '1';
  const token = String(env.COMMONS_TOKEN ?? '').trim();
  if (!disabled && !TOKEN_RE.test(token)) throw new Error('COMMONS_TOKEN 缺失或格式不对（应为 sbk_ 加 48 位十六进制，scope=read 的凭据）');
  const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d));
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    commonsUrl,
    token,
    disabled,
    port: num(env.PORT, 8080, 1, 65535),
    publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),
    pollMs: num(env.POLL_SECONDS, 60, 5, 600) * 1000,
    staleMs: num(env.STALE_MINUTES, 5, 1, 1440) * 60_000,
    authTtlMs: num(env.AUTH_TTL_MINUTES, 30, 2, 1440) * 60_000,
    exclude: env.MIRROR_EXCLUDE != null ? list(env.MIRROR_EXCLUDE) : ['_commons/'],
    pageOrder: list(env.MIRROR_PAGE_ORDER),
    promptTemplate: env.MIRROR_PROMPT ? String(env.MIRROR_PROMPT).replace(/\\n/g, '\n') : null,
    title: env.MIRROR_TITLE || null,
    timeZone: env.MIRROR_TIMEZONE || 'Asia/Shanghai',
    denyHosts: [...list(env.MIRROR_DENY_HOSTS), u.hostname],
    buildTimeoutMs: num(env.BUILD_TIMEOUT_SECONDS, 60, 5, 600) * 1000,
    maxBytes: num(env.MIRROR_MAX_MB, 16, 1, 256) * 1024 * 1024,
  };
}

// 日志一律去掉凭据
export const scrubber = (token) => (msg) => {
  let s = String(msg);
  if (token) s = s.split(token).join('***');
  return s.replace(/sb[ke]_[A-Za-z0-9_-]+/g, 'sb*_***');
};

// 在独立线程里调 buildSite，超时就终止线程
export function buildInWorker(data, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./build-worker.js', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const timer = setTimeout(() => { w.terminate(); reject(fail('BUILD_TIMEOUT', `构建超过 ${timeoutMs / 1000} 秒，已终止`)); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); if (m.ok) resolve(m); else reject(fail(m.code, m.message)); });
    w.once('error', (e) => { clearTimeout(timer); reject(fail('BUILD', `构建线程出错：${e.message}`)); });
  });
}

const etagOf = (buf) => `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`;
const READ_PERMS = new Set(['read', 'self_tokens']);

export function createMirror({ client, config, now = Date.now, log = console, builder = buildInWorker }) {
  const scrub = scrubber(config.token);
  const say = (level, msg) => log[level](scrub(msg));
  let site = null; // { commitRev, files: Map(route → { ...file, fresh, etag }) }
  let published = new Map(); // 每页上一次公开的版本，供下次某页复查不过时沿用
  const pageCache = new Map(); // `${path}@${blob_rev}` → { text, last_modified }
  let epoch = 0; // 每次撤下 +1；撤下之前开始的构建结果作废
  let lastAuthOkAt = null;
  let lastSyncOkAt = null;
  let halted = null;
  let lastError = null;
  let building = null;
  let buildFailures = 0;
  let nextBuildAt = 0;
  let timer = false; // false = 不自动排下一次（测试里手动调 tick）；start() 之后才定时
  let ticking = false;

  const takeDown = () => { epoch++; site = null; published = new Map(); pageCache.clear(); lastAuthOkAt = null; lastSyncOkAt = null; };

  async function build(who) {
    const myEpoch = epoch;
    const list = await client.listPages();
    const commitRev = list.commit_rev;
    const entries = (list.pages ?? []).filter((p) => p.path.endsWith('.md') && !config.exclude.some((x) => p.path.startsWith(x)));
    const pages = [];
    const keep = new Set();
    for (const p of entries) {
      const k = `${p.path}@${p.blob_rev}`;
      keep.add(k);
      let c = pageCache.get(k);
      if (!c) {
        const r = await client.readPage(p.path, commitRev);
        c = { text: r.text, last_modified: r.last_modified ?? null };
        if (epoch === myEpoch) pageCache.set(k, c);
      }
      pages.push({ path: p.path, ...c });
    }
    if (epoch !== myEpoch) return;
    for (const k of pageCache.keys()) if (!keep.has(k)) pageCache.delete(k);
    // 只传本轮页面对应的上一版；总量按实际传给构建线程的内容计算
    const previous = pages.filter((p) => published.has(p.path)).map((p) => [p.path, published.get(p.path)]);
    const bytes = pages.reduce((a, p) => a + Buffer.byteLength(p.text), 0) + previous.reduce((a, [, v]) => a + Buffer.byteLength(v.source ?? ''), 0);
    if (bytes > config.maxBytes) throw Object.assign(new Error(`资料总量 ${(bytes / 1048576).toFixed(1)} MB 超过上限 ${config.maxBytes / 1048576} MB`), { code: 'TOO_LARGE' });
    const built = await builder({
      title: config.title ?? who.instance?.display_name ?? who.instance?.name ?? '共享资料',
      instance: who.instance?.name ?? '', commitRev, generatedAt: now(), pages, previous,
      publicUrl: config.publicUrl, timeZone: config.timeZone, extraDenyHosts: config.denyHosts,
      pageOrder: config.pageOrder, promptTemplate: config.promptTemplate,
    }, config.buildTimeoutMs);
    if (epoch !== myEpoch) return; // 构建期间被撤下
    const files = new Map();
    for (const [route, f] of Object.entries(built.files)) {
      const fresh = Buffer.from(materialize(f, null, config.timeZone));
      files.set(route, { ...f, fresh, etag: etagOf(fresh) });
    }
    site = { commitRev, files };
    published = new Map(built.published);
    lastSyncOkAt = now();
    const hidden = Object.entries(built.stats).map(([k, v]) => `${k} ${v}`).join('、') || '无';
    say('log', `[mirror] 已发布 ${commitRev.slice(0, 7)}：${built.pageCount} 页；隐藏 ${hidden}`);
    for (const h of built.held) say('warn', `[mirror] 页面没有通过公开检查，沿用上一版或暂不公开：${h.path}（检出：${(h.leaks ?? []).join('、')}）`);
  }

  // 一次检查：确认授权；版本变了就开始构建（不等构建完成，构建期间照常做授权检查）。返回本次开始的构建（测试用）
  async function tick() {
    if (halted || config.disabled || ticking) return null;
    ticking = true;
    let started = null;
    try {
      const who = await client.whoami();
      const tok = who?.token ?? {};
      const perms = tok.effective_permissions ?? [];
      if (tok.scope !== 'read' || !perms.includes('read') || perms.some((p) => !READ_PERMS.has(p))) {
        halted = `镜像凭据 scope=${tok.scope}、权限 [${perms.join(', ')}]；只接受 scope=read 且只有读权限的凭据`;
        takeDown();
        say('error', `[mirror] ${halted}；已撤下内容并停止同步`);
        return null;
      }
      lastAuthOkAt = now();
      if (lastError) say('log', '[mirror] 资料库恢复可用');
      lastError = null;
      const rev = who?.instance?.published_commit_rev;
      if (site && rev && site.commitRev === rev) {
        lastSyncOkAt = now();
      } else if (!building && now() >= nextBuildAt) {
        building = started = build(who)
          .then(() => { buildFailures = 0; nextBuildAt = 0; })
          .catch((e) => {
            if (e.code === 'UNAUTHORIZED') { // 构建途中凭据被吊销：同样立即撤下
              if (site) say('warn', '[mirror] 凭据已失效（可能被吊销），已撤下公开内容');
              takeDown();
              return;
            }
            buildFailures++;
            nextBuildAt = now() + Math.min(config.pollMs * 2 ** Math.min(buildFailures, 4), 10 * 60_000);
            say('warn', `[mirror] 构建失败 ${e.code ?? 'ERROR'}：${e.message}（已读的页面会缓存，稍后继续）`);
          })
          .finally(() => { building = null; });
      }
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') {
        if (site) say('warn', '[mirror] 凭据已失效（可能被吊销），已撤下公开内容');
        takeDown();
      }
      const msg = `${e.code ?? 'ERROR'}：${e.message}`;
      if (msg !== lastError) say('warn', `[mirror] 检查失败 ${msg}`);
      lastError = msg;
    } finally {
      ticking = false;
      if (timer !== false && !halted) timer = setTimeout(tick, config.pollMs);
    }
    return started;
  }

  const available = () => !config.disabled && !halted && site != null && lastAuthOkAt != null && now() - lastAuthOkAt <= config.authTtlMs;
  const isStale = () => lastSyncOkAt == null || now() - lastSyncOkAt > config.staleMs;

  const BASE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
  };
  function send(req, res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { ...BASE_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    let pathname;
    try { pathname = new URL(req.url, 'http://mirror.invalid').pathname; } catch { return send(req, res, 400, 'Bad request\n'); }
    if (pathname === '/healthz') {
      // 停用（MIRROR_DISABLED）时进程就绪即 200，部署能完成切换；内容入口仍是 503
      const ok = available();
      const body = { ok, disabled: config.disabled, stale: ok ? isStale() : null, commit_rev: ok ? site.commitRev.slice(0, 7) : null,
        last_auth_ok_at: lastAuthOkAt ? new Date(lastAuthOkAt).toISOString() : null,
        last_sync_ok_at: lastSyncOkAt ? new Date(lastSyncOkAt).toISOString() : null };
      return send(req, res, ok || config.disabled ? 200 : 503, `${JSON.stringify(body)}\n`, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (pathname === '/robots.txt') return send(req, res, 200, 'User-agent: *\nAllow: /\n');
    if (!available()) {
      const why = config.disabled ? '公开同步已停用。\n' : halted ? '同步已停止，请联系资料库管理员。\n' : '资料暂时不可用，请稍后再试。\n';
      return send(req, res, 503, why, { 'Retry-After': '60' });
    }
    const f = site.files.get(pathname);
    if (!f) return send(req, res, 404, 'Not found\n');
    const stale = isStale();
    const body = stale ? Buffer.from(materialize(f, { lastSyncOkAt }, config.timeZone)) : f.fresh;
    const etag = stale ? etagOf(body) : f.etag;
    // 内容每次都要回源确认（no-cache + ETag），撤下后缓存不会继续提供
    const headers = { ...BASE_HEADERS, 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    headers['Content-Type'] = f.mime;
    if (!f.html) headers['Access-Control-Allow-Origin'] = '*';
    if (f.download) headers['Content-Disposition'] = 'attachment; filename="trip.md"';
    if (f.html) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  return {
    handle,
    tick,
    start() { timer = null; if (config.disabled) { say('log', '[mirror] MIRROR_DISABLED=1：不同步，内容入口返回 503'); return null; } return tick(); },
    stop() { if (timer) clearTimeout(timer); timer = false; },
    state: () => ({ commitRev: site?.commitRev ?? null, lastAuthOkAt, lastSyncOkAt, lastError, halted, building: !!building }),
  };
}

async function main() {
  const config = loadConfig();
  delete process.env.COMMONS_TOKEN;
  const client = createCommonsClient({ url: config.commonsUrl, token: config.token });
  const mirror = createMirror({ client, config });
  const server = http.createServer(mirror.handle);
  server.listen(config.port, () => console.log(`[mirror] 监听 :${config.port}，资料库 ${config.commonsUrl}，每 ${config.pollMs / 1000} 秒检查一次`));
  mirror.start();
  const shutdown = () => { mirror.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.COMMONS_TOKEN;
  main().catch((e) => { console.error(scrubber(token)(`[mirror] 启动失败：${e.message}`)); process.exit(1); });
}
