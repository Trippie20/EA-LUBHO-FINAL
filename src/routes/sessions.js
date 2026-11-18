// Hosting machines (Super Admin) and hosting sessions (Start / Stop / Status).
// Nothing here claims success: a session is "running" only after the host agent says so.

import { badRequest, conflict, forbidden, notFound, newId, sha256Hex, randomHex, text } from '../util.js';
import { pickHost, createTask, sessionView, requestStop, hostOnline, activeSessionCount, parseConfig } from '../hosting-core.js';
import { userHoldsLicence } from './licences.js';

const isAdmin = (u) => u.role === 'super_admin';

const SELECT = `SELECT s.*, e.name AS ea_name, e.version AS ea_version, f.filename AS file_name,
    a.label AS account_label, a.login AS account_login, h.name AS host_name, h.last_seen AS host_last_seen,
    u.email AS user_email
  FROM hosting_sessions s
  LEFT JOIN eas e ON e.id = s.ea_id LEFT JOIN ea_files f ON f.id = s.file_id
  LEFT JOIN mt5_accounts a ON a.id = s.account_id LEFT JOIN hosts h ON h.id = s.host_id
  JOIN users u ON u.id = s.user_id`;

const toView = (ctx, row, admin = false) => {
  const v = sessionView(row, row.host_id ? { last_seen: row.host_last_seen } : null, ctx.now());
  if (!admin) delete v.userEmail;
  return v;
};

async function loadSession(ctx, admin = false) {
  const row = await ctx.db.prepare(`${SELECT} WHERE s.id = ?`).bind(ctx.params.id).first();
  if (!row || (!admin && row.user_id !== ctx.user.id)) throw notFound('Hosting session not found.');
  return row;
}

// Shared checks for starting (or restarting) a session.
async function checkStart(ctx, { userId, accountId, fileId, ignoreSessionId = null }) {
  const account = await ctx.db.prepare('SELECT * FROM mt5_accounts WHERE id = ? AND user_id = ?').bind(accountId, userId).first();
  if (!account) throw notFound('MT5 account not found.');
  if (account.status !== 'connected') {
    throw conflict('This MT5 account has not been verified by the hosting machine yet, so it cannot be hosted. Verify it first.', 'account_not_verified');
  }
  const file = await ctx.db.prepare('SELECT f.*, e.status AS ea_status, e.name AS ea_name FROM ea_files f JOIN eas e ON e.id = f.ea_id WHERE f.id = ?').bind(fileId).first();
  if (!file) throw notFound('EX5 file not found.');
  const owner = await ctx.db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  const ownsIt = file.owner_id === userId || owner?.role === 'super_admin';
  if (!ownsIt) {
    if (file.ea_status !== 'published') throw notFound('EX5 file not found.');
    if (!(await userHoldsLicence(ctx, userId, file.ea_id))) {
      throw conflict('You need an active licence for this EA before it can be hosted.', 'licence_required');
    }
  }
  const busy = await ctx.db
    .prepare("SELECT id FROM hosting_sessions WHERE account_id = ? AND status IN ('requested','starting','running','stop_requested') AND id != ?")
    .bind(accountId, ignoreSessionId ?? '')
    .first();
  if (busy) throw conflict('This MT5 account already has an active hosting session.', 'account_busy');
  const n = await activeSessionCount(ctx, 'user_id = ?', userId);
  if (n >= 5) throw conflict('You can have at most 5 active hosting sessions.');
  const host = await pickHost(ctx);
  if (!host) throw conflict('No hosting machine is registered yet. The administrator must connect one first.', 'no_host');
  return { account, file, host };
}

async function queueStart(ctx, session, host) {
  await createTask(ctx, { type: 'start_session', hostId: host.id, userId: session.user_id, accountId: session.account_id, sessionId: session.id });
}

