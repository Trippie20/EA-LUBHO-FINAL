// EAs and their private EX5 files.

import { HttpError, badRequest, conflict, forbidden, notFound, newId, sha256Hex, text, oneOf } from '../util.js';
import { LIMITS, maxFileBytes, storageKind, checkFileName, checkBytes, putBytes, getBytes, deleteBytes } from '../storage.js';
import { activeSessionCount } from '../hosting-core.js';

const isAdmin = (u) => u.role === 'super_admin';

const eaView = (e, extra = {}) => ({
  id: e.id,
  ownerId: e.owner_id,
  ownerEmail: e.owner_email,
  name: e.name,
  version: e.version,
  description: e.description,
  status: e.status,
  files: e.files ?? 0,
  createdAt: e.created_at,
  updatedAt: e.updated_at,
  ...extra,
});

const SELECT_EA = `SELECT e.*, u.email AS owner_email,
    (SELECT COUNT(*) FROM ea_files f WHERE f.ea_id = e.id) AS files
  FROM eas e JOIN users u ON u.id = e.owner_id`;

async function loadEa(ctx, { write = false } = {}) {
  const ea = await ctx.db.prepare(`${SELECT_EA} WHERE e.id = ?`).bind(ctx.params.id).first();
  if (!ea) throw notFound('EA not found.');
  const mine = ea.owner_id === ctx.user.id;
  if (write && !mine && !isAdmin(ctx.user)) throw notFound('EA not found.');
  if (!write && !mine && !isAdmin(ctx.user) && ea.status !== 'published') throw notFound('EA not found.');
  return ea;
}

function fields(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = text(body.name, 'Name', { min: 1, max: 80 });
  if (!partial || body.version !== undefined) out.version = text(body.version ?? '1.0', 'Version', { min: 1, max: 20 });
  if (!partial || body.description !== undefined) out.description = text(body.description ?? '', 'Description', { max: 600 });
  return out;
}

async function fileOwnerUsage(ctx, userId) {
  const r = await ctx.db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM ea_files WHERE owner_id = ?').bind(userId).first();
  return r.s;
}

