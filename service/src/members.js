// 成员与凭据：member = 人；token = 某个 agent 的凭据；有效权限 = 角色 ∩ scope，每次请求重新计算。
// 状态全部在 git 外的 SQLite 里；凭据和一次性码只存 sha256。沿用上游 enroll.js 的一次性码 → 专属 token 模型，
// 增加 member 绑定、scope、不可复用的 token_id。
import { CommonsError, fail, sha256, randomHex, newId } from './util.js';
import { sanitizeIpLiteral } from './net.js';
import { checkEmail } from './mailer.js';

export const ROLES = ['admin', 'member', 'reader'];
export const SCOPES = ['admin', 'member', 'read'];
const ROLE_PERMS = {
  admin: ['read', 'write', 'self_tokens', 'admin'],
  member: ['read', 'write', 'self_tokens'],
  reader: ['read', 'self_tokens'],
};
const SCOPE_PERMS = {
  admin: ['read', 'write', 'self_tokens', 'admin'],
  member: ['read', 'write', 'self_tokens'],
  read: ['read', 'self_tokens'],
};

export const MEMBER_ID_RE = /^m-[a-z0-9][a-z0-9-]{1,30}$/;
export const CLIENT_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DAY = 86_400_000;
export const DEFAULT_INVITE_TTL_MS = DAY;
export const MAX_INVITE_TTL_MS = 30 * DAY;

export function effectivePerms(role, scope) {
  const r = new Set(ROLE_PERMS[role] ?? []);
  return new Set((SCOPE_PERMS[scope] ?? []).filter((p) => r.has(p)));
}

