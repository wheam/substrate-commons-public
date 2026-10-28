// 来源 IP：明确可信代理链，只取边缘代理写入的那一段，不信任客户端自己填的 XFF 首段。
import net from 'node:net';

export const sanitizeIpLiteral = (raw) => {
  const s = String(raw ?? '').trim();
  return s.length <= 45 && net.isIP(s) ? s : null;
};

// trustedHops = 部署前面可信代理的层数（Railway 边缘 = 1）。XFF 由各代理依次在末尾追加，
// 所以从右往左数第 trustedHops 段是最外层可信代理看到的真实来源；更左边的都可能是客户端伪造的。
// trustedHops = 0 表示直连（本地测试），用 socket 地址。
export function clientIp(req, { trustedHops = 1, header = null } = {}) {
  if (header) return sanitizeIpLiteral(req.headers[header.toLowerCase()]);
  if (trustedHops <= 0) return sanitizeIpLiteral(req.socket?.remoteAddress?.replace(/^::ffff:/, ''));
  const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pick = parts[parts.length - trustedHops];
  return sanitizeIpLiteral(pick) ?? null;
}
