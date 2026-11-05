// The Sponsor Management server, written once and run in two places:
//   - Supabase Edge Function (Deno + Postgres)  -> supabase/functions/sponsors/index.ts
//   - a normal computer (Node + SQLite)         -> server.js
// handle(Request) -> Response, with standard web Request/Response objects.
// Every rule (who may see what, one club per sponsor, the 14-day clock) is checked here, never only in the browser.
import { createDb, ensureSchema, isUniqueError } from './db.mjs';
import { createAuth, hashPassword, passwordProblem, newId } from './auth.mjs';
import { normName, possibleMatch, parseInstagram } from './match.mjs';
import { addLocalDays, localDate, localDayStart, isDate } from './time.mjs';
import { seedBasics, seedDemo, syncClubs, DEMO_PASSWORD } from './setup.mjs';

export const RESERVE_DAYS = 14;
const WARN_DAYS = [3, 1];   // in-site reminders this many days before a reservation ends
const DAY = 86400000;
export const STATUS = {
  reserved: 'Reserved', contacted: 'Contacted', negotiation: 'In Negotiation', confirmed: 'Confirmed',
  pending_review: 'Pending SAO Review', rejected: 'Rejected', released: 'Released', expired: 'Expired',
};
const ACTIVE = ['reserved', 'contacted', 'negotiation', 'confirmed', 'pending_review'];
const WORKING = ['reserved', 'contacted', 'negotiation', 'confirmed'];
// What a club may move a claim to from each status
const NEXT = {
  reserved: ['contacted', 'negotiation', 'confirmed', 'rejected', 'released'],
  contacted: ['negotiation', 'confirmed', 'rejected', 'released'],
  negotiation: ['confirmed', 'rejected', 'released'],
  confirmed: ['rejected', 'released'],
  pending_review: ['released'],
};
const UNAVAILABLE = 'This sponsor is currently unavailable.';
const DENIED = 'Access denied.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Max-Age': '86400',
};
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
const respond = (status, body, type = 'application/json; charset=utf-8') => new Response(type.startsWith('application/json') ? JSON.stringify(body) : body,
  { status, headers: { ...CORS, ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-store' } });

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
// A reply that still saves what was done (for example a wrong password counts towards the lock)
class Reply { constructor(status, body) { this.status = status; this.body = body; } }

const str = (v, max = 200) => (typeof v === 'string' ? v.trim() : '').slice(0, max);
const need = (v, label, min = 1, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) fail(400, `${label} is required.`);
  if (s.length > max) fail(400, `${label} is too long (at most ${max} characters).`);
  return s;
};
const reasonOf = v => need(v, 'A reason', 3, 500);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Simple per-person limits for searching and signing in (kept in memory)
const hits = new Map();
function rateLimit(key, max, windowMs, now) {
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); if (hits.size > 5000) hits.clear(); return; }
  if (++h.count > max) fail(429, 'Too many requests. Wait a minute and try again.');
}

/**
 * driver      database driver (see db.mjs)
 * now         clock (tests move it forward)
 * allowSetup  whether the first SAO Head account can be created from the website
 * setupCode   if set, the first-time setup form must be given this code
 */