export const sessionRoutes = [
  // EX5 files this user is allowed to host: their own, plus files of published EAs they hold a licence for.
  {
    method: 'GET',
    path: '/hostable',
    auth: 'user',
    async handle(ctx) {
      const own = isAdmin(ctx.user)
        ? await ctx.db.prepare('SELECT f.id, f.filename, e.id AS ea_id, e.name, e.version FROM ea_files f JOIN eas e ON e.id = f.ea_id ORDER BY e.name').all()
        : await ctx.db.prepare('SELECT f.id, f.filename, e.id AS ea_id, e.name, e.version FROM ea_files f JOIN eas e ON e.id = f.ea_id WHERE f.owner_id = ? ORDER BY e.name').bind(ctx.user.id).all();
      const licensed = await ctx.db
        .prepare(
          `SELECT DISTINCT f.id, f.filename, e.id AS ea_id, e.name, e.version FROM ea_files f JOIN eas e ON e.id = f.ea_id
            WHERE e.status = 'published' AND e.owner_id != ? AND EXISTS (
              SELECT 1 FROM licences l WHERE l.user_id = ? AND l.status = 'active' AND (l.ea_id IS NULL OR l.ea_id = e.id)
                AND (l.expires_at IS NULL OR l.expires_at > ?))`,
        )
        .bind(ctx.user.id, ctx.user.id, ctx.now())
        .all();
      const row = (r, source) => ({ fileId: r.id, filename: r.filename, eaId: r.ea_id, eaName: r.name, eaVersion: r.version, source });
      return { files: [...own.results.map((r) => row(r, 'own')), ...(isAdmin(ctx.user) ? [] : licensed.results.map((r) => row(r, 'licensed')))] };
    },
  },

  // ----- hosting sessions (user) -----
  {
    method: 'GET',
    path: '/sessions',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`).bind(ctx.user.id).all();
      return { sessions: results.map((r) => toView(ctx, r)) };
    },
  },
  {
    method: 'GET',
    path: '/sessions/:id',
    auth: 'user',
    async handle(ctx) {
      return { session: toView(ctx, await loadSession(ctx, isAdmin(ctx.user)), isAdmin(ctx.user)) };
    },
  },
  {
    method: 'POST',
    path: '/sessions',
    auth: 'user',
    async handle(ctx) {
      const b = await ctx.body(30_000);
      const accountId = text(b.accountId, 'Account', { min: 1, max: 40 });
      const fileId = text(b.fileId, 'EX5 file', { min: 1, max: 40 });
      const cfg = parseConfig(b);
      const { account, file, host } = await checkStart(ctx, { userId: ctx.user.id, accountId, fileId });
      const id = newId();
      await ctx.db
        .prepare(
          `INSERT INTO hosting_sessions (id, user_id, ea_id, file_id, account_id, host_id, desired, status, status_detail, symbol, timeframe, preset_name, preset, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', 'requested', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.user.id, file.ea_id, file.id, account.id, host.id, 'Waiting for the hosting machine.', cfg.symbol, cfg.timeframe, cfg.preset_name, cfg.preset, ctx.now(), ctx.now())
        .run();
      await queueStart(ctx, { id, user_id: ctx.user.id, account_id: account.id }, host);
      await ctx.log('session.start_requested', 'session', id, `${file.ea_name} on ${account.login}`);
      return { id };
    },
  },
  // Change the hosting configuration. Only while the session is not running, so the host never
  // runs something different from what the page shows.
  {
    method: 'PATCH',
    path: '/sessions/:id/config',
    auth: 'user',
    async handle(ctx) {
      const s = await loadSession(ctx);
      if (!['stopped', 'failed'].includes(s.status)) throw conflict('Stop the session before changing its configuration.');
      const cfg = parseConfig(await ctx.body(30_000), s);
      await ctx.db
        .prepare('UPDATE hosting_sessions SET symbol = ?, timeframe = ?, preset_name = ?, preset = ?, updated_at = ? WHERE id = ?')
        .bind(cfg.symbol, cfg.timeframe, cfg.preset_name, cfg.preset, ctx.now(), s.id)
        .run();
      await ctx.log('session.config_changed', 'session', s.id, `${cfg.symbol || 'default symbol'} ${cfg.timeframe}${cfg.preset ? ' +preset' : ''}`);
      return {};
    },
  },
  {
    method: 'POST',
    path: '/sessions/:id/restart',
    auth: 'user',
    async handle(ctx) {
      const s = await loadSession(ctx);
      if (!['stopped', 'failed'].includes(s.status)) throw conflict('Only a stopped or failed session can be started again.');
      if (!s.file_id) throw conflict('The EX5 file for this session no longer exists.');
      const { host } = await checkStart(ctx, { userId: s.user_id, accountId: s.account_id, fileId: s.file_id, ignoreSessionId: s.id });
      await ctx.db
        .prepare("UPDATE hosting_sessions SET desired = 'running', status = 'requested', status_detail = ?, host_id = ?, started_at = NULL, stopped_at = NULL, last_report_at = NULL, updated_at = ? WHERE id = ?")
        .bind('Waiting for the hosting machine.', host.id, ctx.now(), s.id)
        .run();
      await queueStart(ctx, s, host);
      await ctx.log('session.start_requested', 'session', s.id, 'restart');
      return {};
    },
  },
  {
    method: 'POST',
    path: '/sessions/:id/stop',
    auth: 'user',
    async handle(ctx) {
      const s = await loadSession(ctx);
      const status = await requestStop(ctx, s);
      await ctx.log('session.stop_requested', 'session', s.id);
      return { status };
    },
  },
  {
    method: 'DELETE',
    path: '/sessions/:id',
    auth: 'user',
    async handle(ctx) {
      const s = await loadSession(ctx);
      if (!['stopped', 'failed'].includes(s.status)) throw conflict('Stop the session before removing it.');
      await ctx.db.prepare('DELETE FROM hosting_sessions WHERE id = ?').bind(s.id).run();
      await ctx.log('session.delete', 'session', s.id);
      return {};
    },
  },

  // ----- Super Admin: all sessions -----
  {
    method: 'GET',
    path: '/admin/sessions',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT} ORDER BY s.created_at DESC LIMIT 300`).all();
      return { sessions: results.map((r) => toView(ctx, r, true)) };
    },
  },
  {
    method: 'POST',
    path: '/admin/sessions/:id/stop',
    auth: 'admin',
    async handle(ctx) {
      const s = await loadSession(ctx, true);
      const status = await requestStop(ctx, s, 'Stopped by the administrator.');
      await ctx.log('admin.session_stop', 'session', s.id, s.user_email);
      await ctx.notify({ userId: s.user_id, kind: 'warning', title: 'Hosting session stopped by administrator', detail: `${s.ea_name ?? 'EA'} on ${s.account_login ?? 'account'}` });
      return { status };
    },
  },

  // ----- hosting machines (Super Admin) -----
  {
    method: 'GET',
    path: '/admin/hosts',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT h.*, (SELECT COUNT(*) FROM hosting_sessions s WHERE s.host_id = h.id AND s.status IN ('requested','starting','running','stop_requested')) AS sessions
             FROM hosts h ORDER BY h.created_at`,
        )
        .all();
      return {
        hosts: results.map((h) => ({
          id: h.id,
          name: h.name,
          online: hostOnline(h, ctx.now()),
          lastSeen: h.last_seen,
          agentVersion: h.agent_version,
          info: h.info ? JSON.parse(h.info) : null,
          activeSessions: h.sessions,
          createdAt: h.created_at,
        })),
      };
    },
  },
  {
    method: 'POST',
    path: '/admin/hosts',
    auth: 'admin',
    async handle(ctx) {
      const name = text((await ctx.body()).name, 'Name', { min: 1, max: 60 });
      const count = await ctx.db.prepare('SELECT COUNT(*) AS c FROM hosts').first();
      if (count.c >= 20) throw conflict('At most 20 hosting machines.');
      const token = `lhost_${randomHex(24)}`;
      const id = newId();
      await ctx.db.prepare('INSERT INTO hosts (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(id, name, await sha256Hex(token), ctx.now()).run();
      await ctx.log('host.create', 'host', id, name);
      return { id, token }; // shown once; put it in the agent's config file
    },
  },
  {
    method: 'POST',
    path: '/admin/hosts/:id/rotate-token',
    auth: 'admin',
    async handle(ctx) {
      const h = await ctx.db.prepare('SELECT * FROM hosts WHERE id = ?').bind(ctx.params.id).first();
      if (!h) throw notFound('Host not found.');
      const token = `lhost_${randomHex(24)}`;
      await ctx.db.prepare('UPDATE hosts SET token_hash = ? WHERE id = ?').bind(await sha256Hex(token), h.id).run();
      await ctx.log('host.rotate_token', 'host', h.id, h.name);
      return { token };
    },
  },
  {
    method: 'PATCH',
    path: '/admin/hosts/:id',
    auth: 'admin',
    async handle(ctx) {
      const name = text((await ctx.body()).name, 'Name', { min: 1, max: 60 });
      const r = await ctx.db.prepare('UPDATE hosts SET name = ? WHERE id = ?').bind(name, ctx.params.id).run();
      if (!r.meta.changes) throw notFound('Host not found.');
      await ctx.log('host.rename', 'host', ctx.params.id, name);
      return {};
    },
  },
  {
    method: 'DELETE',
    path: '/admin/hosts/:id',
    auth: 'admin',
    async handle(ctx) {
      const h = await ctx.db.prepare('SELECT * FROM hosts WHERE id = ?').bind(ctx.params.id).first();
      if (!h) throw notFound('Host not found.');
      if ((await activeSessionCount(ctx, 'host_id = ?', h.id)) > 0) throw conflict('Stop the sessions on this host first.');
      await ctx.db.prepare('DELETE FROM hosts WHERE id = ?').bind(h.id).run();
      await ctx.log('host.delete', 'host', h.id, h.name);
      return {};
    },
  },
];
