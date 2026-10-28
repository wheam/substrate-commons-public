// 公开镜像的脱敏（mirror 专用，不改实例里的内容）。原则：宁可多藏；复查不过的内容不发布。
// 在 Markdown 文档树上做（doc.js）：
//   1. 规范化：解码 HTML 实体；去掉零宽 / 方向控制等格式字符、私用区字符、数字后的组合符号；全角字母数字转半角
//   2. 结构规则作用于节点：敏感字段所在的列表项 / 段落行（含续行；值另起一段时连同下一块）、表格的敏感列与“字段 | 值”行、
//      健康话题所在的标题小节 / 列表项 / 行 / 表格列与行
//   3. 文字规则作用于“读者看到的连续文字”（粗体、链接等标记不占字符，被拆开的号码会连起来看）：
//      网址（允许的保留、其余换成［链接已隐藏］）→ 通用模式 → 关键词后面的值 → 无协议的私人文档地址；改动映射回原令牌
//   4. 链接目标：协议、主机、路径、参数、#片段、已隐藏值都要过关，不过关只留文字加“（链接已隐藏）”；title 一律去掉
//   5. 整批先跑一遍收集“已隐藏值”，第二遍才定链接去留；序列化后重新解析比对可见文字，再复查，不过关的整段不发布
import MarkdownIt from 'markdown-it';
import { parseTree, inlineOf, inlineView, applyInlineEdits, textToken, visibleOf, nodeText, serialize, roundTripOk, hrefsOf, md } from './doc.js';

const { unescapeAll } = new MarkdownIt().utils;

export const MASK = '［已隐藏］';
export const LINK_HIDDEN = '（链接已隐藏）';
export const BARE_LINK_MASK = '［链接已隐藏］';
export const TOPIC_HIDDEN = '（此处可能涉及健康等个人信息，未公开）';

const FILL = String.fromCharCode(1); // 已处理过的字符在工作副本里换成它：不是字母数字，后面的模式不会再匹配进来
const bump = (stats, k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };

