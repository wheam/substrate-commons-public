// 崩溃测试用的子进程服务：在 FAULT 指定的事务节点 SIGKILL 自己。
import { createService } from '../../src/server.js';

const { DATA_DIR, FAULT, REPO_URL } = process.env;
let armed = false;
const fault = (p) => {
  if (!FAULT) return;
  if (FAULT === 'after_response') {
    if (p === 'after_db') armed = true;
    else if (p === 'after_response' && armed) process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (p === FAULT) process.kill(process.pid, 'SIGKILL');
};
const svc = await createService({
  dataDir: DATA_DIR, repoUrl: REPO_URL || null, slug: 'test-instance', displayName: '测试实例', trustedHops: 0, auditStdout: false,
  bootstrap: { code: `sbe_${'a1'.repeat(16)}`, member: 'm-owner', name: 'Owner' }, fault, syncWaitMs: 1000, log: { error() {}, warn() {} },
});
svc.startBackground({ pushEveryMs: 200, fetchEveryMs: 60_000 });
await svc.startAdmin();
const server = svc.app.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port, report: svc.report })}\n`);
});
process.on('SIGTERM', async () => { server.close(); await svc.close(); process.exit(0); });
