// MT5 accounts. Passwords are encrypted before they reach the database and never come back out.

import { badRequest, conflict, notFound, newId, text, oneOf, encryptSecret } from '../util.js';
import { pickHost, createTask, activeSessionCount } from '../hosting-core.js';

const aad = (id, userId) => `acct:${id}:${userId}`;

const view = (a) => ({
  id: a.id,
  userId: a.user_id,
  userEmail: a.user_email,
  label: a.label,
  login: a.login,
  server: a.server,
  kind: a.kind,
  status: a.status, // unverified | connected | failed (connected only if an agent confirmed it)
  statusDetail: a.status_detail,
  verifiedAt: a.verified_at,
  info: a.info ? JSON.parse(a.info) : null,
  infoAt: a.info_at,
  createdAt: a.created_at,
});

const SELECT = 'SELECT a.*, u.email AS user_email FROM mt5_accounts a JOIN users u ON u.id = a.user_id';

async function mine(ctx) {
  const a = await ctx.db.prepare(`${SELECT} WHERE a.id = ? AND a.user_id = ?`).bind(ctx.params.id, ctx.user.id).first();
  if (!a) throw notFound('Account not found.');
  return a;
}

// Real broker accounts stay switched off until the security review is done (set ALLOW_LIVE_ACCOUNTS=true to enable).
const liveAllowed = (env) => env.ALLOW_LIVE_ACCOUNTS === 'true';
function parse(body, partial, env) {
  const out = {};
  if (!partial || body.label !== undefined) out.label = text(body.label ?? '', 'Label', { max: 60 });
  if (!partial) {
    out.login = text(body.login, 'MT5 login', { min: 3, max: 12, pattern: /^\d+$/, patternMessage: 'MT5 login must be digits only.' });
    out.server = text(body.server, 'Server', { min: 2, max: 80, pattern: /^[\w .()-]+$/, patternMessage: 'Server name has invalid characters.' });
  }
  if (body.kind !== undefined || !partial) out.kind = oneOf(body.kind ?? 'demo', 'Type', ['demo', 'live']);
  if (out.kind === 'live' && !liveAllowed(env)) {
    throw conflict('Live (real-money) accounts are switched off during testing. Please use a demo account.', 'live_disabled');
  }
  if (!partial || body.password !== undefined) out.password = text(body.password, 'MT5 password', { min: 1, max: 100 });
  return out;
}

async function queueVerify(ctx, a) {
  const host = await pickHost(ctx);
  await createTask(ctx, { type: 'verify_account', hostId: host?.id ?? null, userId: a.user_id, accountId: a.id });
  await ctx.db
    .prepare("UPDATE mt5_accounts SET status = 'unverified', status_detail = ?, updated_at = ? WHERE id = ?")
    .bind(host ? 'Waiting for the hosting machine to verify this login.' : 'No hosting machine is registered yet, so this login cannot be verified.', ctx.now(), a.id)
    .run();
}

export const accountRoutes = [
  {
    method: 'GET',
    path: '/accounts',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} WHERE a.user_id = ? ORDER BY a.created_at DESC`).bind(ctx.user.id).all();
      return { accounts: results.map(view) };
    },
  },
  {
    method: 'POST',
    path: '/accounts',
    auth: 'user',
    async handle(ctx) {
      const f = parse(await ctx.body(), false, ctx.env);
      const count = await ctx.db.prepare('SELECT COUNT(*) AS c FROM mt5_accounts WHERE user_id = ?').bind(ctx.user.id).first();
      if (count.c >= 10) throw conflict('You can store at most 10 MT5 accounts.');
      const dup = await ctx.db.prepare('SELECT id FROM mt5_accounts WHERE user_id = ? AND login = ? AND server = ?').bind(ctx.user.id, f.login, f.server).first();
      if (dup) throw conflict('That login and server are already saved.');
      const id = newId();
      const { ct, iv } = await encryptSecret(ctx.env, f.password, aad(id, ctx.user.id));
      await ctx.db
        .prepare(
          `INSERT INTO mt5_accounts (id, user_id, label, login, server, kind, pw_ct, pw_iv, key_version, status, status_detail, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unverified', '', ?, ?)`,
        )
        .bind(id, ctx.user.id, f.label, f.login, f.server, f.kind, ct, iv, ctx.now(), ctx.now())
        .run();
      const a = await ctx.db.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first();
      await queueVerify(ctx, a);
      await ctx.log('account.create', 'account', id, `${f.login}@${f.server}`); // never the password
      return { id };
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/:id',
    auth: 'user',
    async handle(ctx) {
      const a = await mine(ctx);
      const body = await ctx.body();
      const f = parse(body, true, ctx.env);
      if ((await activeSessionCount(ctx, 'account_id = ?', a.id)) > 0 && f.password !== undefined) {
        throw conflict('Stop hosting sessions on this account before changing its password.');
      }
      const label = f.label ?? a.label;
      const kind = f.kind ?? a.kind;
      await ctx.db.prepare('UPDATE mt5_accounts SET label = ?, kind = ?, updated_at = ? WHERE id = ?').bind(label, kind, ctx.now(), a.id).run();
      if (f.password !== undefined) {
        const { ct, iv } = await encryptSecret(ctx.env, f.password, aad(a.id, a.user_id));
        await ctx.db.prepare('UPDATE mt5_accounts SET pw_ct = ?, pw_iv = ? WHERE id = ?').bind(ct, iv, a.id).run();
        await queueVerify(ctx, a);
        await ctx.log('account.password_change', 'account', a.id, `${a.login}@${a.server}`);
      } else {
        await ctx.log('account.update', 'account', a.id, `${a.login}@${a.server}`);
      }
      return {};
    },
  },
  {
    method: 'POST',
    path: '/accounts/:id/verify',
    auth: 'user',
    async handle(ctx) {
      await ctx.guard(`verify:${ctx.user.id}`, 10, 10 * 60 * 1000);
      await ctx.hit(`verify:${ctx.user.id}`);
      const a = await mine(ctx);
      const pending = await ctx.db
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE account_id = ? AND type = 'verify_account' AND status IN ('pending','claimed')")
        .bind(a.id)
        .first();
      if (pending.c > 0) throw conflict('A check is already waiting for the hosting machine.');
      await queueVerify(ctx, a);
      await ctx.log('account.verify_requested', 'account', a.id);
      return {};
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    auth: 'user',
    async handle(ctx) {
      const a = await mine(ctx);
      if ((await activeSessionCount(ctx, 'account_id = ?', a.id)) > 0) throw conflict('Stop the hosting sessions on this account first.');
      await ctx.db.prepare('DELETE FROM hosting_sessions WHERE account_id = ?').bind(a.id).run();
      await ctx.db.prepare('DELETE FROM mt5_accounts WHERE id = ?').bind(a.id).run();
      await ctx.log('account.delete', 'account', a.id, `${a.login}@${a.server}`);
      return {};
    },
  },
  // Super Admin monitoring: statuses only, never credentials.
  {
    method: 'GET',
    path: '/admin/accounts',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} ORDER BY a.created_at DESC LIMIT 300`).all();
      return { accounts: results.map(view) };
    },
  },
];
