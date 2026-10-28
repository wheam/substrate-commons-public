// 个人信息提示：按实例配置对邮箱、电话、证件号、银行卡号选择 allow / warn / reject。
// 订单号、确认号没有可靠的通用格式，所以不在这一层检测。凭据不归这里管（secrets.js 一律拒绝）。
// 邮箱：以每个 @ 为锚点向两侧扩展（线性时间）。整段正则在长串无 @ 文本上会退化成平方级回溯（Codex 实现评审 #2）。
const LOCAL_CH = /[A-Za-z0-9._%+-]/;
const DOMAIN_CH = /[A-Za-z0-9.-]/;
function findEmails(text) {
  const out = [];
  let i = text.indexOf('@');
  while (i >= 0) {
    let a = i; while (a > 0 && i - a < 64 && LOCAL_CH.test(text[a - 1])) a--;
    let b = i + 1; while (b < text.length && b - i <= 255 && DOMAIN_CH.test(text[b])) b++;
    const domain = text.slice(i + 1, b).replace(/\.+$/, '');
    if (a < i && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(domain)) out.push(`${text.slice(a, i)}@${domain}`);
    i = text.indexOf('@', b > i + 1 ? b : i + 1);
  }
  return out;
}

const DETECTORS = {
  email: findEmails,
  phone: (text) => [
    ...(text.match(/(?<![\d])1[3-9]\d{9}(?![\d])/g) ?? []),
    ...(text.match(/\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\d])/g) ?? []),
  ],
  id_number: (text) => (text.match(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g) ?? []).filter(validCnId),
  bank_card: (text) => (text.match(/(?<![\d])\d{16,19}(?![\d])/g) ?? []).filter(luhn),
};

export const PII_KINDS = Object.keys(DETECTORS);
const LABELS = { email: '邮箱', phone: '电话', id_number: '证件号', bank_card: '银行卡号' };

function validCnId(s) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = w.reduce((acc, x, i) => acc + x * Number(s[i]), 0);
  if ('10X98765432'[sum % 11] !== s[17].toUpperCase()) return false;
  const y = Number(s.slice(6, 10)); const m = Number(s.slice(10, 12)); const d = Number(s.slice(12, 14));
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function luhn(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let n = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// policy: {email:'allow'|'warn'|'reject', ...}；未配置的类型按 warn 处理。
// 返回 {warnings:[文案], rejections:[文案]}；文案只说类型和数量，不回显命中的值。
export function scanPii(text, policy = {}) {
  const warnings = [];
  const rejections = [];
  for (const kind of PII_KINDS) {
    const action = policy[kind] ?? 'warn';
    if (action === 'allow') continue;
    const hits = DETECTORS[kind](String(text ?? ''));
    if (!hits.length) continue;
    const msg = `检测到疑似${LABELS[kind]} ${hits.length} 处`;
    if (action === 'reject') rejections.push(`${msg}；本实例不允许写入${LABELS[kind]}`);
    else warnings.push(`${msg}（已放行；请确认确实需要共享给全体成员，且会永久留在 git 历史里）`);
  }
  return { warnings, rejections };
}
