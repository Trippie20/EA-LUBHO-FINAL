// Licences: admin creates keys (shown once), users redeem them, EAs/hosts check them.
// Only a SHA-256 hash of each key is stored.

import { HttpError, badRequest, conflict, notFound, newId, sha256Hex, text, integer, oneOf, DAY_MS } from '../util.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEN_MIN = 10 * 60 * 1000;

function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return 'LUBHO-' + [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
const normalise = (k) => String(k ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 40);

// 'active' | 'suspended' | 'revoked' | 'expired'
export const effectiveStatus = (l, now) => (l.status === 'active' && l.expires_at && l.expires_at <= now ? 'expired' : l.status);

const view = (l, now, accounts = 0) => ({
  id: l.id,
  hint: l.key_hint,
  label: l.label,
  eaId: l.ea_id,
  eaName: l.ea_name ?? null,
  userId: l.user_id,
  userEmail: l.user_email ?? null,
  maxAccounts: l.max_accounts,
  durationDays: l.duration_days,
  expiresAt: l.expires_at,
  status: effectiveStatus(l, now),
  storedStatus: l.status,
  accountsUsed: l.accounts_used ?? accounts,
  createdAt: l.created_at,
  redeemedAt: l.redeemed_at,
});

const SELECT = `SELECT l.*, e.name AS ea_name, u.email AS user_email,
    (SELECT COUNT(*) FROM licence_accounts la WHERE la.licence_id = l.id) AS accounts_used
  FROM licences l LEFT JOIN eas e ON e.id = l.ea_id LEFT JOIN users u ON u.id = l.user_id`;

// Does this user hold a usable licence covering the EA? Used before hosting someone else's EA.
export async function userHoldsLicence(ctx, userId, eaId) {
  const row = await ctx.db
    .prepare(
      `SELECT id FROM licences WHERE user_id = ? AND status = 'active'
          AND (ea_id IS NULL OR ea_id = ?) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    )
    .bind(userId, eaId, ctx.now())
    .first();
  return Boolean(row);
}

async function load(ctx) {
  const l = await ctx.db.prepare(`${SELECT} WHERE l.id = ?`).bind(ctx.params.id).first();
  if (!l) throw notFound('Licence not found.');
  return l;
}

async function setStatus(ctx, status, action) {
  const l = await load(ctx);
  if (l.status === 'revoked') throw conflict('A revoked licence cannot be changed.');
  await ctx.db.prepare('UPDATE licences SET status = ? WHERE id = ?').bind(status, l.id).run();
  await ctx.log(action, 'licence', l.id, l.key_hint);
  if (l.user_id) {
    await ctx.notify({ userId: l.user_id, kind: status === 'active' ? 'info' : 'warning', title: `Licence ${status}`, detail: `${l.label || l.key_hint} is now ${status}.` });
  }
  return {};
}

export const licenceRoutes = [
  {
    method: 'POST',
    path: '/admin/licences',
    auth: 'admin',
    async handle(ctx) {
      const b = await ctx.body();
      const label = text(b.label ?? '', 'Label', { max: 80 });
      const maxAccounts = integer(b.maxAccounts ?? 1, 'Accounts allowed', { min: 1, max: 50 });
      const durationDays = integer(b.durationDays, 'Duration (days)', { min: 1, max: 3650, optional: true });
      const startOn = oneOf(b.startOn ?? 'first_use', 'Start', ['first_use', 'now']);
      let eaId = null;
      if (b.eaId) {
        const ea = await ctx.db.prepare('SELECT id FROM eas WHERE id = ?').bind(String(b.eaId)).first();
        if (!ea) throw badRequest('That EA does not exist.');
        eaId = ea.id;
      }
      const key = makeKey();
      const id = newId();
      const expiresAt = durationDays && startOn === 'now' ? ctx.now() + durationDays * DAY_MS : null;
      await ctx.db
        .prepare(
          `INSERT INTO licences (id, key_hash, key_hint, label, ea_id, max_accounts, duration_days, expires_at, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, await sha256Hex(key), `…${key.slice(-4)}`, label, eaId, maxAccounts, durationDays, expiresAt, ctx.user.id, ctx.now())
        .run();
      await ctx.log('licence.create', 'licence', id, `${label || 'unnamed'} (${durationDays ? durationDays + ' days' : 'lifetime'})`);
      return { id, key }; // the only time the full key is ever shown
    },
  },
  {
    method: 'GET',
    path: '/admin/licences',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} ORDER BY l.created_at DESC LIMIT 300`).all();
      return { licences: results.map((l) => view(l, ctx.now())) };
    },
  },
  { method: 'POST', path: '/admin/licences/:id/suspend', auth: 'admin', handle: (ctx) => setStatus(ctx, 'suspended', 'licence.suspend') },
  { method: 'POST', path: '/admin/licences/:id/restore', auth: 'admin', handle: (ctx) => setStatus(ctx, 'active', 'licence.restore') },
  { method: 'POST', path: '/admin/licences/:id/revoke', auth: 'admin', handle: (ctx) => setStatus(ctx, 'revoked', 'licence.revoke') },
  {
    method: 'POST',
    path: '/admin/licences/:id/reset-accounts',
    auth: 'admin',
    async handle(ctx) {
      const l = await load(ctx);
      await ctx.db.prepare('DELETE FROM licence_accounts WHERE licence_id = ?').bind(l.id).run();
      await ctx.log('licence.reset_accounts', 'licence', l.id, l.key_hint);
      return {};
    },
  },

  // A user attaches a key to their account.
  {
    method: 'POST',
    path: '/licences/redeem',
    auth: 'user',
    async handle(ctx) {
      await ctx.guard(`redeem:${ctx.user.id}`, 8, TEN_MIN);
      const key = normalise((await ctx.body()).key);
      const l = key ? await ctx.db.prepare('SELECT * FROM licences WHERE key_hash = ?').bind(await sha256Hex(key)).first() : null;
      if (!l || (l.user_id && l.user_id !== ctx.user.id)) {
        await ctx.hit(`redeem:${ctx.user.id}`);
        throw new HttpError(404, 'invalid_key', 'That licence key is not valid or is already in use.');
      }
      if (l.status !== 'active') throw conflict(`This licence is ${l.status}.`, 'licence_inactive');
      if (l.expires_at && l.expires_at <= ctx.now()) throw conflict('This licence has expired.', 'licence_expired');
      if (!l.user_id) {
        const expires = l.expires_at ?? (l.duration_days ? ctx.now() + l.duration_days * DAY_MS : null);
        await ctx.db.prepare('UPDATE licences SET user_id = ?, redeemed_at = ?, expires_at = ? WHERE id = ?').bind(ctx.user.id, ctx.now(), expires, l.id).run();
        await ctx.log('licence.redeem', 'licence', l.id, l.key_hint);
        await ctx.notify({ audience: 'admins', kind: 'info', title: 'Licence redeemed', detail: `${ctx.user.email} redeemed ${l.label || l.key_hint}` });
      }
      return { id: l.id };
    },
  },
  {
    method: 'GET',
    path: '/licences',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} WHERE l.user_id = ? ORDER BY l.created_at DESC`).bind(ctx.user.id).all();
      return { licences: results.map((l) => ({ ...view(l, ctx.now()), userEmail: undefined })) };
    },
  },

  // Public check used by EAs (MQL5 WebRequest) and anything else. Binds the MT5 login to the licence.
  {
    method: 'POST',
    path: '/licence/validate',
    auth: 'public',
    async handle(ctx) {
      await ctx.guard(`validate:${ctx.ip}`, 30, TEN_MIN);
      const b = await ctx.body(2000);
      const key = normalise(b.key);
      const login = String(b.mt5Login ?? '').trim();
      const deny = async (reason) => {
        await ctx.hit(`validate:${ctx.ip}`);
        return { valid: false, reason };
      };
      if (!key || !/^\d{3,12}$/.test(login)) return deny('bad_request');
      const l = await ctx.db.prepare('SELECT * FROM licences WHERE key_hash = ?').bind(await sha256Hex(key)).first();
      if (!l) return deny('unknown_key');
      if (l.status !== 'active') return { valid: false, reason: l.status };
      if (b.eaId && l.ea_id && l.ea_id !== String(b.eaId)) return { valid: false, reason: 'wrong_ea' };
      let expires = l.expires_at;
      if (!expires && l.duration_days) {
        expires = ctx.now() + l.duration_days * DAY_MS; // clock starts on first use
        await ctx.db.prepare('UPDATE licences SET expires_at = ? WHERE id = ?').bind(expires, l.id).run();
      }
      if (expires && expires <= ctx.now()) return { valid: false, reason: 'expired' };
      const bound = await ctx.db.prepare('SELECT id FROM licence_accounts WHERE licence_id = ? AND mt5_login = ?').bind(l.id, login).first();
      if (bound) {
        await ctx.db.prepare('UPDATE licence_accounts SET last_seen = ? WHERE id = ?').bind(ctx.now(), bound.id).run();
      } else {
        const n = await ctx.db.prepare('SELECT COUNT(*) AS c FROM licence_accounts WHERE licence_id = ?').bind(l.id).first();
        if (n.c >= l.max_accounts) return { valid: false, reason: 'account_limit' };
        await ctx.db
          .prepare('INSERT INTO licence_accounts (id, licence_id, mt5_login, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
          .bind(newId(), l.id, login, ctx.now(), ctx.now())
          .run();
      }
      return { valid: true, expiresAt: expires };
    },
  },
];
