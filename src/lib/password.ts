import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Personal passwords: scrypt from node:crypto, stored as
//   scrypt$<log2 N>$<r>$<p>$<salt b64url>$<key b64url>
// so the cost can be raised later; verifyPassword flags hashes made with
// older parameters (needsRehash) so the sign-in can upgrade them.

const LOG_N = 15; // N = 32768 — roughly 50–100 ms on a Netlify function
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;

function derive(pw: string, salt: Buffer, logN: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw.normalize('NFKC'), salt, keyLen, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(pw, salt, LOG_N, R, P, KEY_LEN);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Checked when there is no real hash (unknown email, no password yet) so the
// response takes as long as a real miss and doesn't reveal which emails exist.
const DUMMY_HASH = `scrypt$${LOG_N}$${R}$${P}$${Buffer.alloc(SALT_LEN, 7).toString('base64url')}$${Buffer.alloc(KEY_LEN, 9).toString('base64url')}`;

interface Parsed {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  // Refuse absurd parameters rather than burning the function's time/memory
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (!salt.length || key.length < 16) return null;
  return { logN, r, p, salt, key };
}

export async function verifyPassword(
  pw: string,
  stored: string | null
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const real = stored ? parse(stored) : null;
  const h = real ?? (parse(DUMMY_HASH) as Parsed);
  let key: Buffer;
  try {
    key = await derive(pw, h.salt, h.logN, h.r, h.p, h.key.length);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const match = key.length === h.key.length && timingSafeEqual(key, h.key);
  if (!real || !match) return { ok: false, needsRehash: false };
  const needsRehash = h.logN !== LOG_N || h.r !== R || h.p !== P || h.key.length !== KEY_LEN || h.salt.length !== SALT_LEN;
  return { ok: true, needsRehash };
}

// Very common passwords that meet the length rule; compared case-insensitively.
const COMMON = new Set([
  '123456789012', '1234567890123', '12345678901234', '123456789123', '111111111111', '000000000000',
  'password1234', 'password12345', 'password123!', 'password2024', 'password2025', 'password2026',
  'passwordpassword', 'qwertyuiopas', 'qwerty123456', 'qwertyuiop12', 'qwertyqwerty', 'asdfghjkl123',
  'iloveyou1234', 'letmein12345', 'welcome12345', 'welcome123456', 'changeme1234', 'abc123456789',
  'abcdefghijkl', 'administrator', 'aaaaaaaaaaaa', 'football1234', 'baseball1234', 'princess1234',
  'sunshine1234', 'trustno1trustno1', 'monkey123456', 'dragon123456', 'master123456', 'flammard1234',
]);

/** Why a new password is unacceptable, or null if it's fine. */
export function passwordProblem(pw: string, email?: string | null): string | null {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  const lower = pw.toLowerCase();
  if (email && lower.trim() === email.toLowerCase().trim()) return "Don't use your email address as your password.";
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw)) return 'That password is too common. Choose something less guessable.';
  return null;
}

/** SHA-256 hex of a setup/reset token — the only form stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh one-time token (32 random bytes, base64url) and its hash. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
