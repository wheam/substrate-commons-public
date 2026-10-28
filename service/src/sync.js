// 与 GitHub 私库的同步：服务是 main 的唯一写者；不自动 rebase，也不自动 merge。
// push 失败分三类：
//   transient（网络/临时故障）→ 继续本地接受写入，但未推送提交到上限（个数或时长）后冻结；上限在接受写入之前检查；
//   rejected（权限被拒/服务端规则拒绝）→ 立即冻结，不自动重试（admin 修好后用 sync_retry）；
//   diverged（远端 main 不是本地头的祖先 = 有人绕过服务直推）→ 立即冻结写入和自动补推，走线下分叉恢复。
//     收到 non-fast-forward 但 fetch 失败、无法确认时 → fork_suspected 冻结，之后的检查确认没有分叉才解冻。
//
// 网络操作不占用单写者队列：一个合并请求、单飞的后台 worker 负责 push / fetch，推送的是开始时的固定提交。
// 结果写回前校验“维护代数”：维护 CLI（另一个进程）开始后，旧的网络结果一律作废，不会覆盖 CLI 的处置。

export function classifyPushError(text) {
  const s = String(text ?? '');
  if (/Could not resolve host|Connection timed out|Connection refused|Network is unreachable|Operation timed out|Connection reset|Connection closed|early EOF|unexpected disconnect|timed out|Temporary failure|Broken pipe|\btimeout\b|HTTP (?:5\d\d)|The remote end hung up/i.test(s)) return 'transient';
  if (/Permission denied|denied to|\b403\b|Authentication failed|Repository not found|protected branch|pre-receive hook declined|GH006|GH013|remote rejected|\bdeclined\b/i.test(s)) return 'rejected';
  if (/non-fast-forward|fetch first|\[rejected\]|stale info|Updates were rejected/i.test(s)) return 'diverged';
  return 'transient';
}

const FORK_MSG = '远端 main 出现了不经服务的提交，已冻结写入；需要 admin 在维护窗口执行分叉恢复';

