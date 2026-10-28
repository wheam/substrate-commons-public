// 统一的内容路径策略：只认 .md；拒绝 ..、绝对路径、隐藏路径、控制字符；
// 限制深度与长度；_commons/ 只能经 update_config 修改。读写、历史、revert、维护导入共用这一份规则。
import { fail } from './util.js';
import { containsCredential } from './secrets.js';

export const COMMONS_DIR = '_commons';
export const CONFIG_PATH = '_commons/config.yaml';
export const CONVENTIONS_PATH = '_commons/conventions.md';
export const CONFIG_FILES = new Set([CONFIG_PATH, CONVENTIONS_PATH]);

const MAX_PATH = 200;
const MAX_SEGMENT = 100;
const MAX_DEPTH = 6;
// 段内允许：任意语言的字母和数字、组合符号、- _ . 以及中文常用的间隔号
const SEGMENT_RE = /^[\p{L}\p{N}\p{M}_.\-·]+$/u;

// 返回规范化后的路径，或抛 INVALID_PATH。kind: 'content'（普通页）| 'config'（_commons 文件）| 'any'
export function checkPath(input, { kind = 'content' } = {}) {
  if (typeof input !== 'string' || !input) fail('INVALID_PATH', 'path 必须是非空字符串');
  if (containsCredential(input)) fail('CREDENTIAL_DETECTED', 'path 里疑似含有密钥或凭据，已拒绝'); // 先查，后面的报错文案才不会回显它
  const p = input.normalize('NFC');
  if (p !== input) fail('INVALID_PATH', 'path 必须是 Unicode NFC 规范形式');
  if (p.length > MAX_PATH) fail('INVALID_PATH', `path 过长（上限 ${MAX_PATH} 字符）`);
  if (/[\p{Cc}\p{Cf}\\]/u.test(p)) fail('INVALID_PATH', 'path 不能含控制字符、格式字符或反斜杠');
  if (p.startsWith('/')) fail('INVALID_PATH', 'path 必须是实例内相对路径，不能以 / 开头');
  const segs = p.split('/');
  if (segs.length > MAX_DEPTH) fail('INVALID_PATH', `目录层级过深（上限 ${MAX_DEPTH}）`);
  for (const s of segs) {
    if (!s) fail('INVALID_PATH', 'path 不能含空段（// 或结尾 /）');
    if (s === '.' || s === '..') fail('INVALID_PATH', 'path 不能含 . 或 ..');
    if (s.startsWith('.')) fail('INVALID_PATH', '不允许隐藏路径（以 . 开头的段）');
    if (s.length > MAX_SEGMENT) fail('INVALID_PATH', `路径段过长（上限 ${MAX_SEGMENT}）`);
    if (!SEGMENT_RE.test(s)) fail('INVALID_PATH', `路径段含不允许的字符：${JSON.stringify(s)}（允许字母、数字、- _ . ·）`);
  }
  if (!p.endsWith('.md')) fail('INVALID_PATH', '只允许 .md 页面');
  if (segs.slice(0, -1).some((seg) => seg.toLowerCase().endsWith('.md'))) fail('INVALID_PATH', '目录名不能以 .md 结尾');
  const isConfig = segs[0] === COMMONS_DIR;
  if (isConfig) {
    if (kind === 'content') fail('FORBIDDEN', '_commons/ 下的文件只能由 admin 经 update_config 修改');
    if (!CONFIG_FILES.has(p) && p !== CONFIG_PATH) fail('INVALID_PATH', `_commons/ 下只允许 ${[...CONFIG_FILES].join('、')}`);
  } else if (kind === 'config') {
    fail('INVALID_PATH', `update_config 只能修改 ${[...CONFIG_FILES].join('、')}`);
  }
  return p;
}

// config.yaml 不是 .md；单独校验
export function checkConfigPath(input) {
  if (input === CONFIG_PATH || input === CONVENTIONS_PATH) return input;
  return fail('INVALID_PATH', `update_config 只能修改 ${CONFIG_PATH} 或 ${CONVENTIONS_PATH}`);
}

// 已提交树里的条目是否可以发布给读接口：只认普通文件（100644）的合法内容路径或 _commons 配置文件。
export function isPublishableEntry(p, entry) {
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644') return false;
  if (p === CONFIG_PATH) return true;
  try { checkPath(p, { kind: 'any' }); return true; } catch { return false; }
}

export const isContentPath = (p) => !p.startsWith(`${COMMONS_DIR}/`);

// 最终树的路径冲突（Codex 实现评审 #5）：在大小写不敏感的文件系统（macOS / Windows）上克隆时会互相覆盖或合并的情况。
// allPaths = 最终树里全部文件路径；changed = 本次新增或修改的路径。只报告牵涉本次变更的冲突，不让历史遗留问题挡住无关写入。
export function treeConflicts(allPaths, changed) {
  const files = new Map(); // lower → 实际文件路径
  const dirs = new Map(); // lower → 实际目录路径
  const conflicts = [];
  for (const p of allPaths) {
    const lower = p.toLowerCase();
    if (files.has(lower) && files.get(lower) !== p) conflicts.push([files.get(lower), p, '文件名只差大小写']);
    files.set(lower, files.get(lower) ?? p);
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      const dl = d.toLowerCase();
      if (dirs.has(dl) && dirs.get(dl) !== d) conflicts.push([dirs.get(dl), d, '目录名只差大小写']);
      if (!dirs.has(dl)) dirs.set(dl, d);
    }
  }
  for (const [dl, d] of dirs) if (files.has(dl)) conflicts.push([files.get(dl), `${d}/`, '同名的文件和目录']);
  const touched = (x) => [...changed].some((c) => c === x || c.toLowerCase() === x.toLowerCase() || c.toLowerCase().startsWith(`${x.replace(/\/$/, '').toLowerCase()}/`));
  return conflicts.filter(([a, b]) => touched(a) || touched(b));
}
