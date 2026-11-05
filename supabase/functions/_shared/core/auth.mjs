// Sign-in: scrypt password hashes, sign-in tokens kept only as a SHA-256 hash, and a 15-minute lock after 8 wrong passwords.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_DAYS = 7;
const LOCK_AFTER = 8, LOCK_MS = 15 * 60000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(hash, want);
}
export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'The password must be at least 8 characters.';
  if (p.length > 200) return 'The password is too long.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'The password must contain letters and numbers.';
  return null;
}
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export const newId = () => crypto.randomBytes(9).toString('base64url');

export function createAuth(db, now) {
  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.q('INSERT INTO sp_sessions (token, user_id, expires) VALUES ($1, $2, $3)', [sha(token), userId, now() + SESSION_DAYS * 86400000]);
    return token;
  }
  const endSession = token => token && db.q('DELETE FROM sp_sessions WHERE token = $1', [sha(token)]);
  const endAllSessions = (userId, keepToken) => keepToken
    ? db.q('DELETE FROM sp_sessions WHERE user_id = $1 AND token <> $2', [userId, sha(keepToken)])
    : db.q('DELETE FROM sp_sessions WHERE user_id = $1', [userId]);
  async function sessionUser(token) {
    if (!token) return null;
    const row = await db.one('SELECT user_id, expires FROM sp_sessions WHERE token = $1', [sha(token)]);
    if (!row) return null;
    if (Number(row.expires) < now()) { await endSession(token); return null; }
    const u = await db.one('SELECT * FROM sp_users WHERE id = $1', [row.user_id]);
    return u && Number(u.active) ? u : null;
  }

  const lockedUntil = async key => { const f = await db.one('SELECT until FROM sp_failures WHERE key = $1', [key]); return f ? Number(f.until) : 0; };
  async function recordFailure(key) {
    const f = await db.one('SELECT count, until FROM sp_failures WHERE key = $1', [key]);
    let count = (f ? Number(f.count) : 0) + 1, until = f ? Number(f.until) : 0;
    if (count >= LOCK_AFTER) { until = now() + LOCK_MS; count = 0; }
    await db.q('INSERT INTO sp_failures (key, count, until) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET count = excluded.count, until = excluded.until', [key, count, until]);
  }

  async function login(email, password, ip) {
    const keys = [`e:${String(email || '').trim().toLowerCase()}`, `ip:${ip || '?'}`];
    for (const k of keys) if (await lockedUntil(k) > now()) return { error: 'Too many wrong attempts. Try again in 15 minutes.', status: 429 };
    const u = await db.one('SELECT * FROM sp_users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
    const ok = u && Number(u.active) && checkPassword(password, u.pass);
    if (!ok) { for (const k of keys) await recordFailure(k); return { error: 'Wrong email or password.', status: 401 }; }
    for (const k of keys) await db.q('DELETE FROM sp_failures WHERE key = $1', [k]);
    await db.q('DELETE FROM sp_sessions WHERE expires < $1', [now()]);
    return { token: await createSession(u.id), user: u };
  }

  return { createSession, endSession, endAllSessions, sessionUser, login, checkPassword };
}