export function createApp({ driver, now = () => Date.now(), allowSetup = true, setupCode = '' }) {
  const db = createDb(driver);
  const auth = createAuth(db, now);
  const { q, one } = db;

  let schemaP = null;
  const ready = () => (schemaP ||= ensureSchema(driver).then(() => db.tx(() => syncClubs(db))).catch(e => { schemaP = null; throw e; }));
  // A club's logo: a built-in picture (assets/clubs/...) or one SAO uploaded (served by /api/clubs/:id/logo)
  const CLUB_COLS = 'id, name, active, logo, logo_v, CASE WHEN logo_data IS NULL THEN 0 ELSE 1 END AS uploaded';
  const clubOut = c => ({ id: c.id, name: c.name, active: !!Number(c.active), logo: Number(c.uploaded) ? null : c.logo || null,
    logoApi: Number(c.uploaded) ? `/api/clubs/${c.id}/logo?v=${Number(c.logo_v) || 0}` : null });

  // ---------- small helpers ----------
  const audit = (actor, action, record, before, after, reason = null) => q(
    'INSERT INTO sp_audit (id, at, actor_id, action, record, before_value, after_value, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [newId(), now(), actor?.id || null, action, record, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), reason]);
  const event = (claimId, actor, kind, from, to, text) => q(
    'INSERT INTO sp_events (id, claim_id, at, actor_id, kind, from_status, to_status, text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [newId(), claimId, now(), actor?.id || null, kind, from || null, to || null, text || null]);
  async function notifyClub(clubId, text, link) {
    const reps = await q("SELECT id FROM sp_users WHERE club_id = $1 AND role = 'rep' AND active = 1", [clubId]);
    for (const r of reps) await q('INSERT INTO sp_notices (id, user_id, at, text, link, seen) VALUES ($1, $2, $3, $4, $5, 0)', [newId(), r.id, now(), text, link || null]);
  }
  const MAX_ACTIVE = 20;   // default: sponsors a club may hold at once (SAO can change it in Admin > Rules)
  const settings = async () => ({ stallDays: Number(await db.meta('stall_days')) || 30, maxActive: Number(await db.meta('max_active')) || MAX_ACTIVE });
  const activeCount = async clubId => Number((await one('SELECT COUNT(*) AS n FROM sp_claims WHERE club_id = $1 AND active = 1', [clubId]))?.n || 0);

  // ---------- the clock: end reservations with no contact after 14 days, and send reminders ----------
  async function sweep() {
    const t = now();
    const due = await q(`SELECT c.id, c.club_id, s.name FROM sp_claims c JOIN sp_sponsors s ON s.id = c.sponsor_id
      WHERE c.status = 'reserved' AND c.expires_at <= $1`, [t]);
    for (const c of due) {
      await q(`UPDATE sp_claims SET status = 'expired', active = 0, closed_at = $1, close_reason = $2 WHERE id = $3 AND status = 'reserved'`,
        [t, `No contact logged within ${RESERVE_DAYS} days`, c.id]);
      await event(c.id, null, 'expired', 'reserved', 'expired', `Reservation ended: no contact logged within ${RESERVE_DAYS} days. The sponsor is free again.`);
      await audit(null, 'claim.expire', `claim:${c.id}`, { status: 'reserved' }, { status: 'expired' });
      await notifyClub(c.club_id, `Your reservation for ${c.name} has ended and the sponsor was released (no contact logged in ${RESERVE_DAYS} days).`, `#/claim/${c.id}`);
    }
    for (let level = 0; level < WARN_DAYS.length; level++) {
      const days = WARN_DAYS[level];
      const soon = await q(`SELECT c.id, c.club_id, c.expires_at, s.name FROM sp_claims c JOIN sp_sponsors s ON s.id = c.sponsor_id
        WHERE c.status = 'reserved' AND c.expires_at <= $1 AND c.warned < $2`, [t + days * DAY, level + 1]);
      for (const c of soon) {
        await q('UPDATE sp_claims SET warned = $1 WHERE id = $2', [level + 1, c.id]);
        const left = Math.max(1, Math.ceil((Number(c.expires_at) - t) / DAY));
        await notifyClub(c.club_id, `${c.name}: your reservation ends in ${left} day${left === 1 ? '' : 's'} unless you log a contact.`, `#/claim/${c.id}`);
      }
    }
    return due.length;
  }

  // ---------- reading claims ----------
  const CLAIM_SELECT = `SELECT c.*, s.name AS sponsor_name, s.ig_handle, s.category_id, s.state AS sponsor_state, k.name AS category_name, cl.name AS club_name
    FROM sp_claims c JOIN sp_sponsors s ON s.id = c.sponsor_id LEFT JOIN sp_categories k ON k.id = s.category_id LEFT JOIN sp_clubs cl ON cl.id = c.club_id`;
  async function claimView(c, user) {
    const stallDays = (await settings()).stallDays;
    return {
      id: c.id, sponsorId: c.sponsor_id, sponsor: c.sponsor_name, instagram: c.ig_handle || null,
      categoryId: c.category_id, category: c.category_name || '', clubId: c.club_id,
      club: user.role === 'sao' || c.club_id === user.club_id ? c.club_name : undefined,
      status: c.status, statusLabel: STATUS[c.status], active: !!Number(c.active),
      reservedAt: num(c.reserved_at), expiresAt: num(c.expires_at), firstContact: c.first_contact || null,
      lastActivityAt: num(c.last_activity_at), notes: c.notes || '', createdAt: num(c.created_at),
      closedAt: num(c.closed_at), closeReason: c.close_reason || null,
      stalled: ['contacted', 'negotiation'].includes(c.status) && Number(c.last_activity_at) < now() - stallDays * DAY,
      next: user.role === 'sao' ? (Number(c.active) && c.status !== 'pending_review' ? Object.keys(STATUS).filter(s => s !== c.status && s !== 'pending_review' && s !== 'expired') : [])
        : (Number(c.active) ? NEXT[c.status] || [] : []),
    };
  }
  const num = v => v == null ? null : Number(v);

  // A club user may only ever load their own club's claims. Unknown ids get the same answer, so nothing leaks.
  async function claimFor(user, id) {
    const c = await one(CLAIM_SELECT + ' WHERE c.id = $1', [String(id)]);
    if (!c || (user.role !== 'sao' && c.club_id !== user.club_id)) fail(403, DENIED);
    return c;
  }

  // Filters shared by the claims list and the CSV export
  function claimFilter(user, p) {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
    if (user.role !== 'sao') add('c.club_id = ?', user.club_id);
    else if (p.get('club')) add('c.club_id = ?', p.get('club'));
    const st = p.get('status');
    if (st === 'active') where.push(`c.active = 1`);
    else if (st === 'closed') where.push(`c.active = 0`);
    else if (st === 'stalled') { where.push(`c.status IN ('contacted', 'negotiation')`); args.push(now() - (p._stall || 30) * DAY); where.push(`c.last_activity_at < $${args.length}`); }
    else if (st === 'expiring') { where.push(`c.status = 'reserved'`); args.push(now() + 3 * DAY); where.push(`c.expires_at <= $${args.length}`); }
    else if (STATUS[st]) add('c.status = ?', st);
    if (p.get('category')) add('s.category_id = ?', p.get('category'));
    if (isDate(p.get('from'))) add('c.created_at >= ?', localDayStart(p.get('from')));
    if (isDate(p.get('to'))) add('c.created_at < ?', localDayStart(p.get('to')) + DAY);
    const term = normName(p.get('q') || '');
    if (term) add('s.norm_name LIKE ?', `%${term}%`);
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
  }
  async function listClaims(user, p) {
    p._stall = (await settings()).stallDays;
    const { sql, args } = claimFilter(user, p);
    const rows = await q(CLAIM_SELECT + sql + ' ORDER BY c.active DESC, c.last_activity_at DESC LIMIT 2000', args);
    return Promise.all(rows.map(r => claimView(r, user)));
  }

  // ---------- sponsors: matching ----------
  async function findExact(name, handle) {
    const n = normName(name);
    const byName = n && (await one(`SELECT * FROM sp_sponsors WHERE state = 'active' AND norm_name = $1`, [n])
      || await one(`SELECT s.* FROM sp_aliases a JOIN sp_sponsors s ON s.id = a.sponsor_id WHERE s.state = 'active' AND a.norm_name = $1`, [n]));
    const byIg = handle ? await one(`SELECT * FROM sp_sponsors WHERE state = 'active' AND ig_handle = $1`, [handle]) : null;
    return { byName: byName || null, byIg };
  }
  async function allNames() {
    const s = await q(`SELECT s.id, s.name, s.ig_handle, s.category_id, k.name AS category_name,
      (SELECT c.club_id FROM sp_claims c WHERE c.sponsor_id = s.id AND c.active = 1) AS holder
      FROM sp_sponsors s LEFT JOIN sp_categories k ON k.id = s.category_id WHERE s.state = 'active'`);
    const aliases = await q(`SELECT a.sponsor_id, a.name FROM sp_aliases a JOIN sp_sponsors s ON s.id = a.sponsor_id WHERE s.state = 'active'`);
    const by = Object.fromEntries(s.map(x => [x.id, { ...x, aliases: [] }]));
    for (const a of aliases) by[a.sponsor_id]?.aliases.push(a.name);
    return Object.values(by);
  }
  async function possibleMatches(name, exceptId) {
    const out = [];
    for (const s of await allNames()) {
      if (s.id === exceptId) continue;
      const why = [s.name, ...s.aliases].map(n => possibleMatch(name, n)).find(Boolean);
      if (why) out.push({ id: s.id, name: s.name, reason: why });
    }
    return out;
  }
  const activeClaimOn = sponsorId => one('SELECT * FROM sp_claims WHERE sponsor_id = $1 AND active = 1', [sponsorId]);

  async function newClaim({ sponsorId, clubId, status, actor, notes, firstContact = null, text }) {
    const id = newId(), t = now();
    const reserved = status === 'reserved';
    try {
      await q(`INSERT INTO sp_claims (id, sponsor_id, club_id, status, active, reserved_at, expires_at, first_contact, last_activity_at, notes,
        created_by, created_at, warned) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, 0)`,
        [id, sponsorId, clubId, status, status === 'pending_review' ? null : t, reserved ? addLocalDays(t, RESERVE_DAYS) : null,
          firstContact, t, notes || null, actor?.id || null, t]);
    } catch (e) { if (isUniqueError(e)) fail(409, UNAVAILABLE, { code: 'unavailable' }); throw e; }
    await event(id, actor, status === 'pending_review' ? 'held' : 'reserved', null, status, text);
    return id;
  }
  async function newSponsor({ name, categoryId, handle, actor }) {
    const id = newId();
    try {
      await q('INSERT INTO sp_sponsors (id, name, norm_name, category_id, ig_handle, state, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, name, normName(name), categoryId, handle || null, 'active', now(), actor.id]);
    } catch (e) { if (isUniqueError(e)) fail(409, UNAVAILABLE, { code: 'unavailable' }); throw e; }
    await audit(actor, 'sponsor.create', `sponsor:${id}`, null, { name, categoryId, instagram: handle || null });
    return id;
  }
  // keepName: SAO is about to assign this same sponsor, so a look-alike name it created stays in the registry
  async function closeClaim(c, status, reason, actor, text, { keepName = false } = {}) {
    await q('UPDATE sp_claims SET status = $1, active = 0, closed_at = $2, close_reason = $3, last_activity_at = $2 WHERE id = $4',
      [status, now(), reason, c.id]);
    await event(c.id, actor, status, c.status, status, text || reason);
    if (c.status === 'pending_review') {
      // A look-alike name that was never approved leaves the registry, so the next club typing it is checked again
      // (otherwise it would match this leftover record exactly and skip SAO's review).
      const rv = await one(`SELECT detail, sponsor_id FROM sp_reviews WHERE claim_id = $1 AND state = 'open' AND kind = 'duplicate'`, [c.id]);
      const provisional = rv && !(rv.detail && JSON.parse(rv.detail).conflict) && rv.sponsor_id === c.sponsor_id;
      const others = Number((await one('SELECT COUNT(*) AS n FROM sp_claims WHERE sponsor_id = $1 AND id <> $2', [c.sponsor_id, c.id]))?.n || 0);
      if (provisional && !others && !keepName) await q(`UPDATE sp_sponsors SET state = 'rejected' WHERE id = $1 AND state = 'active'`, [c.sponsor_id]);
      await q(`UPDATE sp_reviews SET state = 'closed', resolved_at = $1, resolved_by = $2, resolution = 'closed', reason = $3
        WHERE claim_id = $4 AND state = 'open'`, [now(), actor?.id || null, reason, c.id]);
    }
  }

  // Put sponsor `fromId` into `toId`: its name becomes another name of the target, and its history moves there
  async function mergeSponsor(fromId, toId, actor, reason) {
    const from = await one('SELECT * FROM sp_sponsors WHERE id = $1', [fromId]);
    const to = await one(`SELECT * FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [toId]);
    if (!from || !to || from.id === to.id) fail(400, 'Choose two different sponsors.');
    await q(`UPDATE sp_sponsors SET state = 'merged', merged_into = $1 WHERE id = $2`, [to.id, from.id]);
    await q('UPDATE sp_aliases SET sponsor_id = $1 WHERE sponsor_id = $2', [to.id, from.id]);
    if (from.norm_name !== to.norm_name && !(await one('SELECT id FROM sp_aliases WHERE norm_name = $1', [from.norm_name])))
      await q('INSERT INTO sp_aliases (id, sponsor_id, name, norm_name) VALUES ($1, $2, $3, $4)', [newId(), to.id, from.name, from.norm_name]);
    if (from.ig_handle && !to.ig_handle) await q('UPDATE sp_sponsors SET ig_handle = $1 WHERE id = $2', [from.ig_handle, to.id]);
    await q('UPDATE sp_claims SET sponsor_id = $1 WHERE sponsor_id = $2 AND active = 0', [to.id, from.id]);
    await audit(actor, 'sponsor.merge', `sponsor:${to.id}`, { merged: from.name }, { into: to.name }, reason);
    return to;
  }

  // ---------- routes ----------
  const routes = [];
  const on = (method, path, role, fn) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn });

  // --- session & sign-in ---
  on('GET', '/api/session', 'none', async ({ user }) => {
    const count = Number((await one('SELECT COUNT(*) AS n FROM sp_users'))?.n || 0);
    if (!count) return { needsSetup: allowSetup, setupDisabled: !allowSetup, setupNeedsCode: !!setupCode };
    if (!user) {
      const demo = (await db.meta('demo')) === '1';
      return { user: null, demo: demo ? { password: DEMO_PASSWORD, accounts: (await q(`SELECT email, name FROM sp_users WHERE email LIKE '%@demo.local' ORDER BY name LIMIT 30`)) } : null };
    }
    const clubs = user.role === 'sao' ? await q(`SELECT ${CLUB_COLS} FROM sp_clubs ORDER BY sort, name`)
      : await q(`SELECT ${CLUB_COLS} FROM sp_clubs WHERE id = $1`, [user.club_id]);
    const categories = await q(`SELECT id, name, active FROM sp_categories ${user.role === 'sao' ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
    const unread = Number((await one('SELECT COUNT(*) AS n FROM sp_notices WHERE user_id = $1 AND seen = 0', [user.id]))?.n || 0);
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, clubId: user.club_id, mustChange: !!Number(user.must_change) },
      clubs: clubs.map(clubOut), categories: categories.map(c => ({ ...c, active: !!Number(c.active) })),
      statuses: STATUS, reserveDays: RESERVE_DAYS, settings: await settings(), unread, today: localDate(now()),
      // SAO: how many review items wait, for the count on the Reviews menu
      openReviews: user.role === 'sao' ? Number((await one(`SELECT COUNT(*) AS n FROM sp_reviews WHERE state = 'open'`))?.n || 0) : undefined,
    };
  });

  on('POST', '/api/setup', 'none', async ({ body }) => {
    if (!allowSetup) fail(403, 'Setup is turned off on this server.');
    if (Number((await one('SELECT COUNT(*) AS n FROM sp_users'))?.n || 0)) fail(409, 'This site is already set up.');
    if (setupCode && body.code !== setupCode) fail(403, 'The setup code is not right.');
    const name = need(body.name, 'Your name', 2, 100), email = need(body.email, 'Email', 3, 200).toLowerCase();
    if (!emailOk(email)) fail(400, 'Enter a valid email address.');
    const p = passwordProblem(body.password); if (p) fail(400, p);
    await seedBasics(db);
    const id = newId();
    await q('INSERT INTO sp_users (id, email, name, role, club_id, pass, active, must_change, created_at) VALUES ($1, $2, $3, $4, NULL, $5, 1, 0, $6)',
      [id, email, name, 'sao', hashPassword(body.password), now()]);
    if (body.demo) await seedDemo(db, now);
    await audit({ id }, 'setup', 'site', null, { demo: !!body.demo });
    return { token: await auth.createSession(id) };
  });

  on('POST', '/api/login', 'none', async ({ body, ip }) => {
    rateLimit(`login:${ip}`, 30, 60000, now());
    const r = await auth.login(body.email, body.password, ip);
    if (r.error) return new Reply(r.status, { error: r.error });
    await audit(r.user, 'login', `user:${r.user.id}`);
    return { token: r.token };
  });
  on('POST', '/api/logout', 'any', async ({ token }) => { await auth.endSession(token); return { ok: true }; });
  on('POST', '/api/password', 'any', async ({ user, body, token }) => {
    if (!auth.checkPassword(body.current, user.pass)) fail(400, 'Your current password is not right.');
    const p = passwordProblem(body.next); if (p) fail(400, p);
    if (body.next === body.current) fail(400, 'Choose a new password that is different from the current one.');
    await q('UPDATE sp_users SET pass = $1, must_change = 0 WHERE id = $2', [hashPassword(body.next), user.id]);
    await auth.endAllSessions(user.id, token);
    await audit(user, 'user.password', `user:${user.id}`);
    return { ok: true };
  });

  // Called every hour by GitHub Actions too, so reservations end on time even when nobody is using the site
  on('POST', '/api/tick', 'none', async () => ({ expired: await sweep() }));
  on('GET', '/api/tick', 'none', async () => ({ expired: await sweep() }));

  // --- notices ---
  on('GET', '/api/notices', 'any', async ({ user }) => (await q('SELECT id, at, text, link, seen FROM sp_notices WHERE user_id = $1 ORDER BY at DESC LIMIT 40', [user.id]))
    .map(n => ({ ...n, at: Number(n.at), seen: !!Number(n.seen) })));
  on('POST', '/api/notices/seen', 'any', async ({ user }) => { await q('UPDATE sp_notices SET seen = 1 WHERE user_id = $1', [user.id]); return { ok: true }; });

  // --- sponsor search (live suggestions while typing). Clubs only learn "available" or "unavailable". ---
  on('GET', '/api/sponsors/search', 'any', async ({ user, params }) => {
    rateLimit(`search:${user.id}`, 120, 60000, now());
    const raw = str(params.get('q'), 100), n = normName(raw), ig = raw.startsWith('@') || /instagram\.com/i.test(raw) ? parseInstagram(raw).handle : null;
    if (!n && !ig) return [];
    const clubs = user.role === 'sao' ? Object.fromEntries((await q('SELECT id, name FROM sp_clubs')).map(c => [c.id, c.name])) : {};
    const scored = [];
    for (const s of await allNames()) {
      const names = [s.name, ...s.aliases];
      let score = 0;
      if (ig && s.ig_handle === ig) score = 100;
      for (const nm of names) {
        const nn = normName(nm);
        if (nn === n) score = Math.max(score, 90);
        else if (n.length >= 1 && nn.startsWith(n)) score = Math.max(score, 70);
        else if (n.length >= 2 && nn.includes(n)) score = Math.max(score, 50);
        else if (n.length >= 3 && possibleMatch(raw, nm)) score = Math.max(score, 40);
      }
      if (score) scored.push({ score, s });
    }
    scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    return scored.slice(0, 8).map(({ s }) => ({
      id: s.id, name: s.name, category: s.category_name || '', categoryId: s.category_id, instagram: s.ig_handle || null,
      available: !s.holder, mine: !!s.holder && s.holder === user.club_id,
      ...(user.role === 'sao' ? { holder: s.holder ? clubs[s.holder] : null } : {}),
    }));
  });

  // --- claims ---
  on('GET', '/api/claims', 'any', ({ user, params }) => listClaims(user, params));

  on('POST', '/api/claims', 'any', async ({ user, body }) => {
    if (user.role !== 'rep') fail(403, 'Only club representatives add sponsors for their club. SAO can assign a sponsor from its page.');
    rateLimit(`claim:${user.id}`, 30, 60000, now());
    const club = await one('SELECT * FROM sp_clubs WHERE id = $1 AND active = 1', [user.club_id]);
    if (!club) fail(403, 'Your account is not linked to an active club. Ask SAO.');
    // Each club may hold a limited number of sponsors at once (all active statuses count, including Pending SAO Review)
    const { maxActive } = await settings();
    if (await activeCount(club.id) >= maxActive)
      fail(409, `Your club already holds ${maxActive} sponsors, the most allowed at once. Close one (Rejected or Released) before adding another, or ask SAO.`, { code: 'limit' });
    const notes = str(body.notes, 1000);
    let name, categoryId, handle = null, picked = null;
    if (body.sponsorId) {
      picked = await one(`SELECT * FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [String(body.sponsorId)]);
      if (!picked) fail(400, 'That sponsor was not found. Type the name again.');
      name = picked.name; categoryId = picked.category_id;
    } else {
      name = need(body.name, 'Sponsor name', 2, 100);
      if (!normName(name)) fail(400, 'The sponsor name needs letters or numbers.');
      categoryId = need(body.categoryId, 'Category');
      if (!(await one('SELECT id FROM sp_categories WHERE id = $1 AND active = 1', [categoryId]))) fail(400, 'Choose a category from the list.');
      const ig = parseInstagram(body.instagram);
      if (ig.error) fail(400, ig.error, { field: 'instagram' });
      handle = ig.handle;
    }

    // 1. exact match (same name after cleaning, a registered other name, or the same Instagram account)
    let target = picked, conflict = null;
    if (!picked) {
      const { byName, byIg } = await findExact(name, handle);
      if (byName && byIg && byName.id !== byIg.id) conflict = [{ id: byName.id, name: byName.name, reason: 'Same name' }, { id: byIg.id, name: byIg.name, reason: 'Same Instagram account' }];
      else if (byName && handle && byName.ig_handle && byName.ig_handle !== handle) conflict = [{ id: byName.id, name: byName.name, reason: 'Same name, different Instagram account' }];
      else target = byName || byIg;
    }
    if (target && !conflict) {
      const holder = await activeClaimOn(target.id);
      if (holder && holder.club_id === user.club_id) return new Reply(409, { error: 'Your club already has this sponsor.', code: 'own', claimId: holder.id });
      // the attempt is logged for SAO (the reply still names nobody)
      if (holder) { await audit(user, 'claim.blocked', `sponsor:${target.id}`, null, { name, club: club.name }); return new Reply(409, { error: UNAVAILABLE, code: 'unavailable', sponsorId: target.id }); }
      if (handle && !target.ig_handle) await q('UPDATE sp_sponsors SET ig_handle = $1 WHERE id = $2', [handle, target.id]);
      const id = await newClaim({ sponsorId: target.id, clubId: user.club_id, status: 'reserved', actor: user, notes, text: `Sponsor reserved for ${RESERVE_DAYS} days` });
      await audit(user, 'claim.reserve', `claim:${id}`, null, { sponsor: target.name, club: club.name });
      return { result: 'reserved', claimId: id };
    }

    // 2. possible match (or two records disagree) -> held for SAO; it still blocks other clubs while SAO looks
    const candidates = conflict || await possibleMatches(name, null);
    if (candidates.length) {
      const sponsorId = conflict ? null : await newSponsor({ name, categoryId, handle, actor: user });
      if (conflict) {
        // the name or Instagram account already belongs to another record; hold against the first one if it is free
        const free = [];
        for (const cand of conflict) if (!(await activeClaimOn(cand.id))) free.push(cand);
        if (free.length < conflict.length) fail(409, UNAVAILABLE, { code: 'unavailable' });
      }
      const holdOn = sponsorId || conflict[0].id;
      const id = await newClaim({ sponsorId: holdOn, clubId: user.club_id, status: 'pending_review', actor: user, notes,
        text: 'Held for SAO review: the name looks like a sponsor already in the registry' });
      await q(`INSERT INTO sp_reviews (id, kind, claim_id, club_id, sponsor_id, sponsor_name, detail, state, created_at, created_by)
        VALUES ($1, 'duplicate', $2, $3, $4, $5, $6, 'open', $7, $8)`,
        [newId(), id, user.club_id, holdOn, name, JSON.stringify({ candidates: candidates.slice(0, 6), instagram: handle, categoryId, conflict: !!conflict }), now(), user.id]);
      await audit(user, 'claim.hold', `claim:${id}`, null, { name, candidates: candidates.map(c => c.name) });
      return { result: 'review', claimId: id };
    }

    // 3. new sponsor -> registry record and the club's 14-day reservation, together
    const sponsorId = await newSponsor({ name, categoryId, handle, actor: user });
    const id = await newClaim({ sponsorId, clubId: user.club_id, status: 'reserved', actor: user, notes, text: `Sponsor reserved for ${RESERVE_DAYS} days` });
    await audit(user, 'claim.reserve', `claim:${id}`, null, { sponsor: name, club: club.name });
    return { result: 'reserved', claimId: id };
  });

  on('GET', '/api/claims/:id', 'any', async ({ user, args }) => {
    const c = await claimFor(user, args.id);
    const events = await q(`SELECT e.*, u.name AS actor_name, u.role AS actor_role FROM sp_events e LEFT JOIN sp_users u ON u.id = e.actor_id
      WHERE e.claim_id = $1 ORDER BY e.at`, [c.id]);
    const out = { claim: await claimView(c, user), events: events.map(e => ({
      at: Number(e.at), kind: e.kind, from: e.from_status, to: e.to_status, text: e.text,
      by: e.actor_id ? (e.actor_role === 'sao' && user.role !== 'sao' ? 'SAO' : e.actor_name) : 'System',
    })) };
    if (user.role === 'sao') {
      out.history = await Promise.all((await q(CLAIM_SELECT + ' WHERE c.sponsor_id = $1 AND c.id <> $2 ORDER BY c.created_at DESC', [c.sponsor_id, c.id])).map(r => claimView(r, user)));
      out.review = await one(`SELECT * FROM sp_reviews WHERE claim_id = $1 AND kind = 'duplicate' ORDER BY created_at DESC`, [c.id]);
      if (out.review) out.review = reviewView(out.review);
    }
    return out;
  });

  on('POST', '/api/claims/:id/status', 'any', async ({ user, args, body }) => {
    const c = await claimFor(user, args.id);
    if (!Number(c.active)) fail(409, c.status === 'expired' ? 'This reservation has ended and the sponsor was released.' : 'This claim is closed.');
    const to = String(body.status || '');
    if (user.role === 'sao' && c.status === 'pending_review') fail(400, 'Resolve this in Reviews first.');
    const allowed = user.role === 'sao' ? Object.keys(STATUS).filter(s => s !== c.status && s !== 'pending_review' && s !== 'expired') : NEXT[c.status] || [];
    if (!allowed.includes(to)) fail(400, c.status === 'pending_review' ? 'SAO has to review this sponsor before you can contact them.' : `You can't move a ${STATUS[c.status]} sponsor to ${STATUS[to] || 'that status'}.`);
    if (user.role === 'sao' && ['released', 'rejected'].includes(to) || user.role === 'sao' && c.status !== 'reserved' && to === 'reserved') reasonOf(body.note);
    const note = str(body.note, 1000);
    const t = now();
    let first = c.first_contact;
    if (WORKING.includes(to) && to !== 'reserved' && !first) {
      const d = body.contactDate;
      if (!isDate(d)) fail(400, 'Enter the date you first contacted the sponsor.', { field: 'contactDate' });
      if (d > localDate(t)) fail(400, 'The contact date cannot be in the future.', { field: 'contactDate' });
      if (c.reserved_at && d < localDate(Number(c.reserved_at))) fail(400, 'The contact date cannot be before the sponsor was reserved.', { field: 'contactDate' });
      first = d;
    }
    if (['rejected', 'released'].includes(to)) {
      const reason = note || (to === 'rejected' ? 'Sponsor declined' : 'Released by the club');
      await closeClaim(c, to, user.role === 'sao' ? `SAO: ${reason}` : reason, user, `${STATUS[c.status]} → ${STATUS[to]}${note ? ': ' + note : ''}`);
      if (user.role === 'sao') await notifyClub(c.club_id, `SAO changed ${c.sponsor_name} to ${STATUS[to]}: ${reason}`, `#/claim/${c.id}`);
    } else {
      const expires = to === 'reserved' ? addLocalDays(t, RESERVE_DAYS) : null;
      await q(`UPDATE sp_claims SET status = $1, first_contact = $2, expires_at = $3, reserved_at = $4, warned = 0, last_activity_at = $5 WHERE id = $6`,
        [to, to === 'reserved' ? null : first, expires, to === 'reserved' ? t : c.reserved_at, t, c.id]);
      await event(c.id, user, 'status', c.status, to, `${STATUS[c.status]} → ${STATUS[to]}${first && !c.first_contact ? ` (first contact ${first})` : ''}${note ? ': ' + note : ''}`);
      if (user.role === 'sao') await notifyClub(c.club_id, `SAO changed ${c.sponsor_name} to ${STATUS[to]}${note ? ': ' + note : ''}`, `#/claim/${c.id}`);
    }
    await audit(user, 'claim.status', `claim:${c.id}`, { status: c.status }, { status: to, firstContact: first || null }, note || null);
    return { ok: true };
  });

  on('POST', '/api/claims/:id/note', 'any', async ({ user, args, body }) => {
    const c = await claimFor(user, args.id);
    const text = need(body.text, 'The note', 1, 1000);
    await event(c.id, user, 'note', null, null, text);
    if (Number(c.active)) await q('UPDATE sp_claims SET last_activity_at = $1 WHERE id = $2', [now(), c.id]);
    await audit(user, 'claim.note', `claim:${c.id}`, null, { text });
    return { ok: true };
  });

  // --- requests to SAO (for example "we have worked with this sponsor for years") ---
  on('POST', '/api/requests', 'any', async ({ user, body }) => {
    if (user.role !== 'rep') fail(403, 'Only club representatives send requests to SAO.');
    rateLimit(`req:${user.id}`, 10, 60000, now());
    const sponsorName = need(body.sponsorName, 'Sponsor name', 2, 100), message = need(body.message, 'Your message', 5, 1000);
    let sponsorId = null;
    if (body.sponsorId) sponsorId = (await one(`SELECT id FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [String(body.sponsorId)]))?.id || null;
    if (!sponsorId) sponsorId = (await findExact(sponsorName, null)).byName?.id || null;
    const id = newId();
    await q(`INSERT INTO sp_reviews (id, kind, club_id, sponsor_id, sponsor_name, message, state, created_at, created_by)
      VALUES ($1, 'request', $2, $3, $4, $5, 'open', $6, $7)`, [id, user.club_id, sponsorId, sponsorName, message, now(), user.id]);
    await audit(user, 'request.create', `review:${id}`, null, { sponsorName, message });
    return { ok: true };
  });
  on('GET', '/api/requests', 'any', async ({ user }) => {
    const rows = await q(`SELECT * FROM sp_reviews WHERE kind = 'request' AND club_id = $1 ORDER BY created_at DESC LIMIT 100`, [user.club_id || '']);
    return rows.map(r => ({ id: r.id, sponsorName: r.sponsor_name, message: r.message, state: r.state, createdAt: Number(r.created_at),
      resolvedAt: num(r.resolved_at), reply: r.reason || null }));
  });

  // ---------- deleting for good ----------
  // A claim goes with its history, notes, review items, reminders and log entries.
  async function wipeClaimRows(id) {
    await q('DELETE FROM sp_events WHERE claim_id = $1', [id]);
    await q('DELETE FROM sp_reviews WHERE claim_id = $1', [id]);
    await q('DELETE FROM sp_audit WHERE record = $1', [`claim:${id}`]);
    await q('DELETE FROM sp_notices WHERE link = $1', [`#/claim/${id}`]);
    await q('DELETE FROM sp_claims WHERE id = $1', [id]);
  }
  // A sponsor goes with every claim on it, its other names and records merged into it.
  async function wipeSponsor(id) {
    for (const c of await q('SELECT id FROM sp_claims WHERE sponsor_id = $1', [id])) await wipeClaimRows(c.id);
    for (const m of await q('SELECT id FROM sp_sponsors WHERE merged_into = $1', [id])) await wipeSponsor(m.id);
    await q('DELETE FROM sp_reviews WHERE sponsor_id = $1', [id]);
    await q('DELETE FROM sp_aliases WHERE sponsor_id = $1', [id]);
    await q('DELETE FROM sp_audit WHERE record = $1', [`sponsor:${id}`]);
    await q('DELETE FROM sp_sponsors WHERE id = $1', [id]);
  }
  // Deleting a claim also removes the sponsor record when no other club ever claimed it.
  async function wipeClaim(c) {
    await wipeClaimRows(c.id);
    const others = Number((await one('SELECT COUNT(*) AS n FROM sp_claims WHERE sponsor_id = $1', [c.sponsor_id]))?.n || 0);
    if (!others) await wipeSponsor(c.sponsor_id);
  }

  // A rep deletes one of their own club's sponsors; SAO can delete any claim.
  on('POST', '/api/claims/:id/delete', 'any', async ({ user, args }) => {
    const c = await claimFor(user, args.id);
    await wipeClaim(c);
    await audit(user, 'claim.delete', `club:${c.club_id}`, null, { club: c.club_name });
    return { ok: true };
  });

  // ================= SAO Heads only =================
  on('GET', '/api/dashboard', 'sao', async ({ user }) => {
    const { stallDays } = await settings();
    const t = now();
    const byStatus = Object.fromEntries((await q('SELECT status, COUNT(*) AS n FROM sp_claims GROUP BY status')).map(r => [r.status, Number(r.n)]));
    const clubs = await q(`SELECT ${CLUB_COLS} FROM sp_clubs ORDER BY sort, name`);
    const perClub = await q(`SELECT club_id, status, COUNT(*) AS n FROM sp_claims WHERE active = 1 GROUP BY club_id, status`);
    const clubRows = clubs.map(c => {
      const mine = perClub.filter(r => r.club_id === c.id);
      return { ...clubOut(c), total: mine.reduce((a, r) => a + Number(r.n), 0),
        byStatus: Object.fromEntries(mine.map(r => [r.status, Number(r.n)])) };
    });
    const expiring = await Promise.all((await q(CLAIM_SELECT + ` WHERE c.status = 'reserved' AND c.expires_at <= $1 ORDER BY c.expires_at LIMIT 20`, [t + 3 * DAY])).map(r => claimView(r, user)));
    const stalled = await Promise.all((await q(CLAIM_SELECT + ` WHERE c.status IN ('contacted', 'negotiation') AND c.last_activity_at < $1 ORDER BY c.last_activity_at LIMIT 20`, [t - stallDays * DAY])).map(r => claimView(r, user)));
    const openReviews = Number((await one(`SELECT COUNT(*) AS n FROM sp_reviews WHERE state = 'open' AND kind = 'duplicate'`))?.n || 0);
    const openRequests = Number((await one(`SELECT COUNT(*) AS n FROM sp_reviews WHERE state = 'open' AND kind = 'request'`))?.n || 0);
    const recent = (await q(`SELECT e.at, e.kind, e.text, e.to_status, e.claim_id, u.name AS actor_name, s.name AS sponsor, cl.name AS club
      FROM sp_events e JOIN sp_claims c ON c.id = e.claim_id JOIN sp_sponsors s ON s.id = c.sponsor_id LEFT JOIN sp_clubs cl ON cl.id = c.club_id
      LEFT JOIN sp_users u ON u.id = e.actor_id ORDER BY e.at DESC LIMIT 15`)).map(e => ({ ...e, at: Number(e.at), by: e.actor_name || 'System' }));
    const sponsors = Number((await one(`SELECT COUNT(*) AS n FROM sp_sponsors WHERE state = 'active'`))?.n || 0);
    return { byStatus, clubs: clubRows, expiring, stalled, openReviews, openRequests, recent, sponsors, stallDays,
      activeClaims: ACTIVE.reduce((a, s) => a + (byStatus[s] || 0), 0) };
  });

  on('GET', '/api/export.csv', 'sao', async ({ user, params }) => {
    const rows = await listClaims(user, params);
    const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const d = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
    const lines = [['Sponsor', 'Category', 'Instagram', 'Club', 'Status', 'Reserved at', 'Reservation ends', 'First contact', 'Last activity', 'Closed reason'].join(',')];
    for (const r of rows) lines.push([r.sponsor, r.category, r.instagram ? '@' + r.instagram : '', r.club, r.statusLabel, d(r.reservedAt), d(r.expiresAt), r.firstContact || '', d(r.lastActivityAt), r.closeReason || ''].map(cell).join(','));
    await audit(user, 'export', 'claims', null, { rows: rows.length });
    return new Reply(200, '﻿' + lines.join('\r\n') + '\r\n');
  });

  on('POST', '/api/claims/:id/release', 'sao', async ({ user, args, body }) => {
    const c = await claimFor(user, args.id);
    if (!Number(c.active)) fail(409, 'This claim is already closed.');
    const reason = reasonOf(body.reason);
    await closeClaim(c, 'released', `Released by SAO: ${reason}`, user);
    await notifyClub(c.club_id, `SAO released your claim on ${c.sponsor_name}: ${reason}`, `#/claim/${c.id}`);
    await audit(user, 'claim.release', `claim:${c.id}`, { status: c.status, club: c.club_name }, { status: 'released' }, reason);
    return { ok: true };
  });

  on('POST', '/api/claims/:id/extend', 'sao', async ({ user, args, body }) => {
    const c = await claimFor(user, args.id);
    if (c.status !== 'reserved') fail(400, 'Only a Reserved sponsor has a deadline to extend.');
    const days = Math.round(Number(body.days));
    if (!(days >= 1 && days <= 30)) fail(400, 'Extend by 1 to 30 days.');
    const reason = reasonOf(body.reason);
    const until = addLocalDays(Number(c.expires_at), days);
    await q('UPDATE sp_claims SET expires_at = $1, warned = 0, last_activity_at = $2 WHERE id = $3', [until, now(), c.id]);
    await event(c.id, user, 'extended', null, null, `SAO extended the reservation by ${days} day${days === 1 ? '' : 's'}: ${reason}`);
    await notifyClub(c.club_id, `SAO gave you ${days} more day${days === 1 ? '' : 's'} on ${c.sponsor_name}.`, `#/claim/${c.id}`);
    await audit(user, 'claim.extend', `claim:${c.id}`, { expiresAt: Number(c.expires_at) }, { expiresAt: until }, reason);
    return { ok: true };
  });

  // Give a sponsor to a club. If another club holds it, that claim is closed first (only one active claim ever).
  on('POST', '/api/sponsors/:id/assign', 'sao', async ({ user, args, body }) => {
    const s = await one(`SELECT * FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [args.id]);
    if (!s) fail(404, 'Sponsor not found.');
    const club = await one('SELECT * FROM sp_clubs WHERE id = $1 AND active = 1', [String(body.clubId || '')]);
    if (!club) fail(400, 'Choose an active club.');
    const reason = reasonOf(body.reason);
    const status = WORKING.includes(body.status) ? body.status : 'reserved';
    const cur = await activeClaimOn(s.id);
    if (cur && cur.club_id === club.id) fail(409, `${club.name} already holds this sponsor.`);
    let first = null;
    if (status !== 'reserved') {
      first = cur?.first_contact || (isDate(body.contactDate) ? body.contactDate : localDate(now()));
    }
    let fromClub = null;
    if (cur) {
      fromClub = (await one('SELECT name FROM sp_clubs WHERE id = $1', [cur.club_id]))?.name;
      await closeClaim(cur, 'released', `Released by SAO: ${reason}`, user, `Released by SAO: ${reason}`, { keepName: true });
      await notifyClub(cur.club_id, `SAO released your claim on ${s.name}: ${reason}`, `#/claim/${cur.id}`);
    }
    const id = await newClaim({ sponsorId: s.id, clubId: club.id, status, actor: user, firstContact: first,
      text: `Assigned by SAO${status === 'reserved' ? ` (reserved for ${RESERVE_DAYS} days)` : ` as ${STATUS[status]}`}: ${reason}` });
    await notifyClub(club.id, `SAO assigned ${s.name} to your club.`, `#/claim/${id}`);
    await audit(user, cur ? 'claim.reassign' : 'claim.assign', `sponsor:${s.id}`, cur ? { club: fromClub, claim: cur.id } : null, { club: club.name, claim: id, status }, reason);
    return { ok: true, claimId: id };
  });

  // --- duplicate reviews and club requests ---
  function reviewView(r) {
    return { id: r.id, kind: r.kind, claimId: r.claim_id, clubId: r.club_id, sponsorId: r.sponsor_id, sponsorName: r.sponsor_name,
      detail: r.detail ? JSON.parse(r.detail) : null, message: r.message, state: r.state, createdAt: Number(r.created_at),
      resolvedAt: num(r.resolved_at), resolution: r.resolution, reason: r.reason };
  }
  on('GET', '/api/reviews', 'sao', async () => {
    const rows = await q(`SELECT r.*, cl.name AS club_name, u.name AS by_name, rb.name AS resolved_by_name FROM sp_reviews r
      LEFT JOIN sp_clubs cl ON cl.id = r.club_id LEFT JOIN sp_users u ON u.id = r.created_by LEFT JOIN sp_users rb ON rb.id = r.resolved_by
      ORDER BY CASE WHEN r.state = 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`);
    const clubs = Object.fromEntries((await q('SELECT id, name FROM sp_clubs')).map(c => [c.id, c.name]));
    const out = [];
    for (const r of rows) {
      const v = { ...reviewView(r), club: r.club_name, by: r.by_name, resolvedBy: r.resolved_by_name };
      // show SAO who holds each look-alike sponsor right now
      if (v.detail?.candidates) for (const cand of v.detail.candidates) {
        const s = await one('SELECT name, state, merged_into FROM sp_sponsors WHERE id = $1', [cand.id]);
        const h = await activeClaimOn(cand.id);
        cand.holder = h ? { club: clubs[h.club_id], status: STATUS[h.status] } : null;
        cand.gone = !s || s.state !== 'active';
      }
      if (v.sponsorId && v.kind === 'request') {
        const h = await activeClaimOn(v.sponsorId);
        v.holder = h ? { club: clubs[h.club_id], status: STATUS[h.status], claimId: h.id } : null;
      }
      out.push(v);
    }
    return out;
  });

  on('POST', '/api/reviews/:id/resolve', 'sao', async ({ user, args, body }) => {
    const r = await one(`SELECT * FROM sp_reviews WHERE id = $1`, [args.id]);
    if (!r || r.state !== 'open') fail(409, 'This review is already closed.');
    const reason = reasonOf(body.reason);
    const t = now();
    const finish = resolution => q(`UPDATE sp_reviews SET state = 'closed', resolved_at = $1, resolved_by = $2, resolution = $3, reason = $4 WHERE id = $5`,
      [t, user.id, resolution, reason, r.id]);

    if (r.kind === 'request') {
      await finish('answered');
      await notifyClub(r.club_id, `SAO answered your request about ${r.sponsor_name}: ${reason}`, '#/requests');
      await audit(user, 'request.answer', `review:${r.id}`, null, null, reason);
      return { ok: true };
    }
    const c = await one(CLAIM_SELECT + ' WHERE c.id = $1', [r.claim_id]);
    if (!c || c.status !== 'pending_review') { await finish('closed'); return { ok: true }; }
    const action = body.action;
    if (action === 'approve') {
      const detail = r.detail ? JSON.parse(r.detail) : {};
      if (detail.conflict) fail(400, 'This request\'s name and Instagram account belong to existing records. Choose "Same sponsor as" one of them, or reject.');
      await q(`UPDATE sp_claims SET status = 'reserved', reserved_at = $1, expires_at = $2, last_activity_at = $1, warned = 0 WHERE id = $3`,
        [t, addLocalDays(t, RESERVE_DAYS), c.id]);
      await event(c.id, user, 'status', 'pending_review', 'reserved', `SAO approved it as a different sponsor. Reserved for ${RESERVE_DAYS} days.`);
      await finish('approved');
      await notifyClub(c.club_id, `SAO approved ${c.sponsor_name}. It is reserved for your club for ${RESERVE_DAYS} days.`, `#/claim/${c.id}`);
    } else if (action === 'merge') {
      const detail = r.detail ? JSON.parse(r.detail) : {};
      const to = await one(`SELECT * FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [String(body.targetId || '')]);
      if (!to) fail(400, 'Choose the existing sponsor this is the same as.');
      // Normally the held claim sits on a new record made from this request, which now joins the existing sponsor.
      // When the request's name and Instagram pointed at two existing records, it sits on one of them instead.
      const provisional = !detail.conflict;
      if (provisional && to.id === c.sponsor_id) fail(400, 'Choose the existing sponsor this is the same as.');
      // step out of the way first (only one active claim per sponsor), then move the records
      await q('UPDATE sp_claims SET active = 0 WHERE id = $1', [c.id]);
      if (provisional) await mergeSponsor(c.sponsor_id, to.id, user, reason);
      const other = await activeClaimOn(to.id);
      await q('UPDATE sp_claims SET sponsor_id = $1 WHERE id = $2', [to.id, c.id]);
      if (other) {
        await q(`UPDATE sp_claims SET status = 'released', closed_at = $1, close_reason = $2, last_activity_at = $1 WHERE id = $3`, [t, UNAVAILABLE, c.id]);
        await event(c.id, user, 'released', 'pending_review', 'released', `SAO review: this is a sponsor that is currently unavailable.`);
        await notifyClub(c.club_id, `SAO reviewed ${r.sponsor_name}: ${UNAVAILABLE}`, `#/claim/${c.id}`);
      } else {
        await q(`UPDATE sp_claims SET status = 'reserved', active = 1, reserved_at = $1, expires_at = $2, last_activity_at = $1, warned = 0 WHERE id = $3`,
          [t, addLocalDays(t, RESERVE_DAYS), c.id]);
        await event(c.id, user, 'status', 'pending_review', 'reserved', `SAO matched it to ${to.name}. Reserved for ${RESERVE_DAYS} days.`);
        await notifyClub(c.club_id, `SAO approved ${to.name}. It is reserved for your club for ${RESERVE_DAYS} days.`, `#/claim/${c.id}`);
      }
      await finish(other ? 'merged-unavailable' : 'merged');
    } else if (action === 'reject') {
      await closeClaim(c, 'released', `SAO review: ${reason}`, user);
      await finish('rejected');
      await notifyClub(c.club_id, `SAO reviewed ${c.sponsor_name} and did not approve it: ${reason}`, `#/claim/${c.id}`);
    } else fail(400, 'Choose what to do.');
    await audit(user, 'review.' + action, `review:${r.id}`, { status: 'pending_review' }, { claim: c.id, targetId: body.targetId || null }, reason);
    return { ok: true };
  });

  // --- sponsor registry ---
  on('GET', '/api/sponsors', 'sao', async () => {
    const clubs = Object.fromEntries((await q('SELECT id, name FROM sp_clubs')).map(c => [c.id, c.name]));
    const counts = Object.fromEntries((await q('SELECT sponsor_id, COUNT(*) AS n FROM sp_claims GROUP BY sponsor_id')).map(r => [r.sponsor_id, Number(r.n)]));
    const rows = await q(`SELECT s.*, k.name AS category_name, (SELECT c.club_id FROM sp_claims c WHERE c.sponsor_id = s.id AND c.active = 1) AS holder,
      (SELECT c.status FROM sp_claims c WHERE c.sponsor_id = s.id AND c.active = 1) AS holder_status
      FROM sp_sponsors s LEFT JOIN sp_categories k ON k.id = s.category_id WHERE s.state = 'active' ORDER BY s.name`);
    const aliases = await q('SELECT sponsor_id, name FROM sp_aliases');
    return rows.map(s => ({ id: s.id, name: s.name, category: s.category_name || '', categoryId: s.category_id, instagram: s.ig_handle,
      aliases: aliases.filter(a => a.sponsor_id === s.id).map(a => a.name), holder: s.holder ? clubs[s.holder] : null, holderId: s.holder,
      holderStatus: s.holder_status || null, claims: counts[s.id] || 0, createdAt: Number(s.created_at) }));
  });
  on('GET', '/api/sponsors/:id', 'sao', async ({ user, args }) => {
    const s = await one(`SELECT s.*, k.name AS category_name FROM sp_sponsors s LEFT JOIN sp_categories k ON k.id = s.category_id WHERE s.id = $1`, [args.id]);
    if (!s) fail(404, 'Sponsor not found.');
    const claims = await Promise.all((await q(CLAIM_SELECT + ' WHERE c.sponsor_id = $1 ORDER BY c.created_at DESC', [s.id])).map(r => claimView(r, user)));
    const aliases = (await q('SELECT name FROM sp_aliases WHERE sponsor_id = $1 ORDER BY name', [s.id])).map(a => a.name);
    return { id: s.id, name: s.name, category: s.category_name, categoryId: s.category_id, instagram: s.ig_handle, state: s.state, mergedInto: s.merged_into,
      aliases, claims, createdAt: Number(s.created_at) };
  });
  on('POST', '/api/sponsors/:id', 'sao', async ({ user, args, body }) => {
    const s = await one(`SELECT * FROM sp_sponsors WHERE id = $1 AND state = 'active'`, [args.id]);
    if (!s) fail(404, 'Sponsor not found.');
    const name = need(body.name, 'Sponsor name', 2, 100), n = normName(name);
    if (!n) fail(400, 'The sponsor name needs letters or numbers.');
    const categoryId = need(body.categoryId, 'Category');
    if (!(await one('SELECT id FROM sp_categories WHERE id = $1', [categoryId]))) fail(400, 'Choose a category.');
    const ig = parseInstagram(body.instagram); if (ig.error) fail(400, ig.error);
    const aliasNames = [...new Set((Array.isArray(body.aliases) ? body.aliases : []).map(a => str(a, 100)).filter(a => normName(a) && normName(a) !== n))].slice(0, 20);
    const clash = await one(`SELECT name FROM sp_aliases WHERE norm_name = $1 AND sponsor_id <> $2`, [n, s.id]);
    if (clash) fail(409, `"${name}" is already another name of a different sponsor.`);
    for (const a of aliasNames) {
      const an = normName(a);
      const other = await one(`SELECT name FROM sp_sponsors WHERE norm_name = $1 AND state = 'active' AND id <> $2`, [an, s.id])
        || await one(`SELECT name FROM sp_aliases WHERE norm_name = $1 AND sponsor_id <> $2`, [an, s.id]);
      if (other) fail(409, `The other name "${a}" already belongs to ${other.name}. Merge the two sponsors instead.`);
    }
    try {
      await q('UPDATE sp_sponsors SET name = $1, norm_name = $2, category_id = $3, ig_handle = $4 WHERE id = $5', [name, n, categoryId, ig.handle, s.id]);
    } catch (e) { if (isUniqueError(e)) fail(409, 'Another sponsor already has this name or Instagram account. Merge them instead.'); throw e; }
    const before = (await q('SELECT name FROM sp_aliases WHERE sponsor_id = $1', [s.id])).map(a => a.name);
    await q('DELETE FROM sp_aliases WHERE sponsor_id = $1', [s.id]);
    for (const a of aliasNames) await q('INSERT INTO sp_aliases (id, sponsor_id, name, norm_name) VALUES ($1, $2, $3, $4)', [newId(), s.id, a, normName(a)]);
    await audit(user, 'sponsor.edit', `sponsor:${s.id}`, { name: s.name, categoryId: s.category_id, instagram: s.ig_handle, aliases: before },
      { name, categoryId, instagram: ig.handle, aliases: aliasNames }, str(body.reason, 500) || null);
    return { ok: true };
  });
  on('POST', '/api/sponsors/:id/merge', 'sao', async ({ user, args, body }) => {
    const reason = reasonOf(body.reason);
    const a = await activeClaimOn(args.id), b = await activeClaimOn(String(body.targetId || ''));
    if (a && b) fail(409, 'Both sponsors have an active claim. Release one of the claims first.');
    if (a) await q('UPDATE sp_claims SET sponsor_id = $1 WHERE id = $2', [String(body.targetId), a.id]).catch(e => { if (isUniqueError(e)) fail(409, UNAVAILABLE); throw e; });
    const to = await mergeSponsor(args.id, String(body.targetId || ''), user, reason);
    return { ok: true, id: to.id };
  });

  // --- people, clubs, categories, settings, audit ---
  on('GET', '/api/users', 'sao', async () => (await q(`SELECT u.id, u.email, u.name, u.role, u.club_id, u.active, u.must_change, u.created_at, c.name AS club
    FROM sp_users u LEFT JOIN sp_clubs c ON c.id = u.club_id ORDER BY u.role DESC, c.name, u.name`))
    .map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, clubId: u.club_id, club: u.club, active: !!Number(u.active),
      mustChange: !!Number(u.must_change), createdAt: Number(u.created_at) })));

  async function userFields(body, existing) {
    const name = need(body.name, 'Name', 2, 100), email = need(body.email, 'Email', 3, 200).toLowerCase();
    if (!emailOk(email)) fail(400, 'Enter a valid email address.');
    const role = body.role === 'sao' ? 'sao' : 'rep';
    let clubId = null;
    if (role === 'rep') {
      clubId = String(body.clubId || '');
      if (!(await one('SELECT id FROM sp_clubs WHERE id = $1', [clubId]))) fail(400, 'Choose the representative\'s club.');
    }
    const dupe = await one('SELECT id FROM sp_users WHERE email = $1', [email]);
    if (dupe && dupe.id !== existing?.id) fail(409, 'Another account already uses this email.');
    return { name, email, role, clubId };
  }
  on('POST', '/api/users', 'sao', async ({ user, body }) => {
    const f = await userFields(body);
    const p = passwordProblem(body.password); if (p) fail(400, p);
    const id = newId();
    await q('INSERT INTO sp_users (id, email, name, role, club_id, pass, active, must_change, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7)',
      [id, f.email, f.name, f.role, f.clubId, hashPassword(body.password), now()]);
    await audit(user, 'user.create', `user:${id}`, null, f);
    return { ok: true, id };
  });
  on('POST', '/api/users/:id', 'sao', async ({ user, args, body }) => {
    const u = await one('SELECT * FROM sp_users WHERE id = $1', [args.id]);
    if (!u) fail(404, 'Account not found.');
    const f = await userFields(body, u);
    const active = body.active === false ? 0 : 1;
    if (u.id === user.id && (!active || f.role !== 'sao')) fail(400, 'You cannot turn off or demote your own account.');
    await q('UPDATE sp_users SET name = $1, email = $2, role = $3, club_id = $4, active = $5 WHERE id = $6', [f.name, f.email, f.role, f.clubId, active, u.id]);
    if (body.password) {
      const p = passwordProblem(body.password); if (p) fail(400, p);
      await q('UPDATE sp_users SET pass = $1, must_change = 1 WHERE id = $2', [hashPassword(body.password), u.id]);
    }
    if (body.password || !active || f.role !== u.role || f.clubId !== u.club_id) await auth.endAllSessions(u.id);
    await audit(user, 'user.edit', `user:${u.id}`, { name: u.name, email: u.email, role: u.role, clubId: u.club_id, active: !!Number(u.active) },
      { ...f, active: !!active, passwordReset: !!body.password });
    return { ok: true };
  });

  // Club logos are public (they are on the club's own pages anyway), so pictures load without sign-in
  on('GET', '/api/clubs/:id/logo', 'none', async ({ args }) => {
    const c = await one('SELECT logo_data FROM sp_clubs WHERE id = $1', [args.id]);
    const m = c && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(c.logo_data || '');
    if (!m) fail(404, 'No logo.');
    const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status: 200, headers: { ...CORS, ...SECURITY, 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable' } });
  });
  on('POST', '/api/clubs/:id/logo', 'sao', async ({ user, args, body }) => {
    const c = await one('SELECT id, name, logo_v FROM sp_clubs WHERE id = $1', [args.id]);
    if (!c) fail(404, 'Club not found.');
    let data = null;
    if (body.data != null) {
      data = String(body.data);
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) fail(400, 'Use a PNG, JPG or WebP picture.');
      if (data.length > 400000) fail(400, 'The picture is too big. Use one under 250 KB.');
    }
    await q('UPDATE sp_clubs SET logo_data = $1, logo_v = $2 WHERE id = $3', [data, (Number(c.logo_v) || 0) + 1, c.id]);
    await audit(user, data ? 'club.logo' : 'club.logo.remove', `club:${c.id}`, null, { club: c.name });
    return { ok: true };
  });

  for (const [table, label, path] of [['sp_clubs', 'club', 'clubs'], ['sp_categories', 'category', 'categories']]) {
    on('POST', `/api/${path}`, 'sao', async ({ user, body }) => {
      const name = need(body.name, 'Name', 2, 100);
      if (await one(`SELECT id FROM ${table} WHERE LOWER(name) = $1`, [name.toLowerCase()])) fail(409, `A ${label} with this name already exists.`);
      const sort = Number((await one(`SELECT COALESCE(MAX(sort), 0) AS m FROM ${table}`))?.m || 0) + 1;
      const id = newId();
      await q(`INSERT INTO ${table} (id, name, active, sort) VALUES ($1, $2, 1, $3)`, [id, name, sort]);
      await audit(user, `${label}.create`, `${label}:${id}`, null, { name });
      return { ok: true, id };
    });
    on('POST', `/api/${path}/:id`, 'sao', async ({ user, args, body }) => {
      const row = await one(`SELECT * FROM ${table} WHERE id = $1`, [args.id]);
      if (!row) fail(404, 'Not found.');
      const name = need(body.name, 'Name', 2, 100), active = body.active === false ? 0 : 1;
      if (await one(`SELECT id FROM ${table} WHERE LOWER(name) = $1 AND id <> $2`, [name.toLowerCase(), row.id])) fail(409, `A ${label} with this name already exists.`);
      await q(`UPDATE ${table} SET name = $1, active = $2 WHERE id = $3`, [name, active, row.id]);
      await audit(user, `${label}.edit`, `${label}:${row.id}`, { name: row.name, active: !!Number(row.active) }, { name, active: !!active });
      return { ok: true };
    });
  }

  on('POST', '/api/settings', 'sao', async ({ user, body }) => {
    const before = await settings();
    const stallDays = body.stallDays == null ? before.stallDays : Math.round(Number(body.stallDays));
    if (!(stallDays >= 7 && stallDays <= 180)) fail(400, 'Choose between 7 and 180 days.');
    const maxActive = body.maxActive == null ? before.maxActive : Math.round(Number(body.maxActive));
    if (!(maxActive >= 1 && maxActive <= 200)) fail(400, 'The sponsor limit must be between 1 and 200.');
    await db.meta('stall_days', stallDays);
    await db.meta('max_active', maxActive);
    await audit(user, 'settings.edit', 'settings', before, { stallDays, maxActive });
    return { ok: true };
  });

  // --- SAO deletes anything, for good ---
  on('POST', '/api/sponsors/:id/delete', 'sao', async ({ user, args }) => {
    const s = await one('SELECT id, name FROM sp_sponsors WHERE id = $1', [args.id]);
    if (!s) fail(404, 'Sponsor not found.');
    await wipeSponsor(s.id);
    await audit(user, 'sponsor.delete', 'sponsors', null, { name: s.name });
    return { ok: true };
  });
  on('POST', '/api/users/:id/delete', 'sao', async ({ user, args }) => {
    const u = await one('SELECT id, name, email FROM sp_users WHERE id = $1', [args.id]);
    if (!u) fail(404, 'Account not found.');
    if (u.id === user.id) fail(400, 'You cannot delete your own account.');
    await q('DELETE FROM sp_sessions WHERE user_id = $1', [u.id]);
    await q('DELETE FROM sp_notices WHERE user_id = $1', [u.id]);
    await q('DELETE FROM sp_users WHERE id = $1', [u.id]);
    await audit(user, 'user.delete', 'users', null, { name: u.name, email: u.email });
    return { ok: true };
  });
  // A club goes with its sponsors' claims, its requests and its rep accounts.
  on('POST', '/api/clubs/:id/delete', 'sao', async ({ user, args }) => {
    const c = await one('SELECT id, name FROM sp_clubs WHERE id = $1', [args.id]);
    if (!c) fail(404, 'Club not found.');
    for (const cl of await q('SELECT * FROM sp_claims WHERE club_id = $1', [c.id])) await wipeClaim(cl);
    await q('DELETE FROM sp_reviews WHERE club_id = $1', [c.id]);
    for (const u of await q('SELECT id FROM sp_users WHERE club_id = $1', [c.id])) {
      await q('DELETE FROM sp_sessions WHERE user_id = $1', [u.id]);
      await q('DELETE FROM sp_notices WHERE user_id = $1', [u.id]);
    }
    const reps = Number((await one('SELECT COUNT(*) AS n FROM sp_users WHERE club_id = $1', [c.id]))?.n || 0);
    await q('DELETE FROM sp_users WHERE club_id = $1', [c.id]);
    await q('DELETE FROM sp_clubs WHERE id = $1', [c.id]);
    await audit(user, 'club.delete', 'clubs', null, { name: c.name, accounts: reps });
    return { ok: true };
  });
  // Sponsors in a deleted category move to "Other".
  on('POST', '/api/categories/:id/delete', 'sao', async ({ user, args }) => {
    const k = await one('SELECT id, name FROM sp_categories WHERE id = $1', [args.id]);
    if (!k) fail(404, 'Category not found.');
    const other = await one(`SELECT id FROM sp_categories WHERE LOWER(name) = 'other' AND id <> $1`, [k.id]);
    await q('UPDATE sp_sponsors SET category_id = $1 WHERE category_id = $2', [other ? other.id : null, k.id]);
    await q('DELETE FROM sp_categories WHERE id = $1', [k.id]);
    await audit(user, 'category.delete', 'categories', null, { name: k.name });
    return { ok: true };
  });
  // Deleting an open duplicate review also deletes the claim it was holding.
  on('POST', '/api/reviews/:id/delete', 'sao', async ({ user, args }) => {
    const r = await one('SELECT * FROM sp_reviews WHERE id = $1', [args.id]);
    if (!r) fail(404, 'Not found.');
    const held = r.kind === 'duplicate' && r.state === 'open' && r.claim_id ? await one('SELECT * FROM sp_claims WHERE id = $1', [r.claim_id]) : null;
    await q('DELETE FROM sp_reviews WHERE id = $1', [r.id]);
    if (held) await wipeClaim(held);
    await audit(user, 'review.delete', 'reviews', null, { kind: r.kind, sponsor: r.sponsor_name });
    return { ok: true };
  });

  on('GET', '/api/audit', 'sao', async ({ params }) => {
    const offset = Math.max(0, Math.round(Number(params.get('offset')) || 0));
    const rows = await q(`SELECT a.*, u.name AS actor_name FROM sp_audit a LEFT JOIN sp_users u ON u.id = a.actor_id ORDER BY a.at DESC LIMIT 100 OFFSET ${offset}`);
    return rows.map(a => ({ at: Number(a.at), by: a.actor_name || 'System', action: a.action, record: a.record,
      before: a.before_value ? JSON.parse(a.before_value) : null, after: a.after_value ? JSON.parse(a.after_value) : null, reason: a.reason }));
  });

  // ---------- handle one request ----------
  async function handle(request, { ip = '' } = {}) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const at = url.pathname.indexOf('/api/');
    const path = at >= 0 ? url.pathname.slice(at).replace(/\/+$/, '') : url.pathname;
    let match = null;
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = path.match(r.re);
      if (m) { match = { r, args: m.groups || {} }; break; }
    }
    if (!match) return respond(404, { error: 'Not found.' });
    let body = {};
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 100000) return respond(413, { error: 'Too large.' });
      try { body = text ? JSON.parse(text) : {}; } catch { return respond(400, { error: 'Bad request.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
    try {
      await ready();
      const out = await db.tx(async () => {
        await sweep();
        const user = await auth.sessionUser(token);
        if (match.r.role !== 'none' && !user) fail(401, 'Please sign in again.');
        if (match.r.role === 'sao' && user.role !== 'sao') fail(403, DENIED);
        return match.r.fn({ user, body, params: url.searchParams, args: match.args, token, ip });
      });
      if (out instanceof Response) return out;
      if (out instanceof Reply) return typeof out.body === 'string' ? respond(out.status, out.body, 'text/csv; charset=utf-8') : respond(out.status, out.body);
      return respond(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return respond(e.status, { error: e.message, ...e.extra });
      console.error(e);
      return respond(500, { error: 'Something went wrong on the server.' });
    }
  }

  return { handle, ready, sweep };
}
