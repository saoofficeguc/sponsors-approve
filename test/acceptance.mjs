// The acceptance tests from the requirements (section 11), plus a few more. Run: npm test
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createApp } from '../supabase/functions/_shared/core/app.mjs';
import { parseInstagram, possibleMatch, normName } from '../supabase/functions/_shared/core/match.mjs';
import { addLocalDays } from '../supabase/functions/_shared/core/time.mjs';
const { sqliteDriver } = createRequire(import.meta.url)('../scripts/sqlite-driver.js');

let clock = Date.parse('2026-11-05T10:00:00Z');
const DAY = 86400000;
const driver = sqliteDriver(':memory:');
const pending = [];   // background work (the sheet update), so tests can wait for it
const app = createApp({ driver, now: () => clock, background: p => { const w = p.catch(e => console.error(e)); pending.push(w); return w; } });

// Every new sponsor needs its Instagram profile link. Tests that are about something else get one made from the
// sponsor's name (same name -> same link); tests about Instagram itself pass their own.
const autoIg = name => 'https://www.instagram.com/' + (String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || 'x' + [...String(name)].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 1e9, 7));
async function call(method, path, body, token) {
  if (method === 'POST' && path === '/api/claims' && body && !body.sponsorId && !('instagram' in body)) body = { ...body, instagram: autoIg(body.name) };
  const r = await app.handle(new Request('http://x' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), { ip: '1.2.3.4' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let sao, A, B, C, cats, clubs;
async function login(email) { return (await call('POST', '/api/login', { email, password: 'Start1234' })).data.token; }
// sign-ins last 7 days, so sign in again after moving the clock forward
async function relogin() {
  [A, B, C] = [await login('a@club.test'), await login('b@club.test'), await login('c@club.test')];
  sao = (await call('POST', '/api/login', { email: 'head@sao.test', password: 'Head12345' })).data.token;
}

test('setup and accounts', async () => {
  const s = await call('POST', '/api/setup', { name: 'SAO Head', email: 'head@sao.test', password: 'Head12345' });
  assert.equal(s.status, 200); sao = s.data.token;
  const sess = (await call('GET', '/api/session', null, sao)).data;
  assert.equal(sess.clubs.length, 23);
  assert.equal(sess.clubs.find(c => c.name === 'AYB GUC').logo, 'assets/clubs/ayb.png');
  assert.ok(sess.clubs.find(c => c.name === 'Enactus GUC')); assert.equal(sess.categories.length, 12);
  clubs = sess.clubs; cats = Object.fromEntries(sess.categories.map(c => [c.name, c.id]));
  for (const [i, e] of [[0, 'a@club.test'], [1, 'b@club.test'], [2, 'c@club.test']])
    assert.equal((await call('POST', '/api/users', { name: e, email: e, role: 'rep', clubId: clubs[i].id, password: 'Start1234' }, sao)).status, 200);
  [A, B, C] = [await login('a@club.test'), await login('b@club.test'), await login('c@club.test')];
  assert.ok(A && B && C);
});

let brandX;
test('Club A reserves Brand X; Club B is blocked and the owner stays hidden', async () => {
  const a = await call('POST', '/api/claims', { name: 'Brand X', categoryId: cats.Technology, instagram: 'https://www.instagram.com/brandx.eg/' }, A);
  assert.equal(a.data.result, 'reserved'); brandX = a.data.claimId;
  const b = await call('POST', '/api/claims', { name: 'Brand X', categoryId: cats.Technology }, B);
  assert.equal(b.status, 409); assert.equal(b.data.error, 'This sponsor is currently unavailable.');
  assert.ok(!JSON.stringify(b.data).includes(clubs[0].name));
});

test('different capitalization or the same Instagram handle is the same conflict', async () => {
  for (const body of [{ name: 'BRAND-x.', categoryId: cats.Other }, { name: 'Totally Other Name', categoryId: cats.Other, instagram: 'https://instagram.com/BrandX.EG?igsh=abc' }]) {
    const r = await call('POST', '/api/claims', body, B);
    assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(r.data.error, 'This sponsor is currently unavailable.');
  }
});

test('the search tells other clubs only "unavailable", never who', async () => {
  const r = await call('GET', '/api/sponsors/search?q=bran', null, B);
  assert.equal(r.data[0].name, 'Brand X'); assert.equal(r.data[0].available, false);
  assert.ok(!('holder' in r.data[0])); assert.ok(!JSON.stringify(r.data).includes(clubs[0].name));
});

test('a close but ambiguous spelling is held for SAO review', async () => {
  const r = await call('POST', '/api/claims', { name: 'Brand X Egypt', categoryId: cats.Technology }, B);
  assert.equal(r.data.result, 'review');
  const c = (await call('GET', '/api/claims/' + r.data.claimId, null, B)).data.claim;
  assert.equal(c.status, 'pending_review');
  // it cannot be contacted until SAO decides
  assert.equal((await call('POST', `/api/claims/${c.id}/status`, { status: 'contacted', contactDate: '2026-11-05' }, B)).status, 400);
  // and it blocks a third club meanwhile
  assert.equal((await call('POST', '/api/claims', { name: 'brand x egypt', categoryId: cats.Technology }, C)).status, 409);
});

test('SAO resolves the review as the same (unavailable) sponsor', async () => {
  const rev = (await call('GET', '/api/reviews', null, sao)).data.find(r => r.state === 'open' && r.kind === 'duplicate');
  assert.ok(rev.detail.candidates.some(c => c.name === 'Brand X' && c.holder));
  const x = rev.detail.candidates.find(c => c.name === 'Brand X');
  const r = await call('POST', `/api/reviews/${rev.id}/resolve`, { action: 'merge', targetId: x.id, reason: 'Same brand' }, sao);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = (await call('GET', '/api/claims/' + rev.claimId, null, B)).data.claim;
  assert.equal(c.status, 'released'); assert.equal(c.closeReason, 'This sponsor is currently unavailable.');
  // the other name now leads to the same sponsor
  assert.equal((await call('POST', '/api/claims', { name: 'Brand X Egypt', categoryId: cats.Technology }, C)).data.error, 'This sponsor is currently unavailable.');
});

test('two clubs reserving the same new sponsor at the same moment: only one wins', async () => {
  const [r1, r2] = await Promise.all([
    call('POST', '/api/claims', { name: 'Race Cola', categoryId: cats['Food and Beverage'] }, B),
    call('POST', '/api/claims', { name: 'race cola', categoryId: cats['Food and Beverage'] }, C),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const all = (await call('GET', '/api/claims?status=active&q=racecola', null, sao)).data;
  assert.equal(all.length, 1);
});

let zeta;
test('14 days with no first contact: the reservation ends and the sponsor can be claimed again', async () => {
  zeta = (await call('POST', '/api/claims', { name: 'Zeta Bank', categoryId: cats['Banking and Finance'] }, A)).data.claimId;
  const c = (await call('GET', '/api/claims/' + zeta, null, A)).data.claim;
  assert.equal(c.expiresAt, addLocalDays(clock, 14));
  clock += 13 * DAY; await relogin();
  assert.equal((await call('POST', '/api/claims', { name: 'Zeta Bank', categoryId: cats['Banking and Finance'] }, B)).status, 409);
  const notes = (await call('GET', '/api/notices', null, A)).data;
  assert.ok(notes.some(n => /ends in 1 day/.test(n.text)), JSON.stringify(notes));
  clock += DAY + 1000; await relogin();
  await call('POST', '/api/tick');
  assert.equal((await call('GET', '/api/claims/' + zeta, null, A)).data.claim.status, 'expired');
  const b = await call('POST', '/api/claims', { name: 'Zeta Bank', categoryId: cats['Banking and Finance'] }, B);
  assert.equal(b.data.result, 'reserved');
  // history stays: SAO still sees the first, expired claim
  assert.equal((await call('GET', '/api/claims/' + b.data.claimId, null, sao)).data.history.length, 1);
});

test('Club A logs Contacted before the deadline: the clock stops and the change is timestamped', async () => {
  const id = (await call('POST', '/api/claims', { name: 'Omega Motors', categoryId: cats.Automotive }, A)).data.claimId;
  clock += 5 * DAY; await relogin();
  const today = new Date(clock).toISOString().slice(0, 10);
  assert.equal((await call('POST', `/api/claims/${id}/status`, { status: 'contacted', contactDate: '2099-01-01' }, A)).status, 400);
  assert.equal((await call('POST', `/api/claims/${id}/status`, { status: 'contacted', contactDate: today }, A)).status, 200);
  clock += 20 * DAY; await relogin();
  await call('POST', '/api/tick');
  const d = (await call('GET', '/api/claims/' + id, null, A)).data;
  assert.equal(d.claim.status, 'contacted'); assert.equal(d.claim.expiresAt, null); assert.equal(d.claim.firstContact, today);
  const ev = d.events.find(e => e.to === 'contacted');
  assert.ok(ev.at && ev.by === 'a@club.test');
});

test('Club A cannot open Club B\'s list or records through the URL or API', async () => {
  await call('POST', '/api/claims', { name: 'Kappa Foods', categoryId: cats['Food and Beverage'] }, B);
  const bList = (await call('GET', '/api/claims', null, B)).data;
  const aList = (await call('GET', '/api/claims?club=' + clubs[1].id, null, A)).data;
  assert.ok(aList.every(c => c.clubId === clubs[0].id));
  const theirs = bList.find(c => c.active);
  assert.equal((await call('GET', '/api/claims/' + theirs.id, null, A)).status, 403);
  assert.equal((await call('POST', `/api/claims/${theirs.id}/status`, { status: 'released' }, A)).status, 403);
  assert.equal((await call('GET', '/api/dashboard', null, A)).status, 403);
  assert.equal((await call('GET', '/api/users', null, A)).status, 403);
  assert.equal((await call('GET', '/api/claims/does-not-exist', null, A)).status, 403);
});

test('SAO reassigns a claim: the old one closes, the new one is exclusive, the reason is logged', async () => {
  const made = await call('POST', '/api/claims', { name: 'Lumen Labs', categoryId: cats.Technology }, A);
  assert.equal(made.data.result, 'reserved'); brandX = made.data.claimId;
  const c = (await call('GET', '/api/claims/' + brandX, null, sao)).data.claim;
  assert.equal((await call('POST', `/api/sponsors/${c.sponsorId}/assign`, { clubId: clubs[2].id, reason: '' }, sao)).status, 400);
  const r = await call('POST', `/api/sponsors/${c.sponsorId}/assign`, { clubId: clubs[2].id, reason: 'Club C has a signed letter' }, sao);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/claims/' + brandX, null, A)).data.claim.status, 'released');
  const active = (await call('GET', '/api/claims?status=active&q=lumenlabs', null, sao)).data;
  assert.equal(active.length, 1); assert.equal(active[0].clubId, clubs[2].id);
  assert.equal((await call('POST', '/api/claims', { name: 'Lumen Labs', categoryId: cats.Technology }, A)).status, 409);
  const log = (await call('GET', '/api/audit', null, sao)).data.find(a => a.action === 'claim.reassign');
  assert.equal(log.reason, 'Club C has a signed letter');
  // the old club's view never names the new club
  assert.ok(!JSON.stringify((await call('GET', '/api/claims/' + brandX, null, A)).data).includes(clubs[2].name));
});

test('CSV export has a row per claim and neutralizes formulas', async () => {
  await call('POST', '/api/claims', { name: '=HYPERLINK("x")', categoryId: cats.Other }, A);
  const r = await call('GET', '/api/export.csv', null, sao);
  assert.equal(r.status, 200); assert.ok(r.data.includes("'=HYPERLINK"));
  assert.equal((await call('GET', '/api/export.csv', null, A)).status, 403);
});

test('club logos: SAO uploads one, anyone can load it, clubs cannot change it', async () => {
  const id = clubs.find(c => c.name === 'Cura').id;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', `/api/clubs/${id}/logo`, { data: png }, A)).status, 403);
  assert.equal((await call('POST', `/api/clubs/${id}/logo`, { data: 'data:text/html;base64,PGI+' }, sao)).status, 400);
  assert.equal((await call('POST', `/api/clubs/${id}/logo`, { data: png }, sao)).status, 200);
  const c = (await call('GET', '/api/session', null, sao)).data.clubs.find(x => x.id === id);
  assert.ok(c.logoApi && !c.logo);
  const r = await app.handle(new Request('http://x' + c.logoApi));
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
});

test('a site set up before the guide clubs gets them once, without duplicates', async () => {
  const { createDb } = await import('../supabase/functions/_shared/core/db.mjs');
  const { syncClubs } = await import('../supabase/functions/_shared/core/setup.mjs');
  const driver = sqliteDriver(':memory:');
  const old = createApp({ driver });
  await old.ready();
  const db = createDb(driver);
  for (const [i, n] of ['SPSA GUC', 'AYB GUC', 'The Insider', 'Cura'].entries()) await db.q('INSERT INTO sp_clubs (id, name, active, sort) VALUES ($1, $2, 1, $3)', ['c' + i, n, i]);
  await db.tx(() => syncClubs(db)); await db.tx(() => syncClubs(db));
  await db.meta('clubs_guide_2026', '0'); await db.tx(() => syncClubs(db));
  const rows = await db.q('SELECT name, logo FROM sp_clubs');
  assert.equal(rows.length, 23);   // the 4 old clubs are matched ("The Insider" = "Insider GUC"), 19 added
  assert.equal(rows.find(r => r.name === 'The Insider').logo, 'assets/clubs/insider.png');
  assert.equal(rows.filter(r => r.name === 'Enactus GUC').length, 1);
  assert.ok(rows.every(r => r.logo), 'every club has a logo');
});

test('a club can hold at most 20 sponsors at once (SAO can change it)', async () => {
  const d = clubs.find(c => c.name === 'Qubit GUC');
  const made = await call('POST', '/api/users', { name: 'Rep D', email: 'd@club.test', role: 'rep', clubId: d.id, password: 'Start1234' }, sao);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const D = await login('d@club.test');
  const add = n => call('POST', '/api/claims', { name: `Limit Test ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor'][n]} Zone${n}x${n * 7}`, categoryId: cats.Other }, D);
  for (let i = 0; i < 20; i++) assert.equal((await add(i)).status, 200, 'claim ' + i);
  const over = await add(20);
  assert.equal(over.status, 409); assert.equal(over.data.code, 'limit');
  // closing one frees a place
  const one = (await call('GET', '/api/claims?status=active', null, D)).data[0];
  assert.equal((await call('POST', `/api/claims/${one.id}/status`, { status: 'released' }, D)).status, 200);
  assert.equal((await add(20)).status, 200);
  // SAO lowers the limit; the club is now over it and cannot add
  assert.equal((await call('POST', '/api/settings', { maxActive: 5 }, sao)).status, 200);
  assert.equal((await add(21)).data.code, 'limit');
  assert.equal((await call('GET', '/api/session', null, D)).data.settings.maxActive, 5);
  await call('POST', '/api/settings', { maxActive: 20 }, sao);
});

test('a rep deletes their own sponsor completely; never another club\'s', async () => {
  const id = (await call('POST', '/api/claims', { name: 'Gone Forever Ltd', categoryId: cats.Other, notes: 'secret note' }, A)).data.claimId;
  await call('POST', `/api/claims/${id}/note`, { text: 'another note' }, A);
  assert.equal((await call('POST', `/api/claims/${id}/delete`, null, B)).status, 403);
  assert.equal((await call('POST', `/api/claims/${id}/delete`, null, A)).status, 200);
  assert.equal((await call('GET', '/api/claims/' + id, null, sao)).status, 403);
  const all = JSON.stringify((await call('GET', '/api/sponsors', null, sao)).data) + JSON.stringify((await call('GET', '/api/audit', null, sao)).data);
  assert.ok(!all.includes('Gone Forever') && !all.includes('secret note'));
  // the sponsor is free again for anyone
  assert.equal((await call('POST', '/api/claims', { name: 'Gone Forever Ltd', categoryId: cats.Other }, B)).data.result, 'reserved');
});

test('SAO deletes sponsors, accounts, clubs, categories; clubs cannot', async () => {
  const sp = (await call('GET', '/api/sponsors', null, sao)).data.find(s => s.name === 'Gone Forever Ltd');
  assert.equal((await call('POST', `/api/sponsors/${sp.id}/delete`, null, A)).status, 403);
  assert.equal((await call('POST', `/api/sponsors/${sp.id}/delete`, null, sao)).status, 200);
  assert.ok(!(await call('GET', '/api/claims', null, B)).data.some(c => c.sponsor === 'Gone Forever Ltd'));
  // a category: its sponsors move to "Other"
  const tmpCat = (await call('POST', '/api/categories', { name: 'Temporary Cat' }, sao)).data.id;
  await call('POST', '/api/claims', { name: 'Category Mover Co', categoryId: tmpCat }, B);
  assert.equal((await call('POST', `/api/categories/${tmpCat}/delete`, null, sao)).status, 200);
  assert.equal((await call('GET', '/api/sponsors', null, sao)).data.find(s => s.name === 'Category Mover Co').category, 'Other');
  // a club with its accounts and claims
  const club = (await call('POST', '/api/clubs', { name: 'Short Lived Club' }, sao)).data.id;
  await call('POST', '/api/users', { name: 'Rep E', email: 'e@club.test', role: 'rep', clubId: club, password: 'Start1234' }, sao);
  const E = await login('e@club.test');
  await call('POST', '/api/claims', { name: 'Club Bound Sponsor', categoryId: cats.Other }, E);
  assert.equal((await call('POST', `/api/clubs/${club}/delete`, null, sao)).status, 200);
  assert.equal((await call('GET', '/api/claims', null, E)).status, 401);   // the account is gone
  assert.ok(!(await call('GET', '/api/users', null, sao)).data.some(u => u.email === 'e@club.test'));
  assert.ok(!(await call('GET', '/api/sponsors', null, sao)).data.some(s => s.name === 'Club Bound Sponsor'));
  // SAO cannot delete themself
  const me = (await call('GET', '/api/session', null, sao)).data.user.id;
  assert.equal((await call('POST', `/api/users/${me}/delete`, null, sao)).status, 400);
});

test('a rejected or withdrawn look-alike name does not stay behind as a free sponsor', async () => {
  await call('POST', '/api/claims', { name: 'Starbright Coffee', categoryId: cats.Other }, A);
  // SAO rejects a look-alike
  const held = (await call('POST', '/api/claims', { name: 'Starbright Coffee Egypt', categoryId: cats.Other }, B)).data;
  assert.equal(held.result, 'review');
  const rv = (await call('GET', '/api/reviews', null, sao)).data.find(r => r.claimId === held.claimId);
  assert.equal((await call('POST', `/api/reviews/${rv.id}/resolve`, { action: 'reject', reason: 'Same brand' }, sao)).status, 200);
  assert.equal((await call('POST', '/api/claims', { name: 'Starbright Coffee Egypt', categoryId: cats.Other }, C)).data.result, 'review');
  // a club withdraws its own look-alike request
  const mine = (await call('GET', '/api/claims?status=pending_review', null, C)).data.find(x => x.sponsor === 'Starbright Coffee Egypt');
  assert.equal((await call('POST', `/api/claims/${mine.id}/status`, { status: 'released' }, C)).status, 200);
  assert.equal((await call('POST', '/api/claims', { name: 'Starbright Coffee Egypt', categoryId: cats.Other }, B)).data.result, 'review');
  // the closed requests keep their history
  assert.equal((await call('GET', '/api/claims/' + held.claimId, null, B)).data.claim.sponsor, 'Starbright Coffee Egypt');
  // an approved one stays a normal sponsor
  const again = (await call('GET', '/api/reviews', null, sao)).data.find(r => r.state === 'open' && r.sponsorName === 'Starbright Coffee Egypt');
  assert.equal((await call('POST', `/api/reviews/${again.id}/resolve`, { action: 'approve', reason: 'Different company' }, sao)).status, 200);
  assert.equal((await call('POST', '/api/claims', { name: 'Starbright Coffee Egypt', categoryId: cats.Other }, C)).data.error, 'This sponsor is currently unavailable.');
});

test('first time signing in: SAO adds only the email, the rep chooses a password', async () => {
  const club = clubs.find(c => c.name === 'GDG GUC');
  assert.equal((await call('POST', '/api/users', { name: 'New Rep', email: 'New.Rep@club.test', role: 'rep', clubId: club.id }, sao)).status, 200);
  const u = (await call('GET', '/api/users', null, sao)).data.find(x => x.email === 'new.rep@club.test');
  assert.equal(u.setUp, false);
  // signing in normally explains what to do
  const early = await call('POST', '/api/login', { email: 'new.rep@club.test', password: 'whatever1' });
  assert.equal(early.status, 401); assert.equal(early.data.code, 'not-set-up');
  assert.equal((await call('POST', '/api/first-time/check', { email: ' NEW.rep@club.test ' })).data.state, 'set-password');
  assert.equal((await call('POST', '/api/first-time/password', { email: 'new.rep@club.test', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/first-time/password', { email: 'new.rep@club.test', password: 'Chosen123', confirm: 'Chosen124' })).status, 400);
  const done = await call('POST', '/api/first-time/password', { email: 'new.rep@club.test', password: 'Chosen123', confirm: 'Chosen123' });
  assert.equal(done.status, 200); assert.ok(done.data.token);
  assert.equal((await call('GET', '/api/session', null, done.data.token)).data.user.clubId, club.id);
  // nobody can set it a second time
  assert.equal((await call('POST', '/api/first-time/password', { email: 'new.rep@club.test', password: 'Hijack123' })).status, 409);
  assert.equal((await call('POST', '/api/first-time/check', { email: 'new.rep@club.test' })).data.state, 'already');
  assert.equal((await call('POST', '/api/login', { email: 'new.rep@club.test', password: 'Chosen123' })).status, 200);
  // forgotten password: SAO sends them back through first-time sign-in
  assert.equal((await call('POST', `/api/users/${u.id}`, { name: 'New Rep', email: 'new.rep@club.test', role: 'rep', clubId: club.id, resetToFirstTime: true }, sao)).status, 200);
  assert.ok(!(await call('GET', '/api/session', null, done.data.token)).data.user);   // signed out everywhere
  assert.equal((await call('POST', '/api/first-time/check', { email: 'new.rep@club.test' })).data.state, 'set-password');
});

test('first time signing in with an unknown email sends an access request to SAO', async () => {
  const club = clubs.find(c => c.name === 'TEDxGUC');
  const chk = (await call('POST', '/api/first-time/check', { email: 'stranger@club.test' })).data;
  assert.equal(chk.state, 'unknown'); assert.ok(chk.clubs.some(c => c.id === club.id));
  assert.equal((await call('POST', '/api/first-time/request', { email: 'stranger@club.test', name: 'S', clubId: club.id })).status, 400);
  assert.equal((await call('POST', '/api/first-time/request', { email: 'stranger@club.test', name: 'Sara Stranger', clubId: club.id, message: 'New TEDx rep' })).status, 200);
  assert.equal((await call('POST', '/api/first-time/check', { email: 'stranger@club.test' })).data.state, 'pending');
  // SAO sees it, with a notification and a count
  const s = (await call('GET', '/api/session', null, sao)).data;
  assert.ok(s.openAccess >= 1);
  assert.ok((await call('GET', '/api/notices', null, sao)).data.some(n => n.text.includes('stranger@club.test')));
  const req = (await call('GET', '/api/access-requests', null, sao)).data.find(r => r.email === 'stranger@club.test');
  assert.equal(req.club, 'TEDxGUC');
  // clubs cannot see or answer requests
  assert.equal((await call('GET', '/api/access-requests', null, A)).status, 403);
  assert.equal((await call('POST', `/api/access-requests/${req.id}/approve`, {}, A)).status, 403);
  assert.equal((await call('POST', `/api/access-requests/${req.id}/approve`, {}, sao)).status, 200);
  assert.equal((await call('POST', '/api/first-time/check', { email: 'stranger@club.test' })).data.state, 'set-password');
  const tok = (await call('POST', '/api/first-time/password', { email: 'stranger@club.test', password: 'Stranger1' })).data.token;
  assert.equal((await call('GET', '/api/session', null, tok)).data.user.clubId, club.id);
  // a declined request: the person can see the reason and ask again
  await call('POST', '/api/first-time/request', { email: 'nope@club.test', name: 'No Body', clubId: club.id }, null);
  const r2 = (await call('GET', '/api/access-requests', null, sao)).data.find(r => r.email === 'nope@club.test');
  assert.equal((await call('POST', `/api/access-requests/${r2.id}/decline`, { reason: 'Not a member' }, sao)).status, 200);
  const again = (await call('POST', '/api/first-time/check', { email: 'nope@club.test' })).data;
  assert.equal(again.state, 'unknown'); assert.equal(again.declined.reason, 'Not a member');
  // an email that already has an account cannot send a request
  assert.equal((await call('POST', '/api/first-time/request', { email: 'a@club.test', name: 'Imposter', clubId: club.id })).status, 409);
});

test('a new sponsor needs its Instagram profile link; the same account can never be added twice', async () => {
  const add = (instagram, name = 'Link Rule Co') => call('POST', '/api/claims', { name, categoryId: cats.Other, instagram }, B);
  for (const [ig, why] of [['', 'missing'], ['@linkruleco', 'just the @name'], ['linkruleco', 'bare name'], ['https://www.instagram.com/p/Cabc/', 'a post'],
    ['https://www.instagram.com/stories/linkruleco/', 'a story'], ['https://example.com/linkruleco', 'another website']]) {
    const r = await add(ig);
    assert.equal(r.status, 400, why); assert.equal(r.data.field, 'instagram', why);
  }
  assert.equal((await add('https://www.instagram.com/linkruleco/')).data.result, 'reserved');
  // another club: a different name with the same account, in any link form, is blocked
  for (const ig of ['https://instagram.com/LinkRuleCo', 'instagram.com/linkruleco?igsh=xyz', 'https://m.instagram.com/linkruleco/']) {
    const r = await call('POST', '/api/claims', { name: 'Different Name Entirely', categoryId: cats.Other, instagram: ig }, C);
    assert.equal(r.status, 409, ig); assert.equal(r.data.error, 'This sponsor is currently unavailable.');
  }
  // the same name with another account is blocked too, because a club holds that name
  assert.equal((await call('POST', '/api/claims', { name: 'Link Rule Co', categoryId: cats.Other, instagram: 'https://www.instagram.com/linkrule_egypt' }, C)).status, 409);
  // choosing an existing sponsor from the suggestions needs no link
  const free = (await call('GET', '/api/sponsors/search?q=Starbright', null, C)).data.find(s => s.available);
  if (free) assert.notEqual((await call('POST', '/api/claims', { sponsorId: free.id }, C)).status, 400);
});

// ---------- club room booking ----------
const today = () => new Date(clock).toISOString().slice(0, 10);
const nextDay = (want, after = 1) => { let d = Date.parse(today() + 'T12:00:00Z') + after * 86400000; while (new Date(d).getUTCDay() !== want) d += 86400000; return new Date(d).toISOString().slice(0, 10); };
const asDMY = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
let cal, room, MON;
test('rooms: the calendar is public and starts with the rooms and slot times', async () => {
  MON = nextDay(1);
  cal = (await call('GET', '/api/rooms/calendar?from=' + MON + '&to=' + MON)).data;
  assert.deepEqual(cal.slots.map(s => [s.id, s.maxPerDay, s.start, s.end]), [['after', 2, '17:30', '20:00'], ['fifth', 5, '15:15', '17:30']]);
  assert.equal(cal.rooms.filter(r => r.afterHours).length, 9);
  assert.ok(cal.rooms.some(r => r.code === 'H10' && r.fifth && !r.afterHours));
  room = code => cal.rooms.find(r => r.code === code).id;
});

test('rooms: a site made with the first placeholder times moves to the confirmed ones, once', async () => {
  const { createDb } = await import('../supabase/functions/_shared/core/db.mjs');
  const { seedRooms } = await import('../supabase/functions/_shared/core/rooms.mjs');
  const drv = sqliteDriver(':memory:');
  await createApp({ driver: drv }).ready();
  const db = createDb(drv);
  await db.q("INSERT INTO sp_clubs (id, name, active, sort) VALUES ('c1', 'Old Club', 1, 0)");
  await db.q(`INSERT INTO sp_slots (id, name, start_time, end_time, max_per_day, sort) VALUES ('fifth', 'Fifth slot', '15:45', '18:30', 5, 0), ('after', 'After hours', '18:30', '21:30', 2, 1)`);
  await db.q(`INSERT INTO sp_bookings (id, date, room_id, slot_id, club_id, start_time, end_time, active, created_at) VALUES ('b1', '2026-11-09', 'r', 'fifth', 'c1', '16:30', '18:30', 1, 0)`);
  await db.q(`INSERT INTO sp_bookings (id, date, room_id, slot_id, club_id, start_time, end_time, active, created_at) VALUES ('b2', '2026-11-09', 'r2', 'fifth', 'c1', '15:45', '18:30', 1, 0)`);
  await db.meta('rooms_v1', '1');
  await db.tx(() => seedRooms(db));
  const s = await db.q('SELECT id, start_time, end_time FROM sp_slots ORDER BY sort');
  assert.deepEqual(s.map(x => [x.id, x.start_time, x.end_time]), [['after', '17:30', '20:00'], ['fifth', '15:15', '17:30']]);
  assert.equal((await db.one(`SELECT end_time FROM sp_bookings WHERE id = 'b1'`)).end_time, '17:30');
  const b2 = await db.one(`SELECT start_time, end_time FROM sp_bookings WHERE id = 'b2'`);
  assert.deepEqual([b2.start_time, b2.end_time], ['15:15', '17:30']);   // whole old slot -> whole new slot
  // SAO changes the times later: they are not reset
  await db.q(`UPDATE sp_slots SET start_time = '17:00' WHERE id = 'after'`);
  await db.tx(() => seedRooms(db));
  assert.equal((await db.one(`SELECT start_time FROM sp_slots WHERE id = 'after'`)).start_time, '17:00');
});

test('rooms: one club per room per slot, and the blocked club is told who has it', async () => {
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.101'), purpose: 'Weekly meeting' }, A)).status, 200);
  const b = await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.101') }, B);
  assert.equal(b.status, 409); assert.equal(b.data.code, 'taken');
  assert.ok(b.data.error.includes(clubs[0].name)); assert.ok(b.data.suggest.length && !b.data.suggest.includes('C5.101'));
  // the same room in the other slot is a different booking
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room('C5.101') }, B)).status, 200);
});

test('rooms: at most 2 after-hours and 5 fifth-slot rooms per club per day, counted separately', async () => {
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.102') }, A)).status, 200);
  const third = await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.104') }, A);
  assert.equal(third.status, 409); assert.equal(third.data.code, 'limit'); assert.match(third.data.error, /already has 2 after-hours rooms/);
  for (const c of ['C5.201', 'C5.202', 'C5.203', 'C5.204', 'C5.205'])
    assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room(c) }, A)).status, 200, c);
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room('C5.206') }, A)).data.code, 'limit');
  // another day starts fresh
  assert.equal((await call('POST', '/api/bookings', { date: nextDay(2), slotId: 'after', roomId: room('C5.104') }, A)).status, 200);
});

