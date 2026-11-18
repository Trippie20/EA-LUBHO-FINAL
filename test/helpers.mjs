// Test harness: the real API handler running on an in-memory SQLite database that behaves like
// Cloudflare D1, with an optional in-memory R2 bucket.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handle } from '../src/handler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
  const wrap = (sql) => {
    const st = db.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() { return st.get(...args) ?? null; },
      async all() { return { results: st.all(...args) }; },
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      _run() { return st.run(...args); },
    };
    return api;
  };
  return {
    raw: db,
    prepare: wrap,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => ({ meta: { changes: Number(s._run().changes) } }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function makeR2() {
  const store = new Map();
  return {
    store,
    async put(key, value) { store.set(key, new Uint8Array(value)); },
    async get(key) {
      const v = store.get(key);
      return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null;
    },
    async delete(key) { store.delete(key); },
  };
}

export const randomKeyBase64 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

export function makeEnv(extra = {}) {
  return {
    DB: makeD1(),
    SETUP_TOKEN: 'setup-token-for-tests',
    CREDENTIAL_KEY: randomKeyBase64(),
    clock: 1_800_000_000_000,
    ...extra,
    get NOW_FN() { return () => this.clock; },
  };
}

let ipCounter = 0;
export const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

// A tiny browser: keeps cookies per "client" and adds the CSRF header like the real site does.
export function makeClient(env, { ip } = {}) {
  const jar = {};
  const clientIp = ip || nextIp();
  async function call(method, path, { body, headers = {}, raw, csrf = true, token } = {}) {
    const h = { 'cf-connecting-ip': clientIp, ...headers };
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && method !== 'GET') h['x-requested-with'] = 'lubho';
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await handle(new Request(`https://lubho.test/api${path}`, { method, headers: h, body: payload }), env);
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      if (/Max-Age=0/i.test(c)) delete jar[k]; else jar[k] = v.join('=');
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const data = await res.json();
      return { status: res.status, headers: res.headers, ...data };
    }
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return { call, jar, ip: clientIp };
}

export function makeRunner() {
  let n = 0;
  let failed = 0;
  const check = (name, cond, extra = '') => {
    n++;
    if (cond) console.log(`  ok   ${name}`);
    else { failed++; console.log(`  FAIL ${name} ${extra}`); }
  };
  const section = (title) => console.log(`\n${title}`);
  const finish = () => {
    console.log(`\n${n - failed}/${n} checks passed`);
    process.exit(failed ? 1 : 0);
  };
  return { check, section, finish, get counts() { return { n, failed }; } };
}
