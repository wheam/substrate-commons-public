// Git 访问层：实例仓库是一个 bare 仓库，所有读写都走 git 对象与 plumbing 命令，
// 不存在工作树，也就不会跟随文件系统里的符号链接。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomHex } from './util.js';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const SHA_RE = /^[0-9a-f]{40}$/;
export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);

// git 错误信息可能带 URL userinfo；出日志或状态前统一剥掉（沿用上游 repo.js 的做法）。
export function sanitizeGitError(message) {
  return String(message ?? '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
}

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args[0]} 失败（${code}）：${sanitizeGitError(stderr).trim().slice(0, 2000)}`);
    this.exitCode = code;
    this.stderr = sanitizeGitError(stderr);
  }
}

export class GitRepo {
  constructor(dir, { sshCommand = null, remoteUrl = null } = {}) {
    this.dir = dir;
    this.sshCommand = sshCommand;
    this.remoteUrl = remoteUrl;
  }

  baseEnv(extra = {}) {
    const env = {
      ...process.env,
      // 不读宿主的全局/系统 git 配置（签名、hooks、别名都可能改变 plumbing 行为）
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_DIR: this.dir,
      ...extra,
    };
    if (this.sshCommand) env.GIT_SSH_COMMAND = this.sshCommand;
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
  }

  run(args, { input, env, buffer = false, okCodes = [0], timeout = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, {
        env: this.baseEnv(env), encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, timeout,
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        if (okCodes.includes(code)) {
          return resolve(buffer || okCodes.length > 1 ? { stdout, code, stderr: sanitizeGitError(String(stderr ?? '')) } : stdout);
        }
        reject(new GitError(args, err?.killed ? 'timeout' : code, String(stderr || err?.message || '')));
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  async exists() { return existsSync(path.join(this.dir, 'HEAD')); }

  async init() {
    mkdirSync(this.dir, { recursive: true });
    await this.run(['init', '--bare', '-q', '-b', 'main', this.dir], { env: { GIT_DIR: undefined } });
    await this.run(['config', 'core.logAllRefUpdates', 'always']);
    await this.run(['config', 'gc.auto', '0']);
    if (this.remoteUrl) await this.setRemote(this.remoteUrl);
  }

  async setRemote(url) {
    const { code } = await this.run(['remote', 'get-url', 'origin'], { okCodes: [0, 2, 128] });
    if (code === 0) await this.run(['remote', 'set-url', 'origin', url]);
    else await this.run(['remote', 'add', 'origin', url]);
    await this.run(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  }

  async revParse(ref) {
    const { stdout, code } = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okCodes: [0, 1, 128] });
    return code === 0 ? stdout.trim() : null;
  }

  async objectType(sha) {
    const { stdout, code } = await this.run(['cat-file', '-t', sha], { okCodes: [0, 1, 128] });
    return code === 0 ? stdout.trim() : null;
  }

  async isAncestor(a, b) {
    if (a === b) return true;
    const { code } = await this.run(['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1, 128] });
    return code === 0;
  }

  // 列出某提交的完整树：Map(path → {mode, type, sha, size})
  async lsTree(commit) {
    const out = await this.run(['ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
    const entries = new Map();
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
      entries.set(rec.slice(tab + 1), { mode, type, sha, size: size === '-' ? 0 : Number(size) });
    }
    return entries;
  }

  async catBlob(sha) {
    const { stdout } = await this.run(['cat-file', 'blob', sha], { buffer: true });
    return stdout;
  }

  async hashObject(content) {
    return (await this.run(['hash-object', '-w', '--stdin'], { input: content })).trim();
  }

  // 以 parent 提交的树为底，套用 changes（{path, sha|null}；null = 删除），写出新树。
  // 用临时 index 文件，不碰任何工作树；文件一律 100644。
  async buildTree(parent, changes) {
    const indexFile = path.join(this.dir, `commons-index-${process.pid}-${randomHex(6)}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      if (parent) await this.run(['read-tree', parent], { env });
      else await this.run(['read-tree', '--empty'], { env });
      const lines = changes.map((c) => (c.sha ? `100644 ${c.sha}\t${c.path}\0` : `0 ${ZERO_SHA}\t${c.path}\0`)).join('');
      if (lines) await this.run(['update-index', '-z', '--index-info'], { env, input: lines });
      return (await this.run(['write-tree'], { env })).trim();
    } finally {
      rmSync(indexFile, { force: true });
    }
  }

  async commitTree({ tree, parents = [], message, author, committer, date }) {
    const args = ['commit-tree', tree];
    for (const p of parents) args.push('-p', p);
    const when = `${Math.floor((date ?? Date.now()) / 1000)} +0000`;
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: when,
    };
    return (await this.run(args, { env, input: message })).trim();
  }

  // 带旧值校验的原子引用更新；old=null 表示要求引用此前不存在。
  async updateRef(ref, newSha, oldSha, reason = 'substrate-commons') {
    await this.run(['update-ref', '-m', reason, ref, newSha, oldSha ?? ZERO_SHA]);
  }

  async revList(args) {
    const out = await this.run(['rev-list', ...args]);
    return out.split('\n').filter(Boolean);
  }

  // 批量读取提交元数据。
  async commitInfos(shas) {
    if (!shas.length) return [];
    const fmt = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%B%x1e';
    const out = await this.run(['log', '--no-walk=unsorted', `--format=${fmt}`, ...shas]);
    return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
      const [sha, parents, an, ae, at, cn, ce, body] = rec.split('\0');
      return {
        sha, parents: parents ? parents.split(' ') : [], authorName: an, authorEmail: ae,
        time: Number(at) * 1000, committerName: cn, committerEmail: ce, message: body ?? '',
      };
    });
  }

  // 一个提交相对第一父提交的原始变更：[{status, srcMode, dstMode, srcSha, dstSha, path}]
  async diffTreeRaw(commit) {
    const out = await this.run(['diff-tree', '-r', '-z', '--no-commit-id', '--root', '--no-renames', commit]);
    const parts = out.split('\0');
    const res = [];
    for (let i = 0; i < parts.length - 1;) {
      const meta = parts[i];
      if (!meta.startsWith(':')) { i++; continue; }
      const [srcMode, dstMode, srcSha, dstSha, status] = meta.slice(1).split(' ');
      res.push({ status, srcMode, dstMode, srcSha, dstSha, path: parts[i + 1] });
      i += 2;
    }
    return res;
  }

  // 两个提交之间的原始变更（a 为 null 时相对空树）
  async diffTreeBetween(a, b) {
    const args = a ? ['diff-tree', '-r', '-z', '--no-renames', a, b] : ['diff-tree', '-r', '-z', '--no-commit-id', '--root', '--no-renames', b];
    const out = await this.run(args);
    const parts = out.split('\0');
    const res = [];
    for (let i = 0; i < parts.length - 1;) {
      const meta = parts[i];
      if (!meta.startsWith(':')) { i++; continue; }
      const [srcMode, dstMode, srcSha, dstSha, status] = meta.slice(1).split(' ');
      res.push({ status, srcMode, dstMode, srcSha, dstSha, path: parts[i + 1] });
      i += 2;
    }
    return res;
  }

  async mergeBase(a, b) {
    const { stdout, code } = await this.run(['merge-base', a, b], { okCodes: [0, 1] });
    return code === 0 ? stdout.trim() : null;
  }

  async numstat(commit) {
    const out = await this.run(['diff-tree', '-r', '-z', '--no-commit-id', '--root', '--numstat', '--no-renames', commit]);
    let added = 0; let deleted = 0;
    for (const rec of out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(rec);
      if (m) { added += m[1] === '-' ? 0 : Number(m[1]); deleted += m[2] === '-' ? 0 : Number(m[2]); }
    }
    return { added, deleted };
  }

  // paths：只显示这些路径（字面匹配，不做 pathspec 通配）；不做改名检测，避免把隐藏文件当作改名来源带出来
  async showPatch(commit, paths) {
    const list = [].concat(paths ?? []);
    if (!list.length) return '';
    const args = ['show', '--no-color', '--format=', '--no-renames', '--patch', '--no-ext-diff', '--no-textconv', commit, '--', ...list];
    return this.run(args, { env: { GIT_LITERAL_PATHSPECS: '1' } });
  }

  // 某路径在 upper 之前的提交（跟随改名），新的在前。
  async pathLog(upper, filePath) {
    const out = await this.run(['log', '--follow', '--format=%H', upper, '--', filePath]);
    return out.split('\n').filter(Boolean);
  }

  async lastCommitFor(upper, filePath) {
    const out = await this.run(['log', '-1', '--format=%H', upper, '--', filePath]);
    return out.trim() || null;
  }

  // ---- 远端 ----
  async fetch() {
    await this.run(['fetch', '--quiet', '--prune', 'origin'], { timeout: 120_000 });
  }

  async push(refspec, extra = []) {
    return this.run(['push', '--porcelain', ...extra, 'origin', refspec], { timeout: 120_000 });
  }

  async lsRemoteMain() {
    const out = await this.run(['ls-remote', 'origin', 'refs/heads/main'], { timeout: 60_000 });
    const sha = out.split('\t')[0]?.trim();
    return isSha(sha) ? sha : null;
  }

  async bundle(file) {
    await this.run(['bundle', 'create', file, '--all'], { timeout: 600_000 });
  }
}

