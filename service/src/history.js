// 历史工具与游标。
// 归属以 git 外的提交账本为权威：账本里有 → service_authenticated / maintenance_import；没有 → unverified。
// 姓名、邮箱、trailer 只是声明，从不拿来补认证归属。
// cursor 用服务端密钥签名，固定三样东西：本轮上界、已返回到的位置、过滤条件；读取本身从不推进已读位置。
import { fail, hmac, timingSafeEqualStr, b64url, utf8Bytes } from './util.js';
import { parseTrailers, stripTrailers } from './git.js';
import { checkPath, isPublishableEntry, CONFIG_PATH } from './paths.js';

const MAX_LIMIT = 50;

// 一条原始变更是否在内容策略内：路径合法，两端都是普通文件（或不存在）
const OK_MODES = new Set(['000000', '100644']);
export function visibleDiff(d) {
  if (!OK_MODES.has(d.srcMode) || !OK_MODES.has(d.dstMode)) return false;
  return isPublishableEntry(d.path, { type: 'blob', mode: '100644' });
}

export function createHistory({ db, repo, members, published, secret }) {
  const key = () => (typeof secret === 'function' ? secret() : secret);
  const sign = (payload) => {
    const body = b64url.encode(JSON.stringify(payload));
    return `${body}.${hmac(key(), body)}`;
  };
  const verify = (cursor, actor) => {
    const [body, sig] = String(cursor ?? '').split('.');
    if (!body || !sig || !timingSafeEqualStr(sig, hmac(key(), body))) fail('INVALID_CURSOR', 'cursor 无效或被改动过');
    let p;
    try { p = JSON.parse(b64url.decode(body).toString('utf8')); } catch { fail('INVALID_CURSOR', 'cursor 无效'); }
    if (p.t !== actor.token_id) fail('INVALID_CURSOR', '这个 cursor 不属于当前凭据');
    return p;
  };

  const nameCache = new Map();
  const displayName = (memberId) => {
    if (!memberId) return null;
    if (!nameCache.has(memberId)) nameCache.set(memberId, members.getMember(memberId)?.display_name ?? memberId);
    return nameCache.get(memberId);
  };

  async function describe(infos) {
    const out = [];
    for (const c of infos) {
      const led = db.get('SELECT * FROM ledger WHERE commit_sha = ?', c.sha);
      const { trailers, present } = parseTrailers(c.message);
      const stat = await repo.numstat(c.sha);
      const full = stripTrailers(c.message).trim();
      const [subject, ...rest] = full.split('\n');
      const base = {
        commit_rev: c.sha, time: new Date(c.time).toISOString(),
        summary: subject, message: rest.join('\n').trim() || subject, added_lines: stat.added, deleted_lines: stat.deleted,
      };
      if (led) {
        const extra = led.extra ? JSON.parse(led.extra) : null;
        out.push({
          ...base, attribution: led.attribution, member_id: led.member_id, display_name: led.member_id ? displayName(led.member_id) : 'system',
          client_label: led.client_label, op: led.op, paths: JSON.parse(led.paths),
          ...(extra?.reverts ? { reverts: extra.reverts } : {}), ...(extra?.import_of ? { import_of: extra.import_of } : {}),
        });
      } else {
        const raw = await repo.diffTreeRaw(c.sha);
        const visible = raw.filter(visibleDiff);
        out.push({
          ...base, attribution: 'unverified', declared_author: c.authorName, op: null,
          paths: visible.map((d) => d.path), ...(visible.length < raw.length ? { hidden_files: raw.length - visible.length } : {}),
          ...(present ? { note: '提交里带有 Commons-* 声明，但不在服务账本中，声明不可信', declared_member: trailers['Commons-Member'] ?? null } : {}),
        });
      }
    }
    return out;
  }

  // 首页：不带 cursor 时从该 token 的已读位置开始（from='start' 则从头）
  async function changes(actor, { cursor = null, path_prefix = null, member = null, limit = 20, from = 'ack' } = {}) {
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 20));
    let U; let pos; let filters;
    if (cursor) {
      const c = verify(cursor, actor);
      if (c.k !== 'changes') fail('INVALID_CURSOR', '这不是 changes 的 cursor');
      U = c.u; pos = c.p; filters = c.f;
      if ((path_prefix ?? null) !== (filters?.prefix ?? null) || (member ?? null) !== (filters?.member ?? null)) {
        fail('INVALID_ARGUMENT', '翻页时过滤条件必须与第一页相同（cursor 里已固定）');
      }
    } else {
      U = published();
      filters = (path_prefix || member) ? { prefix: path_prefix ?? null, member: member ?? null } : null;
      if (from === 'start') pos = null;
      else {
        pos = members.getAck(actor.token_id);
        if (pos && !(await repo.isAncestor(pos, U))) pos = null;
      }
    }
    if (!U) return { changes: [], has_more: false, next_cursor: null, upper_commit_rev: null };
    const range = await repo.revList(['--reverse', '--first-parent', pos ? `${pos}..${U}` : U]);
    const picked = [];
    let last = pos;
    let i = 0;
    for (; i < range.length && picked.length < lim; i++) {
      const sha = range[i];
      last = sha;
      if (filters) {
        const led = db.get('SELECT member_id, paths FROM ledger WHERE commit_sha = ?', sha);
        if (filters.member && led?.member_id !== filters.member) continue;
        if (filters.prefix) {
          const paths = led ? JSON.parse(led.paths) : (await repo.diffTreeRaw(sha)).map((d) => d.path);
          if (!paths.some((p) => p.startsWith(filters.prefix))) continue;
        }
      }
      picked.push(sha);
    }
    const items = await describe(await repo.commitInfos(picked));
    const hasMore = i < range.length;
    const next = sign({ k: 'changes', t: actor.token_id, u: U, p: last ?? null, f: filters });
    return {
      upper_commit_rev: U, changes: items, has_more: hasMore, next_cursor: next,
      ...(filters ? { note: '带过滤条件的结果不能用于 changes_ack' } : { ack_hint: '已经向主人汇报后，用 changes_ack{cursor: next_cursor} 记下已读位置' }),
    };
  }

  async function ack(actor, cursor) {
    const c = verify(cursor, actor);
    if (c.k !== 'changes') fail('INVALID_CURSOR', '这不是 changes 的 cursor');
    if (c.f) fail('INVALID_CURSOR', '带过滤条件的查询得到的 cursor 不能用来推进已读位置');
    if (!c.p) return { acked: null, unchanged: true };
    if (!(await repo.isAncestor(c.p, published()))) fail('INVALID_CURSOR', 'cursor 位置不在已发布主线上');
    for (let attempt = 0; attempt < 10; attempt++) {
      const cur = members.getAck(actor.token_id);
      if (cur === c.p) return { acked: cur, unchanged: true };
      if (cur && (await repo.isAncestor(c.p, cur))) return { acked: cur, unchanged: true, note: '已读位置不会倒退' };
      if (members.casAck(actor.token_id, cur, c.p)) return { acked: c.p, unchanged: false };
    }
    fail('CONFLICT', '已读位置正在被同一凭据的其他请求更新，请重试');
  }

  async function pageHistory(actor, { path, limit = 20, cursor = null }) {
    const p = checkPath(path, { kind: 'any' });
    const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 20));
    let U; let offset = 0;
    if (cursor) {
      const c = verify(cursor, actor);
      if (c.k !== 'page_history' || c.path !== p) fail('INVALID_CURSOR', 'cursor 与 path 不匹配');
      U = c.u; offset = c.o;
    } else U = published();
    if (!U) return { path: p, history: [], has_more: false };
    const shas = await repo.pathLog(U, p);
    const slice = shas.slice(offset, offset + lim);
    const items = await describe(await repo.commitInfos(slice));
    const hasMore = offset + lim < shas.length;
    return { path: p, upper_commit_rev: U, history: items, has_more: hasMore, ...(hasMore ? { next_cursor: sign({ k: 'page_history', t: actor.token_id, u: U, o: offset + lim, path: p }) } : {}) };
  }

  async function showChange(actor, { commit_rev, path = null, max_bytes = 60_000 }) {
    if (typeof commit_rev !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit_rev)) fail('INVALID_ARGUMENT', 'commit_rev 需要提交 SHA');
    const full = await repo.revParse(commit_rev);
    if (!full || !(await repo.isAncestor(full, published()))) fail('NOT_FOUND', '这个提交不在已发布的主线上');
    const p = path ? checkPath(path, { kind: 'any' }) : null;
    const [info] = await describe(await repo.commitInfos([full]));
    const raw = await repo.diffTreeRaw(full);
    const allowed = raw.filter(visibleDiff).map((d) => d.path).filter((x) => !p || x === p);
    const hidden = raw.length - raw.filter(visibleDiff).length;
    let diff = allowed.length ? await repo.showPatch(full, allowed) : '';
    const budget = Math.max(2000, Math.min(200_000, Number(max_bytes) || 60_000));
    let truncated = false;
    if (utf8Bytes(diff) > budget) {
      diff = Buffer.from(diff, 'utf8').subarray(0, budget).toString('utf8').replace(/�$/, '');
      truncated = true;
    }
    return { ...info, diff, truncated, ...(hidden ? { hidden_files: hidden, hidden_note: '这次提交还改了不在内容策略内的文件（隐藏文件、链接等），不显示其内容' } : {}), ...(truncated ? { truncated_hint: '差异过长已截断；可传 path 只看某一页，或调大 max_bytes（上限 200000）' } : {}) };
  }

  async function requestStatus(actor, { request_id }, sync) {
    const led = db.get('SELECT * FROM ledger WHERE request_id = ?', String(request_id ?? ''));
    if (!led) {
      const j = db.get('SELECT status, token_id FROM journal WHERE request_id = ?', String(request_id ?? ''));
      if (j && (j.token_id === actor.token_id || actor.perms.has('admin'))) return { request_id, status: j.status === 'failed' ? 'failed' : 'unknown' };
      fail('NOT_FOUND', '没有这个 request_id');
    }
    // 提交本身对全体成员可见，同步状态也不需要额外限制
    return { request_id, status: 'accepted', commit_rev: led.commit_sha, op: led.op, paths: JSON.parse(led.paths), sync: await sync.commitSyncStatus(led.commit_sha) };
  }

  return { changes, ack, pageHistory, showChange, requestStatus, describe };
}
