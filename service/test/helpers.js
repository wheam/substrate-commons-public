// 测试辅助：临时目录、本地 bare 远端、启动服务、经 MCP 客户端调用工具。
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createService } from '../src/server.js';

export const BOOT_CODE = `sbe_${'a1'.repeat(16)}`;
const cleanups = [];

export function tmp(prefix = 'commons-test-') {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function cleanupAll() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } } }

export const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

export function makeRemote() {
  const d = tmp('commons-remote-');
  git(d, 'init', '--bare', '-q', '-b', 'main', d);
  return d;
}

export async function startService(opts = {}) {
  const dataDir = opts.dataDir ?? tmp('commons-data-');
  const svc = await createService({
    dataDir, slug: 'test-instance', displayName: '测试实例', trustedHops: 0, syncWaitMs: 3000, auditStdout: false,
    bootstrap: { code: BOOT_CODE, member: 'm-owner', name: 'Owner' }, log: { error() {}, warn() {} },
    ...opts,
  });
  const server = await new Promise((resolve) => { const s = svc.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { await new Promise((r) => server.close(r)); await svc.close(); };
  cleanups.push(() => { try { server.close(); } catch { /* ignore */ } });
  return { svc, url, dataDir, close };
}

export async function enroll(url, code) {
  const res = await fetch(`${url}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  return { status: res.status, body: await res.json() };
}

export async function connect(url, token) {
  const client = new Client({ name: 'commons-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch {
      const m = /^(\{[\s\S]*?\n\})\n\n-----/.exec(text);
      if (m) data = JSON.parse(m[1]);
    }
    return { isError: !!r.isError, text, data };
  };
  return { client, call, close: () => client.close() };
}

// 引导 admin，再为若干成员各签发一把 member 凭据并连接
export async function setupMembers(url, names = ['alice', 'bob']) {
  const boot = await enroll(url, BOOT_CODE);
  if (!boot.body.ok) throw new Error(`bootstrap 失败：${JSON.stringify(boot.body)}`);
  const admin = await connect(url, boot.body.token);
  const out = { admin, adminToken: boot.body.token };
  for (const n of names) {
    const mc = await admin.call('member_create', { member_id: `m-${n}`, display_name: n[0].toUpperCase() + n.slice(1) });
    if (mc.isError) throw new Error(mc.text);
    const inv = await admin.call('invite_create', { member_id: `m-${n}`, client_label: `${n}-claude-code` });
    if (inv.isError) throw new Error(inv.text);
    const r = await enroll(url, inv.data.code);
    if (!r.body.ok) throw new Error(JSON.stringify(r.body));
    out[n] = await connect(url, r.body.token);
    out[`${n}Token`] = r.body.token;
  }
  return out;
}

let n = 0;
export const key = () => `test-key-${Date.now()}-${n++}`;
