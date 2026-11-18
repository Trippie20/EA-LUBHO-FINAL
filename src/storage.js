// Private EX5 storage. Bytes live in R2 when the FILES binding exists, otherwise in D1 as
// base64 chunks. Neither is publicly reachable: files are only served by authenticated routes.

import { HttpError, toBase64, fromBase64 } from './util.js';

const CHUNK_RAW = 384 * 1024; // 384KB raw -> 512KB base64 per row
export const LIMITS = {
  d1Bytes: 3 * 1024 * 1024,
  r2Bytes: 20 * 1024 * 1024,
  filesPerEa: 20,
  userQuota: 100 * 1024 * 1024,
};

export const maxFileBytes = (env) => (env.FILES ? LIMITS.r2Bytes : LIMITS.d1Bytes);
export const storageKind = (env) => (env.FILES ? 'r2' : 'd1');

export function checkFileName(name) {
  const clean = String(name ?? '').trim();
  if (!/^[\w][\w .()+-]{0,98}\.ex5$/i.test(clean)) {
    throw new HttpError(400, 'bad_filename', 'The file name must end in .ex5 and use only letters, numbers, spaces and . _ - ( ) +');
  }
  return clean;
}

// Basic sanity only. This is NOT a virus scan: it rejects obvious non-EX5 uploads.
export function checkBytes(bytes) {
  if (bytes.length < 16) throw new HttpError(400, 'bad_file', 'That file is empty or too small to be an EX5.');
  const b0 = bytes[0], b1 = bytes[1];
  const looksLikeExe = b0 === 0x4d && b1 === 0x5a; // MZ
  const looksLikeScript = (b0 === 0x23 && b1 === 0x21) || b0 === 0x3c; // #! or <
  if (looksLikeExe || looksLikeScript) {
    throw new HttpError(400, 'bad_file', 'That file does not look like a compiled EX5.');
  }
}

export async function putBytes(env, db, fileId, bytes) {
  if (env.FILES) {
    await env.FILES.put(`ex5/${fileId}`, bytes);
    return 'r2';
  }
  const b64 = toBase64(bytes);
  const size = 512 * 1024;
  let idx = 0;
  for (let i = 0; i < b64.length; i += size) {
    await db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(fileId, idx++, b64.slice(i, i + size)).run();
  }
  return 'd1';
}

export async function getBytes(env, db, file) {
  if (file.storage === 'r2') {
    if (!env.FILES) throw new HttpError(500, 'not_configured', 'This file is stored in R2 but the FILES binding is missing.');
    const obj = await env.FILES.get(`ex5/${file.id}`);
    if (!obj) throw new HttpError(404, 'not_found', 'The stored file is missing.');
    return new Uint8Array(await obj.arrayBuffer());
  }
  const { results } = await db.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx').bind(file.id).all();
  if (!results.length) throw new HttpError(404, 'not_found', 'The stored file is missing.');
  return fromBase64(results.map((r) => r.data).join(''));
}

export async function deleteBytes(env, file) {
  if (file.storage === 'r2' && env.FILES) await env.FILES.delete(`ex5/${file.id}`);
  // D1 chunks are removed by ON DELETE CASCADE.
}