test('rooms: days, rooms and times that cannot be booked', async () => {
  const bad = async (b, re) => { const r = await call('POST', '/api/bookings', b, C); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad({ date: nextDay(4), slotId: 'after', roomId: room('C5.105') }, /only be booked on Sun, Mon, Tue, Wed/);
  await bad({ date: '2026-08-02', slotId: 'after', roomId: room('C5.105') }, /open from 13\/09\/2026/);
  await bad({ date: MON, slotId: 'after', roomId: room('C5.201') }, /can't be booked for the after hours/);
  await bad({ date: MON, slotId: 'fifth', roomId: room('C5.105'), start: '12:00', end: '13:00' }, /choose times inside it/);
  await bad({ date: MON, slotId: 'fifth', roomId: room('C5.105'), start: '17:00', end: '16:30' }, /end time must be after/);
  const ok = await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room('C5.105'), start: '16:00', end: '17:00' }, C);
  assert.equal(ok.status, 200);
  // reps never choose the club: it comes from the account
  const sneaky = await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room('C5.106'), clubId: clubs[0].id }, C);
  assert.equal((await call('GET', '/api/rooms/calendar?from=' + MON + '&to=' + MON)).data.bookings.find(b => b.id === sneaky.data.id).clubId, clubs[2].id);
});

