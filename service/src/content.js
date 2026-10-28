// 内容访问层：所有读取都从某个提交的 git 对象直接读，不走文件系统。
// 读接口只看“已发布版本”；树里的符号链接、gitlink、可执行文件、非法路径一律不发布。
// 实例规模很小（几十页），P1 不建 FTS 索引，search 直接扫描已提交快照；缓存按 commit / blob 寻址，天然不会过期。
import { isPublishableEntry, CONFIG_PATH, CONVENTIONS_PATH } from './paths.js';
import { parseConfig, pageTypeFor } from './instance-config.js';
import { parseEntries } from './pagetypes.js';

export function createContent({ repo, displayName }) {
  const treeCache = new Map();
  const blobCache = new Map();
  let blobBytes = 0;
  const configCache = new Map();

  async function tree(commit) {
    if (!commit) return { all: new Map(), pages: new Map() };
    let t = treeCache.get(commit);
    if (t) { treeCache.delete(commit); treeCache.set(commit, t); return t; }
    const raw = await repo.lsTree(commit);
    t = { all: raw, pages: new Map() };
    for (const [p, e] of raw) if (isPublishableEntry(p, e)) t.pages.set(p, e);
    treeCache.set(commit, t);
    if (treeCache.size > 64) treeCache.delete(treeCache.keys().next().value);
    return t;
  }

  async function blobText(sha) {
    let s = blobCache.get(sha);
    if (s != null) return s;
    s = (await repo.catBlob(sha)).toString('utf8');
    blobCache.set(sha, s);
    blobBytes += s.length;
    while (blobBytes > 64 * 1024 * 1024 && blobCache.size > 1) {
      const [k, v] = blobCache.entries().next().value;
      blobCache.delete(k); blobBytes -= v.length;
    }
    return s;
  }

  async function read(commit, p) {
    const t = await tree(commit);
    const e = t.pages.get(p);
    if (!e) return null;
    return { text: await blobText(e.sha), blob: e.sha, size: e.size };
  }

  async function config(commit) {
    const t = await tree(commit);
    const e = t.pages.get(CONFIG_PATH);
    const asDir = [...t.all.keys()].some((k) => k.startsWith(`${CONFIG_PATH}/`)); // 配置路径是个目录（R3-4）
    if (!e && (t.all.has(CONFIG_PATH) || asDir)) {
      // 配置文件存在但不是普通文件（链接、可执行位等）：当作损坏，而不是“没有配置”（R2-6）
      const cfg = parseConfig(null, { displayName });
      cfg.invalid = '_commons/config.yaml 不是普通文件（链接、可执行文件或目录）';
      return cfg;
    }
    const key = e?.sha ?? 'none';
    if (configCache.has(key)) return configCache.get(key);
    let cfg;
    // 配置损坏时：读仍可用（按默认配置展示），写一律拒绝（engine 检查 invalid）——绝不退回到更宽松的策略继续写
    try { cfg = parseConfig(e ? await blobText(e.sha) : null, { displayName }); } catch (err) { cfg = parseConfig(null, { displayName }); cfg.invalid = String(err.message); }
    configCache.set(key, cfg);
    return cfg;
  }

  async function conventions(commit) {
    const r = await read(commit, CONVENTIONS_PATH);
    return r?.text ?? '';
  }

  async function listPages(commit, prefix = '') {
    const t = await tree(commit);
    const out = [];
    for (const [p, e] of t.pages) if (p.startsWith(prefix)) out.push({ path: p, blob_rev: e.sha, size: e.size });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function search(commit, query, { limit = 30, prefix = '' } = {}) {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const t = await tree(commit);
    const results = [];
    for (const [p, e] of t.pages) {
      if (!p.startsWith(prefix)) continue;
      const text = await blobText(e.sha);
      const lower = text.toLowerCase();
      const hay = `${p.toLowerCase()}\n${lower}`;
      if (!terms.every((term) => hay.includes(term))) continue;
      const lines = text.split('\n');
      const snippets = [];
      let score = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        const hits = terms.filter((term) => l.includes(term)).length;
        if (!hits) continue;
        score += hits;
        if (snippets.length < 3) snippets.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
      if (terms.some((term) => p.toLowerCase().includes(term))) score += 3;
      results.push({ path: p, blob_rev: e.sha, score, snippets });
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return results.slice(0, limit);
  }

  // 同类型所有页面的条目（用于跨页编号唯一、同名去重、下一个编号）
  async function entriesOfType(commit, cfg, type, { excludePath = null } = {}) {
    const t = await tree(commit);
    const out = [];
    for (const [p, e] of t.pages) {
      if (p === excludePath || pageTypeFor(cfg, p) !== type) continue;
      const { entries } = parseEntries(await blobText(e.sha), type.entry);
      for (const en of entries) out.push({ id: en.id, title: en.title, where: p });
    }
    return out;
  }

  return { tree, read, blobText, config, conventions, listPages, search, entriesOfType };
}
