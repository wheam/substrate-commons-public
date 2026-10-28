// git 外的服务状态：成员、凭据、一次性码、事务日志、提交账本、幂等记录、
// 已读位置、事件、通知邮件记录。全部放在 volume 上的一个 SQLite 文件里，靠 SQLite 事务保证原子性。
// 凭据与一次性码只存 sha256。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  member_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, client_label TEXT NOT NULL, scope TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
  revoked_by TEXT, revoke_reason TEXT, invite_id TEXT, redeemed_ip TEXT, last_used_at INTEGER, ack_commit TEXT, last_ip TEXT);
CREATE TABLE IF NOT EXISTS invites (
  invite_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, member_id TEXT NOT NULL,
  display_name TEXT, role TEXT, client_label TEXT NOT NULL, scope TEXT NOT NULL, token_ttl_ms INTEGER,
  created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
  redeemed_at INTEGER, redeemed_ip TEXT, token_id TEXT);
CREATE TABLE IF NOT EXISTS bootstrap_codes (code_hash TEXT PRIMARY KEY, registered_at INTEGER NOT NULL, consumed_at INTEGER);
CREATE TABLE IF NOT EXISTS journal (
  request_id TEXT PRIMARY KEY, token_id TEXT, member_id TEXT, idem_key TEXT, params_digest TEXT,
  op TEXT NOT NULL, paths TEXT NOT NULL, parent TEXT, commit_sha TEXT, expected TEXT, result TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS ledger (
  commit_sha TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, parent TEXT, member_id TEXT, token_id TEXT,
  client_label TEXT, request_id TEXT UNIQUE, op TEXT NOT NULL, paths TEXT NOT NULL, attribution TEXT NOT NULL,
  extra TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (
  token_id TEXT NOT NULL, idem_key TEXT NOT NULL, params_digest TEXT NOT NULL, request_id TEXT NOT NULL,
  result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (token_id, idem_key));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, token_id TEXT NOT NULL, idem_key TEXT NOT NULL, params_digest TEXT NOT NULL,
  subject TEXT NOT NULL, summary TEXT NOT NULL, from_commit TEXT, to_commit TEXT NOT NULL, recipient_count INTEGER NOT NULL,
  change_count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, message_id TEXT, result TEXT, created_at INTEGER NOT NULL, sent_at INTEGER,
  UNIQUE (token_id, idem_key));
CREATE INDEX IF NOT EXISTS tokens_member ON tokens(member_id);
CREATE INDEX IF NOT EXISTS journal_status ON journal(status);
`;

export function openDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 增量字段：成员邮箱（只用于通知邮件，不进 git、不经 MCP 外露）
  if (!db.prepare('PRAGMA table_info(members)').all().some((c) => c.name === 'email')) db.exec('ALTER TABLE members ADD COLUMN email TEXT');
  const store = wrap(db);
  if (fresh || store.meta.get('schema_version') == null) store.meta.set('schema_version', String(SCHEMA_VERSION));
  store.fresh = fresh;
  return store;
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const plain = (row) => (row ? { ...row } : row);
  let depth = 0;
  const store = {
    raw: db,
    get: (sql, ...p) => plain(stmt(sql).get(...p)),
    all: (sql, ...p) => stmt(sql).all(...p).map(plain),
    run: (sql, ...p) => stmt(sql).run(...p),
    // 同步事务：fn 内的所有语句要么全部生效，要么全部回滚（支持嵌套调用，内层并入外层）。
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE'); // 失败直接抛出，depth 不变（只有真正开启了事务才进入嵌套状态）
      depth++;
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
        throw e;
      } finally { depth--; }
    },
    inTx: () => depth > 0,
    close: () => db.close(),
    meta: {
      get: (k) => stmt('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null,
      set: (k, v) => {
        if (v == null) stmt('DELETE FROM meta WHERE key = ?').run(k);
        else stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
      },
      json: (k) => { const v = stmt('SELECT value FROM meta WHERE key = ?').get(k)?.value; return v == null ? null : JSON.parse(v); },
      setJson: (k, v) => store.meta.set(k, v == null ? null : JSON.stringify(v)),
    },
    event(kind, detail) {
      stmt('INSERT INTO events(ts, kind, detail) VALUES (?, ?, ?)').run(Date.now(), kind, JSON.stringify(detail ?? {}));
      stmt('DELETE FROM events WHERE id <= (SELECT MAX(id) - 1000 FROM events)').run();
    },
  };
  return store;
}

// 用 SQLite 自带的在线备份生成一致快照（不含明文凭据：库里本来只有 hash）。
export function backupDb(store, file) {
  store.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
