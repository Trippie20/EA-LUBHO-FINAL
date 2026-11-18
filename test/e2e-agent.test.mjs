// Runs the REAL Python agent (simulation driver) against the real API over HTTP.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../src/handler.js';
import { makeEnv, makeClient, makeRunner } from './helpers.mjs';
const { check, section, finish } = makeRunner();

const env = makeEnv();
env.clock = Date.now();
const tick = setInterval(() => { env.clock = Date.now(); }, 100);
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await handle(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const admin = makeClient(env), alice = makeClient(env);
await admin.call('POST', '/setup', { body: { setupToken: env.SETUP_TOKEN, email: 'admin@x.com', name: 'A', password: 'long-enough-pass' } });
await admin.call('POST', '/auth/login', { body: { email: 'admin@x.com', password: 'long-enough-pass' } });
await alice.call('POST', '/auth/register', { body: { email: 'alice@x.com', name: 'Alice', password: 'Wonderland-9921' } });
const token = (await admin.call('POST', '/admin/hosts', { body: { name: 'Sim host' } })).token;
const dir = mkdtempSync(join(tmpdir(), 'agent-'));
writeFileSync(join(dir, 'config.json'), JSON.stringify({ serverUrl: base, token, dataDir: join(dir, 'data'), monitorSeconds: 1 }));
const agent = spawn('python3', ['-I', 'agent/lubho_agent.py', '--config', join(dir, 'config.json'), '--simulate'], { stdio: ['ignore', 'pipe', 'pipe'] });
let agentLog = ''; agent.stdout.on('data', (d) => (agentLog += d)); agent.stderr.on('data', (d) => (agentLog += d));
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); } return null; };

section('Real agent <-> real API (simulated MT5)');
const eaId = (await alice.call('POST', '/eas', { body: { name: 'Jumbo' } })).id;
const bytes = new Uint8Array(500).fill(3); bytes[0] = 1;
const fileId = (await alice.call('POST', `/eas/${eaId}/files?name=Jumbo.ex5`, { raw: bytes, headers: { 'content-type': 'application/octet-stream' } })).id;
const acct = (await alice.call('POST', '/accounts', { body: { label: 'D', login: '12345678', server: 'S-Demo', password: 'good-password' } })).id;
const bad = (await alice.call('POST', '/accounts', { body: { label: 'B', login: '87654321', server: 'S-Demo', password: 'bad-password' } })).id;
const status = async (id) => (await alice.call('GET', '/accounts')).accounts.find((a) => a.id === id);
check('good login verified by agent', !!(await until(async () => (await status(acct)).status === 'connected')), agentLog.slice(-400));
check('bad login reported failed', !!(await until(async () => (await status(bad)).status === 'failed')));
check('simulated result is labelled', /SIMULATED/.test((await status(acct)).statusDetail + (await status(bad)).statusDetail));
check('host reports simulated flag', (await admin.call('GET', '/admin/hosts')).hosts[0].info.simulated === true);
let r = await alice.call('POST', '/sessions', { body: { accountId: acct, fileId, symbol: 'XAUUSD.m', timeframe: 'M5' } });
const sid = r.id;
check('session reaches running via the agent', !!(await until(async () => (await alice.call('GET', `/sessions/${sid}`)).session.status === 'running')), agentLog.slice(-400));
check('agent reports a monitor snapshot (labelled SIM currency)', !!(await until(async () => (await alice.call('GET', '/monitor')).items[0]?.snapshot?.currency === 'SIM')), agentLog.slice(-300));
r = await alice.call('GET', `/sessions/${sid}`);
check('detail says simulated', /SIMULATED/.test(r.session.detail));
await alice.call('POST', `/sessions/${sid}/stop`);
check('session reaches stopped via the agent', !!(await until(async () => (await alice.call('GET', `/sessions/${sid}`)).session.status === 'stopped')));
check('agent log holds no password', !/good-password|bad-password/.test(agentLog));
agent.kill();
// stale token
const agent2 = spawn('python3', ['-I', 'agent/lubho_agent.py', '--config', join(dir, 'config.json'), '--simulate', '--once'], { stdio: 'ignore' });
agent2.kill();
clearInterval(tick); server.close(); rmSync(dir, { recursive: true, force: true });
finish();