test('rooms: reps grabbing the same room at the same moment, only one wins', async () => {
  const res = await Promise.all([A, B, C].map(t => call('POST', '/api/bookings', { date: nextDay(3), slotId: 'after', roomId: room('H12') }, t)));
  assert.equal(res.filter(r => r.status === 200).length, 1);
});

test('rooms: SAO can override a limit, block rooms (which cancels bookings) and see who booked', async () => {
  const over = { date: MON, slotId: 'after', roomId: room('C5.104'), clubId: clubs[0].id };
  assert.equal((await call('POST', '/api/bookings', over, sao)).data.code, 'limit');
  const ok = await call('POST', '/api/bookings', { ...over, override: true }, sao);
  assert.equal(ok.status, 200);
  const c = (await call('GET', '/api/rooms/calendar?from=' + MON + '&to=' + MON, null, sao)).data;
  assert.equal(c.bookings.find(b => b.id === ok.data.id).override, true);
  assert.ok(c.bookings.every(b => 'by' in b));
  assert.ok((await call('GET', '/api/rooms/calendar?from=' + MON + '&to=' + MON)).data.bookings.every(b => !('by' in b)));   // public: no personal details
  // block C5.102 on Monday: club A's booking there is cancelled and the club is told
  const blk = await call('POST', '/api/blocks', { date: MON, roomId: room('C5.102'), reason: 'Exam' }, sao);
  assert.equal(blk.data.cancelled, 1);
  assert.ok((await call('GET', '/api/notices', null, A)).data.some(n => /C5\.102.*blocked it: Exam/.test(n.text)));
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.102') }, B)).data.code, 'blocked');
  // clubs cannot block or manage rooms
  assert.equal((await call('POST', '/api/blocks', { date: MON, reason: 'mine' }, A)).status, 403);
  assert.equal((await call('POST', '/api/rooms', { code: 'X1', afterHours: true }, A)).status, 403);
});

