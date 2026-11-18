// First-time setup, registration, login, logout and "my account".

import {
  HttpError, badRequest, conflict, newId, sha256Hex, safeEqual,
  hashPassword, verifyPassword, text, email, password, PBKDF2_ITERATIONS,
} from '../util.js';
import { activeSessionCount } from '../hosting-core.js';
import { approvalRequired } from '../settings.js';

const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DUMMY_SALT = '00112233445566778899aabbccddeeff';

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  mustChange: Boolean(u.must_change),
});

async function createUser(ctx, { emailAddr, name, plainPassword, role, mustChange = 0, status = 'active' }) {
  const id = newId();
  const h = await hashPassword(plainPassword);
  const result = await ctx.db
    .prepare(
      role === 'super_admin'
        // Atomic: only succeeds while there is no super admin yet.
        ? `INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, role, status, must_change, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'super_admin', 'active', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'super_admin')`
        : `INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, role, status, must_change, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'user', '${status}', ?, ?)`,
    )
    .bind(id, emailAddr, name, h.pw_hash, h.pw_salt, h.pw_iter, mustChange, ctx.now())
    .run();
  if (result.meta.changes === 0) return null;
  return { id, email: emailAddr, name, role, status: role === 'super_admin' ? 'active' : status, must_change: mustChange };
}

