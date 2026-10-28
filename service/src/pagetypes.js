// 结构化页面的条目解析、校验与模板。
// 模板（page_template）和校验规则都从 config.yaml 里同一份 page_types 定义生成，二者不会各说各话。
//
// 条目格式（以餐厅为例）：
//   ### R35 某某店
//   - 片区：示例城市甲·中心街区
//   - 人均：大众点评¥80（截图，2025-01-15）
//   ...
// 同级标题都必须是条目；更高一级的标题（## / #）只是分节，结束当前条目。
import MarkdownIt from 'markdown-it';
import { pageTypeFor } from './instance-config.js';

// 用 CommonMark 解析器识别块结构（R2-7）：标题、代码块、引用、列表的判定与渲染结果一致，不再手写规则。
const md = new MarkdownIt('commonmark');
const FIELD = /^([^:：\n]{1,30}?)\s*[:：]\s*(.*)$/;

export const normTitle = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s·・.,，。()（）\-_/]+/g, '');

// 条目格式：顶格的 `### <编号> <名称>`；条目里的列表项首行 `字段：值` 是字段。
// 引用块或列表里的同级（或更高级）标题、HTML 标题在结构化页面里一律报错，不能静默放过。
export function parseEntries(text, def) {
  const lines = String(text ?? '').split('\n');
  if (lines[0] === '---') { // frontmatter 换成空行（保留行号），不交给 Markdown 解析
    const end = lines.indexOf('---', 1);
    if (end > 0) for (let k = 0; k <= end; k++) lines[k] = '';
  }
  const tokens = md.parse(lines.join('\n'), {});
  const entries = [];
  const errors = [];
  const fieldNames = new Set(def.fields.map((f) => f.name));
  const where = (n) => `第 ${n + 1} 行「${(lines[n] ?? '').trim().slice(0, 60)}」`;
  let cur = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const line = t.map?.[0] ?? tokens[i - 1]?.map?.[0] ?? 0;
    if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1));
      const content = tokens[i + 1]?.type === 'inline' ? tokens[i + 1].content.trim() : '';
      if (t.level > 0) {
        if (level <= def.level) errors.push(`${where(line)}：结构化页面的标题必须顶格写，不能放在引用或列表里`);
        continue;
      }
      if (level === def.level) {
        const m = /^(\S+)\s+(.+)$/.exec(content);
        if (!m || !def.idRe.test(m[1])) {
          errors.push(`${where(line)}：条目标题应为「${def.heading} <编号> <名称>」，编号格式 ${def.idPattern}${def.idExample ? `（如 ${def.idExample}）` : ''}`);
          cur = null;
          continue;
        }
        cur = { id: m[1], title: m[2].trim(), line: line + 1, fields: new Map(), dupFields: [] };
        entries.push(cur);
      } else if (level < def.level) {
        cur = null;
      }
      continue;
    }
    if ((t.type === 'html_block' || t.type === 'inline') && /<h[1-6][\s>/]/i.test(t.content)) {
      errors.push(`${where(line)}：结构化页面里不要用 HTML 标题`);
      continue;
    }
    if (cur && t.type === 'inline' && tokens[i - 1]?.type === 'paragraph_open' && tokens[i - 2]?.type === 'list_item_open') {
      const fm = FIELD.exec(t.content.split('\n')[0]);
      if (fm && fieldNames.has(fm[1].trim())) {
        const name = fm[1].trim();
        if (cur.fields.has(name)) cur.dupFields.push(name);
        else cur.fields.set(name, fm[2].trim());
      }
    }
  }
  return { entries, errors };
}

