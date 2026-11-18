// Live Trade Monitor, Analytics Centre and platform settings.
// Everything here is read from stored data. If the host agent has not reported something,
// the answer is "no data" — never an estimate.

import { badRequest } from '../util.js';
import { setSetting, approvalRequired } from '../settings.js';
import { hostOnline } from '../hosting-core.js';

const STALE_MS = 3 * 60 * 1000;
const DAY = 86_400_000;

const snapView = (r) =>
  r && {
    at: r.at,
    balance: r.balance,
    equity: r.equity,
    margin: r.margin,
    freeMargin: r.free_margin,
    currency: r.currency,
    positions: JSON.parse(r.positions || '[]'),
  };

async function count(ctx, sql, ...args) {
  return (await ctx.db.prepare(sql).bind(...args).first()).c ?? 0;
}

function hostedSeconds(rows, now) {
  let total = 0;
  for (const s of rows) {
    if (!s.started_at) continue;
    const end = s.stopped_at ?? (s.status === 'running' ? now : s.last_report_at ?? s.started_at);
    if (end > s.started_at) total += (end - s.started_at) / 1000;
  }
  return Math.round(total);
}

export const monitorRoutes = [
  // ----- Live Trade Monitor: latest read-only snapshot per account that has a session -----
  {
    method: 'GET',
    path: '/monitor',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT s.id AS session_id, s.status, s.host_id, h.last_seen AS host_last_seen, e.name AS ea_name,
                  a.id AS account_id, a.label, a.login, a.server, a.kind
             FROM hosting_sessions s
             JOIN mt5_accounts a ON a.id = s.account_id
             LEFT JOIN eas e ON e.id = s.ea_id LEFT JOIN hosts h ON h.id = s.host_id
            WHERE s.user_id = ? AND s.status IN ('running', 'starting', 'stop_requested')
            ORDER BY s.created_at DESC`,
        )
        .bind(ctx.user.id)
        .all();
      const items = [];
      for (const r of results) {
        const snap = snapView(await ctx.db.prepare('SELECT * FROM account_snapshots WHERE account_id = ? ORDER BY at DESC LIMIT 1').bind(r.account_id).first());
        const online = hostOnline({ last_seen: r.host_last_seen }, ctx.now());
        items.push({
          sessionId: r.session_id,
          sessionStatus: online || r.status === 'starting' ? r.status : 'unknown',
          eaName: r.ea_name,
          accountId: r.account_id,
          accountLabel: r.label || r.login,
          login: r.login,
          server: r.server,
          kind: r.kind,
          snapshot: snap,
          stale: snap ? ctx.now() - snap.at > STALE_MS : null,
          floatingProfit: snap ? snap.positions.reduce((a, p) => a + (p.profit || 0), 0) : null,
        });
      }
      return { items };
    },
  },

  // ----- Analytics Centre (user) -----
  {
    method: 'GET',
    path: '/analytics',
    auth: 'user',
    async handle(ctx) {
      const u = ctx.user.id;
      const now = ctx.now();
      const sessions = (await ctx.db.prepare('SELECT * FROM hosting_sessions WHERE user_id = ?').bind(u).all()).results;
      const byEa = (
        await ctx.db
          .prepare(
            `SELECT COALESCE(e.name, 'Removed EA') AS name, COUNT(*) AS sessions
               FROM hosting_sessions s LEFT JOIN eas e ON e.id = s.ea_id WHERE s.user_id = ? GROUP BY s.ea_id ORDER BY sessions DESC LIMIT 10`,
          )
          .bind(u)
          .all()
      ).results;
      const accounts = (await ctx.db.prepare('SELECT id, label, login, server, kind FROM mt5_accounts WHERE user_id = ?').bind(u).all()).results;
      const equity = [];
      for (const a of accounts) {
        const { results } = await ctx.db
          .prepare('SELECT at, balance, equity FROM account_snapshots WHERE account_id = ? AND at > ? ORDER BY at DESC LIMIT 300')
          .bind(a.id, now - 14 * DAY)
          .all();
        if (results.length) equity.push({ accountId: a.id, label: a.label || a.login, login: a.login, points: results.reverse().map((r) => ({ at: r.at, balance: r.balance, equity: r.equity })) });
      }
      const licences = (await ctx.db.prepare('SELECT status, expires_at FROM licences WHERE user_id = ?').bind(u).all()).results;
      const nextExpiry = licences.filter((l) => l.status === 'active' && l.expires_at && l.expires_at > now).map((l) => l.expires_at).sort()[0] ?? null;
      return {
        analytics: {
          sessions: {
            total: sessions.length,
            running: sessions.filter((s) => s.status === 'running').length,
            failed: sessions.filter((s) => s.status === 'failed').length,
            stopped: sessions.filter((s) => s.status === 'stopped').length,
            hostedSeconds: hostedSeconds(sessions, now),
          },
          byEa,
          equity, // empty until the host agent reports snapshots for a running session
          storageBytes: await count(ctx, 'SELECT COALESCE(SUM(size),0) AS c FROM ea_files WHERE owner_id = ?', u),
          files: await count(ctx, 'SELECT COUNT(*) AS c FROM ea_files WHERE owner_id = ?', u),
          licences: { active: licences.filter((l) => l.status === 'active' && (!l.expires_at || l.expires_at > now)).length, total: licences.length, nextExpiry },
        },
      };
    },
  },

  // ----- Analytics Centre (Super Admin, platform-wide) -----
  {
    method: 'GET',
    path: '/admin/analytics',
    auth: 'admin',
    async handle(ctx) {
      const now = ctx.now();
      const since = now - 30 * DAY;
      const daily = async (table, col, extra = '') => {
        const { results } = await ctx.db.prepare(`SELECT ${col} AS t FROM ${table} WHERE ${col} > ? ${extra}`).bind(since).all();
        const days = {};
        for (const r of results) {
          const d = new Date(r.t).toISOString().slice(0, 10);
          days[d] = (days[d] || 0) + 1;
        }
        const out = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(now - i * DAY).toISOString().slice(0, 10);
          out.push({ day: d, count: days[d] || 0 });
        }
        return out;
      };
      const sessions = (await ctx.db.prepare('SELECT * FROM hosting_sessions').all()).results;
      const topEas = (
        await ctx.db
          .prepare(`SELECT COALESCE(e.name, 'Removed EA') AS name, COUNT(*) AS sessions FROM hosting_sessions s LEFT JOIN eas e ON e.id = s.ea_id GROUP BY s.ea_id ORDER BY sessions DESC LIMIT 10`)
          .all()
      ).results;
      return {
        analytics: {
          registrations: await daily('users', 'created_at', "AND role = 'user'"),
          sessionsCreated: await daily('hosting_sessions', 'created_at'),
          hostedSeconds: hostedSeconds(sessions, now),
          sessionsTotal: sessions.length,
          sessionsFailed: sessions.filter((s) => s.status === 'failed').length,
          topEas,
          storageBytes: await count(ctx, 'SELECT COALESCE(SUM(size),0) AS c FROM ea_files'),
        },
      };
    },
  },

  // ----- Platform settings (Super Admin) -----
  {
    method: 'GET',
    path: '/admin/settings',
    auth: 'admin',
    async handle(ctx) {
      return {
        settings: {
          requireApproval: await approvalRequired(ctx),
          liveAccountsAllowed: ctx.env.ALLOW_LIVE_ACCOUNTS === 'true', // set in Cloudflare, not here
        },
      };
    },
  },
  {
    method: 'PUT',
    path: '/admin/settings',
    auth: 'admin',
    async handle(ctx) {
      const b = await ctx.body();
      if (typeof b.requireApproval !== 'boolean') throw badRequest('requireApproval must be true or false.');
      await setSetting(ctx, 'require_approval', b.requireApproval);
      await ctx.log('admin.settings_changed', 'settings', 'require_approval', String(b.requireApproval));
      return {};
    },
  },
];