export const eaRoutes = [
  // Own EAs; super admin can add ?all=1 to see everything.
  {
    method: 'GET',
    path: '/eas',
    auth: 'user',
    async handle(ctx) {
      const all = isAdmin(ctx.user) && ctx.url.searchParams.get('all') === '1';
      const { results } = all
        ? await ctx.db.prepare(`${SELECT_EA} ORDER BY e.updated_at DESC LIMIT 300`).all()
        : await ctx.db.prepare(`${SELECT_EA} WHERE e.owner_id = ? ORDER BY e.updated_at DESC LIMIT 300`).bind(ctx.user.id).all();
      return { eas: results.map((e) => eaView(e)) };
    },
  },
  // Published EAs from the catalogue, so users can hold a licence and host them.
  {
    method: 'GET',
    path: '/catalogue',
    auth: 'user',
    async handle(ctx) {
      const { results } = await ctx.db.prepare(`${SELECT_EA} WHERE e.status = 'published' ORDER BY e.name LIMIT 300`).all();
      return { eas: results.map((e) => eaView(e, { ownerEmail: undefined, ownerId: undefined })) };
    },
  },
  {
    method: 'POST',
    path: '/eas',
    auth: 'user',
    async handle(ctx) {
      const f = fields(await ctx.body());
      const count = await ctx.db.prepare('SELECT COUNT(*) AS c FROM eas WHERE owner_id = ?').bind(ctx.user.id).first();
      if (count.c >= 50) throw conflict('You have reached the limit of 50 EAs.');
      const id = newId();
      await ctx.db
        .prepare('INSERT INTO eas (id, owner_id, name, version, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.user.id, f.name, f.version, f.description, 'draft', ctx.now(), ctx.now())
        .run();
      await ctx.log('ea.create', 'ea', id, f.name);
      return { id };
    },
  },
  {
    method: 'GET',
    path: '/eas/:id',
    auth: 'user',
    async handle(ctx) {
      const ea = await loadEa(ctx);
      const mine = ea.owner_id === ctx.user.id || isAdmin(ctx.user);
      const { results } = mine
        ? await ctx.db.prepare('SELECT id, filename, size, sha256, storage, uploaded_at FROM ea_files WHERE ea_id = ? ORDER BY uploaded_at DESC').bind(ea.id).all()
        : { results: [] };
      return {
        ea: eaView(ea, mine ? {} : { ownerEmail: undefined, ownerId: undefined }),
        files: results.map((f) => ({ id: f.id, filename: f.filename, size: f.size, sha256: f.sha256, storage: f.storage, uploadedAt: f.uploaded_at })),
      };
    },
  },
  {
    method: 'PATCH',
    path: '/eas/:id',
    auth: 'user',
    async handle(ctx) {
      const ea = await loadEa(ctx, { write: true });
      const f = fields(await ctx.body(), true);
      const next = { name: ea.name, version: ea.version, description: ea.description, ...f };
      await ctx.db
        .prepare('UPDATE eas SET name = ?, version = ?, description = ?, updated_at = ? WHERE id = ?')
        .bind(next.name, next.version, next.description, ctx.now(), ea.id)
        .run();
      await ctx.log('ea.update', 'ea', ea.id, next.name);
      return {};
    },
  },
  // Only the Super Admin publishes (and unpublishes). Published EAs need a licence to be hosted by others.
  {
    method: 'POST',
    path: '/admin/eas/:id/status',
    auth: 'admin',
    async handle(ctx) {
      const body = await ctx.body();
      const status = oneOf(body.status, 'Status', ['draft', 'published']);
      const ea = await loadEa(ctx, { write: true });
      if (status === 'published' && ea.files === 0) throw conflict('Upload at least one EX5 file before publishing.');
      await ctx.db.prepare('UPDATE eas SET status = ?, updated_at = ? WHERE id = ?').bind(status, ctx.now(), ea.id).run();
      await ctx.log(status === 'published' ? 'ea.publish' : 'ea.unpublish', 'ea', ea.id, ea.name);
      if (ea.owner_id !== ctx.user.id) {
        await ctx.notify({ userId: ea.owner_id, kind: 'info', title: `EA ${status === 'published' ? 'published' : 'unpublished'}`, detail: ea.name });
      }
      return {};
    },
  },
  {
    method: 'DELETE',
    path: '/eas/:id',
    auth: 'user',
    async handle(ctx) {
      const ea = await loadEa(ctx, { write: true });
      if ((await activeSessionCount(ctx, 'ea_id = ?', ea.id)) > 0) throw conflict('Stop the hosting sessions using this EA first.');
      const { results } = await ctx.db.prepare('SELECT * FROM ea_files WHERE ea_id = ?').bind(ea.id).all();
      for (const file of results) await deleteBytes(ctx.env, file);
      await ctx.db.prepare('DELETE FROM hosting_sessions WHERE ea_id = ?').bind(ea.id).run();
      await ctx.db.prepare('DELETE FROM eas WHERE id = ?').bind(ea.id).run();
      await ctx.log('ea.delete', 'ea', ea.id, ea.name);
      return {};
    },
  },

  // Upload: raw bytes in the body, file name in ?name=
  {
    method: 'POST',
    path: '/eas/:id/files',
    auth: 'user',
    async handle(ctx) {
      const ea = await loadEa(ctx, { write: true });
      const name = checkFileName(ctx.url.searchParams.get('name'));
      const limit = maxFileBytes(ctx.env);
      const declared = Number(ctx.request.headers.get('content-length') || 0);
      if (declared > limit) throw new HttpError(413, 'too_large', `Files can be at most ${Math.floor(limit / 1048576)}MB here.`);
      const bytes = new Uint8Array(await ctx.request.arrayBuffer());
      if (bytes.length > limit) throw new HttpError(413, 'too_large', `Files can be at most ${Math.floor(limit / 1048576)}MB here.`);
      checkBytes(bytes);
      const n = await ctx.db.prepare('SELECT COUNT(*) AS c FROM ea_files WHERE ea_id = ?').bind(ea.id).first();
      if (n.c >= LIMITS.filesPerEa) throw conflict(`An EA can hold at most ${LIMITS.filesPerEa} files.`);
      if ((await fileOwnerUsage(ctx, ea.owner_id)) + bytes.length > LIMITS.userQuota) throw conflict('Storage quota reached (100MB).', 'quota');
      const id = newId();
      const sha = await sha256Hex(bytes);
      // Row first (chunks reference it), then bytes; clean up if storing fails.
      await ctx.db
        .prepare('INSERT INTO ea_files (id, ea_id, owner_id, filename, size, sha256, storage, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ea.id, ea.owner_id, name, bytes.length, sha, storageKind(ctx.env), ctx.now())
        .run();
      try {
        await putBytes(ctx.env, ctx.db, id, bytes);
      } catch (err) {
        await ctx.db.prepare('DELETE FROM ea_files WHERE id = ?').bind(id).run();
        throw err;
      }
      await ctx.db.prepare('UPDATE eas SET updated_at = ? WHERE id = ?').bind(ctx.now(), ea.id).run();
      await ctx.log('file.upload', 'file', id, `${name} (${bytes.length} bytes) for ${ea.name}`);
      return { id, filename: name, size: bytes.length, sha256: sha };
    },
  },
  {
    method: 'GET',
    path: '/files/:id/download',
    auth: 'user',
    async handle(ctx) {
      const file = await ctx.db.prepare('SELECT * FROM ea_files WHERE id = ?').bind(ctx.params.id).first();
      if (!file || (file.owner_id !== ctx.user.id && !isAdmin(ctx.user))) throw notFound('File not found.');
      const bytes = await getBytes(ctx.env, ctx.db, file);
      await ctx.log('file.download', 'file', file.id, file.filename);
      return new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${file.filename.replace(/"/g, '')}"`,
        },
      });
    },
  },
  {
    method: 'DELETE',
    path: '/files/:id',
    auth: 'user',
    async handle(ctx) {
      const file = await ctx.db.prepare('SELECT * FROM ea_files WHERE id = ?').bind(ctx.params.id).first();
      if (!file || (file.owner_id !== ctx.user.id && !isAdmin(ctx.user))) throw notFound('File not found.');
      if ((await activeSessionCount(ctx, 'file_id = ?', file.id)) > 0) throw conflict('Stop the hosting session using this file first.');
      await deleteBytes(ctx.env, file);
      await ctx.db.prepare('DELETE FROM hosting_sessions WHERE file_id = ?').bind(file.id).run();
      await ctx.db.prepare('DELETE FROM ea_files WHERE id = ?').bind(file.id).run();
      await ctx.log('file.delete', 'file', file.id, file.filename);
      return {};
    },
  },
  // Super Admin file overview.
  {
    method: 'GET',
    path: '/admin/files',
    auth: 'admin',
    async handle(ctx) {
      const { results } = await ctx.db
        .prepare(
          `SELECT f.id, f.filename, f.size, f.sha256, f.storage, f.uploaded_at, e.name AS ea_name, u.email AS owner_email
             FROM ea_files f JOIN eas e ON e.id = f.ea_id JOIN users u ON u.id = f.owner_id
            ORDER BY f.uploaded_at DESC LIMIT 300`,
        )
        .all();
      const total = await ctx.db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM ea_files').first();
      return {
        totalBytes: total.s,
        files: results.map((f) => ({ id: f.id, filename: f.filename, size: f.size, sha256: f.sha256, storage: f.storage, uploadedAt: f.uploaded_at, eaName: f.ea_name, ownerEmail: f.owner_email })),
      };
    },
  },
];
