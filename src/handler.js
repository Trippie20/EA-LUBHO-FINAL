// EA LUBHO API. Runs as a Cloudflare Pages Function (functions/api/[[path]].js) and is
// imported directly by the tests, so it only uses Web APIs plus the D1-style `env.DB`.

import { HttpError, badRequest, forbidden, newId, sha256Hex, safeEqual, randomHex } from './util.js';
import { routes } from './routes/index.js';

export const SESSION_COOKIE = 'lubho_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;

const compiled = routes.map((r) => {
  const keys = [];
  const source = r.path.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { ...r, keys, re: new RegExp(`^${source}$`) };
});

function makeCtx(request, env) {
  const url = new URL(request.url);
  const ctx = {
    request,
    env,
    db: env.DB,
    url,
    method: request.method,
    path: url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/',
    ip: request.headers.get('cf-connecting-ip') || 'unknown',
    now: () => (env.NOW_FN ? env.NOW_FN() : Date.now()),
    params: {},
    user: null,
    host: null,
    cookies: [],
  };

  // Reads a small JSON object body.
  ctx.body = async (maxBytes = 50_000) => {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
    const raw = await request.text();
    if (raw.length > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* fall through */
    }
    throw badRequest('The request body must be a JSON object.');
  };

  // Rate limiting. `hit` records an attempt; `guard` throws when too many were recorded recently.
  ctx.hit = async (bucket) => {
    await ctx.db.prepare('INSERT INTO attempts (bucket, at) VALUES (?, ?)').bind(bucket, ctx.now()).run();
    await ctx.db.prepare('DELETE FROM attempts WHERE at < ?').bind(ctx.now() - 24 * 60 * 60 * 1000).run();
  };
  ctx.guard = async (bucket, max, windowMs) => {
    const row = await ctx.db
      .prepare('SELECT COUNT(*) AS c FROM attempts WHERE bucket = ? AND at > ?')
      .bind(bucket, ctx.now() - windowMs)
      .first();
    if ((row?.c ?? 0) >= max) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  };

  // Activity log and notifications.
  ctx.log = async (action, targetType = '', targetId = '', detail = '', actor = ctx.user) => {
    await ctx.db
      .prepare(
        'INSERT INTO activity_logs (actor_id, actor_email, action, target_type, target_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(actor?.id ?? null, actor?.email ?? '', action, targetType, String(targetId), String(detail).slice(0, 300), ctx.ip, ctx.now())
      .run();
  };
  ctx.notify = async ({ userId = null, audience = 'user', kind = 'info', title, detail = '' }) => {
    await ctx.db
      .prepare('INSERT INTO notifications (id, user_id, audience, kind, title, detail, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .bind(newId(), audience === 'admins' ? null : userId, audience, kind, title, String(detail).slice(0, 300), ctx.now())
      .run();
  };

  // Login cookie helpers.
  ctx.startSession = async (userId) => {
    const token = randomHex(32);
    await ctx.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(), userId, await sha256Hex(token), ctx.now(), ctx.now() + SESSION_TTL_MS, ctx.now())
      .run();
    ctx.cookies.push(
      `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
  };
  ctx.clearSessionCookie = () => {
    ctx.cookies.push(`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  };

  return ctx;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

async function requireUser(ctx, adminOnly) {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Please log in.');
  const row = await ctx.db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, s.last_seen, u.id, u.email, u.name, u.role, u.status, u.must_change
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.expires_at <= ctx.now()) throw new HttpError(401, 'unauthenticated', 'Please log in.');
  if (row.status !== 'active') throw new HttpError(403, 'suspended', 'This account is suspended.');
  if (ctx.now() - row.last_seen > SESSION_TOUCH_MS) {
    await ctx.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').bind(ctx.now(), row.sid).run();
  }
  ctx.user = row;
  ctx.sessionId = row.sid;
  if (adminOnly && row.role !== 'super_admin') throw forbidden('Super Admin access is required.');
}

async function requireHost(ctx) {
  await ctx.guard(`hostauth:${ctx.ip}`, 30, 15 * 60 * 1000);
  const header = ctx.request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const host = token.startsWith('lhost_')
    ? await ctx.db.prepare('SELECT * FROM hosts WHERE token_hash = ?').bind(await sha256Hex(token)).first()
    : null;
  if (!host) {
    await ctx.hit(`hostauth:${ctx.ip}`);
    throw new HttpError(401, 'bad_host_token', 'Unknown host token.');
  }
  ctx.host = host;
}

// Browsers cannot add this header or send credentials cross-site without our consent,
// so requiring it on every state-changing request blocks cross-site request forgery.
function csrfCheck(ctx) {
  const origin = ctx.request.headers.get('origin');
  if (origin && origin !== ctx.url.origin) throw forbidden('Cross-site request blocked.');
  if (ctx.request.headers.get('x-requested-with') !== 'lubho') {
    throw new HttpError(403, 'csrf', 'Missing security header.');
  }
}

export async function handle(request, env) {
  const ctx = makeCtx(request, env);
  let response;
  try {
    const route = compiled.find((r) => r.method === ctx.method && r.re.test(ctx.path));
    if (!route) throw new HttpError(404, 'not_found', 'Unknown route.');
    const match = ctx.path.match(route.re);
    route.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(match[i + 1])));

    const mutating = !['GET', 'HEAD'].includes(ctx.method);
    if (route.auth === 'user' || route.auth === 'admin') {
      if (mutating) csrfCheck(ctx);
      await requireUser(ctx, route.auth === 'admin');
    } else if (route.auth === 'host') {
      await requireHost(ctx);
    } else if (route.csrf && mutating) {
      csrfCheck(ctx);
    }

    const result = await route.handle(ctx);
    response =
      result instanceof Response
        ? result
        : new Response(JSON.stringify({ ok: true, ...result }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
  } catch (err) {
    if (err instanceof HttpError) {
      response = new Response(JSON.stringify({ ok: false, error: err.code, message: err.message, ...(err.extra || {}) }), {
        status: err.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } else {
      console.error('api error', err && err.stack ? err.stack : err);
      response = new Response(JSON.stringify({ ok: false, error: 'server_error', message: 'Something went wrong on the server.' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  }
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  for (const c of ctx.cookies) headers.append('set-cookie', c);
  return new Response(response.body, { status: response.status, headers });
}
