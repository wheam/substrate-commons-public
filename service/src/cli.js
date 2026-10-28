// 维护命令行（在服务所在的机器 / 容器里运行，例如 `railway ssh -- node src/cli.js status`）。
// 环境变量与服务相同：DATA_DIR、REPO_URL、GIT_SSH_KEY_FILE、INSTANCE_NAME、INSTANCE_DISPLAY_NAME。
// 服务在运行 → 命令经 admin socket 交给服务进程，在单写者队列里独占执行（不会和写入交错）；
// 服务没运行 → 直接操作仓库与状态库（带维护锁）。
import { openContext, forkStatus, forkRecover, resolveMaintenance, enterMaintenanceLocked, statusOf } from './maintenance.js';
import { acquireMaintenanceLock, releaseMaintenanceLock } from './sync.js';
import { runningServer, callAdmin } from './admin-socket.js';
import { sshCommandFor } from './server.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; flags[k] = v; }
}
const env = process.env;
const dataDir = env.DATA_DIR ?? '/data';
const out = (v) => console.log(JSON.stringify(v, null, 2));
const USAGE = '用法：node src/cli.js status | fork-status | fork-recover --admin m-x [--import all|none|sha,sha] [--yes] | resolve-maintenance --bootstrap-code sbe_... [--member m-owner --name Owner] [--yes] | enter-maintenance [--reason restore] --yes';

const args = {
  'fork-recover': () => ({ adminMember: flags.admin, importShas: flags.import === 'all' ? 'all' : (flags.import && flags.import !== true ? String(flags.import).split(',') : 'none') }),
  'resolve-maintenance': () => ({ bootstrapCode: flags['bootstrap-code'], member: flags.member ?? 'm-owner', name: flags.name ?? 'Owner' }),
  'enter-maintenance': () => ({ reason: flags.reason ?? 'manual' }),
};
const needsYes = new Set(['fork-recover', 'resolve-maintenance', 'enter-maintenance']);

async function main() {
  if (!['status', 'fork-status', ...needsYes].includes(cmd)) { console.log(USAGE); process.exitCode = 2; return; }
  if (cmd === 'fork-recover' && !flags.admin) throw new Error('需要 --admin <member_id>');
  if (cmd === 'resolve-maintenance' && !flags['bootstrap-code']) throw new Error('需要 --bootstrap-code sbe_...（新生成的）');
  const socket = runningServer(dataDir);
  if (needsYes.has(cmd) && !flags.yes) {
    out(socket ? await callAdmin(socket, cmd === 'fork-recover' ? 'fork-status' : 'status', {}) : await direct(cmd === 'fork-recover' ? 'fork-status' : 'status'));
    console.log(`\n确认无误后加 --yes 执行。${cmd !== 'fork-recover' ? '（这会作废全部凭据与未兑换的一次性码）' : ''}`);
    return;
  }
  out(socket ? { via: 'server', result: await callAdmin(socket, cmd, args[cmd]?.() ?? {}) } : { via: 'direct', result: await direct(cmd, args[cmd]?.() ?? {}) });
}

async function direct(command, a = {}) {
  const ctx = openContext({
    dataDir, repoUrl: env.REPO_URL || null,
    sshCommand: env.GIT_SSH_KEY_FILE ? sshCommandFor(env.GIT_SSH_KEY_FILE, env.GIT_KNOWN_HOSTS_FILE) : null,
    slug: env.INSTANCE_NAME, displayName: env.INSTANCE_DISPLAY_NAME || env.INSTANCE_NAME,
  });
  try {
    if (command === 'status') return await statusOf(ctx);
    if (command === 'fork-status') return await forkStatus(ctx);
    if (command === 'fork-recover') return await forkRecover(ctx, a);
    if (command === 'resolve-maintenance') return await resolveMaintenance(ctx, a);
    if (command === 'enter-maintenance') {
      acquireMaintenanceLock(ctx.db, { holder: 'cli:enter-maintenance' });
      try { return await enterMaintenanceLocked(ctx, a); } finally { releaseMaintenanceLock(ctx.db); }
    }
    throw new Error(USAGE);
  } finally { await ctx.close(); }
}

try { await main(); } catch (e) {
  console.error(`失败：${e.code ? `[${e.code}] ` : ''}${e.message}`);
  process.exitCode = 1;
}
