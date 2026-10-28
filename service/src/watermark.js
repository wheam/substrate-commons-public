// 授权代数的库外见证（Codex 实现评审 #1 / R2-1）。
// 状态库只存 hash，但若整个 SQLite 文件被旧快照替换，已吊销的凭据和已兑换的一次性码会“复活”，
// 而 git 历史未必有变化。两个见证都不会随状态库一起回滚：
//   1. volume 上的水位文件 state/auth-watermark.json（防“只替换了状态库文件”）；
//   2. 实例私库里的 refs/commons/auth-watermark（防“整个 volume 回滚”）。它是一条只能快进的提交链：
//      每次授权变更追加一个提交，推送不带 force，所以远端的代数只增不减；回滚后的旧 volume 再推会被拒绝。
// 协议：
//   - 授权变更先在 SQLite 事务里 +1 代数，再写本地水位文件，再推远端见证；接口在返回前等推送完成（有上限）。
//   - 推送失败会持续重试（witness_pushed_epoch 落后于代数时）。
//   - 启动时必须读到远端见证并确认状态库不落后，才开放认证；读不到就保持关闭并重试（server.js 的认证闸门）。
// 残余风险（如实记录在运维手册）：授权变更恰好推不上 GitHub、且在重试成功前整个 volume 被回滚到变更之前。
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_REF = 'refs/commons/auth-watermark';
const TRACK = 'refs/commons/remote-auth-watermark';
const BOT = { name: 'substrate-commons', email: 'bot@watermark.invalid' };

