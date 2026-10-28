// Markdown 文档树：解析、读者可见文字、按可见文字区间改写、序列化回 Markdown。
// 脱敏在树上做（结构规则作用于节点，文字规则作用于“读者看到的连续文字”），再序列化；序列化结果会重新解析比对可见文字。
import MarkdownIt from 'markdown-it';

export const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
md.disable('image');
const Token = md.core.State.prototype.Token;

export function textToken(content) {
  const t = new Token('text', '', 0);
  t.content = content;
  return t;
}

// 块级树：容器节点 { type, open, close, children }，叶子 { type, token }；inline 叶子的行内令牌在 token.children
export function parseTree(text) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  for (const t of md.parse(String(text ?? ''), {})) {
    if (t.nesting === 1) {
      const n = { type: t.type.replace(/_open$/, ''), open: t, close: null, children: [] };
      stack.at(-1).children.push(n);
      stack.push(n);
    } else if (t.nesting === -1) {
      if (stack.length > 1) stack.pop().close = t;
    } else stack.at(-1).children.push({ type: t.type, token: t });
  }
  return root;
}

export function flatten(node, out = []) {
  for (const c of node.children ?? []) {
    if (c.open) { out.push(c.open); flatten(c, out); out.push(c.close); } else out.push(c.token);
  }
  return out;
}

export const inlineOf = (node) => node.children?.find((c) => c.type === 'inline')?.token ?? null;

// ---------- 行内：读者看到的连续文字 ----------
const TEXTY = new Set(['text', 'code_inline']);
// s：行内令牌拼起来的可见文字（软 / 硬换行记作 \n，强调、链接标记不占字符）；owner[i] = [令牌序号, 内容偏移（换行为 -1）]
export function inlineView(children) {
  let s = '';
  const owner = [];
  (children ?? []).forEach((t, k) => {
    if (TEXTY.has(t.type)) {
      for (let o = 0; o < t.content.length; o++) owner.push([k, o]);
      s += t.content;
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') {
      owner.push([k, -1]);
      s += '\n';
    }
  });
  return { s, owner };
}

// 按可见文字的区间改写行内令牌：edits = [{ start, end, repl }]（互不重叠）。区间跨越多个令牌时，替换文字放在第一个字所在的令牌
export function applyInlineEdits(children, view, edits) {
  if (!edits.length) return children;
  const del = new Uint8Array(view.s.length);
  const insAt = new Map();
  for (const e of edits) {
    for (let i = e.start; i < e.end; i++) del[i] = 1;
    if (e.repl) insAt.set(e.start, (insAt.get(e.start) ?? '') + e.repl);
  }
  const parts = children.map(() => []);
  const keepBreak = children.map(() => true);
  const before = new Map();
  view.owner.forEach(([k, o], i) => {
    const ins = insAt.get(i);
    if (o >= 0) {
      if (ins) parts[k].push(ins);
      if (!del[i]) parts[k].push(children[k].content[o]);
    } else {
      if (ins) before.set(k, (before.get(k) ?? '') + ins);
      if (del[i]) keepBreak[k] = false;
    }
  });
  const out = [];
  const atEnd = insAt.get(view.s.length);
  children.forEach((t, k) => {
    if (before.has(k)) out.push(textToken(before.get(k)));
    if (TEXTY.has(t.type)) {
      t.content = parts[k].join('');
      if (t.content !== '') out.push(t);
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') {
      if (keepBreak[k]) out.push(t);
    } else out.push(t);
  });
  if (atEnd) out.push(textToken(atEnd));
  return out;
}

// 一段令牌（整页或一个节点）的可见文字：块之间、单元格之间换行
export function visibleOf(tokens) {
  let s = '';
  for (const t of tokens) {
    if (t.type === 'inline') s += inlineView(t.children).s;
    else if (t.type === 'fence' || t.type === 'code_block') s += `\n${t.content}\n`;
    else if (t.nesting !== 0 || t.type === 'hr') s += '\n';
  }
  return s;
}
export const nodeText = (node) => visibleOf(node.open ? flatten({ children: [node] }) : [node.token]);

