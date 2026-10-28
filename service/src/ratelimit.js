// 认证后的速率限制：按成员和 token 分别计数，固定 60 秒窗口。
export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  function hit(key, limit) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start >= 60_000) { b = { start: t, n: 0 }; buckets.set(key, b); }
    b.n++;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (t - v.start >= 60_000) buckets.delete(k);
    return b.n <= limit;
  }
  // kind: 'read' | 'write'；rates 来自实例配置
  return function check(actor, kind, rates) {
    if (kind === 'write') {
      return hit(`w:t:${actor.token_id}`, rates.writes_per_minute_token) && hit(`w:m:${actor.member_id}`, rates.writes_per_minute_member);
    }
    return hit(`r:t:${actor.token_id}`, rates.reads_per_minute_token);
  };
}
