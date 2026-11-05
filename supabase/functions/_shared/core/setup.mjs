// Starting data: the 17 clubs, the category list, and optional demo accounts and sponsors.
import { hashPassword, newId } from './auth.mjs';
import { normName } from './match.mjs';
import { addLocalDays, localDate } from './time.mjs';

export const DEFAULT_CLUBS = ['SPSA GUC', 'AYB GUC', 'GUC MUN', 'Revive GUC', 'TCS GUC', 'Athar GUC', 'Insider GUC', 'IEEE GUC', 'Innovators GUC',
  'GDG GUC', 'Elwarsha GUC', 'VGS GUC', 'The Moot Court Club', 'Cura', 'Qubit GUC', 'TEDxGUC', 'Inspire GUC'];
export const DEFAULT_CATEGORIES = ['Food and Beverage', 'Technology', 'Telecommunications', 'Banking and Finance', 'Fashion and Lifestyle', 'Education',
  'Entertainment', 'Health and Wellness', 'Retail and E-commerce', 'Automotive', 'Travel and Hospitality', 'Other'];
export const DEMO_PASSWORD = 'Demo1234';

export async function seedBasics(db) {
  let i = 0;
  for (const name of DEFAULT_CLUBS) await db.q('INSERT INTO sp_clubs (id, name, active, sort) VALUES ($1, $2, 1, $3)', [newId(), name, i++]);
  i = 0;
  for (const name of DEFAULT_CATEGORIES) await db.q('INSERT INTO sp_categories (id, name, active, sort) VALUES ($1, $2, 1, $3)', [newId(), name, i++]);
}

const slug = s => s.toLowerCase().replace(/guc/g, '').replace(/[^a-z0-9]+/g, '') || 'club';

export async function seedDemo(db, now) {
  const clubs = await db.q('SELECT id, name FROM sp_clubs ORDER BY sort');
  const cats = Object.fromEntries((await db.q('SELECT id, name FROM sp_categories')).map(c => [c.name, c.id]));
  const pass = hashPassword(DEMO_PASSWORD);
  const t = now();
  for (const c of clubs)
    await db.q('INSERT INTO sp_users (id, email, name, role, club_id, pass, active, must_change, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7)',
      [newId(), `${slug(c.name)}@demo.local`, `${c.name} Rep`, 'rep', c.id, pass, t]);
  const DAY = 86400000;
  const demo = [
    ['Vodafone Egypt', 'Telecommunications', 'vodafoneegypt', 0, 'contacted', 9],
    ['Pepsi', 'Food and Beverage', 'pepsiegypt', 1, 'negotiation', 20],
    ['CIB', 'Banking and Finance', 'cibegypt', 2, 'reserved', 12],
    ['Talabat', 'Retail and E-commerce', 'talabategypt', 3, 'reserved', 2],
    ['Orange', 'Telecommunications', 'orangeegypt', 7, 'confirmed', 30],
    ['Cilantro', 'Food and Beverage', 'cilantrocafe', 9, 'reserved', 5],
    ['Instabug', 'Technology', 'instabug', 9, 'contacted', 40],
    ['Swvl', 'Travel and Hospitality', null, 4, 'rejected', 25],
    ['Juhayna', 'Food and Beverage', 'juhaynaegypt', 5, 'expired', 18],
  ];
  for (const [name, cat, ig, ci, status, ago] of demo) {
    const sid = newId(), cid = newId(), club = clubs[ci];
    const at = t - ago * DAY;
    await db.q('INSERT INTO sp_sponsors (id, name, norm_name, category_id, ig_handle, state, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [sid, name, normName(name), cats[cat], ig, 'active', at]);
    const active = ['reserved', 'contacted', 'negotiation', 'confirmed'].includes(status) ? 1 : 0;
    const contacted = !['reserved', 'expired'].includes(status) && status !== 'rejected' ? localDate(at + DAY) : (status === 'rejected' ? localDate(at + DAY) : null);
    const expires = status === 'reserved' ? addLocalDays(at, 14) : null;
    await db.q(`INSERT INTO sp_claims (id, sponsor_id, club_id, status, active, reserved_at, expires_at, first_contact, last_activity_at, notes,
      created_at, closed_at, close_reason, warned) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0)`,
      [cid, sid, club.id, status, active, at, expires, contacted, at + DAY, 'Demo record', at, active ? null : at + 2 * DAY,
        status === 'expired' ? 'No contact logged within 14 days' : status === 'rejected' ? 'Sponsor declined' : null]);
    await db.q('INSERT INTO sp_events (id, claim_id, at, actor_id, kind, from_status, to_status, text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [newId(), cid, at, null, 'reserved', null, 'reserved', 'Sponsor reserved for 14 days (demo)']);
  }
  await db.meta('demo', '1');
}
