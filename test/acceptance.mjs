// The acceptance tests from the requirements (section 11), plus a few more. Run: npm test
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createApp } from '../supabase/functions/_shared/core/app.mjs';
import { parseInstagram, possibleMatch, normName } from '../supabase/functions/_shared/core/match.mjs';
import { addLocalDays } from '../supabase/functions/_shared/core/time.mjs';
const { sqliteDriver } = createRequire(import.meta.url)('../scripts/sqlite-driver.js');

let clock = Date.parse('2026-11-05T10:00:00Z');
const DAY = 86400000;
const app = createApp({ driver: sqliteDriver(':memory:'), now: () => clock });

async function call(method, path, body, token) {
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
  for (const body of [{ name: 'BRAND-x.', categoryId: cats.Other }, { name: 'Totally Other Name', categoryId: cats.Other, instagram: '@BrandX.EG' }]) {
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
