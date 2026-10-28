// 维护命令的本地通道（R2-3）：服务运行时，维护 CLI 不再自己改仓库和状态库，而是经 volume 上的
// Unix socket（只在容器内可达，权限 600）把命令交给服务进程，由服务在单写者队列里独占执行。
// 这样维护操作和普通写事务天然互斥，不存在“写到一半被维护插进来”的窗口。
import net from 'node:net';
import { existsSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function socketPathFor(dataDir) {
  const p = path.join(dataDir, 'state', 'admin.sock');
  if (Buffer.byteLength(p) < 100) return p;
  return path.join(os.tmpdir(), `commons-${crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.sock`);
}
export const pidFileFor = (dataDir) => path.join(dataDir, 'state', 'server.pid');

// 只有 socket 成功监听、权限设好之后才写 pid 文件并返回；失败则抛错（R3-3）
export async function startAdminSocket({ dataDir, handlers, log = console }) {
  const sock = socketPathFor(dataDir);
  if (existsSync(sock)) rmSync(sock, { force: true });
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i); buf = '';
      let reply;
      try {
        const { cmd, args } = JSON.parse(line);
        const h = handlers[cmd];
        if (!h) throw Object.assign(new Error(`未知命令：${cmd}`), { code: 'UNKNOWN' });
        reply = { ok: true, result: await h(args ?? {}) };
      } catch (e) {
        reply = { ok: false, code: e.code ?? null, error: e.message };
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(sock, 0o600);
  server.on('error', (e) => log.error?.(`[admin] socket 错误：${e.message}`));
  writeFileSync(pidFileFor(dataDir), JSON.stringify({ pid: process.pid, socket: sock, at: Date.now() }));
  return { close: () => { server.close(); rmSync(sock, { force: true }); rmSync(pidFileFor(dataDir), { force: true }); } };
}

// CLI 侧：服务在运行就返回 socket 路径；没有服务在运行返回 null。
// 服务进程活着但 socket 不在 → 抛错，绝不退回到直接操作（R3-3）
export function runningServer(dataDir) {
  const f = pidFileFor(dataDir);
  if (!existsSync(f)) return null;
  let info;
  try { info = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`pid 文件无法解析：${f}；确认服务没在运行后再删掉它`); }
  try { process.kill(info.pid, 0); } catch (e) {
    if (e.code === 'ESRCH') return null; // 进程已不在：服务没在运行
    throw new Error(`无法确认服务进程 ${info.pid} 的状态（${e.code}），拒绝直接操作`);
  }
  if (!existsSync(info.socket)) throw new Error(`服务进程 ${info.pid} 在运行，但维护通道 ${info.socket} 不在；拒绝直接操作，请先重启服务`);
  return info.socket;
}

export function callAdmin(socket, cmd, args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error('维护命令超时')); }, timeoutMs);
    c.on('connect', () => c.write(`${JSON.stringify({ cmd, args })}\n`));
    c.on('data', (d) => { buf += d; });
    c.on('end', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(buf);
        if (r.ok) resolve(r.result); else reject(Object.assign(new Error(r.error), { code: r.code }));
      } catch (e) { reject(e); }
    });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