// 解析 commit message 末段的 Commons-* trailer。重复、未知或格式异常 → 声明不可信。
const KNOWN_TRAILERS = new Set(['Commons-Member', 'Commons-Token', 'Commons-Op', 'Commons-Request', 'Commons-Reverts', 'Commons-Import-Of']);
export function parseTrailers(message) {
  const paras = String(message ?? '').trimEnd().split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? '';
  const lines = last.split('\n').filter((l) => l.trim());
  if (!lines.length || !lines.every((l) => /^Commons-[A-Za-z-]+: /.test(l))) return { trailers: {}, valid: false, present: false };
  const trailers = {};
  let valid = true;
  for (const l of lines) {
    const idx = l.indexOf(': ');
    const k = l.slice(0, idx); const v = l.slice(idx + 2).trim();
    if (!KNOWN_TRAILERS.has(k) || Object.hasOwn(trailers, k) || !v) valid = false;
    trailers[k] = v;
  }
  return { trailers, valid, present: true };
}

// 去掉 trailer 段，得到给人看的说明（subject + 正文）。
export function stripTrailers(message) {
  const paras = String(message ?? '').trimEnd().split(/\n\s*\n/);
  if (paras.length > 1 && parseTrailers(message).present) paras.pop();
  return paras.join('\n\n');
}
