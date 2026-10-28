// 在独立线程里构建站点：成员内容再大，也不会卡住服务主线程的授权检查和网页响应；主线程按时限终止本线程
import { parentPort, workerData } from 'node:worker_threads';
import { buildSite } from './render.js';

try {
  const r = buildSite({ ...workerData, previous: new Map(workerData.previous) });
  parentPort.postMessage({ ok: true, files: r.files, stats: r.stats, held: r.held, published: [...r.published], pageCount: r.pageCount });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e.code ?? 'BUILD', message: e.message });
}