// ref：远端见证所在的 ref。默认用自定义命名空间；托管方若拒绝自定义 ref，可改成分支名（环境变量 WATERMARK_REF）。
export function createWatermark({ db, repo, dir, hasRemote, log = console, onStale = () => {}, ref = DEFAULT_REF }) {
  const REF = ref;
  const file = path.join(dir, 'auth-watermark.json');
  const instanceId = () => db.meta.get('instance_id');
  const dbEpoch = () => Number(db.meta.get('auth_epoch') ?? 0);

  // 本地见证只升不降：同一实例的见证永远不会被写成更小的代数（R3-1：落后的状态库不能抹掉见证）
  function writeLocal(epoch) {
    const cur = readLocal();
    const next = cur && cur.instance_id === instanceId() ? Math.max(cur.epoch, epoch) : epoch;
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ instance_id: instanceId(), epoch: next }));
    renameSync(tmp, file);
  }

  function readLocal() {
    if (!existsSync(file)) return null;
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'));
      return Number.isSafeInteger(v.epoch) ? v : null;
    } catch { return null; }
  }

  async function makeCommit(epoch, parent) {
    const blob = await repo.hashObject(`${instanceId()} ${epoch}\n`);
    const tree = (await repo.run(['mktree'], { input: `100644 blob ${blob}\tepoch\n` })).trim();
    return repo.commitTree({ tree, parents: parent ? [parent] : [], message: `auth watermark ${epoch}\n`, author: BOT, committer: BOT, date: 1_000_000_000_000 + epoch * 1000 });
  }

  // 读远端见证：不存在 → null；读失败 → 抛错（调用方据此不开放认证）
  async function readRemote() {
    if (!hasRemote) return null;
    const ls = await repo.run(['ls-remote', 'origin', REF], { okCodes: [0], timeout: 60_000 });
    if (!ls.trim()) return null;
    await repo.run(['fetch', '--quiet', 'origin', `+${REF}:${TRACK}`], { timeout: 60_000 });
    const content = (await repo.run(['cat-file', 'blob', `${TRACK}:epoch`])).trim();
    const [id, n] = content.split(' ');
    if (!Number.isSafeInteger(Number(n))) throw new Error('远端水位内容格式不对');
    return { instance_id: id, epoch: Number(n), head: (await repo.revParse(TRACK)) };
  }

  const pushPlain = (commit) => repo.run(['push', '--porcelain', 'origin', `${commit}:${REF}`], { okCodes: [0, 1, 128], timeout: 60_000 });

  const epochOf = async (commit) => {
    if (!commit) return { id: null, epoch: 0 };
    const [id, n] = (await repo.run(['cat-file', 'blob', `${commit}:epoch`])).trim().split(' ');
    return { id, epoch: Number(n) || 0 };
  };

  // 每次都用“推送这一刻”的状态库代数，并且要求严格大于父提交里的代数——链上的代数只增不减（R3-2）
  const nonFastForward = (r) => /non-fast-forward|fetch first|\[rejected\]/i.test(`${r.stdout}\n${r.stderr}`);
  const setPushed = (n) => db.meta.set('witness_pushed_epoch', String(n));
  let pushing = null;
  async function pushLoop() {
    for (let round = 0; round < 5; round++) {
      const epoch = dbEpoch();
      if (epoch <= Number(db.meta.get('witness_pushed_epoch') ?? 0)) return;
      const parent = await repo.revParse(REF);
      const pe = await epochOf(parent);
      if (pe.id === instanceId() && pe.epoch > epoch) { onStale({ epoch: pe.epoch }); return; } // 本地链本身就证明状态库落后
      if (pe.id === instanceId() && pe.epoch === epoch) { setPushed(epoch); return; }
      let commit = await makeCommit(epoch, parent);
      let r = await pushPlain(commit);
      if (r.code !== 0 && nonFastForward(r)) {
        // 远端见证不是本地链的后代：可能是 volume 被回滚，或远端由别处推进过
        const remote = await readRemote();
        const now = dbEpoch();
        if (remote && remote.instance_id === instanceId()) {
          if (remote.epoch > now) { onStale(remote); return; }
          if (remote.epoch === now) { await repo.run(['update-ref', REF, remote.head]); setPushed(now); return; }
        }
        commit = await makeCommit(now, remote?.head ?? null); // 接在远端链后面，代数严格更大
        r = await pushPlain(commit);
      }
      if (r.code !== 0) { log.warn?.(`[watermark] 推送远端水位失败，稍后重试：${String(r.stderr).slice(0, 200)}`); return; }
      await repo.run(['update-ref', REF, commit]);
      setPushed((await epochOf(commit)).epoch);
    }
  }

  // 推送远端水位：单飞；推送期间又有新的授权变更，就在这一轮结束后再推一次（总是推当时的最新代数）
  let again = false;
  function pushRemote() {
    if (!hasRemote) return Promise.resolve();
    if (pushing) { again = true; return pushing; }
    pushing = (async () => { do { again = false; await pushLoop(); } while (again); })()
      .catch((e) => log.warn?.(`[watermark] ${e.message}`)).finally(() => { pushing = null; });
    return pushing;
  }

  function record(epoch) {
    writeLocal(epoch);
    return pushRemote();
  }

  // 见证里见过的最大代数（只认同一实例的见证）。remoteError 非空表示远端没读到。
  async function witnesses() {
    const id = instanceId();
    const local = readLocal();
    let remote = null; let remoteError = null;
    try { remote = await readRemote(); } catch (e) { remoteError = e.message; }
    const same = (w) => (w && w.instance_id === id ? w.epoch : 0);
    return { local, remote, remoteError, floor: Math.max(same(local), same(remote)) };
  }

  // 开放认证前的核实：{ok:true} | {ok:false, stale:{floor}} | {ok:false, retry:message}
  async function verify() {
    const w = await witnesses();
    if (w.floor > dbEpoch()) return { ok: false, stale: { floor: w.floor } };
    if (hasRemote && w.remoteError) return { ok: false, retry: w.remoteError };
    if (hasRemote && (!w.remote || w.remote.instance_id !== instanceId() || w.remote.epoch < dbEpoch())) {
      await pushRemote(dbEpoch());
      if (Number(db.meta.get('witness_pushed_epoch') ?? 0) < dbEpoch()) return { ok: false, retry: '远端水位还没推上去' };
    }
    writeLocal(dbEpoch());
    return { ok: true };
  }

  return {
    record, writeLocal, readLocal, pushRemote, readRemote, witnesses, verify,
    flush: () => pushing ?? Promise.resolve(),
    pending: () => hasRemote && Number(db.meta.get('witness_pushed_epoch') ?? 0) < dbEpoch(),
  };
}
