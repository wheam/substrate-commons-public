// 通用小工具：错误码、id、哈希、规范化 JSON、互斥队列。
import crypto from 'node:crypto';

// 业务错误统一带 code，工具层据此给 agent 稳定的错误类型（CONFLICT / FORBIDDEN / ...）。
export class CommonsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export const fail = (code, message, details) => { throw new CommonsError(code, message, details); };

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

// 时间有序、不可复用的 id：前缀 + 毫秒时间戳（base36）+ 随机段。
export function newId(prefix) {
  const t = Date.now().toString(36).padStart(9, '0');
  return `${prefix}-${t}${crypto.randomBytes(6).toString('hex')}`;
}

// 规范化 JSON：键排序，用于幂等参数摘要与签名载荷。
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// 进程内单写者队列：所有改动仓库或同步状态的操作都排进这里串行执行。
// 注意它不是跨进程锁；部署上只运行一个写进程。
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export const b64url = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (s) => Buffer.from(String(s), 'base64url'),
};

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const utf8Bytes = (s) => Buffer.byteLength(String(s), 'utf8');

// 只保留第一行、截断到 n 个字符，用于 commit subject。
export function oneLine(s, n) {
  const line = String(s ?? '').split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