// ---------- 序列化 ----------
// 文字转义：反斜杠、反引号、星号、方括号、尖括号总是转义；下划线只在词边界转义（词中的下划线不构成强调）；
// ~ 总是转义；& 只在像实体时转义。行首的 # > - + = | 和“数字.”另行转义（删掉中间的行后，上下行不会拼成标题、表格或列表）
export const escapeText = (s) => String(s)
  .replace(/[\\`*[\]<~]/g, '\\$&')
  .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
  .replace(/&(?=#?[A-Za-z0-9]{1,32};)/g, '\\&');
const escapeLineStart = (line) => line.replace(/^(\s*)([#>+=|-]|\d{1,9}(?=[.)]))/, (m, sp, c) => (/\d/.test(c) ? `${sp}${c}\\` : `${sp}\\${c}`));
// 链接目标：含括号或空白时用 <…> 包起来（括号原样保留），里面只编码 < > \ 和换行
const pct = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
// 目标里像实体的 & 前加反斜杠，免得重新解析时被解码（ghp&lowbar;… 不能变成 ghp_…）
const encodeHref = (h) => {
  const v = String(h).replace(/&(?=#?[A-Za-z0-9]{1,32};)/g, '\\&');
  return /[\s()<>]/.test(v) ? `<${v.replace(/[<>\n]/g, pct)}>` : v;
};

// 相邻的“结束 X、开始 X”成对去掉（反复做，处理嵌套：~~**甲**~~~~**乙**~~ → ~~**甲乙**~~）；不产生输出的令牌不算间隔
function mergeAdjacent(children) {
  let toks = (children ?? []).filter((t) => !((t.type === 'text' || t.type === 'code_inline') && t.content === '') && t.type !== 'em_open' && t.type !== 'em_close');
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i].type;
      const b = toks[i + 1].type;
      if ((a === 'strong_close' && b === 'strong_open') || (a === 's_close' && b === 's_open')) { toks = [...toks.slice(0, i), ...toks.slice(i + 2)]; changed = true; break; }
    }
  }
  return toks;
}

function serializeInline(children) {
  children = mergeAdjacent(children);
  let out = '';
  const stack = [];
  let prevClose = null; // 刚输出的强调结束标记：紧接着又开始同类强调时直接合并（**甲****乙** → **甲乙**）
  for (const t of children ?? []) {
    const before = out.length;
    switch (t.type) {
      case 'text': case 'code_inline': out += escapeText(t.content); break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '\\\n'; break;
      case 'strong_open': case 's_open': {
        const mark = t.type === 'strong_open' ? '**' : '~~';
        if (prevClose && prevClose.mark === mark && prevClose.end === out.length) {
          out = out.slice(0, -mark.length);
          stack.push({ pos: prevClose.openPos, mark });
        } else {
          stack.push({ pos: out.length, mark });
          out += mark;
        }
        prevClose = null;
        continue;
      }
      case 'strong_close': case 's_close': {
        const o = stack.pop();
        if (!o || !o.mark) break;
        const inner = out.slice(o.pos + o.mark.length);
        // 空的、或首尾是空白的强调，Markdown 不认，标记会变成可见字符：去掉标记
        if (!inner || /^\s|\s$/.test(inner)) { out = out.slice(0, o.pos) + inner; break; }
        out += o.mark;
        prevClose = { mark: o.mark, end: out.length, openPos: o.pos };
        continue;
      }
      case 'link_open': stack.push({ pos: out.length, href: t.attrGet('href') ?? '' }); out += '['; break;
      case 'link_close': { const o = stack.pop(); if (o && o.href !== undefined) out += `](${encodeHref(o.href)})`; break; }
      default: break; // 斜体等只留文字
    }
    if (out.length !== before) prevClose = null; // 不产生输出的令牌（斜体标记、空文字）不打断合并
  }
  return out;
}

// 相邻的同类列表在 Markdown 里会合并成一个：交替使用列表标记（- / *、. / )）让它们保持分开
function blocks(nodes, tight = false) {
  let prev = null;
  const parts = nodes.map((n) => {
    let lines;
    if (n.type === 'bullet_list' || n.type === 'ordered_list') {
      const ordered = n.type === 'ordered_list';
      const want = ordered ? (n.open.markup === ')' ? ')' : '.') : '-';
      const alt = ordered ? (want === '.' ? ')' : '.') : '*';
      const mark = prev && prev.type === n.type && prev.mark === want ? alt : want;
      lines = listBlock(n, ordered, mark);
      prev = { type: n.type, mark };
    } else {
      lines = block(n);
      if (lines.length) prev = null;
    }
    return lines;
  }).filter((l) => l.length);
  return parts.flatMap((lines, i) => (i ? (tight ? lines : ['', ...lines]) : lines));
}

function listBlock(n, ordered, mark = ordered ? '.' : '-') {
  // 起始编号会显示出来：超过 4 位（可能是号码）一律从 1 开始
  const raw = ordered ? Number(n.open.attrGet('start') ?? 1) : 1;
  const start = Number.isInteger(raw) && raw >= 0 && raw <= 9999 ? raw : 1;
  const items = n.children.filter((c) => c.type === 'list_item');
  const tight = items.some((item) => item.children.some((c) => c.type === 'paragraph' && c.open.hidden));
  const out = [];
  items.forEach((item, i) => {
    const marker = ordered ? `${start + i}${mark} ` : `${mark} `;
    const lines = blocks(item.children, tight);
    if (i && !tight) out.push('');
    (lines.length ? lines : ['']).forEach((l, k) => out.push(k === 0 ? marker + l : (l === '' ? '' : ' '.repeat(marker.length) + l)));
  });
  return out;
}

function tableBlock(n) {
  const rows = [];
  const walk = (x) => { for (const c of x.children ?? []) { if (c.type === 'tr') rows.push(c); else if (c.open) walk(c); } };
  walk(n);
  const cell = (c) => serializeInline(inlineOf(c)?.children).replace(/\\\n|\n/g, ' ').replace(/\|/g, '\\|');
  const out = [];
  rows.forEach((r, i) => {
    const cells = r.children.filter((c) => c.type === 'th' || c.type === 'td');
    out.push(`| ${cells.map(cell).join(' | ')} |`);
    if (i === 0) {
      out.push(`|${cells.map((c) => {
        const a = /text-align:(\w+)/.exec(c.open.attrGet('style') ?? '')?.[1];
        return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
      }).join('|')}|`);
    }
  });
  return out;
}

function longestRun(s, ch) {
  let best = 0;
  let cur = 0;
  for (const c of s) { cur = c === ch ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
}

function block(n) {
  switch (n.type) {
    case 'heading': {
      const text = serializeInline(inlineOf(n)?.children).replace(/\\\n|\n/g, ' ').replace(/#/g, '\\#');
      return [`${'#'.repeat(Number(n.open.tag.slice(1)) || 1)} ${text}`];
    }
    case 'paragraph': return serializeInline(inlineOf(n)?.children).split('\n').map(escapeLineStart);
    case 'bullet_list': return listBlock(n, false);
    case 'ordered_list': return listBlock(n, true);
    case 'blockquote': return blocks(n.children).map((l) => (l ? `> ${l}` : '>'));
    case 'table': return tableBlock(n);
    case 'fence': case 'code_block': {
      const content = n.token.content.replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
      return [fence, ...content.split('\n'), fence]; // 语言标记不输出（它也是成员写的文字）
    }
    case 'hr': return ['---'];
    default: return n.children?.length ? blocks(n.children) : [];
  }
}

export function serialize(tree) {
  return blocks(tree.children).join('\n').trim();
}

// 所有链接目标（按出现顺序）
export function hrefsOf(tokens) {
  const out = [];
  for (const t of tokens) if (t.type === 'inline') for (const c of t.children ?? []) if (c.type === 'link_open') out.push(c.attrGet('href') ?? '');
  return out;
}
// 往返检查：序列化结果重新解析后，可见文字、链接目标、有序列表起始编号都必须与树上一致
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const starts = (tokens) => tokens.filter((t) => t.type === 'ordered_list_open').map((t) => Number(t.attrGet('start') ?? 1));
export function roundTripOk(tree, text) {
  const a = flatten(tree);
  const b = md.parse(text, {});
  const clamp = (x) => (Number.isInteger(x) && x >= 0 && x <= 9999 ? x : 1);
  return squash(visibleOf(a)) === squash(visibleOf(b))
    && JSON.stringify(hrefsOf(a)) === JSON.stringify(hrefsOf(b))
    && JSON.stringify(starts(a).map(clamp)) === JSON.stringify(starts(b));
}