// 显示名会进 git author，去掉 git 不接受的 < > 与换行，并限制长度
export function cleanDisplayName(s) {
  const v = String(s ?? '').replace(/[<>\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!v || v.length > 40) fail('INVALID_ARGUMENT', 'display_name 必须是 1–40 个字符');
  return v;
}

export function createMembers({ db, now = Date.now }) {
  const getMember = (id) => db.get('SELECT * FROM members WHERE member_id = ?', id);
  const labelTaken = (label) => db.get(`SELECT 1 AS x FROM tokens WHERE client_label = ? AND revoked_at IS NULL
      UNION SELECT 1 FROM invites WHERE client_label = ? AND status = 'pending' AND expires_at > ?`, label, label, now());

  const api = {
    getMember,

    publicMember(m) {
      if (!m) return null;
      const n = db.get('SELECT COUNT(*) AS n FROM tokens WHERE member_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', m.member_id, now()).n;
      return { member_id: m.member_id, display_name: m.display_name, role: m.role, status: m.status, active_agents: n };
    },

    listMembers() {
      return db.all('SELECT * FROM members ORDER BY created_at').map((m) => api.publicMember(m));
    },

    createMember({ member_id, display_name, role = 'member', by = null }) {
      if (!MEMBER_ID_RE.test(member_id ?? '')) fail('INVALID_ARGUMENT', 'member_id 格式：m- 开头，小写字母、数字、-，共 3–32 位（如 m-alice）');
      if (!ROLES.includes(role)) fail('INVALID_ARGUMENT', `role 只能是 ${ROLES.join(' / ')}`);
      const name = cleanDisplayName(display_name);
      if (getMember(member_id)) fail('ALREADY_EXISTS', `member_id 已存在且不可复用：${member_id}`);
      db.run('INSERT INTO members(member_id, display_name, role, status, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?)',
        member_id, name, role, 'active', now(), now(), by);
      db.event('member_created', { member_id, role, by });
      return api.publicMember(getMember(member_id));
    },

    setRole(member_id, role, by) {
      if (!ROLES.includes(role)) fail('INVALID_ARGUMENT', `role 只能是 ${ROLES.join(' / ')}`);
      const m = getMember(member_id) ?? fail('NOT_FOUND', `没有这个成员：${member_id}`);
      if (m.role === 'admin' && role !== 'admin') api.assertNotLastAdmin(member_id);
      db.run('UPDATE members SET role = ?, updated_at = ? WHERE member_id = ?', role, now(), member_id);
      db.event('member_role', { member_id, role, by });
      return api.publicMember(getMember(member_id));
    },

    setStatus(member_id, status, by) {
      if (!['active', 'disabled'].includes(status)) fail('INVALID_ARGUMENT', 'status 只能是 active / disabled');
      const m = getMember(member_id) ?? fail('NOT_FOUND', `没有这个成员：${member_id}`);
      if (status === 'disabled' && m.role === 'admin') api.assertNotLastAdmin(member_id);
      db.run('UPDATE members SET status = ?, updated_at = ? WHERE member_id = ?', status, now(), member_id);
      db.event('member_status', { member_id, status, by });
      return api.publicMember(getMember(member_id));
    },

    // 成员邮箱只用于通知邮件；null 表示清除
    setEmail(member_id, email, by) {
      getMember(member_id) ?? fail('NOT_FOUND', `没有这个成员：${member_id}`);
      const v = email == null || email === '' ? null : checkEmail(email);
      db.run('UPDATE members SET email = ?, updated_at = ? WHERE member_id = ?', v, now(), member_id);
      db.event('member_email', { member_id, set: v != null, by });
      return { member_id, email: v };
    },

    // 通知邮件的收件人：有效的 member / admin 成员（不含只读成员），且登记了邮箱
    mailRecipients() {
      return db.all("SELECT member_id, display_name, email FROM members WHERE status = 'active' AND role != 'reader' AND email IS NOT NULL ORDER BY created_at");
    },

    mailRoster() {
      return db.all('SELECT member_id, display_name, role, status, email FROM members ORDER BY created_at')
        .map((m) => ({ ...m, receives: m.status === 'active' && m.role !== 'reader' && m.email != null }));
    },

    assertNotLastAdmin(member_id) {
      const n = db.get("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND status = 'active' AND member_id != ?", member_id).n;
      if (n === 0) fail('FORBIDDEN', '这是最后一位有效 admin，不能降权或禁用（需要时用 BOOTSTRAP_FORCE 流程追加 admin）');
    },

    createInvite({ member_id, client_label, scope = 'member', ttl_ms = DEFAULT_INVITE_TTL_MS, token_ttl_ms = null, by }) {
      const m = getMember(member_id) ?? fail('NOT_FOUND', `没有这个成员：${member_id}`);
      if (m.status !== 'active') fail('FORBIDDEN', `成员已禁用：${member_id}`);
      if (!SCOPES.includes(scope)) fail('INVALID_ARGUMENT', `scope 只能是 ${SCOPES.join(' / ')}`);
      if (scope === 'admin' && m.role !== 'admin') fail('INVALID_ARGUMENT', '只有 admin 成员才能持有 admin scope 的凭据');
      if (!CLIENT_LABEL_RE.test(client_label ?? '')) fail('INVALID_ARGUMENT', 'client_label 只能用 A-Za-z0-9._-，1–64 位（如 alice-claude-code）');
      if (labelTaken(client_label)) fail('ALREADY_EXISTS', `client_label 已被占用：${client_label}`);
      if (!Number.isSafeInteger(ttl_ms) || ttl_ms < 60_000 || ttl_ms > MAX_INVITE_TTL_MS) fail('INVALID_ARGUMENT', '邀请有效期须在 1 分钟到 30 天之间');
      if (token_ttl_ms != null && (!Number.isSafeInteger(token_ttl_ms) || token_ttl_ms < 3_600_000)) fail('INVALID_ARGUMENT', 'token 有效期至少 1 小时');
      const code = `sbe_${randomHex(16)}`;
      const invite_id = newId('i');
      db.run(`INSERT INTO invites(invite_id, code_hash, kind, member_id, client_label, scope, token_ttl_ms, created_by, created_at, expires_at, status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')`, invite_id, sha256(code), 'invite', member_id, client_label, scope, token_ttl_ms, by, now(), now() + ttl_ms);
      db.event('invite_created', { invite_id, member_id, client_label, scope, by });
      return { code, invite_id, member_id, client_label, scope, expires_at: now() + ttl_ms };
    },

    // 引导码：首次初始化或 BOOTSTRAP_FORCE 时登记为 admin 邀请。同一个码只登记一次——
    // 用过（或登记过）之后，重启不会再次创建 admin。
    registerBootstrap({ code, member_id = 'm-owner', display_name = 'Owner', ttl_ms = 7 * DAY, reason = 'first_init' }) {
      if (!/^sbe_[0-9a-f]{32}$/.test(code ?? '')) fail('INVALID_ARGUMENT', 'BOOTSTRAP_ADMIN_CODE 格式应为 sbe_ + 32 位十六进制');
      if (!MEMBER_ID_RE.test(member_id)) fail('INVALID_ARGUMENT', 'BOOTSTRAP_ADMIN_MEMBER 格式不对');
      const h = sha256(code);
      return db.tx(() => {
        if (db.get('SELECT 1 AS x FROM bootstrap_codes WHERE code_hash = ?', h)) return { registered: false };
        db.run('INSERT INTO bootstrap_codes(code_hash, registered_at) VALUES (?, ?)', h, now());
        db.run(`INSERT INTO invites(invite_id, code_hash, kind, member_id, display_name, role, client_label, scope, created_by, created_at, expires_at, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`, newId('i'), h, 'bootstrap', member_id, cleanDisplayName(display_name), 'admin',
        `${member_id.slice(2)}-admin-${randomHex(2)}`, 'admin', `bootstrap:${reason}`, now(), now() + ttl_ms);
        db.event('bootstrap_registered', { member_id, reason });
        return { registered: true };
      });
    },

    // 兑换一次性码。返回明文 token（只此一次）；先持久化再返回。
    redeem({ code, ip = null, baselineCommit = null }) {
      const h = sha256(String(code ?? ''));
      return db.tx(() => {
        const inv = db.get('SELECT * FROM invites WHERE code_hash = ?', h);
        if (!inv || inv.status === 'cancelled') throw new CommonsError('INVALID_CODE', '一次性码无效');
        if (inv.status === 'redeemed') throw new CommonsError('CODE_USED', '一次性码已被使用（如果不是你本人用的，请立即告诉管理员吊销）');
        if (inv.status === 'expired' || now() > inv.expires_at) {
          db.run("UPDATE invites SET status = 'expired' WHERE invite_id = ?", inv.invite_id);
          throw new CommonsError('CODE_EXPIRED', '一次性码已过期，请让管理员重新发一个');
        }
        if (inv.status !== 'pending') throw new CommonsError('INVALID_CODE', '一次性码无效');
        let m = getMember(inv.member_id);
        if (inv.kind === 'bootstrap') {
          if (!m) {
            db.run('INSERT INTO members(member_id, display_name, role, status, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?)',
              inv.member_id, inv.display_name ?? 'Owner', 'admin', 'active', now(), now(), inv.created_by);
          } else {
            db.run("UPDATE members SET role = 'admin', status = 'active', updated_at = ? WHERE member_id = ?", now(), inv.member_id);
          }
          db.run('UPDATE bootstrap_codes SET consumed_at = ? WHERE code_hash = ?', now(), h);
          m = getMember(inv.member_id);
        }
        if (!m || m.status !== 'active') throw new CommonsError('MEMBER_DISABLED', '这个一次性码对应的成员已被禁用');
        const token = `sbk_${randomHex(24)}`;
        const token_id = newId('t');
        const cleanIp = sanitizeIpLiteral(ip);
        db.run(`INSERT INTO tokens(token_id, member_id, client_label, scope, hash, created_at, expires_at, invite_id, redeemed_ip, last_used_at, ack_commit)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, token_id, m.member_id, inv.client_label, inv.scope, sha256(token), now(),
        inv.token_ttl_ms ? now() + inv.token_ttl_ms : null, inv.invite_id, cleanIp, null, baselineCommit);
        db.run("UPDATE invites SET status = 'redeemed', redeemed_at = ?, redeemed_ip = ?, token_id = ? WHERE invite_id = ?", now(), cleanIp, token_id, inv.invite_id);
        db.event('invite_redeemed', { invite_id: inv.invite_id, member_id: m.member_id, token_id, client_label: inv.client_label, ip: cleanIp, kind: inv.kind });
        return { token, token_id, member_id: m.member_id, display_name: m.display_name, client_label: inv.client_label, scope: inv.scope, role: m.role, kind: inv.kind };
      });
    },

    identify(token) {
      if (typeof token !== 'string' || !/^sbk_[0-9a-f]{48}$/.test(token)) return null;
      const row = db.get(`SELECT t.token_id, t.member_id, t.client_label, t.scope, t.expires_at, t.revoked_at, t.last_used_at,
          m.display_name, m.role, m.status FROM tokens t JOIN members m ON m.member_id = t.member_id WHERE t.hash = ?`, sha256(token));
      if (!row || row.revoked_at != null || row.status !== 'active') return null;
      if (row.expires_at != null && now() > row.expires_at) return null;
      const perms = effectivePerms(row.role, row.scope);
      if (!perms.size) return null;
      if (!row.last_used_at || now() - row.last_used_at > 600_000) {
        try { db.run('UPDATE tokens SET last_used_at = ? WHERE token_id = ?', now(), row.token_id); } catch { /* 不拦认证 */ }
      }
      return { token_id: row.token_id, member_id: row.member_id, display_name: row.display_name, role: row.role, scope: row.scope, client_label: row.client_label, perms };
    },

    listTokens(member_id = null) {
      const rows = member_id
        ? db.all('SELECT * FROM tokens WHERE member_id = ? ORDER BY created_at', member_id)
        : db.all('SELECT * FROM tokens ORDER BY created_at');
      return rows.map((t) => ({
        token_id: t.token_id, member_id: t.member_id, client_label: t.client_label, scope: t.scope,
        created_at: t.created_at, expires_at: t.expires_at, last_used_at: t.last_used_at,
        status: t.revoked_at != null ? 'revoked' : (t.expires_at != null && now() > t.expires_at ? 'expired' : 'active'),
      }));
    },

    listInvites() {
      return db.all('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100').map((i) => ({
        invite_id: i.invite_id, kind: i.kind, member_id: i.member_id, client_label: i.client_label, scope: i.scope,
        created_at: i.created_at, expires_at: i.expires_at,
        status: i.status === 'pending' && now() > i.expires_at ? 'expired' : i.status, token_id: i.token_id,
      }));
    },

    // 吊销：成员只能吊销自己名下的 token；admin 可吊销任何人的。授权看不可变的 member_id。
    revokeToken({ token_id, actor, reason = null }) {
      const t = db.get('SELECT * FROM tokens WHERE token_id = ?', token_id) ?? fail('NOT_FOUND', `没有这个 token：${token_id}`);
      if (t.member_id !== actor.member_id && !actor.perms.has('admin')) fail('FORBIDDEN', '只能吊销自己名下的 token');
      if (t.revoked_at != null) return { token_id, already_revoked: true };
      db.run('UPDATE tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE token_id = ?', now(), actor.member_id, reason, token_id);
      db.event('token_revoked', { token_id, member_id: t.member_id, by: actor.member_id });
      return { token_id, revoked: true };
    },

    cancelInvite({ invite_id, actor }) {
      const i = db.get('SELECT * FROM invites WHERE invite_id = ?', invite_id) ?? fail('NOT_FOUND', `没有这个邀请：${invite_id}`);
      if (i.status !== 'pending') return { invite_id, status: i.status };
      db.run("UPDATE invites SET status = 'cancelled' WHERE invite_id = ?", invite_id);
      db.event('invite_cancelled', { invite_id, by: actor.member_id });
      return { invite_id, status: 'cancelled' };
    },

    // 从旧快照恢复后：作废全部 token 与未兑换的一次性码，结果先持久化。
    // floor：外部见证（水位文件、远端水位）里见过的最大授权代数；作废后的代数必须高于它，否则下次启动会再判一次“落后”。
    resetAuth(reason, { floor = 0 } = {}) {
      return db.tx(() => {
        if (floor > api.authEpoch()) db.meta.set('auth_epoch', String(floor));
        const t = db.run("UPDATE tokens SET revoked_at = ?, revoked_by = 'system', revoke_reason = ? WHERE revoked_at IS NULL", now(), reason);
        const i = db.run("UPDATE invites SET status = 'cancelled' WHERE status = 'pending'");
        db.meta.set('auth_reset_at', now());
        db.meta.set('auth_reset_reason', reason);
        db.event('auth_reset', { reason, tokens: Number(t.changes), invites: Number(i.changes) });
        return { revoked_tokens: Number(t.changes), cancelled_invites: Number(i.changes) };
      });
    },

    // 记录凭据的最近来源 IP；换了来源返回旧值（调用方据此通知 admin）
    noteIp(token_id, ip) {
      if (!ip) return null;
      const row = db.get('SELECT last_ip, redeemed_ip FROM tokens WHERE token_id = ?', token_id);
      const prev = row?.last_ip ?? row?.redeemed_ip ?? null;
      if (prev === ip) return null;
      db.run('UPDATE tokens SET last_ip = ? WHERE token_id = ?', ip, token_id);
      return prev ? { previous: prev } : null;
    },

    // 已读位置用 CAS 写入：只有库里的值仍是调用方读到的旧值时才更新（防止并发 ack 倒退）
    casAck(token_id, expected, commit) {
      return Number(db.run('UPDATE tokens SET ack_commit = ? WHERE token_id = ? AND ack_commit IS ?', commit, token_id, expected).changes) === 1;
    },
    setAck(token_id, commit) { db.run('UPDATE tokens SET ack_commit = ? WHERE token_id = ?', commit, token_id); },
    authEpoch: () => Number(db.meta.get('auth_epoch') ?? 0),
    onAuthChange: null,
    getAck(token_id) { return db.get('SELECT ack_commit FROM tokens WHERE token_id = ?', token_id)?.ack_commit ?? null; },
    hasAnyMember() { return !!db.get('SELECT 1 AS x FROM members LIMIT 1'); },
  };

  // 授权代数：每次改动成员、凭据、一次性码都在同一个 SQLite 事务里 +1，并写到库外的见证（水位文件、远端水位 ref）。
  // 状态库若被旧快照替换，它的代数会低于见证，启动时据此进入维护模式并作废全部凭据（Codex 实现评审 #1）。
  for (const name of ['createMember', 'setRole', 'setStatus', 'createInvite', 'registerBootstrap', 'redeem', 'revokeToken', 'cancelInvite', 'resetAuth']) {
    const orig = api[name];
    api[name] = (...args) => {
      let changed = true;
      const out = db.tx(() => {
        const r = orig(...args);
        changed = !(r && (r.registered === false || r.already_revoked === true)); // 没有实际改动就不推进代数（R3-1）
        if (changed) db.meta.set('auth_epoch', String(api.authEpoch() + 1));
        return r;
      });
      if (!changed) return out;
      try { api.onAuthChange?.(api.authEpoch()); } catch (e) { console.error(`[auth] 水位见证写入失败：${e.message}`); }
      return out;
    };
  }
  return api;
}
