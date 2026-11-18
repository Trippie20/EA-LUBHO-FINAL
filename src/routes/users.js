// Super Admin: user management.

import { HttpError, conflict, notFound, forbidden, hashPassword } from '../util.js';
import { stopAllForUser, activeSessionCount } from '../hosting-core.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function temporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function loadUser(ctx) {
  const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(ctx.params.id).first();
  if (!user) throw notFound('User not found.');
  return user;
}

export const userRoutes = [
  {
    method: 'GET',
    path: '/admin/users',
    auth: 'admin',
    async handle(ctx) {
      const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 60);
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const { results } = await ctx.db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login,
                  (SELECT COUNT(*) FROM eas e WHERE e.owner_id = u.id) AS eas,
                  (SELECT COUNT(*) FROM mt5_accounts a WHERE a.user_id = u.id) AS accounts,
                  (SELECT COUNT(*) FROM hosting_sessions s WHERE s.user_id = u.id
                     AND s.status IN ('requested','starting','running','stop_requested')) AS active_sessions
             FROM users u
            WHERE (? = '' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')
            ORDER BY u.created_at DESC LIMIT 200`,
        )
        .bind(q, like, like)
        .all();
      return {
        users: results.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          createdAt: u.created_at,
          lastLogin: u.last_login,
          eas: u.eas,
          accounts: u.accounts,
          activeSessions: u.active_sessions,
        })),
      };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/suspend',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      if (user.id === ctx.user.id) throw conflict('You cannot suspend your own account.');
      if (user.role === 'super_admin') throw forbidden('A Super Admin account cannot be suspended.');
      await ctx.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(user.id).run();
      await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
      const stopped = await stopAllForUser(ctx, user.id, 'Account suspended by the administrator.');
      await ctx.log('admin.user_suspend', 'user', user.id, `${user.email}; stop requested for ${stopped} session(s)`);
      return { stoppedSessions: stopped };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/restore',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      await ctx.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(user.id).run();
      await ctx.log('admin.user_restore', 'user', user.id, user.email);
      return {};
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/approve',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      if (!['pending', 'rejected'].includes(user.status)) throw conflict('This user is not waiting for approval.');
      await ctx.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(user.id).run();
      await ctx.log('admin.user_approve', 'user', user.id, user.email);
      await ctx.notify({ userId: user.id, kind: 'success', title: 'Account approved', detail: 'You can now add MT5 accounts and EAs.' });
      return {};
    },
  },
  {
    method: 'POST',
    path: '/admin/users/:id/reject',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      if (user.status !== 'pending') throw conflict('Only a pending registration can be rejected.');
      await ctx.db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").bind(user.id).run();
      await ctx.log('admin.user_reject', 'user', user.id, user.email);
      return {};
    },
  },

  // There is no email service on the free plan, so the admin hands over a temporary password.
  {
    method: 'POST',
    path: '/admin/users/:id/reset-password',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      if (user.id === ctx.user.id) throw conflict('Use "Change password" for your own account.');
      if (user.role === 'super_admin') throw forbidden('A Super Admin password cannot be reset here.');
      const temp = temporaryPassword();
      const h = await hashPassword(temp);
      await ctx.db
        .prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 1 WHERE id = ?')
        .bind(h.pw_hash, h.pw_salt, h.pw_iter, user.id)
        .run();
      await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
      await ctx.log('admin.user_reset_password', 'user', user.id, user.email);
      return { temporaryPassword: temp };
    },
  },

  {
    method: 'DELETE',
    path: '/admin/users/:id',
    auth: 'admin',
    async handle(ctx) {
      const user = await loadUser(ctx);
      if (user.id === ctx.user.id) throw conflict('You cannot delete your own account.');
      if (user.role === 'super_admin') throw forbidden('A Super Admin account cannot be deleted.');
      if ((await activeSessionCount(ctx, 'user_id = ?', user.id)) > 0) {
        throw new HttpError(409, 'conflict', 'This user still has active hosting sessions. Suspend the user first and wait for the sessions to stop.');
      }
      await ctx.log('admin.user_delete', 'user', user.id, user.email);
      await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
      return {};
    },
  },
];
