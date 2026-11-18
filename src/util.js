// Shared helpers: errors, encoding, hashing, password hashing and credential encryption.
// Only Web APIs are used so the same code runs on Cloudflare Workers and in Node tests.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const badRequest = (message, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

// ---------- encoding ----------
export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- hashing and randomness ----------
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}
export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
export const newId = () => randomHex(8);

// Compare two strings without leaking where they differ.
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- passwords ----------
// Cloudflare Workers allow at most 100,000 PBKDF2 iterations, so that is the default.
// The iteration count is stored per user so it can be raised later.
export const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password, iter = PBKDF2_ITERATIONS, saltHex = null) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { pw_hash: toHex(bits), pw_salt: toHex(salt), pw_iter: iter };
}

export async function verifyPassword(password, record) {
  const { pw_hash } = await hashPassword(password, record.pw_iter, record.pw_salt);
  return safeEqual(pw_hash, record.pw_hash);
}

// ---------- credential encryption (AES-256-GCM) ----------
// CREDENTIAL_KEY is a Cloudflare secret holding 32 random bytes, base64 encoded.
// `aad` binds a ciphertext to its record so it cannot be swapped to another account.
async function credentialKey(env) {
  if (!env.CREDENTIAL_KEY) {
    throw new HttpError(500, 'not_configured', 'The CREDENTIAL_KEY secret is not set on the server.');
  }
  let bytes;
  try {
    bytes = fromBase64(env.CREDENTIAL_KEY);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes.length !== 32) {
    throw new HttpError(500, 'not_configured', 'CREDENTIAL_KEY must be 32 random bytes, base64 encoded.');
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env, plaintext, aad) {
  const key = await credentialKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext));
  return { ct: toBase64(ct), iv: toBase64(iv) };
}

export async function decryptSecret(env, { ct, iv }, aad) {
  const key = await credentialKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(aad) },
    key,
    fromBase64(ct),
  );
  return dec.decode(plain);
}

// ---------- validation ----------
export function text(value, name, { min = 0, max = 200, pattern = null, patternMessage = null } = {}) {
  const s = String(value ?? '').trim();
  if (s.length < min) throw badRequest(min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (s.length > max) throw badRequest(`${name} must be at most ${max} characters.`);
  if (pattern && s && !pattern.test(s)) throw badRequest(patternMessage || `${name} is not valid.`);
  return s;
}

export function integer(value, name, { min, max, optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function oneOf(value, name, allowed) {
  if (!allowed.includes(value)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(value) {
  const e = String(value ?? '').trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) throw badRequest('Enter a valid email address.');
  return e;
}

export function password(value, name = 'Password') {
  const p = String(value ?? '');
  if (p.length < 10) throw badRequest(`${name} must be at least 10 characters.`);
  if (p.length > 200) throw badRequest(`${name} is too long.`);
  return p;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
