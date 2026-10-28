// 凭据识别与日志兜底脱敏。写路径与审计共用同一套规则，避免「拒收了但又写进日志」。
// 在上游规则基础上增加本服务签发的 sbk_ / sbe_、JWT / OAuth token、口令类字段。
const CREDENTIAL_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,            // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}/,             // OpenAI / DeepSeek 风格
  /AKIA[0-9A-Z]{16}/,                    // AWS access key
  /ghp_[A-Za-z0-9]{20,}/,                // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/,        // GitHub fine-grained PAT
  /gh[ousr]_[A-Za-z0-9]{20,}/,           // GitHub OAuth / app token
  /xox[baprs]-[A-Za-z0-9-]{10,}/,        // Slack
  /AIza[0-9A-Za-z_-]{30,}/,              // Google API key
  /ya29\.[0-9A-Za-z_-]{20,}/,            // Google OAuth access token
  /GOCSPX-[A-Za-z0-9_-]{20,}/,           // Google OAuth client secret
  /(?:^|[^A-Za-z0-9])1\/\/[A-Za-z0-9_-]{30,}/, // Google OAuth refresh token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM 私钥
  /sbk_[0-9a-f]{16,}/i,                  // 本服务 / 上游 substrate 签发的凭据
  /sbe_[0-9a-f]{16,}/i,                  // 本服务 / 上游 substrate 的一次性码
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:Bearer)\s+[A-Za-z0-9._~+/-]{24,}/, // HTTP Bearer 头
];

// 口令类字段：「密码：xxxx」「password=xxxx」。酒店 Wi-Fi 密码这类共享信息放行（同一行出现 wifi / 无线）。
// 值必须像口令（6 位以上 ASCII 可见字符），避免误伤「密码：不要写进来」这类说明文字。
const PASSWORD_LINE = /(?:password|passwd|passcode|pwd|密码|口令|密钥|私钥)\s*[:：=]\s*[\x21-\x7e]{6,}/i;
const WIFI_HINT = /wi-?fi|无线|wlan|热点/i;

const COLLAPSIBLE = /[\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]+/gu;

export function containsCredential(value) {
  const raw = String(value ?? '');
  const collapsed = raw.replace(COLLAPSIBLE, '');
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(raw) || pattern.test(collapsed))) return true;
  return raw.split('\n').some((line) => PASSWORD_LINE.test(line) && !WIFI_HINT.test(line));
}

// 审计是最后一道防线：任意层级的字符串只要疑似含凭据，整段替换，不尝试保留局部上下文。
export function redactCredentials(value) {
  if (typeof value === 'string') {
    return containsCredential(value) ? '[REDACTED: suspected credential]' : value;
  }
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredentials(item)]));
  }
  return value;
}

// 在报错文案、幂等记录这类“要原样回给调用方或落盘”的文本里隐藏凭据：能定位的片段替换掉，
// 定位不了的（例如被空白拆开的凭据）整段替换。用于 R2-2：拒绝结果不能把请求里的凭据带进状态库或回显。
const MASK = '[凭据已隐藏]';
export function maskCredentials(value) {
  if (typeof value === 'string') {
    if (!containsCredential(value)) return value;
    let out = value;
    for (const re of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), MASK);
    out = out.split('\n').map((line) => (PASSWORD_LINE.test(line) && !WIFI_HINT.test(line) ? line.replace(/([:：=]\s*)[\x21-\x7e]{6,}/, `$1${MASK}`) : line)).join('\n');
    return containsCredential(out) ? MASK : out;
  }
  if (Array.isArray(value)) return value.map(maskCredentials);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskCredentials(v)]));
  return value;
}