// ---------- 1. 规范化 ----------
export function normalize(input) {
  return String(input ?? '')
    .replace(/&([a-z#][a-z0-9]{1,31});/gi, (m) => unescapeAll(m))
    .replace(/[\p{Cf}\uE000-\uF8FF]/gu, '')
    .replace(/(\p{Nd})\p{M}+/gu, '$1')
    .replace(/[\p{Nd}\uFF20-\uFF3A\uFF41-\uFF5A\uFF0B\uFF0D\uFF3F]/gu, (c) => {
      const n = c.normalize('NFKC');
      return n.length === 1 && n.charCodeAt(0) < 128 ? n : c;
    });
}

// ---------- 字段与话题 ----------
const ZH_FIELD_KEYS = ['订单号', '订单编号', '确认号', '确认编号', '确认码', '预订号', '预订编号', '预约号', '预约码', '取票码', '取车码',
  '票号', '电话号码', '联系电话', '手机号', '联系方式', '邮箱', '电子邮件', '车牌', '证件号', '身份证号', '护照号', '卡号', '银行卡',
  '账号', '账户', '用户名', '微信号', '密码', '入住码', '门禁码', '开门码', '门锁码', '验证码', '取件码'];
// 只在表头、标题这类“整列 / 整节”的位置算敏感的字段名（行内的“身份证：记得带原件”是提醒，不隐藏）
const ZH_SECTION_KEYS = ['身份证', '护照', '证件'];
const EN_FIELD = /\b(?:booking (?:ref|reference|no|number|code|id)|confirmation(?: (?:no|number|code|id))?|reservation (?:no|number|code|id)|order (?:no|number|id)|pnr|phone|tel|telephone|mobile|e-?mail|passport(?: no| number)?|license plate|plate (?:no|number)|account(?: no| number| name)?|username|user name|password|passcode|pin(?: code)?|access code|door code|entry code|check-?in code|lock code|wechat(?: id)?|reference)\b/;

// 字段名是否敏感。短名（≤12 字）包含关键词即算；长名只看结尾，免得整句被当成字段名。section=true 用于表头与标题
export function isSensitiveField(name, { section = false } = {}) {
  let n = String(name);
  if (n.length > 64) return false; // 字段名不会这么长；也给下面的处理设上限
  n = n.replace(/[*_`~\\]/g, '').trim();
  if (/[）)]$/.test(n)) { const open = Math.max(n.lastIndexOf('('), n.lastIndexOf('（')); if (open > 0) n = n.slice(0, open).trim(); }
  const zh = n.replace(/\s+/g, '');
  if (!zh) return false;
  const keys = section ? [...ZH_FIELD_KEYS, ...ZH_SECTION_KEYS] : ZH_FIELD_KEYS;
  if (zh.length <= 12 ? keys.some((k) => zh.includes(k)) : keys.some((k) => zh.endsWith(k))) return true;
  if (zh.endsWith('电话') || (zh.length <= 12 && zh.startsWith('电话'))) return true;
  const en = n.toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return en !== '' && en.length <= 30 && EN_FIELD.test(en);
}

// 健康等个人话题：认不出具体值，所在的小节 / 列表项 / 行 / 表格列与行不公开（网址里的字母不算）
const TOPIC_RE = /病史|既往史|疾病|患有|确诊|诊断|糖尿病|高血压|心脏病|哮喘|癫痫|抑郁|焦虑症|精神疾病|怀孕|孕期|备孕|流产|处方|用药|服药|过敏|手术|住院|化疗|癌症|肿瘤|艾滋|\bHIV\b|残疾|病历|血糖|胰岛素|二甲双胍|体检|体重|体脂|生理期|月经/i;
export const hasTopic = (s) => TOPIC_RE.test(String(s).replace(/https?:\/\/\S{0,2000}/gi, ' '));

// “字段：值”行（线性扫描）：返回 { indent, name, value } 或 null
export function parseField(line) {
  const indent = line.length - line.trimStart().length;
  let rest = line.slice(indent);
  const bullet = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(rest);
  if (bullet) rest = rest.slice(bullet[0].length);
  const c = rest.slice(0, 48).search(/[：:]/);
  if (c < 1) return null;
  const name = rest.slice(0, c).replace(/^(?:\*\*|__)/, '').replace(/(?:\*\*|__)\s*$/, '').trim();
  if (!name || name.length > 24 || name.includes('|')) return null;
  return { indent, name, value: rest.slice(c + 1) };
}

// 被去掉的值记进“已隐藏值”（出现在任何链接里，链接也隐藏）：每行第一个词、含数字或 @ 的词、全大写的词，
// 以及每行去掉“字段：”后的整段值和其中的非 ASCII 词（中文密码等）
function remember(secrets, value) {
  for (const line of String(value).split('\n')) {
    [...line.matchAll(/[A-Za-z0-9@._+-]{4,64}/g)].forEach((m, i) => {
      if (i === 0 || /[\d@]/.test(m[0]) || /^[A-Z0-9]+$/.test(m[0])) secrets.add(m[0]);
    });
    const v = line.replace(/^[^：:]{0,24}[：:]/, '').trim();
    for (const x of [v, unquote(v)]) if (x.length >= 2 && x.length <= 64) secrets.add(x);
    // 引号里的值单独再记一份（“芝麻开门”（区分大小写）、{"password":"aB!cD$eF"}）
    for (const m of line.matchAll(/["“'‘「『《`]([^"”'’」』》`\n]{2,64})["”'’」』》`]/g)) secrets.add(unquote(m[1]));
    // 等号右边、逗号列出的各项、括注之前的值（password=guesthouse、opensesame，seashells、花生（严重））
    const parts = [v, ...line.split(/[=＝]/).slice(1)].flatMap((x) => x.split(/[，,、;；]/)).map((x) => unquote(x.replace(/[（(][^）)]*[）)]\s*$/, '')));
    for (const x of parts) if (secretLongEnough(x) && x.length <= 64) secrets.add(x);
    for (const w of v.split(/[\s，,、；;。]+/).map(unquote)) if (w.length >= 2 && w.length <= 64 && /[^\x00-\x7f]/.test(w)) secrets.add(w);
  }
}
// 去掉成对的外层引号 / 括号
export const unquote = (v) => {
  let s = String(v).trim();
  for (let i = 0; i < 4; i++) {
    const m = /^(["'“‘「『《`])(.*)(["'”’」』》`])$/s.exec(s);
    if (!m) break;
    s = m[2].trim();
  }
  return s;
};
// 已隐藏值的最短长度：ASCII 4 个字符，含非 ASCII（中文等）2 个字符
export const secretLongEnough = (s) => s.length >= (/[^\x00-\x7f]/.test(s) ? 2 : 4);

// ---------- 通用模式 ----------
const PROVINCES = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼';
const PLATE = `[${PROVINCES}][A-Z][·•・.\\s-]?[A-Z0-9]{5,6}(?![A-Za-z0-9])`;
const hasDate = (m) => /\d{4}-\d{1,2}-\d{1,2}/.test(m);
// 编号形态：6–40 位字母数字，至少 2 个数字和 2 个字母（PNR、确认码、车牌、账号）；航班号（MU5716、3U8888）除外
export const ID_LIKE = (tok) => {
  if (tok.length < 6) return false;
  const d = tok.replace(/[^0-9]/g, '').length;
  return d >= 2 && tok.length - d >= 2 && !/^[A-Z0-9]{2}\d{3,4}$/.test(tok);
};
const CREDENTIAL = /(?<![A-Za-z0-9])(?:sbk|sbe)_[A-Za-z0-9_-]{6,}|(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|github_pat|sk-ant|sk-proj|xox[abpr])[-_][A-Za-z0-9_-]{10,}|(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g;
const PATTERNS = [
  ['凭据', CREDENTIAL],
  ['邮箱', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g],
  ['证件号', /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g],
  ['电话', /(?<![\w+\uFF0B])\+\s?\d{1,3}(?:[\s.-]?\(?\d\)?){6,14}(?!\d)/g],
  ['电话', /(?<!\d)\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?!\d)/g],
  ['电话', /(?<![\d-])(?:\(0\d{2,3}\)|（0\d{2,3}）|0\d{2,3})[\s-]?\d{7,8}(?!\d)/g],
  ['电话', /(?<!\d)1[3-9]\d[\s.-]?\d{4}[\s.-]?\d{4}(?!\d)/g],
  ['电话', /(?<![\d.-])\d{3,4}[\s.-]\d{3,4}[\s.-]\d{4}(?![\d.-])/g, (m) => !hasDate(m)],
  ['卡号', /(?<!\d)\d{4}(?:[ -]\d{4}){2,4}(?:[ -]\d{1,4})?(?!\d)/g],
  ['车牌', new RegExp(PLATE, 'g')],
  ['长数字', /(?<!\p{Nd})\p{Nd}{7,}(?!\p{Nd})/gu],
  // 被空格、连字符或换行拆开的 9 位以上数字；含日期的不算
  ['长数字', /(?<!\d)\d(?:(?:[ \t\-_·•]|[ \t]{0,3}\n[ \t>]{0,6})?\d){8,}(?!\d)/g, (m) => !hasDate(m)],
  ['编号', /(?<![A-Za-z0-9])[A-Za-z0-9]{6,40}(?![A-Za-z0-9])/g, ID_LIKE],
  ['尾号', /(?:尾号|末四位|后四位)\s*[:：]?\s*[A-Za-z0-9]{3,6}/g],
];

// 编号类关键词：紧跟着的第一个值（3 位以上，不论有没有数字）一律隐藏，同一分句里其后带数字的值也隐藏；不放过形似航班号的值
const ID_KEYWORD = /订单号|订单编号|确认号|确认编号|确认码|预订号|预订编号|预约号|预约码|取票码|取车码|电子票号|票号|证件号码|证件号|身份证号|护照号|卡号|账号|账户|用户名|微信号|微信|密码|PNR|booking\s+(?:ref(?:erence)?|no\.?|number|code)|confirmation(?:\s+(?:no\.?|number|code))?|reservation\s+(?:no\.?|number|code)|order\s+(?:no\.?|number|id)|password|username|account/gi;
// 联系类关键词：同一分句里含 5 位以上数字的值隐藏（航班号保留）
const CONTACT_KEYWORD = /电话|手机|联系方式|tel|phone|mobile|whatsapp/gi;
const VALUE = /[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}/y;
const TOKEN = /(?<![A-Za-z0-9._@+-])[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}(?![A-Za-z0-9._@+-])/g;
const KEEP_ID = /^(?:\d{4}-\d{1,2}(?:-\d{1,2})?|\d{1,2}-\d{1,2}|[RHTQCWG]\d{1,3}(?:-B\d)?|IMG-\d{1,3})$/i;
const KEEP_CONTACT = /^(?:\d{4}-\d{1,2}(?:-\d{1,2})?|\d{1,2}-\d{1,2}|[RHTQCWG]\d{1,3}(?:-B\d)?|IMG-\d{1,3}|[A-Z0-9]{2}\d{3,4})$/i;
const SKIP_BEFORE_VALUE = /^[\s：:#＃=是为*_~`"'“”‘’「」『』《》（(\[\\]*/;

// ---------- 链接 ----------
// 私人文档、网盘、表单、短链与本引擎服务地址：带不带协议都不公开
export const DENY_HOSTS = ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'forms.gle', 'goo.gl', 'bit.ly', 't.co',
  'tinyurl.com', 'dwz.cn', 'url.cn', 'xhslink.com', 'feishu.cn', 'feishu.net', 'larksuite.com', 'larkoffice.com',
  'notion.so', 'notion.site', 'dropbox.com', 'dropboxusercontent.com', 'icloud.com', 'onedrive.live.com', '1drv.ms',
  'sharepoint.com', 'docs.qq.com', 'doc.weixin.qq.com', 'kdocs.cn', 'wps.cn', 'shimo.im', 'yuque.com', 'pan.baidu.com',
  'alipan.com', 'aliyundrive.com', 'quark.cn', 'weiyun.com', 'mega.nz', 'wetransfer.com', 'airtable.com', 'up.railway.app'];
const DENY_WORDS = new Set(['order', 'orders', 'orderdetail', 'orderdetails', 'orderid', 'booking', 'bookings', 'reservation',
  'reservations', 'account', 'accounts', 'myaccount', 'member', 'members', 'profile', 'user', 'users', 'login', 'signin',
  'signup', 'auth', 'oauth', 'token', 'invite', 'invitation', 'enroll', 'checkout', 'payment', 'payments', 'pay', 'invoice',
  'eticket', 'voucher', 'confirm', 'confirmation', 'itinerary', 'mytrip', 'mytrips', 'passport', 'wallet', 'admin', 'mcp']);
const DENY_PARAM = /token|key|sig|auth|code|pass|pwd|session|sid|uid|user|share|invite|ticket|order|mail|phone|mobile|tel|secret|openid|unionid/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SCHEMELESS_DENY = new RegExp(`(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]{1,63}\\.){0,8}(?:${DENY_HOSTS.map(escapeRe).join('|')})\\.?(?![A-Za-z0-9-])(?:[/?#][^\\s，。；、）)\\]】」]*)?`, 'gi');
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
// 网址里的固定格式号码（解码后检查）：邮箱、手机号、车牌、证件号、凭据
const URL_FIXED = [/[A-Za-z0-9._%+-]@[A-Za-z0-9-]+\.[A-Za-z]/, /(?<!\d)1[3-9]\d[\s.-]?\d{4}[\s.-]?\d{4}(?!\d)/,
  new RegExp(PLATE), /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/, new RegExp(CREDENTIAL.source)];
const idPiece = (tok) => ID_LIKE(tok) || tok.replace(/\D/g, '').length >= 9;
// 网址解码后也按正文的电话、卡号、证件号、凭据等模式整体检查（先于按符号切片的检查，免得被连字符切开）
const URL_NUMBER_PATTERNS = () => PATTERNS.filter(([name]) => ['凭据', '邮箱', '证件号', '电话', '卡号', '车牌'].includes(name))
  .concat([PATTERNS.find(([name, re]) => name === '长数字' && re.source.includes('\\n'))]);

// 公开的店铺 / 酒店 / 地图页（固定形状）：
// - 携程酒店页、大众点评店铺页：路径里的平台公开 ID 不按“长编号”处理；不允许带任何参数或 #片段。
// - 高德 uri.amap.com：只豁免参数名 keyword 里含 key 的误报；参数值照常做编号、长数字、电话等检查。
const PUBLIC_LISTINGS = [
  { host: /^hotels\.ctrip\.com$/, path: /^\/hotels\/\d{1,12}\.html$/, params: [], idInPath: true },
  { host: /^m\.ctrip\.com$/, path: /^\/html5\/hotel\/hoteldetail\/\d{1,12}\.html$/, params: [], idInPath: true },
  { host: /^(?:www\.|m\.)?dianping\.com$/, path: /^\/shop\/[A-Za-z0-9]{1,40}$/, params: [], idInPath: true },
  { host: /^uri\.amap\.com$/, path: /^\/(?:search|marker)$/, params: ['keyword', 'city', 'callnative', 'position', 'name', 'src', 'coordinate'], okParamNames: ['keyword'] },
];
function publicListing(u) {
  const rule = PUBLIC_LISTINGS.find((r) => r.host.test(u.hostname) && r.path.test(u.pathname));
  if (!rule || u.hash) return null;
  return [...u.searchParams.keys()].every((k) => rule.params.includes(k)) ? rule : null;
}

export function urlAllowed(raw, { extraDenyHosts = [], secrets = new Set() } = {}) {
  let u;
  try { u = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const decoded = safeDecode(raw);
  if (u.username || u.password || decoded.includes('@')) return false;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.')) return false;
  if ([...DENY_HOSTS, ...extraDenyHosts].some((h) => host === h || host.endsWith(`.${h}`))) return false;
  if (host.split('.').some((label) => idPiece(label) || label.replace(/\D/g, '').length >= 7)) return false;
  // 路径、参数（名和值）、#片段 分别解码后检查
  const joined = [safeDecode(u.pathname), ...[...u.searchParams].flat(), safeDecode(u.hash.slice(1))].join(' ');
  if (URL_FIXED.some((re) => re.test(joined))) return false;
  const listing = publicListing(u);
  // 携程 / 点评：编号类检查不看路径里的平台 ID（这类链接不带参数和片段，剩下没有可查的内容）
  const numbered = listing?.idInPath ? '' : joined;
  for (const [, re, when] of URL_NUMBER_PATTERNS()) for (const m of numbered.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) if (!when || when(m[0])) return false;
  if (joined.toLowerCase().split(/[^a-z0-9]+/).some((w) => DENY_WORDS.has(w))) return false;
  for (const k of u.searchParams.keys()) if (DENY_PARAM.test(k) && !listing?.okParamNames?.includes(k)) return false;
  // 像编号的片段：字母数字混排 6 位以上，或含 9 个以上数字（证件号、订单号、手机号）
  if (numbered.split(/[^A-Za-z0-9]+/).some(idPiece)) return false;
  for (const s of secrets) if (secretLongEnough(s) && (raw.includes(s) || decoded.includes(s) || joined.includes(s))) return false;
  return true;
}

const BARE_URL = /(?<![A-Za-z0-9])https?:\/\/[^\s<>"'`）】」』，。；、]{1,2000}/gi;
const trimUrl = (u) => u.replace(/[.,;:!?)\]]+$/, '');

// ---------- 3. 文字规则：在“读者看到的连续文字”上找出要改的区间 ----------
function detect(s, ctx) {
  const edits = [];
  const w = s.split('');
  const consume = (start, end, repl, kind) => {
    edits.push({ start, end, repl });
    for (let i = start; i < end; i++) w[i] = FILL;
    if (kind) bump(ctx.stats, kind);
  };
  // 网址：允许的保留（不参与后面的模式），不允许的整段隐藏
  for (const m of s.matchAll(BARE_URL)) {
    const url = trimUrl(m[0]);
    if (ctx.linkOk(url)) for (let i = m.index; i < m.index + url.length; i++) w[i] = FILL;
    else consume(m.index, m.index + url.length, BARE_LINK_MASK, '链接');
  }
  for (const [name, re, when] of PATTERNS) {
    for (const m of w.join('').matchAll(re)) {
      if (when && !when(m[0])) continue;
      ctx.secrets.add(m[0].replace(/[^A-Za-z0-9@._-]/g, ''));
      ctx.secrets.add(m[0]);
      consume(m.index, m.index + m[0].length, MASK, name);
    }
  }
  inlineFields(w.join(''), ctx, consume);
  keywordValues(w.join(''), ctx, consume);
  for (const m of w.join('').matchAll(SCHEMELESS_DENY)) consume(m.index, m.index + m[0].length, BARE_LINK_MASK, '链接');
  return edits.sort((a, b) => a.start - b.start);
}

// 句中的“敏感字段名：值”（表格单元格、“房间：湖景房；密码：芝麻开门”）：冒号后到分句结束的值整段隐藏，支持中文与符号。
// 身份证、护照、证件、电话、手机只在值里有数字时隐藏（“身份证：记得带原件”“手机：带充电器”是提醒）
// 字段名后可以带括注：“密码（WiFi）：”“Password (WiFi):”；也可以用“是 / 为 / = / is”连接；值到分句结束（；;。换行 |），逗号列出的多个值一并隐藏；
// 冒号后直接换行时，下一行是值
export const INLINE_FIELD = new RegExp(`(${[...ZH_FIELD_KEYS, '电话', '手机'].join('|')}|${ZH_SECTION_KEYS.join('|')}|password|passcode|pwd|pin(?:\\s+code)?|access\\s+code|door\\s+code|entry\\s+code|username|account|booking\\s+ref(?:erence)?|confirmation(?:\\s+(?:no\\.?|number|code))?|pnr)\\s*(?:[（(][^）)\\n]{0,20}[）)])?\\s*(?:[：:=＝]|是|为|\\bis\\b)`, 'gi');
function inlineFields(text, ctx, consume) {
  let pos = 0;
  for (const m of text.matchAll(INLINE_FIELD)) {
    if (m.index < pos) continue;
    let start = m.index + m[0].length;
    while (start < text.length && (text[start] === ' ' || text[start] === '\t' || text[start] === FILL)) start++;
    if (text[start] === '\n') start++; // “密码：”后换行写值
    let end = start;
    while (end < text.length && !/[；;。\n|]/.test(text[end])) end++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    pos = end;
    const value = text.slice(start, end);
    if (!value || /^[\u0001]+$/.test(value)) continue;
    if ([...ZH_SECTION_KEYS, '电话', '手机'].includes(m[1]) && !/\d/.test(value)) continue; // 这几个字段的值本来就是号码
    remember(ctx.secrets, `x：${value.split(FILL).join('')}`);
    consume(start, end, MASK, '字段');
  }
}

// text 是做过通用模式之后的工作副本；关键词彼此的分句不重叠，所以整段只用这一份快照
function keywordValues(text, ctx, consume) {
  const spans = [];
  for (const m of text.matchAll(ID_KEYWORD)) spans.push({ start: m.index + m[0].length, kind: 'id' });
  for (const m of text.matchAll(CONTACT_KEYWORD)) spans.push({ start: m.index + m[0].length, kind: 'contact' });
  spans.sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const sp of spans) {
    if (sp.start < pos) continue;
    let end = sp.start;
    while (end < text.length && end - sp.start < 60 && !/[。；;，,\n|！？!?]/.test(text[end])) end++;
    const seg = text.slice(sp.start, end);
    let from = 0;
    if (sp.kind === 'id') {
      const skip = SKIP_BEFORE_VALUE.exec(seg)[0].length;
      VALUE.lastIndex = skip;
      const v = VALUE.exec(seg);
      if (v && !KEEP_ID.test(v[0])) {
        ctx.secrets.add(v[0]);
        consume(sp.start + skip, sp.start + skip + v[0].length, MASK, '编号');
        from = skip + v[0].length;
      }
    }
    for (const t of seg.matchAll(TOKEN)) {
      if (t.index < from) continue;
      const digits = t[0].replace(/\D/g, '').length;
      if ((sp.kind === 'id' ? KEEP_ID : KEEP_CONTACT).test(t[0]) || (sp.kind === 'id' ? digits === 0 : digits < 5)) continue;
      ctx.secrets.add(t[0]);
      consume(sp.start + t.index, sp.start + t.index + t[0].length, MASK, '编号');
    }
    pos = end;
  }
}

function applyStringEdits(s, edits) {
  let out = '';
  let pos = 0;
  for (const e of edits) { out += s.slice(pos, e.start) + e.repl; pos = e.end; }
  return out + s.slice(pos);
}

// ---------- 2. 结构规则 + 3. 文字规则（作用于文档树） ----------
const level = (n) => Number(n.open.tag.slice(1)) || 1;
const paragraphWith = (text) => parseTree(text.replace(/[\\`*_[\]<>~#|&-]/g, '\\$&')).children[0];

// 站内相对链接的路径与片段：解码前后都不能含已隐藏值，也不能检出疑似敏感信息
export function relativeOk(href, secrets = new Set()) {
  const decoded = safeDecode(href);
  for (const s of secrets) if (secretLongEnough(s) && (href.includes(s) || decoded.includes(s))) return false;
  return findLeaks(decoded).length === 0;
}

// 一个 inline 令牌：文字规则 + 链接目标
function redactInline(tok, ctx) {
  if (!tok) return;
  const view = inlineView(tok.children);
  tok.children = applyInlineEdits(tok.children, view, detect(view.s, ctx));
  const out = [];
  const hide = [];
  for (const c of tok.children) {
    if (c.type === 'link_open') {
      if (c.attrs) c.attrs = c.attrs.filter(([k]) => k !== 'title');
      const href = c.attrGet('href') ?? '';
      let ok;
      if (/^https?:\/\//i.test(href) || href.startsWith('//')) ok = ctx.linkOk(href);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) ok = false;
      else ok = relativeOk(href, ctx.secrets) && detect(safeDecode(href), { ...ctx, stats: {}, linkOk: () => true }).length === 0; // 站内相对链接：路径与片段里不能有号码或已隐藏值
      hide.push(!ok);
      if (!ok) { bump(ctx.stats, '链接'); continue; }
    } else if (c.type === 'link_close') {
      if (hide.pop()) { out.push(textToken(LINK_HIDDEN)); continue; }
    }
    out.push(c);
  }
  tok.children = out;
}

// 段落：逐行看字段与话题；返回 { keep, dropNext }（只有一行“字段：”、值写在下一块时连同下一块）
function redactParagraph(n, ctx) {
  const tok = inlineOf(n);
  if (!tok) return { keep: true, dropNext: false };
  const view = inlineView(tok.children);
  const lines = [];
  let start = 0;
  for (const part of view.s.split('\n')) { lines.push({ start, text: part }); start += part.length + 1; }
  const edits = [];
  let dropNext = false;
  let kept = 0;
  for (let j = 0; j < lines.length; j++) {
    const f = parseField(lines[j].text);
    const sensitive = f && isSensitiveField(f.name);
    if (sensitive || (f && hasTopic(f.name))) {
      // 懒续行算到下一个“字段：值”行；“字段：”没有值时，本段其余各行都算它的内容（值另起一块时连同下一块）
      const empty = f.value.trim() === '';
      let k = j + 1;
      while (k < lines.length && (empty || !parseField(lines[k].text))) k++;
      const to = k < lines.length ? lines[k].start : view.s.length;
      if (sensitive) {
        bump(ctx.stats, '字段');
        remember(ctx.secrets, view.s.slice(lines[j].start, to));
        edits.push({ start: j > 0 && k === lines.length ? lines[j].start - 1 : lines[j].start, end: to, repl: '' });
        // “字段：”没有值：值多半写在下一块里
        if (k === lines.length && empty) dropNext = true;
      } else {
        bump(ctx.stats, '话题');
        remember(ctx.secrets, view.s.slice(lines[j].start, to));
        edits.push({ start: lines[j].start, end: k < lines.length ? lines[k].start - 1 : view.s.length, repl: TOPIC_HIDDEN });
        if (k === lines.length && empty) dropNext = true;
        kept++;
      }
      j = k - 1;
      continue;
    }
    if (hasTopic(lines[j].text)) {
      bump(ctx.stats, '话题');
      remember(ctx.secrets, lines[j].text);
      // 句中的“过敏：”在行尾、没有值：本段其余各行与下一块都算它的内容
      if (/[：:]\s*$/.test(lines[j].text) && hasTopic(lines[j].text.replace(/^.*[；;，,。]/, ''))) {
        edits.push({ start: lines[j].start, end: view.s.length, repl: TOPIC_HIDDEN });
        remember(ctx.secrets, view.s.slice(lines[j].start));
        dropNext = true;
        kept++;
        break;
      }
      edits.push({ start: lines[j].start, end: lines[j].start + lines[j].text.length, repl: TOPIC_HIDDEN });
    }
    kept++;
  }
  if (!kept) return { keep: false, dropNext };
  // 句中的“密码：”在段落末尾、没有值：值在下一块
  const tail = view.s.replace(/\s+$/, '');
  const lastField = [...tail.matchAll(INLINE_FIELD)].at(-1);
  if (lastField && lastField.index + lastField[0].length === tail.length) dropNext = true;
  tok.children = applyInlineEdits(tok.children, view, edits);
  redactInline(tok, ctx);
  return { keep: true, dropNext };
}

const firstLine = (node) => { const tok = inlineOf(node); return tok ? inlineView(tok.children).s.split('\n')[0] : ''; };

// 列表项开头的那一块：穿过引用往里找第一个段落或标题
function leadBlock(node) {
  let n = node.children?.[0];
  while (n && n.type === 'blockquote') n = n.children?.[0];
  return n;
}

function redactListItem(item, ctx) {
  const lead = leadBlock(item);
  if (lead?.type === 'paragraph' || lead?.type === 'heading') {
    const line = firstLine(lead);
    const f = parseField(line);
    // 列表项以敏感字段开头（标题不带冒号也算）：整项（含嵌套内容）去掉；以健康话题开头：整项换成提示
    if ((f && isSensitiveField(f.name, { section: lead.type === 'heading' })) || (lead.type === 'heading' && isSensitiveField(line, { section: true }))) { bump(ctx.stats, '字段'); remember(ctx.secrets, nodeText(item)); return false; }
    if ((f && hasTopic(f.name)) || hasTopic(line)) { bump(ctx.stats, '话题'); remember(ctx.secrets, nodeText(item)); item.children = [paragraphWith(TOPIC_HIDDEN)]; return true; }
  }
  // 列表项是一个范围：项内“删下一块”“整节隐藏”的传递到这里为止
  item.children = redactContainer(item.children, ctx).out;
  return item.children.length > 0;
}

function redactTable(table, ctx) {
  const rows = [];
  const walk = (x) => { for (const c of x.children ?? []) { if (c.type === 'tr') rows.push(c); else if (c.open) walk(c); } };
  walk(table);
  if (!rows.length) return true;
  const cellsOf = (tr) => tr.children.filter((c) => c.type === 'th' || c.type === 'td');
  const textOf = (cell) => inlineView(inlineOf(cell)?.children).s;
  const header = cellsOf(rows[0]);
  const drop = new Set();
  header.forEach((c, k) => {
    const t = textOf(c);
    if (isSensitiveField(t, { section: true })) { drop.add(k); bump(ctx.stats, '表格列'); } else if (hasTopic(t)) { drop.add(k); bump(ctx.stats, '话题'); }
    if (drop.has(k)) remember(ctx.secrets, t);
  });
  if (drop.size === header.length) { remember(ctx.secrets, nodeText(table)); return false; }
  for (const tr of rows) {
    const cells = cellsOf(tr);
    if (tr !== rows[0]) cells.forEach((c, k) => { if (drop.has(k)) remember(ctx.secrets, textOf(c)); });
    tr.children = tr.children.filter((c) => !drop.has(cells.indexOf(c)));
  }
  for (const tb of table.children.filter((c) => c.type === 'tbody')) {
    tb.children = tb.children.filter((tr) => {
      const cells = cellsOf(tr);
      const at = cells.findIndex((c) => textOf(c).trim() !== '');
      // “字段 | 值”式的行：第一格是敏感字段就整行去掉
      if (at >= 0 && isSensitiveField(textOf(cells[at]), { section: true })) { bump(ctx.stats, '表格行'); remember(ctx.secrets, cells.slice(at + 1).map(textOf).join('\n')); return false; }
      if (hasTopic(cells.map(textOf).join('|'))) { bump(ctx.stats, '话题'); remember(ctx.secrets, cells.map(textOf).join('\n')); return false; }
      return true;
    });
  }
  for (const tr of rows) for (const c of cellsOf(tr)) redactInline(inlineOf(c), ctx);
  return true;
}

// 纯文字（代码块、路径、显示名、标题）：逐行看字段（续行按缩进）与话题，再走文字规则
function redactPlain(text, ctx) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const f = parseField(lines[i]);
    if (f && isSensitiveField(f.name)) {
      bump(ctx.stats, '字段');
      remember(ctx.secrets, f.value);
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].length - lines[j].trimStart().length > f.indent) { remember(ctx.secrets, lines[j]); j++; }
      i = j - 1;
      continue;
    }
    if (hasTopic(lines[i])) {
      bump(ctx.stats, '话题');
      remember(ctx.secrets, lines[i]);
      out.push(TOPIC_HIDDEN);
      // 健康字段的缩进值（yaml 等写法）一并隐藏
      if (f) { let j = i + 1; while (j < lines.length && lines[j].trim() !== '' && lines[j].length - lines[j].trimStart().length > f.indent) j++; i = j - 1; }
      continue;
    }
    out.push(lines[i]);
  }
  const s = out.join('\n');
  return applyStringEdits(s, detect(s, ctx));
}

// 返回 { out, carry }：carry.drop = 末尾的“字段：”要删的值在本容器之后；carry.topic = 末尾的健康小节延续到本容器之后（标题级别）
// 代码块：含敏感字段或健康信息时范围难以可靠划定（空行、YAML 列表），整块不公开；否则按纯文字处理
const CODE_HIDDEN = '［已隐藏：这段代码 / 原文里有敏感字段或健康信息］';
// 代码块里出现任何敏感字段词（JSON 键、KEY=值、yaml 等写法都算）或健康话题词，就整块隐藏
const CODE_RISK = new RegExp(`${[...ZH_FIELD_KEYS, ...ZH_SECTION_KEYS, '电话', '手机', '微信'].join('|')}|pass(?:word|wd|code)?|pwd|secret|token|api[_-]?key|account|user(?:name)?|e-?mail|phone|mobile|tel|confirmation|booking|reservation|pnr|passport|card|wechat`, 'i');
function redactCode(text, ctx) {
  const risky = CODE_RISK.test(text) || text.split('\n').some((line) => {
    const f = parseField(line);
    return (f && (isSensitiveField(f.name, { section: true }) || hasTopic(f.name))) || hasTopic(line);
  });
  if (risky) { bump(ctx.stats, '代码块'); remember(ctx.secrets, text); return CODE_HIDDEN; }
  return redactPlain(text, ctx);
}

function redactContainer(children, ctx) {
  const out = [];
  let drop = false;
  let topic = 0;
  // 跳过所属小节（被跳过的内容也记进已隐藏值）；到容器末尾还没结束就经 carry 向外延续
  const skipRest = (i, lvl) => {
    while (i + 1 < children.length && !(children[i + 1].type === 'heading' && level(children[i + 1]) <= lvl)) { i++; remember(ctx.secrets, nodeText(children[i])); }
    if (i + 1 >= children.length) topic = Math.max(topic, lvl);
    return i;
  };
  const dropNextOf = (i) => {
    if (i + 1 < children.length) { remember(ctx.secrets, nodeText(children[i + 1])); bump(ctx.stats, '字段'); return i + 1; }
    drop = true;
    return i;
  };
  for (let i = 0; i < children.length; i++) {
    const n = children[i];
    switch (n.type) {
      case 'heading': {
        const hf = parseField(firstLine(n));
        if ((hf && isSensitiveField(hf.name, { section: true })) || isSensitiveField(firstLine(n), { section: true })) {
          // 敏感字段写成标题：标题连同所属内容（到同级或更高级标题为止）去掉
          bump(ctx.stats, '字段');
          remember(ctx.secrets, firstLine(n));
          i = skipRest(i, level(n));
          continue;
        }
        if (hasTopic(firstLine(n))) {
          // 健康话题标题：标题换成提示，所属内容（到同级或更高级标题为止）不公开
          bump(ctx.stats, '话题');
          remember(ctx.secrets, firstLine(n));
          out.push(parseTree(`${'#'.repeat(level(n))} ${TOPIC_HIDDEN}`).children[0]);
          i = skipRest(i, level(n));
          continue;
        }
        redactInline(inlineOf(n), ctx);
        out.push(n);
        break;
      }
      case 'paragraph': {
        const r = redactParagraph(n, ctx);
        if (r.keep) out.push(n);
        if (r.dropNext) i = dropNextOf(i);
        break;
      }
      case 'bullet_list': case 'ordered_list':
        n.children = n.children.filter((item) => item.type !== 'list_item' || redactListItem(item, ctx));
        if (n.children.some((c) => c.type === 'list_item')) out.push(n);
        break;
      case 'blockquote': {
        // 引用只是包装：里面末尾的“字段：”或健康小节延续到引用之后
        const r = redactContainer(n.children, ctx);
        n.children = r.out;
        if (n.children.length) out.push(n);
        if (r.carry.topic) { bump(ctx.stats, '话题'); i = skipRest(i, r.carry.topic); }
        if (r.carry.drop) i = dropNextOf(i);
        break;
      }
      case 'table':
        if (redactTable(n, ctx)) out.push(n);
        break;
      case 'fence': case 'code_block':
        n.token.info = ''; // 语言标记不输出
        n.token.content = redactCode(n.token.content, ctx);
        out.push(n);
        break;
      default:
        out.push(n);
    }
  }
  return { out, carry: { drop, topic } };
}

// ---------- 复查 ----------
const LEAK_CHECKS = [
  ['邮箱', (t) => /[A-Za-z0-9._%+-]@[A-Za-z0-9-]+\.[A-Za-z]/.test(t)],
  ['电话', (t) => /(?<!\d)1[3-9]\d[\s.-]?\d{4}[\s.-]?\d{4}(?!\d)/.test(t)],
  ['电话', (t) => [...t.matchAll(/(?<![\d.-])\(?\d{3,4}\)?[\s.-]\d{3,4}[\s.-]\d{4}(?![\d.-])/g)].some((m) => !hasDate(m[0]))],
  ['长数字', (t) => /(?<!\p{Nd})\p{Nd}{7,}(?!\p{Nd})/u.test(t)],
  ['长数字', (t) => [...t.matchAll(/(?<!\d)\d(?:(?:[ \t\-_·•]|[ \t]{0,3}\n[ \t>]{0,6})?\d){8,}(?!\d)/g)].some((m) => !hasDate(m[0]))],
  ['编号', (t) => [...t.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{6,40}(?![A-Za-z0-9])/g)].some((m) => ID_LIKE(m[0]))],
  ['凭据', (t) => new RegExp(CREDENTIAL.source).test(t)],
  ['车牌', (t) => new RegExp(PLATE).test(t)],
  ['私人文档地址', (t) => new RegExp(SCHEMELESS_DENY.source, 'i').test(t)],
];
export function findLeaks(text) {
  const t = String(text);
  return [...new Set(LEAK_CHECKS.filter(([, f]) => f(t)).map(([name]) => name))];
}
// 复查前去掉已审过、允许公开的网址（网址里的页面编号由 urlAllowed 单独把关）
export const withoutAllowedUrls = (text, linkOk) => String(text).replace(BARE_URL, (u) => (linkOk(trimUrl(u)) ? ' ' : u));
// 复查一段 Markdown：重新解析，读者看到的文字（去掉允许的网址）里不能检出疑似敏感信息；每个链接目标再审一次
export function checkMarkdown(text, linkOk, secrets = linkOk?.secrets ?? new Set()) {
  const toks = md.parse(text, {});
  const leaks = findLeaks(withoutAllowedUrls(visibleOf(toks), linkOk));
  for (const href of hrefsOf(toks)) {
    const ok = /^https?:\/\//i.test(href) || href.startsWith('//') ? linkOk(href)
      : /^[a-z][a-z0-9+.-]*:/i.test(href) ? false
        : relativeOk(href, secrets);
    if (!ok) { leaks.push('链接'); break; }
  }
  return [...new Set(leaks)];
}

// ---------- 对外接口 ----------
function runOne(input, ctx) {
  const kind = typeof input === 'string' ? 'md' : input.kind;
  const raw = normalize(typeof input === 'string' ? input : input.text);
  if (kind === 'text') return { kind, text: redactPlain(raw, ctx) };
  const tree = parseTree(raw);
  tree.children = redactContainer(tree.children, ctx).out;
  return { kind, tree };
}

// 一批输入（字符串 = Markdown；或 { kind: 'md' | 'text', text }）一起脱敏：任何一处被隐藏的值，出现在任何链接里都会让该链接被隐藏。
// 返回 texts[i]：Markdown 输入是统一写法的 Markdown，纯文字输入是纯文字；没通过复查的为 null（failed 里有原因）。
export function redactAll(inputs, { extraDenyHosts = [] } = {}) {
  // 第一遍：只为收集“已隐藏值”
  const first = { stats: {}, secrets: new Set(), linkOk: () => true };
  for (const input of inputs) runOne(input, first);
  const secrets = new Set([...first.secrets].filter(secretLongEnough));
  const verdicts = new Map();
  const linkOk = (url) => {
    if (!verdicts.has(url)) verdicts.set(url, urlAllowed(url, { extraDenyHosts, secrets }));
    return verdicts.get(url);
  };
  linkOk.secrets = secrets; // 复查相对链接时也要对照已隐藏值
  // 第二遍：定稿
  const ctx = { stats: {}, secrets: new Set(secrets), linkOk };
  const failed = new Map();
  const texts = inputs.map((input, i) => {
    const r = runOne(input, ctx);
    if (r.kind === 'text') {
      const leaks = findLeaks(withoutAllowedUrls(r.text, linkOk));
      if (leaks.length) { failed.set(i, leaks); return null; }
      return r.text;
    }
    const text = serialize(r.tree);
    if (!roundTripOk(r.tree, text)) { failed.set(i, ['统一写法往返不一致']); return null; }
    const leaks = checkMarkdown(text, linkOk);
    if (leaks.length) { failed.set(i, leaks); return null; }
    return text;
  });
  return { texts, failed, stats: ctx.stats, linkOk };
}

export function redactText(text, opts) {
  return redactAll([text], opts).texts[0];
}
