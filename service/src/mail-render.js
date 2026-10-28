// 通知邮件排版：同一份结构化内容渲染成 HTML（卡片式，内联样式，兼容 Gmail / 手机）和纯文本两个版本。
// 内容全部来自成员的 agent：一律转义；只认 **加粗** 和 http(s) 链接两种行内写法，不接受任何原始 HTML。

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const URL_RE = /https?:\/\/[^\s<>"'*，。；、）)]+/g;
const BOLD_RE = /\*\*([^*]+?)\*\*/g;

// 行内：先按 **加粗** 切段，再在每段里找 http(s) 网址；HTML 与纯文本共用同一切分，链接目标不会带上星号
function segments(s) {
  const out = [];
  let last = 0;
  const str = String(s);
  for (const m of str.matchAll(BOLD_RE)) {
    if (m.index > last) out.push({ t: str.slice(last, m.index), bold: false });
    out.push({ t: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ t: str.slice(last), bold: false });
  return out;
}
function linkify(t) {
  let html = '';
  let last = 0;
  for (const m of t.matchAll(URL_RE)) {
    html += esc(t.slice(last, m.index)) + `<a href="${esc(m[0])}" style="color:#1f6feb;text-decoration:underline;word-break:break-all">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return html + esc(t.slice(last));
}
export function inline(s) {
  return segments(s).map((g) => (g.bold ? `<strong>${linkify(g.t)}</strong>` : linkify(g.t))).join('');
}
export const plain = (s) => segments(s).map((g) => g.t).join('');

// 标签颜色：按常见状态词归类
const TAGS = [
  [/新增|新加|上新/, ['#e7f6ec', '#1a7f37']],
  [/取消|删除|作废|下架/, ['#fdecec', '#c62828']],
  [/待定|待确认|待核|候选|备选/, ['#fff4dc', '#9a6700']],
  [/已订|已定|确认|定了|已付/, ['#e3f2f1', '#00796b']],
  [/修改|更新|改|调整|补充/, ['#e8f0fe', '#1f5fbf']],
];
const tagColors = (tag) => (TAGS.find(([re]) => re.test(tag))?.[1] ?? ['#efefef', '#555']);

// 按钮样式：图标 + 文字；默认文字可被 label 覆盖
const BUTTONS = {
  dianping: { icon: '🍴', text: '大众点评', bg: '#fff1e6', fg: '#d9480f', bd: '#ffd8bf' },
  ctrip: { icon: '🏨', text: '携程', bg: '#e8f1ff', fg: '#1f5fbf', bd: '#c9dcff' },
  map: { icon: '📍', text: '地图', bg: '#e7f6ec', fg: '#1a7f37', bd: '#c3e8cf' },
  web: { icon: '🔗', text: '链接', bg: '#f0f0f0', fg: '#444444', bd: '#dddddd' },
};
const buttonText = (l) => `${BUTTONS[l.kind].icon} ${l.label ?? BUTTONS[l.kind].text}`;
function buttonsHtml(links) {
  if (!links?.length) return '';
  return `<div style="margin-top:10px">${links.map((l) => {
    const b = BUTTONS[l.kind];
    return `<a href="${esc(l.url)}" style="display:inline-block;margin:0 6px 6px 0;padding:6px 12px;border-radius:999px;background:${b.bg};color:${b.fg};border:1px solid ${b.bd};font-size:13px;font-weight:600;text-decoration:none;line-height:1.3">${esc(buttonText(l))}</a>`;
  }).join('')}</div>`;
}

const F = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";

function cardHtml(c) {
  const [bg, fg] = c.tag ? tagColors(c.tag) : [];
  return `<tr><td style="padding:12px 14px;background:#ffffff;border:1px solid #e7e5df;border-radius:12px">
<div style="font-size:16px;font-weight:600;color:#1d1d1f;line-height:1.4">${inline(c.title)}${c.tag ? ` <span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;vertical-align:2px">${esc(c.tag)}</span>` : ''}</div>
${c.subtitle ? `<div style="font-size:13px;color:#6e6e73;margin-top:4px;line-height:1.5">${inline(c.subtitle)}</div>` : ''}
${(c.lines ?? []).map((l) => `<div style="font-size:14px;color:#333;margin-top:5px;line-height:1.55">${inline(l)}</div>`).join('\n')}
${buttonsHtml(c.links)}
</td></tr><tr><td style="height:10px;line-height:10px;font-size:0">&nbsp;</td></tr>`;
}

function sectionHtml(s) {
  return `<div style="margin:24px 0 10px;font-size:17px;font-weight:700;color:#1d1d1f">${inline(s.title)}</div>
${s.note ? `<div style="font-size:14px;color:#444;line-height:1.6;margin-bottom:10px">${inline(s.note).replace(/\n/g, '<br>')}</div>` : ''}
${s.cards?.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate">${s.cards.map(cardHtml).join('\n')}</table>` : ''}
${s.bullets?.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${s.bullets.map((b) => `<tr><td valign="top" style="width:16px;font-size:14px;color:#8a8a8e;line-height:1.6">•</td><td style="font-size:14px;color:#333;line-height:1.6;padding-bottom:6px">${inline(b)}</td></tr>`).join('')}</table>` : ''}`;
}

// content: { headline, action, sections[] }；meta: { instanceName, subject, senderName, guideUrl, recipients[] }
export function renderAnnouncement(content, meta) {
  const { headline, action, sections } = content;
  const { instanceName, subject, senderName, guideUrl, recipientNames, replyToSender = true } = meta;
  const footer = `由 ${senderName} 的 AI 在 ${senderName} 确认后，经「${instanceName}」共享库发出 · ${replyToSender ? `直接回复会发给 ${senderName}` : '直接回复会发到发件邮箱'}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f3ef">
<div style="display:none;max-height:0;overflow:hidden;color:transparent">${esc(plain(headline))}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f3ef"><tr><td align="center" style="padding:16px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;font-family:${F};color:#1d1d1f">
<tr><td style="background:#1f4e5f;border-radius:14px 14px 0 0;padding:14px 18px">
<div style="font-size:12px;letter-spacing:1px;color:#bfe0e8">${esc(instanceName)} · 更新通知</div>
<div style="font-size:21px;font-weight:700;color:#ffffff;margin-top:4px;line-height:1.35">${inline(subject)}</div>
</td></tr>
<tr><td style="background:#fbfaf7;border-radius:0 0 14px 14px;padding:16px 18px 20px">
<div style="background:#fff8e1;border-left:4px solid #f2b300;border-radius:8px;padding:12px 14px">
<div style="font-size:15px;line-height:1.6;color:#1d1d1f">${inline(headline)}</div>
<div style="font-size:15px;line-height:1.6;color:#1d1d1f;margin-top:6px"><strong>你需要做：</strong>${inline(action)}</div>
</div>
${sections.map(sectionHtml).join('\n')}
${guideUrl ? `<div style="margin:26px 0 6px"><a href="${esc(guideUrl)}" style="display:inline-block;background:#1f6feb;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:10px;font-size:15px;font-weight:600">查看完整资料 →</a></div>` : ''}
<div style="font-size:12px;color:#8a8a8e;border-top:1px solid #e7e5df;margin-top:22px;padding-top:12px;line-height:1.6">${esc(footer)}<br>收件人：${esc(recipientNames.join('、'))}</div>
</td></tr></table>
</td></tr></table></body></html>`;

  const t = [plain(headline), `你需要做：${plain(action)}`];
  for (const s of sections) {
    t.push('', `【${plain(s.title)}】`);
    if (s.note) t.push(plain(s.note));
    (s.cards ?? []).forEach((c, i) => {
      t.push(`${i + 1}. ${plain(c.title)}${c.tag ? `（${c.tag}）` : ''}`);
      if (c.subtitle) t.push(`   ${plain(c.subtitle)}`);
      for (const l of c.lines ?? []) t.push(`   ${plain(l)}`);
      for (const l of c.links ?? []) t.push(`   ${buttonText(l)}：${l.url}`);
    });
    for (const b of s.bullets ?? []) t.push(`· ${plain(b)}`);
  }
  t.push('', '—');
  if (guideUrl) t.push(`完整资料：${guideUrl}`);
  t.push(footer, `收件人：${recipientNames.join('、')}`);
  return { html, text: `${t.join('\n')}\n` };
}