export function createSync({ db, repo, hasRemote, now = Date.now, maxPending = 20, maxAgeMs = 3_600_000, notify = () => {}, pushImpl = null, log = console }) {
  const meta = db.meta;

  const mode = () => ({ mode: meta.get('mode') ?? 'normal', reason: meta.get('mode_reason'), detail: meta.json('mode_detail'), since: meta.get('mode_since') ? Number(meta.get('mode_since')) : null });
  const maintGen = () => Number(meta.get('maint_gen') ?? 0);
  const maintLock = () => meta.json('maint_lock');

  function setMode(next, reason, detail = {}) {
    const prev = meta.get('mode') ?? 'normal';
    db.tx(() => {
      meta.set('mode', next);
      meta.set('mode_reason', next === 'normal' ? null : reason);
      meta.setJson('mode_detail', next === 'normal' ? null : detail);
      meta.set('mode_since', next === 'normal' ? null : String(now()));
      db.event('mode', { from: prev, to: next, reason, detail });
    });
    if (prev !== next || next !== 'normal') notify(`[${next}] ${reason}${detail?.message ? `：${detail.message}` : ''}`);
  }

  // 冻结有强弱：较弱的冻结原因不能覆盖较强的（R2-4）；维护模式最强，只能由维护命令解除
  const RANK = { pending_limit: 1, push_rejected: 2, fork_suspected: 3, fork: 4 };
  function freeze(reason, detail) {
    const cur = mode();
    if (cur.mode === 'maintenance') return false;
    if (cur.mode === 'frozen' && (RANK[cur.reason] ?? 9) >= RANK[reason]) return false;
    setMode('frozen', reason, detail);
    return true;
  }
  function unfreeze(fromReasons, why) {
    const cur = mode();
    if (cur.mode === 'frozen' && fromReasons.includes(cur.reason)) { setMode('normal', why); return true; }
    return false;
  }

  // 只有在维护代数没变、也没有维护锁时，才应用一次网络操作的结果
  function applyIfCurrent(gen, fn) {
    return db.tx(() => {
      if (maintGen() !== gen || maintLock()) return false;
      fn();
      return true;
    });
  }

  async function pendingInfo(main) {
    const remoteMain = meta.get('remote_main');
    if (!main) return { count: 0, oldest: null };
    const shas = await repo.revList(remoteMain ? ['--reverse', `${remoteMain}..${main}`] : ['--reverse', main]);
    if (!shas.length) return { count: 0, oldest: null };
    const row = db.get('SELECT created_at FROM ledger WHERE commit_sha = ?', shas[0]);
    const oldest = row?.created_at ?? (await repo.commitInfos([shas[0]]))[0]?.time ?? now();
    return { count: shas.length, oldest };
  }

  // 接受新写入之前调用（在单写者队列里）：未推送提交已到上限就先冻结，不让它越界。返回 false = 不能接受
  async function admit() {
    if (!hasRemote) return true;
    const gen = maintGen();
    const main = await repo.revParse('refs/heads/main');
    const p = await pendingInfo(main);
    if (p.count >= maxPending || (p.oldest && now() - p.oldest > maxAgeMs)) {
      applyIfCurrent(gen, () => freeze('pending_limit', { pending: p.count, message: `未推送到 GitHub 的提交已有 ${p.count} 个（最早一个等了 ${Math.round((now() - (p.oldest ?? now())) / 60000)} 分钟），暂停写入；推送恢复后自动解冻` }));
      return false;
    }
    return true;
  }

  async function doPush(main) {
    if (pushImpl) return pushImpl(main);
    const { stdout, stderr, code } = await repo.run(['push', '--porcelain', 'origin', `${main}:refs/heads/main`], { okCodes: [0, 1, 128], timeout: 60_000 })
      .catch((e) => ({ stdout: '', code: -1, stderr: e.stderr ?? e.message }));
    return { ok: code === 0, output: `${stdout ?? ''}\n${stderr ?? ''}` };
  }

  async function pushOnce({ manual = false } = {}) {
    if (!hasRemote) return { status: 'local_only' };
    const gen = maintGen();
    const m = mode();
    if (maintLock() || m.mode === 'maintenance' || (m.mode === 'frozen' && (m.reason === 'fork' || m.reason === 'fork_suspected'))) return { status: 'skipped', mode: m };
    if (m.mode === 'frozen' && m.reason === 'push_rejected' && !manual) return { status: 'skipped', mode: m };
    const main = await repo.revParse('refs/heads/main');
    if (!main) return { status: 'synced' };
    const before = meta.get('remote_main');
    if (before === main) {
      if (m.mode === 'frozen' && m.reason === 'pending_limit') applyIfCurrent(gen, () => unfreeze(['pending_limit'], 'synced'));
      return { status: 'synced' };
    }
    let res;
    try { res = await doPush(main); } catch (e) { res = { ok: false, output: e.stderr ?? e.message }; }
    if (res.ok) {
      // 远端现在就是 main；只在没有维护介入时写回，且已推送位置只前进
      const forward = !before || (await repo.isAncestor(before, main));
      const applied = applyIfCurrent(gen, () => {
        if (forward && meta.get('remote_main') === before) meta.set('remote_main', main);
        meta.set('sync_last_ok', String(now()));
        meta.set('sync_last_error', null);
        unfreeze(['pending_limit', 'push_rejected'], 'synced');
      });
      return { status: applied ? 'synced' : 'discarded' };
    }
    const cls = classifyPushError(res.output);
    if (!applyIfCurrent(gen, () => meta.setJson('sync_last_error', { at: now(), class: cls, message: String(res.output).slice(0, 500) }))) return { status: 'discarded' };
    if (cls === 'diverged') {
      // 明确的历史拒绝：先冻结，再去拉取诊断（R2-5）
      applyIfCurrent(gen, () => freeze('fork_suspected', { local: main, message: '推送被拒绝为非快进，正在核实远端是否有不经服务的提交；核实前暂停写入' }));
      let fetched = true;
      try { await repo.fetch(); } catch { fetched = false; }
      if (!fetched) return { status: 'frozen', reason: 'fork_suspected' };
      const om = await repo.revParse('refs/remotes/origin/main');
      if (!om || !(await repo.isAncestor(om, main))) {
        applyIfCurrent(gen, () => freeze('fork', { remote: om, local: main, message: FORK_MSG }));
        return { status: 'frozen', reason: 'fork' };
      }
      applyIfCurrent(gen, () => { meta.set('remote_main', om); unfreeze(['fork_suspected'], 'fork_cleared'); });
    } else if (cls === 'rejected') {
      applyIfCurrent(gen, () => freeze('push_rejected', { message: '推送被 GitHub 拒绝（权限或分支规则）；修复 deploy key 或规则后由 admin 执行 sync_retry' }));
      return { status: 'frozen', reason: 'push_rejected' };
    }
    const p = await pendingInfo(main);
    if (p.count >= maxPending || (p.oldest && now() - p.oldest > maxAgeMs)) {
      applyIfCurrent(gen, () => freeze('pending_limit', { pending: p.count, message: `未推送到 GitHub 的提交已有 ${p.count} 个，暂停写入；推送恢复后自动解冻` }));
      return { status: 'frozen', reason: 'pending_limit' };
    }
    return { status: 'pending_sync', pending: p.count };
  }

  // 拉取远端，检测外部直推
  async function checkOnce() {
    if (!hasRemote) return { status: 'local_only' };
    const gen = maintGen();
    if (maintLock() || mode().mode === 'maintenance') return { status: 'skipped' };
    try { await repo.fetch(); } catch (e) {
      applyIfCurrent(gen, () => meta.setJson('sync_last_error', { at: now(), class: 'transient', message: String(e.message).slice(0, 500) }));
      return { status: 'fetch_failed' };
    }
    const om = await repo.revParse('refs/remotes/origin/main');
    const main = await repo.revParse('refs/heads/main');
    const m = mode();
    if (!om) {
      if (meta.get('remote_main')) {
        applyIfCurrent(gen, () => freeze('fork', { remote: null, local: main, message: '远端 main 分支消失了，已冻结写入' }));
        return { status: 'frozen' };
      }
      return { status: 'remote_empty' };
    }
    if (om === main || (main && (await repo.isAncestor(om, main)))) {
      applyIfCurrent(gen, () => {
        meta.set('remote_main', om);
        unfreeze(['fork_suspected'], 'fork_cleared');
      });
      return { status: om === main ? 'synced' : 'behind' };
    }
    applyIfCurrent(gen, () => freeze('fork', { remote: om, local: main, message: FORK_MSG }));
    return { status: 'frozen', reason: 'fork' };
  }

  // ---- 单飞 worker：同一时刻最多一个在途网络操作；请求合并 ----
  let running = null;
  let wantPush = false; let wantCheck = false;
  let pushSeq = 0; let pushDone = 0; let lastPush = null;
  let checkSeq = 0; let checkDone = 0; let lastCheck = null;
  const waiters = [];
  const settle = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if ((w.kind === 'push' && pushDone >= w.seq) || (w.kind === 'check' && checkDone >= w.seq)) { waiters.splice(i, 1); w.resolve(w.kind === 'push' ? lastPush : lastCheck); }
    }
  };
  function run() {
    if (running) return running;
    running = (async () => {
      try {
        while (wantPush || wantCheck) {
          if (wantCheck) {
            wantCheck = false; const seq = checkSeq;
            try { lastCheck = await checkOnce(); } catch (e) { lastCheck = { status: 'error', error: e.message }; log.error?.(`[sync] ${e.message}`); }
            checkDone = seq; settle();
          }
          if (wantPush) {
            wantPush = false; const seq = pushSeq; const manual = manualPending; manualPending = false;
            try { lastPush = await pushOnce({ manual }); } catch (e) { lastPush = { status: 'error', error: e.message }; log.error?.(`[sync] ${e.message}`); }
            pushDone = seq; settle();
          }
        }
      } finally { running = null; }
    })();
    return running;
  }
  let manualPending = false;
  function pushNow({ manual = false } = {}) {
    const seq = ++pushSeq; wantPush = true; if (manual) manualPending = true;
    const p = new Promise((resolve) => waiters.push({ kind: 'push', seq, resolve }));
    run();
    return p;
  }
  function checkRemote() {
    const seq = ++checkSeq; wantCheck = true;
    const p = new Promise((resolve) => waiters.push({ kind: 'check', seq, resolve }));
    run();
    return p;
  }

  async function commitSyncStatus(commit) {
    if (!hasRemote) return 'local_only';
    const rm = meta.get('remote_main');
    if (rm && (rm === commit || (await repo.isAncestor(commit, rm)))) return 'synced';
    return 'pending_sync';
  }

  async function status() {
    const main = await repo.revParse('refs/heads/main');
    const p = hasRemote ? await pendingInfo(main) : { count: 0, oldest: null };
    return {
      remote_configured: hasRemote, remote_main: meta.get('remote_main'), local_main: main,
      pending_commits: p.count, oldest_pending_at: p.oldest, max_pending: maxPending,
      last_ok_at: meta.get('sync_last_ok') ? Number(meta.get('sync_last_ok')) : null,
      last_error: meta.json('sync_last_error'), maintenance_lock: maintLock(), ...mode(),
    };
  }

  return { pushNow, checkRemote, admit, commitSyncStatus, status, setMode, mode, maintLock, idle: () => running ?? Promise.resolve() };
}

// ---- 维护锁（跨进程）：维护 CLI 开始前取得，代数 +1；服务的后台网络结果和写入都会让路 ----
export function acquireMaintenanceLock(db, { holder = 'cli', staleMs = 3_600_000 } = {}) {
  return db.tx(() => {
    const cur = db.meta.json('maint_lock');
    if (cur && Date.now() - cur.at < staleMs) throw Object.assign(new Error(`维护锁已被占用（${cur.holder}，${new Date(cur.at).toISOString()}）`), { code: 'LOCKED' });
    db.meta.set('maint_gen', String(Number(db.meta.get('maint_gen') ?? 0) + 1));
    db.meta.setJson('maint_lock', { holder, pid: process.pid, at: Date.now() });
    return Number(db.meta.get('maint_gen'));
  });
}

export function releaseMaintenanceLock(db) {
  db.tx(() => {
    db.meta.set('maint_gen', String(Number(db.meta.get('maint_gen') ?? 0) + 1));
    db.meta.setJson('maint_lock', null);
  });
}