test('rooms: a club cancels its own booking (freeing the room at once), never another club\'s', async () => {
  const mine = (await call('GET', '/api/bookings/mine', null, A)).data.find(b => b.room === 'C5.101' && b.slotId === 'after' && b.active);
  const other = (await call('GET', '/api/bookings/mine', null, B)).data.find(b => b.active);
  assert.equal((await call('POST', '/api/bookings/' + other.id + '/cancel', {}, A)).status, 403);
  assert.equal((await call('POST', '/api/bookings/' + mine.id + '/cancel', {}, A)).status, 200);
  assert.equal((await call('POST', '/api/bookings', { date: MON, slotId: 'after', roomId: room('C5.101') }, B)).status, 200);
  // the cancelled booking is kept (never deleted)
  assert.ok((await call('GET', '/api/bookings/mine', null, A)).data.some(b => b.id === mine.id && !b.active));
});

test('rooms: CSV in the sheet layout, and the security sheet gets a fresh copy after each change', async () => {
  const csv = (await call('GET', '/api/rooms/export.csv', null, sao)).data;
  const head = csv.split('\r\n')[0];
  assert.match(head, /Date,Day,C5\.101,C5\.102/); assert.match(head, /Fifth slot 1/);
  // a pretend Google Sheet that records what it receives
  const http = await import('node:http');
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b)); res.end('{"ok":true}'); }); });
  await new Promise(r => srv.listen(0, r));
  const { createDb } = await import('../supabase/functions/_shared/core/db.mjs');
  await createDb(driver).meta('sheet_url', 'http://127.0.0.1:' + srv.address().port + '/');
  const set = (await call('GET', '/api/rooms-settings', null, sao)).data;
  const sy = await call('POST', '/api/rooms-sheet/sync', {}, sao);
  assert.equal(sy.data.ok, true, JSON.stringify(sy));
  assert.equal(got[0].secret, set.sheetSecret);
  assert.deepEqual(got[0].tabs.map(t => t.name), ['Today', 'Next 7 days', 'After hours', 'Fifth slot']);
  const grid = got[0].tabs.find(t => t.name === 'After hours');
  const monRow = grid.rows.find(r => r[0].endsWith(asDMY(MON)));
  assert.equal(monRow[grid.header.indexOf('C5.101')], clubs[1].name);
  assert.equal(monRow[grid.header.indexOf('C5.102')], 'Blocked');
  assert.equal(grid.rows.length, grid.bg.length);
  // a booking updates the sheet by itself
  got.length = 0;
  await call('POST', '/api/bookings', { date: MON, slotId: 'fifth', roomId: room('H10') }, B);
  await Promise.all(pending.splice(0));
  assert.equal(got.length, 1);
  assert.ok(got[0].tabs[3].rows.some(r => r.includes(clubs[1].name)));
  // the sheet can fetch its copy with the key, and only with it
  assert.equal((await call('GET', '/api/rooms-sheet/data?secret=wrong')).status, 403);
  assert.equal((await call('GET', '/api/rooms-sheet/data?secret=' + set.sheetSecret)).data.tabs.length, 4);
  srv.close();
});

