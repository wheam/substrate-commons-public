// 引擎内置的结构 lint：绝不执行实例仓库里的任何脚本。
// frontmatter 必须可解析（阻断）；断链只提示（不阻断）。
import YAML from 'yaml';
import path from 'node:path';

export function lintPage(pagePath, text, existingPaths) {
  const errors = [];
  const warnings = [];
  const s = String(text ?? '');
  if (s.startsWith('---\n') || s === '---') {
    const end = s.indexOf('\n---', 3);
    if (end < 0) errors.push('frontmatter 以 --- 开头但没有闭合的 ---');
    else {
      try {
        const fm = YAML.parse(s.slice(4, end), { maxAliasCount: 0 });
        if (fm != null && (typeof fm !== 'object' || Array.isArray(fm))) errors.push('frontmatter 必须是键值映射');
      } catch (e) {
        errors.push(`frontmatter 不是合法 YAML（${String(e.message).split('\n')[0]}）`);
      }
    }
  }
  // 相对 .md 链接断链提示
  const dir = path.posix.dirname(pagePath);
  const seen = new Set();
  for (const m of s.matchAll(/\]\(([^)\s#\]]{1,300}?\.md)(?:#[^)\s]{0,200})?\)/g)) { // 量词有上界，避免长串回溯
    const target = m[1];
    if (/^[a-z]+:/i.test(target) || seen.has(target)) continue;
    seen.add(target);
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(dir, target));
    if (!existingPaths.has(resolved)) warnings.push(`链接指向的页面不存在：${target}`);
  }
  return { errors, warnings };
}
