// substrate-commons：小团体共用的 markdown + git 资料库服务（MCP Streamable HTTP，无状态）。
// 一个部署 = 一个实例 = 一个写进程。路由：/healthz、/enroll（公开），/mcp（Bearer 认证）。
import express from 'express';
import path from 'node:path';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb, backupDb } from './db.js';
import { GitRepo } from './git.js';
import { createMembers } from './members.js';
import { createContent } from './content.js';
import { createSync } from './sync.js';
import { createWatermark } from './watermark.js';
import { startAdminSocket } from './admin-socket.js';
import { acquireMaintenanceLock, releaseMaintenanceLock } from './sync.js';
import { forkStatus, forkRecoverLocked, resolveMaintenanceLocked, enterMaintenanceLocked, statusOf } from './maintenance.js';
import { createEngine } from './engine.js';
import { createHistory } from './history.js';
import { createAudit } from './audit.js';
import { createRateLimiter } from './ratelimit.js';
import { boot } from './startup.js';
import { buildMcpServer } from './mcp.js';
import { mountEnroll } from './enroll.js';
import { clientIp } from './net.js';
import { createAnnouncer } from './announce.js';
import { createGmailMailer } from './mailer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.1.0';
export const DEFAULT_TEMPLATE_DIR = path.resolve(here, '..', 'templates', 'instance');

export function sshCommandFor(keyFile, knownHostsFile) {
  if (!keyFile) return null;
  return `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes${knownHostsFile ? ` -o UserKnownHostsFile=${knownHostsFile}` : ''}`;
}

export function createNotifier(url, log = console) {
  if (!url) return () => {};
  return (text) => {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text: `[substrate-commons] ${text}` } }), signal: AbortSignal.timeout(5000) })
      .catch((e) => log.error?.(`[notify] 发送失败：${e.message}`));
  };
}