test('the logo update fills missing logos only, and keeps an uploaded one', async () => {
  const { createDb } = await import('../supabase/functions/_shared/core/db.mjs');
  const { syncClubs } = await import('../supabase/functions/_shared/core/setup.mjs');
  const driver = sqliteDriver(':memory:');
  await createApp({ driver }).ready();
  const db = createDb(driver);
  await db.q("INSERT INTO sp_clubs (id, name, active, sort) VALUES ('a', 'Cura', 1, 0)");
  await db.q("INSERT INTO sp_clubs (id, name, active, sort, logo_data) VALUES ('b', 'Qubit GUC', 1, 1, 'data:image/png;base64,AA==')");
  await db.meta('clubs_guide_2026', '1');   // a site that already had the first update
  await db.tx(() => syncClubs(db));
  const rows = await db.q('SELECT id, logo FROM sp_clubs ORDER BY id');
  assert.equal(rows.length, 2);   // no clubs added
  assert.equal(rows[0].logo, 'assets/clubs/cura.png');
  assert.equal(rows[1].logo, null);   // the uploaded logo still wins
});

test('matching rules', async () => {
  assert.equal(normName('Pepsi Co.'), normName('pepsico'));
  assert.ok(possibleMatch('Vodafone', 'Vodafone Cash'));
  assert.ok(possibleMatch('Juhayna', 'Juhaina'));
  assert.ok(possibleMatch('Orange Egypt', 'Orange'));
  assert.equal(possibleMatch('Orange', 'Etisalat'), null);
  assert.equal(possibleMatch('CIB', 'NBE'), null);
  assert.equal(parseInstagram('https://instagram.com/p/abc').error ? 1 : 0, 1);
  assert.equal(parseInstagram('instagram.com/Pepsi_Egypt?igsh=1').handle, 'pepsi_egypt');
  assert.ok(parseInstagram('bad handle!').error);
});

test('Cairo dates: 14 calendar days at the same local time', () => {
  const start = Date.parse('2026-04-20T10:00:00Z');   // crosses the late-April clock change in Egypt
  const end = addLocalDays(start, 14);
  const local = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false });
  assert.equal(local(end).split(', ')[1], local(start).split(', ')[1]);
  assert.equal(local(end).split(', ')[0], '04/05/2026');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n').join('\n       ')); }
}
console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} passed`);
process.exit(failed ? 1 : 0);
