// Notifications, activity logs, dashboard statistics, system status and EA Studio storage.

import { badRequest, conflict, notFound, newId, text, oneOf } from '../util.js';
import { hostOnline } from '../hosting-core.js';

const isAdmin = (u) => u.role === 'super_admin';
const ACTIVE = "('requested','starting','running','stop_requested')";

const notifScope = (ctx) =>
  isAdmin(ctx.user) ? { sql: "(user_id = ? OR audience = 'admins')", args: [ctx.user.id] } : { sql: 'user_id = ?', args: [ctx.user.id] };

async function count(ctx, sql, ...args) {
  return (await ctx.db.prepare(sql).bind(...args).first()).c;
}

export const miscRoutes = [
  // What the interface may show every signed-in user about the hosting machine(s).
  {
    method: 'GET',
    path: '/platform',
    auth: 'user',
    async handle(ctx) {
      const hosts = (await ctx.db.prepare('SELECT * FROM hosts').all()).results;
      return { platform: { liveAccountsAllowed: ctx.env.ALLOW_LIVE_ACCOUNTS === 'true', hostsRegistered: hosts.length, hostsOnline: hosts.filter((h) => hostOnline(h, ctx.now())).length } };
    },
  },

  // ----- notifications -----
  {
    method: 'GET',
    path: '/notifications',
    auth: 'user',
    async handle(ctx) {
      const sc = notifScope(ctx);
      const { results } = await ctx.db.prepare(`SELECT * FROM notifications WHERE ${sc.sql} ORDER BY created_at DESC, rowid DESC LIMIT 50`).bind(...sc.args).all();
      const unread = await count(ctx, `SELECT COUNT(*) AS c FROM notifications WHERE ${sc.sql} AND read = 0`, ...sc.args);
      return { unread, notifications: results.map((n) => ({ id: n.id, kind: n.kind, title: n.title, detail: n.detail, read: Boolean(n.read), createdAt: n.created_at })) };
    },
  },
  {
    method: 'POST',
    path: '/notifications/read-all',
    auth: 'user',
    async handle(ctx) {
      const sc = notifScope(ctx);
      await ctx.db.prepare(`UPDATE notifications SET read = 1 WHERE ${sc.sql}`).bind(...sc.args).run();
      return {};
    },
  },
  {
    method: 'POST',
    path: '/notifications/:id/read',
    auth: 'user',
    async handle(ctx) {
      const sc = notifScope(ctx);
      await ctx.db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND ${sc.sql}`).bind(ctx.params.id, ...sc.args).run();
      return {};
    },
  },
  {
    method: 'DELETE',
    path: '/notifications',
    auth: 'user',
    async handle(ctx) {
      const sc = notifScope(ctx);
      // Admin-wide notices are shared, so a user (or admin) only clears their own rows.
      await ctx.db.prepare('DELETE FROM notifications WHERE user_id = ?').bind(ctx.user.id).run();
      return {};
    },
  },

  // ----- activity -----
  {
    method: 'GET',
    path: '/activity',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db
        .prepare('SELECT id, action, target_type, target_id, detail, created_at FROM activity_logs WHERE actor_id = ? ORDER BY id DESC LIMIT 50')
        .bind(ctx.user.id)
        .all();
      return { activity: results.map((l) => ({ id: l.id, action: l.action, targetType: l.target_type, detail: l.detail, createdAt: l.created_at })) };
    },
  },
  {
    method: 'GET',
    path: '/admin/logs',
    auth: 'admin',
    async handle(ctx) {
      const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 60);
      const before = Number(ctx.url.searchParams.get('before')) || 9e15;
      const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 200);
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const { results } = await ctx.db
        .prepare(
          `SELECT * FROM activity_logs WHERE id < ? AND (? = '' OR action LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')
            ORDER BY id DESC LIMIT ?`,
        )
        .bind(before, q, like, like, like, limit)
        .all();
      return {
        logs: results.map((l) => ({ id: l.id, actor: l.actor_email || 'system / host', action: l.action, targetType: l.target_type, targetId: l.target_id, detail: l.detail, ip: l.ip, createdAt: l.created_at })),
      };
    },
  },

  // ----- statistics (counted from stored data) -----
  {
    method: 'GET',
    path: '/stats',
    auth: 'user',
    async handle(ctx) {
      const u = ctx.user.id;
      return {
        stats: {
          eas: await count(ctx, 'SELECT COUNT(*) AS c FROM eas WHERE owner_id = ?', u),
          files: await count(ctx, 'SELECT COUNT(*) AS c FROM ea_files WHERE owner_id = ?', u),
          storageBytes: await count(ctx, 'SELECT COALESCE(SUM(size),0) AS c FROM ea_files WHERE owner_id = ?', u),
          accounts: await count(ctx, 'SELECT COUNT(*) AS c FROM mt5_accounts WHERE user_id = ?', u),
          accountsConnected: await count(ctx, "SELECT COUNT(*) AS c FROM mt5_accounts WHERE user_id = ? AND status = 'connected'", u),
          licencesActive: await count(ctx, "SELECT COUNT(*) AS c FROM licences WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)", u, ctx.now()),
          sessionsRunning: await count(ctx, "SELECT COUNT(*) AS c FROM hosting_sessions WHERE user_id = ? AND status = 'running'", u),
          sessionsTotal: await count(ctx, 'SELECT COUNT(*) AS c FROM hosting_sessions WHERE user_id = ?', u),
        },
      };
    },
  },
  {
    method: 'GET',
    path: '/admin/stats',
    auth: 'admin',
    async handle(ctx) {
      const now = ctx.now();
      const hosts = (await ctx.db.prepare('SELECT * FROM hosts').all()).results;
      const by = async (table, col) => {
        const { results } = await ctx.db.prepare(`SELECT ${col} AS k, COUNT(*) AS c FROM ${table} GROUP BY ${col}`).all();
        return Object.fromEntries(results.map((r) => [r.k, r.c]));
      };
      return {
        stats: {
          users: await count(ctx, "SELECT COUNT(*) AS c FROM users WHERE role = 'user' AND status != 'pending'"),
          usersSuspended: await count(ctx, "SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'"),
          usersPending: await count(ctx, "SELECT COUNT(*) AS c FROM users WHERE status = 'pending'"),
          eas: await by('eas', 'status'),
          files: await count(ctx, 'SELECT COUNT(*) AS c FROM ea_files'),
          storageBytes: await count(ctx, 'SELECT COALESCE(SUM(size),0) AS c FROM ea_files'),
          accounts: await by('mt5_accounts', 'status'),
          licences: await by('licences', 'status'),
          licencesExpired: await count(ctx, "SELECT COUNT(*) AS c FROM licences WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", now),
          sessions: await by('hosting_sessions', 'status'),
          hosts: { total: hosts.length, online: hosts.filter((h) => hostOnline(h, now)).length },
          pendingTasks: await count(ctx, "SELECT COUNT(*) AS c FROM tasks WHERE status IN ('pending','claimed')"),
        },
      };
    },
  },
  {
    method: 'GET',
    path: '/admin/system',
    auth: 'admin',
    async handle(ctx) {
      const hosts = (await ctx.db.prepare('SELECT * FROM hosts').all()).results;
      return {
        system: {
          credentialKeyConfigured: Boolean(ctx.env.CREDENTIAL_KEY),
          setupTokenConfigured: Boolean(ctx.env.SETUP_TOKEN),
          fileStorage: ctx.env.FILES ? 'r2' : 'd1',
          hostsRegistered: hosts.length,
          hostsOnline: hosts.filter((h) => hostOnline(h, ctx.now())).length,
        },
      };
    },
  },

  // ----- EA Development Studio (Super Admin only) -----
  {
    method: 'GET',
    path: '/admin/studio',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db.prepare('SELECT id, name, version, platform, updated_at, LENGTH(code) AS size FROM studio_projects WHERE owner_id = ? ORDER BY updated_at DESC').bind(ctx.user.id).all();
      return { projects: results.map((p) => ({ id: p.id, name: p.name, version: p.version, platform: p.platform, updatedAt: p.updated_at, size: p.size })) };
    },
  },
  {
    method: 'GET',
    path: '/admin/studio/:id',
    auth: 'admin',
    async handle(ctx) {
      const p = await ctx.db.prepare('SELECT * FROM studio_projects WHERE id = ? AND owner_id = ?').bind(ctx.params.id, ctx.user.id).first();
      if (!p) throw notFound('Project not found.');
      return { project: { id: p.id, name: p.name, version: p.version, platform: p.platform, code: p.code, updatedAt: p.updated_at } };
    },
  },
  {
    method: 'POST',
    path: '/admin/studio',
    auth: 'admin',
    async handle(ctx) {
      const b = await ctx.body(250_000);
      const f = {
        name: text(b.name, 'Name', { min: 1, max: 80 }),
        version: text(b.version ?? '1.0', 'Version', { min: 1, max: 20 }),
        platform: oneOf(b.platform ?? 'MT5', 'Platform', ['MT5', 'MT4']),
        code: text(b.code ?? '', 'Code', { max: 200_000 }),
      };
      if ((await count(ctx, 'SELECT COUNT(*) AS c FROM studio_projects WHERE owner_id = ?', ctx.user.id)) >= 100) throw conflict('At most 100 studio projects.');
      const id = newId();
      await ctx.db.prepare('INSERT INTO studio_projects (id, owner_id, name, version, platform, code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, ctx.user.id, f.name, f.version, f.platform, f.code, ctx.now()).run();
      await ctx.log('studio.create', 'studio', id, f.name);
      return { id };
    },
  },
  {
    method: 'PUT',
    path: '/admin/studio/:id',
    auth: 'admin',
    async handle(ctx) {
      const b = await ctx.body(250_000);
      const p = await ctx.db.prepare('SELECT * FROM studio_projects WHERE id = ? AND owner_id = ?').bind(ctx.params.id, ctx.user.id).first();
      if (!p) throw notFound('Project not found.');
      const f = {
        name: text(b.name ?? p.name, 'Name', { min: 1, max: 80 }),
        version: text(b.version ?? p.version, 'Version', { min: 1, max: 20 }),
        platform: oneOf(b.platform ?? p.platform, 'Platform', ['MT5', 'MT4']),
        code: b.code === undefined ? p.code : text(b.code, 'Code', { max: 200_000 }),
      };
      await ctx.db.prepare('UPDATE studio_projects SET name = ?, version = ?, platform = ?, code = ?, updated_at = ? WHERE id = ?').bind(f.name, f.version, f.platform, f.code, ctx.now(), p.id).run();
      return {};
    },
  },
  {
    method: 'DELETE',
    path: '/admin/studio/:id',
    auth: 'admin',
    async handle(ctx) {
      const r = await ctx.db.prepare('DELETE FROM studio_projects WHERE id = ? AND owner_id = ?').bind(ctx.params.id, ctx.user.id).run();
      if (!r.meta.changes) throw notFound('Project not found.');
      await ctx.log('studio.delete', 'studio', ctx.params.id);
      return {};
    },
  },
];
