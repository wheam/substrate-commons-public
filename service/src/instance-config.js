// 实例配置 _commons/config.yaml：显示名、页面类型、个人信息策略、上限与速率。
// 只能由 admin 经 update_config 修改；写入前按这里的 schema 严格校验（未知键一律拒绝，防止拼写错误静默失效）。
import YAML from 'yaml';
import { CommonsError } from './util.js';
import { PII_KINDS } from './pii.js';

export const DEFAULT_LIMITS = { page_max_bytes: 256 * 1024, total_max_bytes: 50 * 1024 * 1024 };
export const DEFAULT_RATES = { writes_per_minute_token: 30, writes_per_minute_member: 60, reads_per_minute_token: 300 };
const PII_ACTIONS = new Set(['allow', 'warn', 'reject']);
const TOP_KEYS = new Set(['version', 'display_name', 'limits', 'pii', 'permissions', 'rate_limits', 'page_types']);

export function defaultConfig(displayName = '共享资料库') {
  return {
    version: 1, display_name: displayName, limits: { ...DEFAULT_LIMITS },
    pii: Object.fromEntries(PII_KINDS.map((k) => [k, 'warn'])),
    permissions: { delete: 'member' }, rate_limits: { ...DEFAULT_RATES }, page_types: {},
  };
}

const bad = (msg) => { throw new CommonsError('INVALID_CONFIG', `config.yaml 不合法：${msg}`); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

// 把 glob（* 不跨目录，** 跨目录）转成正则
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'u');
}

// 解析并校验；返回规范化的配置对象。text 为 null 时返回默认配置。
export function parseConfig(text, { displayName } = {}) {
  const base = defaultConfig(displayName);
  if (text == null) return base;
  let doc;
  try { doc = YAML.parse(String(text), { maxAliasCount: 0 }); } catch (e) { bad(`YAML 解析失败（${String(e.message).split('\n')[0]}）`); }
  if (!isObj(doc)) bad('顶层必须是映射');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) bad(`未知字段 ${k}`);
  if (doc.version !== 1) bad('version 必须是 1');
  const cfg = { ...base, version: 1 };
  if (doc.display_name != null) {
    if (typeof doc.display_name !== 'string' || !doc.display_name.trim() || doc.display_name.length > 60) bad('display_name 必须是 1–60 字的字符串');
    cfg.display_name = doc.display_name.trim();
  }
  if (doc.limits != null) {
    if (!isObj(doc.limits)) bad('limits 必须是映射');
    for (const [k, v] of Object.entries(doc.limits)) {
      if (!(k in DEFAULT_LIMITS)) bad(`limits 未知字段 ${k}`);
      if (!posInt(v)) bad(`limits.${k} 必须是正整数`);
    }
    cfg.limits = { ...DEFAULT_LIMITS, ...doc.limits };
  }
  if (doc.pii != null) {
    if (!isObj(doc.pii)) bad('pii 必须是映射');
    for (const [k, v] of Object.entries(doc.pii)) {
      if (!PII_KINDS.includes(k)) bad(`pii 未知类型 ${k}（可选：${PII_KINDS.join('、')}）`);
      if (!PII_ACTIONS.has(v)) bad(`pii.${k} 只能是 allow / warn / reject`);
    }
    cfg.pii = { ...base.pii, ...doc.pii };
  }
  if (doc.permissions != null) {
    if (!isObj(doc.permissions)) bad('permissions 必须是映射');
    for (const [k, v] of Object.entries(doc.permissions)) {
      if (k !== 'delete') bad(`permissions 未知字段 ${k}`);
      if (v !== 'member' && v !== 'admin') bad('permissions.delete 只能是 member 或 admin');
    }
    cfg.permissions = { ...base.permissions, ...doc.permissions };
  }
  if (doc.rate_limits != null) {
    if (!isObj(doc.rate_limits)) bad('rate_limits 必须是映射');
    for (const [k, v] of Object.entries(doc.rate_limits)) {
      if (!(k in DEFAULT_RATES)) bad(`rate_limits 未知字段 ${k}`);
      if (!posInt(v)) bad(`rate_limits.${k} 必须是正整数`);
    }
    cfg.rate_limits = { ...DEFAULT_RATES, ...doc.rate_limits };
  }
  cfg.page_types = {};
  if (doc.page_types != null) {
    if (!isObj(doc.page_types)) bad('page_types 必须是映射（类型名 → 定义）');
    for (const [name, def] of Object.entries(doc.page_types)) cfg.page_types[name] = parsePageType(name, def);
  }
  return cfg;
}

