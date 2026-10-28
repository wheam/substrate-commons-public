// 审计：字段白名单——只记谁、何时、调了什么、结果；绝不记正文、edits、message、检索词。
// stdout 即 Railway 日志；另追加到 volume 上的文件。文件写失败不再静默：计数并告警。
import { appendFileSync } from 'node:fs';
import { redactCredentials } from './secrets.js';

const FIELDS = ['event', 'tool', 'member_id', 'token_id', 'client_label', 'request_id', 'ip', 'ok', 'code', 'ms',
  'path', 'paths', 'op', 'commit_rev', 'reason', 'invite_id', 'kind', 'count', 'mode', 'status'];

export function createAudit({ file = null, stdout = true } = {}) {
  let failures = 0;
  let warned = 0;
  function audit(entry) {
    const out = { ts: new Date().toISOString() };
    for (const k of FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
    const line = JSON.stringify(redactCredentials(out));
    if (stdout) console.log(`AUDIT ${line}`);
    if (file) {
      try { appendFileSync(file, `${line}\n`); } catch (e) {
        failures++;
        if (Date.now() - warned > 60_000) { warned = Date.now(); console.error(`[audit] 审计文件写入失败（累计 ${failures} 次）：${e.message}`); }
      }
    }
  }
  audit.failures = () => failures;
  return audit;
}