// 组装服务；返回 { app, ctx, report, close }。所有外部依赖都可注入，便于测试。
export async function createService(opts) {
  const {
    dataDir, repoUrl = null, sshCommand = null, publicUrl = null, slug, displayName,
    bootstrap = {}, templateDir = DEFAULT_TEMPLATE_DIR, trustedHops = 1, ipHeader = null,
    fault = () => {}, pushImpl = null, notify = () => {}, log = console, syncWaitMs = 4000,
    maxPending = 20, maxPendingAgeMs = 3_600_000, auditFile = path.join(dataDir, 'audit.log'), auditStdout = true,
    witnessWaitMs = 8000, gateRetryMs = 30_000, watermarkRef = undefined,
    mailer = null, announce: announceOpts = {},
  } = opts;
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error('INSTANCE_NAME 必须是小写英文、数字、-（如 demo-commons）');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'state', 'commons.db'));
  const repo = new GitRepo(path.join(dataDir, 'instance.git'), { sshCommand, remoteUrl: repoUrl });
  const members = createMembers({ db });
  const content = createContent({ repo, displayName });
  const notifyAdmin = (text) => { try { notify(text); } catch { /* 通知失败不影响主流程 */ } };
  const sync = createSync({ db, repo, hasRemote: !!repoUrl, notify: notifyAdmin, pushImpl, maxPending, maxAgeMs: maxPendingAgeMs, log });
  const engine = createEngine({ db, repo, content, sync, slug, fault, syncWaitMs });
  // 运行中发现远端见证高于状态库（volume 被回滚后又有人推进过见证）→ 立刻维护并作废全部凭据
  const onStale = (remote) => {
    members.resetAuth('auth_stale', { floor: remote.epoch });
    sync.setMode('maintenance', 'auth_stale', { message: `远端授权水位（${remote.epoch}）高于状态库，状态库可能是旧快照；已作废全部凭据` });
  };
  const watermark = createWatermark({ db, repo, dir: path.join(dataDir, 'state'), hasRemote: !!repoUrl, log, onStale, ref: watermarkRef });
  members.onAuthChange = (epoch) => { watermark.record(epoch); };
  // 授权变更的接口在返回前等远端见证推送完成（最多 witnessWaitMs）
  const afterAuthChange = () => Promise.race([watermark.flush(), new Promise((r) => { setTimeout(r, witnessWaitMs).unref?.(); })]);
  const report = await boot({ db, repo, members, engine, sync, watermark, remoteUrl: repoUrl, bootstrap, templateDir, templateVars: { DISPLAY_NAME: displayName, INSTANCE_NAME: slug }, log });
  const history = createHistory({ db, repo, members, published: engine.published, secret: () => db.meta.get('cursor_secret') ?? 'uninitialized' });
  const audit = createAudit({ file: auditFile, stdout: auditStdout });
  const rateLimit = createRateLimiter();
  const announcer = createAnnouncer({ db, members, published: engine.published, mailer, notify: notifyAdmin, mode: () => sync.mode().mode, ...announceOpts });
  const publicUrlFor = (req) => publicUrl ?? `${req.protocol}://${req.get('host')}`;
  const ctx = { db, repo, members, content, sync, engine, history, audit, rateLimit, watermark, afterAuthChange, displayName, slug, version: VERSION, publicUrl, announcer };
  const isMaintenance = () => (db.meta.get('mode') ?? 'normal') === 'maintenance';

  // 认证闸门（R2-1）：核实远端授权水位、确认状态库没有落后之前，不接受任何认证请求和兑换
  const gate = { open: false, message: '服务正在启动，核实授权状态中，请稍后再试' };
  let gateTimer = null;
  async function verifyGate() {
    if (isMaintenance()) { gate.open = true; return true; }
    let v;
    try { v = await watermark.verify(); } catch (e) { v = { ok: false, retry: e.message }; }
    if (v.ok) {
      if (report.pendingForce) { // 见证核实之后才处理 BOOTSTRAP_FORCE（R3-1）
        report.pendingForce = false;
        const r = members.registerBootstrap({ code: bootstrap.code, member_id: bootstrap.member, display_name: bootstrap.name, reason: 'force' });
        report.actions.push(r.registered ? 'bootstrap_force_registered' : 'bootstrap_force_ignored_already_used');
      }
      gate.open = true;
      return true;
    }
    if (v.stale) {
      members.resetAuth('auth_stale', { floor: v.stale.floor });
      sync.setMode('maintenance', 'auth_stale', { message: `库外授权水位（${v.stale.floor}）高于状态库，状态库可能是旧快照；已作废全部凭据` });
      gate.open = true;
      return true;
    }
    gate.open = false;
    gate.message = `服务正在核实授权状态（${String(v.retry).slice(0, 120)}），请稍后再试`;
    log.warn?.(`[gate] ${gate.message}`);
    return false;
  }
  // 核实失败就定时重试；启动和维护恢复共用这一个入口（R4-1）
  function scheduleGateRetry() {
    if (gateTimer) return;
    gateTimer = setTimeout(async () => { gateTimer = null; if (!(await verifyGate())) scheduleGateRetry(); }, gateRetryMs);
    gateTimer.unref?.();
  }
  const verifyOrRetry = async () => { const ok = await verifyGate(); if (!ok) scheduleGateRetry(); return ok; };
  await verifyOrRetry();
  const closedNow = () => (gate.open ? null : gate.message);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  mountEnroll(app, {
    members, audit, notify: notifyAdmin, publicUrlFor, name: `commons-${slug}`, displayName, trustedHops, ipHeader,
    baseline: async () => engine.published(), isMaintenance, closedNow, afterAuthChange,
  });

  const identify = (req) => {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    return m ? members.identify(m[1]) : null;
  };

  app.post('/mcp', async (req, res) => {
    const ip = clientIp(req, { trustedHops, header: ipHeader });
    if (isMaintenance()) {
      audit({ event: 'rejected_maintenance', ip });
      return res.status(503).json({ error: 'maintenance', message: '服务处于维护模式，暂不接受请求' });
    }
    if (closedNow()) return res.status(503).set('Retry-After', '30').json({ error: 'starting', message: closedNow() });
    const actor = identify(req);
    if (!actor) {
      audit({ event: 'auth_rejected', ip });
      return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
    }
    const moved = members.noteIp(actor.token_id, ip);
    if (moved) {
      db.event('token_new_ip', { token_id: actor.token_id, member_id: actor.member_id, ip, previous: moved.previous });
      notifyAdmin(`ℹ️ ${actor.display_name} 的 ${actor.client_label} 从新的来源访问：${ip}（之前 ${moved.previous}）。如果不是本人，请吊销这把凭据`);
    }
    try {
      const server = await buildMcpServer(ctx, actor, { ip });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      res.on('finish', () => fault('after_response'));
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error?.(`[mcp] 请求处理失败：${e.stack ?? e.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // express.json 解析失败等
  app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    res.status(err.status ?? 400).json({ error: err.type ?? 'bad_request' });
  });

  const timers = [];
  function startBackground({ pushEveryMs = 60_000, fetchEveryMs = 300_000, backupEveryMs = 86_400_000, backupDir = path.join(dataDir, 'backups'), keepBackups = 14 } = {}) {
    if (repoUrl) {
      // 同步不占单写者队列：后台 worker 单飞、合并请求
      timers.push(setInterval(() => { sync.pushNow().catch((e) => log.error?.(`[sync] ${e.message}`)); }, pushEveryMs));
      timers.push(setInterval(() => { sync.checkRemote().catch((e) => log.error?.(`[sync] ${e.message}`)); }, fetchEveryMs));
      sync.pushNow().catch(() => {});
      timers.push(setInterval(() => { if (watermark.pending()) watermark.pushRemote(members.authEpoch()); }, pushEveryMs));
    }
    const runBackup = () => engine.enqueue(async () => {
      const dir = path.join(backupDir, new Date().toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      if (engine.published()) await repo.bundle(path.join(dir, 'instance.bundle'));
      rmSync(path.join(dir, 'commons.db'), { force: true });
      backupDb(db, path.join(dir, 'commons.db'));
      const all = readdirSync(backupDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      for (const d of all.slice(0, Math.max(0, all.length - keepBackups))) rmSync(path.join(backupDir, d), { recursive: true, force: true });
    }).catch((e) => log.error?.(`[backup] 失败：${e.message}`));
    timers.push(setInterval(runBackup, backupEveryMs));
    setTimeout(runBackup, 30_000).unref?.();
    for (const t of timers) t.unref?.();
  }

  // 维护命令通道：在单写者队列里独占执行，并持有维护锁让后台网络结果作废
  let admin = null;
  async function startAdmin() {
    const mctx = { db, repo, members, content, sync, engine, watermark };
    const exclusive = (fn) => engine.enqueue(async () => {
      acquireMaintenanceLock(db, { holder: 'server-admin' });
      // 等后台在途的网络操作结束（最多 5 秒）；就算没等到，它的结果也会因维护代数变化而作废
      try { await Promise.race([sync.idle(), new Promise((r) => { setTimeout(r, 5000).unref?.(); })]); return await fn(); } finally { releaseMaintenanceLock(db); }
    });
    admin = await startAdminSocket({
      dataDir, log,
      handlers: {
        status: () => statusOf(mctx),
        'fork-status': () => forkStatus(mctx),
        'fork-recover': (a) => exclusive(() => forkRecoverLocked(mctx, a)),
        'resolve-maintenance': async (a) => { const r = await exclusive(() => resolveMaintenanceLocked(mctx, a)); await verifyOrRetry(); return r; },
        'enter-maintenance': (a) => exclusive(() => enterMaintenanceLocked(mctx, a)),
      },
    });
    return admin;
  }

  const close = async () => {
    for (const t of timers) clearInterval(t);
    if (gateTimer) clearTimeout(gateTimer);
    admin?.close();
    await Promise.race([Promise.all([sync.idle(), watermark.flush(), engine.enqueue(async () => {})]), new Promise((r) => { setTimeout(r, 15_000); })]);
    db.close();
  };
  return { app, ctx, report, startBackground, startAdmin, gate, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const env = process.env;
  const dataDir = env.DATA_DIR ?? '/data';
  const svc = await createService({
    dataDir, repoUrl: env.REPO_URL || null,
    sshCommand: env.GIT_SSH_KEY_FILE ? sshCommandFor(env.GIT_SSH_KEY_FILE, env.GIT_KNOWN_HOSTS_FILE) : null,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, '') || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null),
    slug: env.INSTANCE_NAME, displayName: env.INSTANCE_DISPLAY_NAME || env.INSTANCE_NAME,
    bootstrap: {
      code: env.BOOTSTRAP_ADMIN_CODE || null, force: env.BOOTSTRAP_FORCE === '1', restoreNonce: env.RESTORE_NONCE || null,
      member: env.BOOTSTRAP_ADMIN_MEMBER || 'm-owner', name: env.BOOTSTRAP_ADMIN_NAME || 'Owner',
    },
    trustedHops: Number(env.TRUSTED_PROXY_HOPS ?? 1), ipHeader: env.CLIENT_IP_HEADER || null,
    notify: createNotifier(env.NOTIFY_WEBHOOK_URL),
    maxPending: Number(env.SYNC_MAX_PENDING ?? 20), maxPendingAgeMs: Number(env.SYNC_MAX_PENDING_MINUTES ?? 60) * 60_000,
    watermarkRef: env.WATERMARK_REF || undefined,
    // 全员通知邮件（可选）：四项都配置了才启用 announce
    mailer: env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.MAIL_FROM_ADDRESS
      ? createGmailMailer({ clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN, fromAddress: env.MAIL_FROM_ADDRESS, fromName: env.MAIL_FROM_NAME || null })
      : null,
    announce: { guideUrl: env.ANNOUNCE_GUIDE_URL || null },
  });
  console.log(`[startup] ${JSON.stringify(svc.report)}`);
  svc.startBackground();
  await svc.startAdmin(); // 维护通道建不起来就直接失败退出，不带着“没有维护通道”的状态运行（R3-3）
  const port = Number(env.PORT ?? 8080);
  const http = svc.app.listen(port, () => console.log(`substrate-commons ${VERSION} (${env.INSTANCE_NAME}) listening on :${port}`));
  // 优雅退出：停止接新请求，等单写者队列里的事务做完再关库（被强杀也没关系，重启时会恢复）
  const shutdown = async (sig) => {
    console.log(`[shutdown] 收到 ${sig}，等待进行中的写入完成`);
    http.close();
    await svc.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