function parsePageType(name, def) {
  const at = `page_types.${name}`;
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name)) bad(`${at}：类型名只能用小写字母、数字、- _`);
  if (!isObj(def)) bad(`${at} 必须是映射`);
  for (const k of Object.keys(def)) if (!['description', 'paths', 'entry'].includes(k)) bad(`${at} 未知字段 ${k}`);
  if (!Array.isArray(def.paths) || !def.paths.length || !def.paths.every((p) => typeof p === 'string' && p.endsWith('.md'))) {
    bad(`${at}.paths 必须是以 .md 结尾的 glob 列表`);
  }
  const type = { name, description: typeof def.description === 'string' ? def.description : '', paths: def.paths, pathRes: def.paths.map(globToRegex), entry: null };
  if (def.entry == null) return type;
  const e = def.entry;
  if (!isObj(e)) bad(`${at}.entry 必须是映射`);
  for (const k of Object.keys(e)) if (!['heading', 'id', 'unique_title', 'fields', 'unknown_values', 'example_title'].includes(k)) bad(`${at}.entry 未知字段 ${k}`);
  const heading = e.heading ?? '###';
  if (!/^#{3,4}$/.test(heading)) bad(`${at}.entry.heading 只能是 ### 或 ####`);
  if (!isObj(e.id) || typeof e.id.pattern !== 'string') bad(`${at}.entry.id.pattern 必填`);
  let idRe;
  try { idRe = new RegExp(`^(?:${e.id.pattern})$`, 'u'); } catch { bad(`${at}.entry.id.pattern 不是合法正则`); }
  if (!Array.isArray(e.fields) || !e.fields.length) bad(`${at}.entry.fields 必须是非空列表`);
  const seen = new Set();
  const fields = e.fields.map((f, i) => {
    if (!isObj(f) || typeof f.name !== 'string' || !f.name.trim()) bad(`${at}.entry.fields[${i}].name 必填`);
    for (const k of Object.keys(f)) if (!['name', 'required', 'enum', 'example', 'hint'].includes(k)) bad(`${at}.entry.fields[${i}] 未知字段 ${k}`);
    const fname = f.name.trim();
    if (fname.length > 30 || /[:：\n]/.test(fname)) bad(`${at}.entry.fields[${i}].name 不能超过 30 字，也不能含冒号或换行`);
    if (seen.has(fname)) bad(`${at}.entry.fields 字段名重复：${fname}`);
    seen.add(fname);
    if (f.required != null && typeof f.required !== 'boolean') bad(`${at}.entry.fields[${i}].required 必须是 true / false`);
    if (f.enum != null && (!Array.isArray(f.enum) || !f.enum.length || !f.enum.every((x) => typeof x === 'string'))) bad(`${at}.entry.fields[${i}].enum 必须是字符串列表`);
    return { name: f.name.trim(), required: f.required === true, enum: f.enum ?? null, example: f.example != null ? String(f.example) : null, hint: f.hint != null ? String(f.hint) : null };
  });
  if (e.unique_title != null && typeof e.unique_title !== 'boolean') bad(`${at}.entry.unique_title 必须是 true / false`);
  const unknown = e.unknown_values ?? ['未知', '待确认'];
  if (!Array.isArray(unknown) || !unknown.every((x) => typeof x === 'string')) bad(`${at}.entry.unknown_values 必须是字符串列表`);
  type.entry = {
    heading, level: heading.length, idPattern: e.id.pattern, idRe, idExample: e.id.example != null ? String(e.id.example) : null,
    uniqueTitle: e.unique_title !== false, fields, unknownValues: unknown, exampleTitle: e.example_title != null ? String(e.example_title) : null,
  };
  return type;
}

export function pageTypeFor(cfg, path) {
  for (const t of Object.values(cfg.page_types)) if (t.pathRes.some((re) => re.test(path))) return t;
  return null;
}