export const authRoutes = [
  {
    method: 'GET',
    path: '/setup/status',
    auth: 'public',
    async handle(ctx) {
      const row = await ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'").first();
      return { needsSetup: row.c === 0, approvalRequired: await approvalRequired(ctx) };
    },
  },

  // Creates the first Super Admin. Needs the SETUP_TOKEN secret, so nobody else can claim it.
  {
    method: 'POST',
    path: '/setup',
    auth: 'public',
    async handle(ctx) {
      if (!ctx.env.SETUP_TOKEN) throw new HttpError(500, 'not_configured', 'The SETUP_TOKEN secret is not set on the server.');
      await ctx.guard(`setup:${ctx.ip}`, 5, FIFTEEN_MIN);
      const body = await ctx.body();
      const exists = await ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'").first();
      if (exists.c > 0) throw conflict('Setup is already complete.', 'already_setup');
      const given = await sha256Hex(String(body.setupToken || ''));
      if (!safeEqual(given, await sha256Hex(ctx.env.SETUP_TOKEN))) {
        await ctx.hit(`setup:${ctx.ip}`);
        throw new HttpError(403, 'bad_setup_token', 'That setup token is wrong.');
      }
      const emailAddr = email(body.email);
      const name = text(body.name, 'Name', { min: 1, max: 80 });
      const plain = password(body.password);
      const user = await createUser(ctx, { emailAddr, name, plainPassword: plain, role: 'super_admin' });
      if (!user) throw conflict('Setup is already complete.', 'already_setup');
      await ctx.log('setup.super_admin_created', 'user', user.id, emailAddr, user);
      return { user: publicUser(user) };
    },
  },

  {
    method: 'POST',
    path: '/auth/register',
    auth: 'public',
    csrf: true,
    async handle(ctx) {
      await ctx.guard(`register:${ctx.ip}`, 8, HOUR);
      await ctx.hit(`register:${ctx.ip}`);
      const body = await ctx.body();
      const emailAddr = email(body.email);
      const name = text(body.name, 'Name', { min: 1, max: 80 });
      const plain = password(body.password);
      if (plain.toLowerCase().includes(emailAddr.split('@')[0]) && emailAddr.split('@')[0].length >= 4) {
        throw badRequest('Do not use your email name inside your password.');
      }
      const taken = await ctx.db.prepare('SELECT id FROM users WHERE email = ?').bind(emailAddr).first();
      if (taken) throw conflict('That email is already registered.', 'email_taken');
      const needsApproval = await approvalRequired(ctx);
      const user = await createUser(ctx, { emailAddr, name, plainPassword: plain, role: 'user', status: needsApproval ? 'pending' : 'active' });
      await ctx.log('user.register', 'user', user.id, `${emailAddr}${needsApproval ? ' (waiting for approval)' : ''}`, user);
      if (needsApproval) {
        await ctx.notify({ audience: 'admins', kind: 'warning', title: 'New user waiting for approval', detail: `${name} (${emailAddr})` });
        return { pending: true, user: publicUser(user) }; // no login until the Super Admin approves
      }
      await ctx.startSession(user.id);
      await ctx.notify({ audience: 'admins', kind: 'info', title: 'New user registered', detail: `${name} (${emailAddr})` });
      await ctx.notify({ userId: user.id, kind: 'info', title: 'Welcome to EA LUBHO', detail: 'Add an MT5 account and an EA to get started.' });
      return { user: publicUser(user) };
    },
  },

  {
    method: 'POST',
    path: '/auth/login',
    auth: 'public',
    csrf: true,
    async handle(ctx) {
      const body = await ctx.body();
      const emailAddr = String(body.email ?? '').trim().toLowerCase().slice(0, 120);
      const plain = String(body.password ?? '').slice(0, 200);
      const ipBucket = `login:ip:${ctx.ip}`;
      const emailBucket = `login:email:${emailAddr}`;
      await ctx.guard(ipBucket, 10, FIFTEEN_MIN);
      await ctx.guard(emailBucket, 8, FIFTEEN_MIN);

      const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').bind(emailAddr).first();
      let ok = false;
      if (user) ok = await verifyPassword(plain, user);
      else await hashPassword(plain, PBKDF2_ITERATIONS, DUMMY_SALT); // same work either way
      if (!ok) {
        await ctx.hit(ipBucket);
        await ctx.hit(emailBucket);
        throw new HttpError(401, 'invalid_credentials', 'Wrong email or password.');
      }
      if (user.status === 'pending') throw new HttpError(403, 'pending', 'Your account is waiting for administrator approval.');
      if (user.status === 'rejected') throw new HttpError(403, 'rejected', 'This registration was not approved. Contact the administrator.');
      if (user.status !== 'active') throw new HttpError(403, 'suspended', 'This account is suspended. Contact the administrator.');

      await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, ctx.now()).run();
      await ctx.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(ctx.now(), user.id).run();
      await ctx.startSession(user.id);
      await ctx.log('auth.login', 'user', user.id, '', user);
      return { user: publicUser(user) };
    },
  },

  {
    method: 'POST',
    path: '/auth/logout',
    auth: 'user',
    async handle(ctx) {
      await ctx.db.prepare('DELETE FROM sessions WHERE id = ?').bind(ctx.sessionId).run();
      ctx.clearSessionCookie();
      return {};
    },
  },

  {
    method: 'GET',
    path: '/me',
    auth: 'user',
    async handle(ctx) {
      return { user: publicUser(ctx.user) };
    },
  },

  {
    method: 'PATCH',
    path: '/me',
    auth: 'user',
    async handle(ctx) {
      const body = await ctx.body();
      const name = text(body.name, 'Name', { min: 1, max: 80 });
      await ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, ctx.user.id).run();
      await ctx.log('user.update_profile', 'user', ctx.user.id);
      return { user: publicUser({ ...ctx.user, name }) };
    },
  },

  {
    method: 'POST',
    path: '/me/password',
    auth: 'user',
    async handle(ctx) {
      await ctx.guard(`pwchange:${ctx.user.id}`, 8, FIFTEEN_MIN);
      const body = await ctx.body();
      const record = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(ctx.user.id).first();
      if (!(await verifyPassword(String(body.current ?? ''), record))) {
        await ctx.hit(`pwchange:${ctx.user.id}`);
        throw new HttpError(403, 'invalid_credentials', 'Your current password is wrong.');
      }
      const next = password(body.next, 'New password');
      const h = await hashPassword(next);
      await ctx.db
        .prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 0 WHERE id = ?')
        .bind(h.pw_hash, h.pw_salt, h.pw_iter, ctx.user.id)
        .run();
      // Every other device is signed out.
      await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(ctx.user.id, ctx.sessionId).run();
      await ctx.log('user.change_password', 'user', ctx.user.id);
      return {};
    },
  },

  {
    method: 'DELETE',
    path: '/me',
    auth: 'user',
    async handle(ctx) {
      await ctx.guard(`pwchange:${ctx.user.id}`, 8, FIFTEEN_MIN);
      const body = await ctx.body();
      const record = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(ctx.user.id).first();
      if (!(await verifyPassword(String(body.password ?? ''), record))) {
        await ctx.hit(`pwchange:${ctx.user.id}`);
        throw new HttpError(403, 'invalid_credentials', 'Your password is wrong.');
      }
      if (ctx.user.role === 'super_admin') throw conflict('The Super Admin account cannot be deleted here.');
      if ((await activeSessionCount(ctx, 'user_id = ?', ctx.user.id)) > 0) {
        throw conflict('Stop all hosting sessions before deleting your account.');
      }
      await ctx.log('user.delete_self', 'user', ctx.user.id, ctx.user.email);
      await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(ctx.user.id).run();
      ctx.clearSessionCookie();
      return {};
    },
  },
];