// 校验一页的最终完整内容。others = 同类型其他页面的条目（用于跨页编号、同名去重）。
// 返回错误列表（空 = 通过），每条都指出是哪一条、缺了什么。
export function validateEntries(text, type, others = []) {
  const def = type.entry;
  if (!def) return [];
  const { entries, errors } = parseEntries(text, def);
  const ids = new Map(); const titles = new Map();
  for (const o of others) { ids.set(o.id, o.where); if (def.uniqueTitle) titles.set(normTitle(o.title), `${o.where} 的 ${o.id}`); }
  for (const e of entries) {
    const label = `${e.id} ${e.title}`;
    if (ids.has(e.id)) errors.push(`${label}：编号 ${e.id} 重复（已在 ${ids.get(e.id)} 使用）`);
    else ids.set(e.id, `本页第 ${e.line} 行`);
    if (def.uniqueTitle) {
      const k = normTitle(e.title);
      if (titles.has(k)) errors.push(`${label}：同名条目已存在（${titles.get(k)}）；更新已有条目请改原条目，不要新增`);
      else titles.set(k, `本页 ${e.id}`);
    }
    for (const name of e.dupFields) errors.push(`${label}：字段「${name}」写了不止一次`);
    for (const field of def.fields) {
      const v = e.fields.get(field.name);
      if (v == null || v === '') {
        if (field.required) errors.push(`${label}：缺少必填字段「${field.name}」（不知道就写 ${def.unknownValues.join(' / ')}，不要猜）`);
        continue;
      }
      if (field.enum && !field.enum.includes(v) && !def.unknownValues.includes(v)) {
        errors.push(`${label}：字段「${field.name}」的值「${v.slice(0, 30)}」不在允许范围内（${field.enum.join(' / ')}）`);
      }
    }
  }
  return errors;
}

export function nextId(type, allEntries) {
  const def = type.entry;
  const sample = def.idExample ?? allEntries[0]?.id;
  if (!sample) return null;
  const m = /^(\D*)(\d+)$/.exec(sample);
  if (!m) return null;
  const prefix = m[1]; const width = m[2].length;
  let max = 0;
  for (const e of allEntries) {
    const mm = /^(\D*)(\d+)$/.exec(e.id);
    if (mm && mm[1] === prefix) max = Math.max(max, Number(mm[2]));
  }
  const candidate = `${prefix}${String(max + 1).padStart(width, '0')}`;
  return def.idRe.test(candidate) ? candidate : null;
}

// page_template 的返回：类型说明 + 条目模板 + 字段表 + 下一个可用编号
export function templateFor(cfg, path, allEntriesOfType = []) {
  const type = pageTypeFor(cfg, path);
  if (!type) {
    return {
      path, page_type: null, kind: 'free',
      guidance: '自由页面：不受条目模板约束，只做基础检查（路径、大小、凭据、个人信息、frontmatter）。写法请遵循 _commons/conventions.md。',
    };
  }
  if (!type.entry) {
    return { path, page_type: type.name, kind: 'free', description: type.description, guidance: '该类型没有条目模板，只做基础检查。' };
  }
  const def = type.entry;
  const id = nextId(type, allEntriesOfType) ?? def.idExample ?? '<编号>';
  const lines = [`${def.heading} ${id} ${def.exampleTitle ?? '<名称>'}`];
  for (const f of def.fields) {
    const value = f.example ?? (f.enum ? f.enum[0] : (f.required ? '<必填>' : '<可选>'));
    lines.push(`- ${f.name}：${value}`);
  }
  return {
    path, page_type: type.name, kind: 'structured', description: type.description,
    entry_heading: def.heading, id_pattern: def.idPattern, next_id: id,
    unique_title: def.uniqueTitle, unknown_values: def.unknownValues,
    fields: def.fields.map((f) => ({ name: f.name, required: f.required, enum: f.enum ?? undefined, example: f.example ?? undefined, hint: f.hint ?? undefined })),
    template: lines.join('\n'),
    rules: [
      `每个条目以「${def.heading} <编号> <名称>」开头，编号格式 ${def.idPattern}，在同类型所有页面里唯一`,
      def.uniqueTitle ? '同名条目不能重复：更新已有条目请改原条目' : null,
      `必填字段不知道时写 ${def.unknownValues.join(' / ')}，不要为了通过校验去猜`,
      '字段行格式：「- 字段名：值」；其他说明可以写在条目里的普通段落',
    ].filter(Boolean),
  };
}
