// Demo run: 17 club reps and an SAO Head use the site at the same time, then everything is checked.
// Start a fresh server with an empty data folder first, e.g.  SP_DATA_DIR=demo-data PORT=5175 node server.js
// then:  npm run demo -- http://localhost:5175 demo-data/sponsors.db
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const BASE = process.argv[2] || 'http://localhost:5175';
const DB = process.argv[3];
const problems = [], notes = [];
const bug = (area, msg, extra) => { problems.push({ area, msg, extra }); console.log('  BUG  ' + area + ': ' + msg + (extra ? ' | ' + JSON.stringify(extra).slice(0, 300) : '')); };
const ok = msg => console.log('  ok   ' + msg);
const slow = [];
const seen = new Map();   // rep email -> every response body they received (for the privacy check)

async function call(method, path, body, who) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(who?.token ? { Authorization: 'Bearer ' + who.token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const ms = Date.now() - t0;
  if (ms > 2000) slow.push({ path, ms });
  const text = await r.text();
  if (who?.email && who.role === 'rep') { if (!seen.has(who.email)) seen.set(who.email, []); seen.get(who.email).push(text); }
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status >= 500) bug('server', `${method} ${path} -> ${r.status}`, data);
  return { status: r.status, data };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const shuffle = (a, seed) => { const b = [...a]; let s = seed; for (let i = b.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor(s / 233280 * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const BRANDS = ['Coca-Cola', 'Etisalat by e&', 'WE', 'NBE', 'Banque Misr', 'QNB', 'HSBC Egypt', 'Edita', 'Chipsy', 'Molto', 'Domty', 'Costa Coffee',
  'Starbucks', "Dunkin'", 'KFC', "McDonald's", "Papa John's", 'Breadfast', 'Rabbit', 'Noon', 'Jumia', 'Uber', 'inDrive', 'Careem', 'Valu', 'Fawry', 'Paymob',
  'Khazna', 'MNT-Halan', 'El Sewedy Electric', 'Orascom', 'Hassan Allam', 'Palm Hills', 'SODIC', 'Mountain View', 'Adidas', 'Nike', 'Puma', 'Defacto',
  'LC Waikiki', 'H&M', 'Zara', 'Samsung', 'Oppo', 'Xiaomi', 'Huawei', 'Dell', 'HP', 'Lenovo', 'Microsoft', 'Google', 'IBM', 'Valeo', 'Siemens',
  'Schneider Electric', 'Pharco', 'EVA Pharma', 'Hikma', 'Seoudi', 'Carrefour', 'Spinneys', 'Metro Market', 'Hyper One', 'B.TECH', 'Raya', '2B',
  'Cairo Festival City', 'Mall of Egypt', 'City Stars', 'Vox Cinemas', 'Watch It', 'Shahid', 'Anghami', 'Netflix', "Gold's Gym", 'Cinnabon', 'Baskin Robbins',
  'Bazooka', 'Buffalo Burger', 'Mo\'men', 'Gad', 'Abou Shakra', 'Zooba', 'Sachi', 'Lychee', 'Tabali', 'Crave', 'Eish + Malh', 'Brgr', 'Mince'];
const LOOKALIKES = ['Coca Cola Egypt', 'Starbuck', 'Samsung Electronics', 'Noon Egypt', 'Jumia Food', 'Uber Eats', 'Fawry Pay', 'Adiddas', 'Carefour', 'KFC Egypt'];

(async () => {
  console.log('\n== Setup (SAO Head + demo data) ==');
  let r = await call('POST', '/api/setup', { name: 'Demo SAO Head', email: 'sao.head@demo.test', password: 'Head12345', demo: true });
  if (r.status !== 200) { console.log('setup failed', r); process.exit(1); }
  const sao = { token: r.data.token, role: 'sao', email: 'sao.head@demo.test' };
  const pub = (await call('GET', '/api/session')).data;
  const sess = (await call('GET', '/api/session', null, sao)).data;
  const clubs = sess.clubs, cats = sess.categories;
  const catId = n => cats.find(c => c.name === n)?.id || cats[0].id;
  ok(`${clubs.length} clubs, ${cats.length} categories, ${pub.demo.accounts.length} demo accounts listed on sign-in`);

  // 17 reps, one per club, in club order
  const reps = [];
  for (const c of clubs.slice(0, 17)) {
    const u = (await call('GET', '/api/users', null, sao)).data.find(x => x.clubId === c.id);
    const l = await call('POST', '/api/login', { email: u.email, password: 'Demo1234' });
    if (l.status !== 200) { bug('login', `${u.email} could not sign in`, l.data); continue; }
    reps.push({ token: l.data.token, role: 'rep', email: u.email, club: c });
  }
  ok(`${reps.length} reps signed in`);

  console.log('\n== 1. All 17 clubs reserve the same new sponsor at the same moment ==');
  const race = await Promise.all(reps.map(rp => call('POST', '/api/claims', { name: 'Lunar Labs', categoryId: catId('Technology') }, rp)));
  const wins = race.filter(x => x.status === 200).length;
  wins === 1 ? ok('exactly 1 club got it, 16 were told "unavailable"') : bug('race', `${wins} clubs got the same sponsor`);
  const msgs = new Set(race.filter(x => x.status !== 200).map(x => x.data.error));
  msgs.size === 1 && msgs.has('This sponsor is currently unavailable.') ? ok('losers all saw the generic message') : bug('race', 'unexpected messages', [...msgs]);
  // spelling variants at the same time
  const race2 = await Promise.all(reps.map((rp, i) => call('POST', '/api/claims', { name: ['Nile Ventures', 'NILE  VENTURES', 'nile-ventures', 'Nile Ventures.'][i % 4], categoryId: catId('Banking and Finance') }, rp)));
  const w2 = race2.filter(x => x.status === 200 && x.data.result === 'reserved').length;
  w2 === 1 ? ok('spelling variants racing: 1 winner') : bug('race', `spelling variants: ${w2} winners`, race2.map(x => x.data.result || x.data.error));

  console.log('\n== 2. Every club adds 8-12 sponsors in parallel (lots of overlap) ==');
  const results = { reserved: 0, review: 0, unavailable: 0, own: 0, other: [] };
  await Promise.all(reps.map(async (rp, i) => {
    const mine = shuffle(BRANDS, i + 7).slice(0, 8 + (i % 5));
    for (const [k, name] of mine.entries()) {
      // look the name up first, like the page does while typing
      await call('GET', '/api/sponsors/search?q=' + encodeURIComponent(name.slice(0, 4)), null, rp);
      const body = { name, categoryId: cats[(i + k) % cats.length].id, notes: `Contact via ${['email', 'LinkedIn', 'a friend', 'their booth'][k % 4]}` };
      if (k % 3 === 0) body.instagram = '@' + name.toLowerCase().replace(/[^a-z0-9]/g, '') + 'eg';
      const x = await call('POST', '/api/claims', body, rp);
      if (x.status === 200) results[x.data.result]++;
      else if (x.data.code) results[x.data.code] = (results[x.data.code] || 0) + 1;
      else results.other.push({ name, status: x.status, error: x.data.error });
    }
  }));
  ok(`reserved ${results.reserved}, held for review ${results.review}, unavailable ${results.unavailable}, already own ${results.own || 0}`);
  if (results.other.length) bug('add', 'unexpected answers while adding normal sponsors', results.other.slice(0, 5));

  console.log('\n== 3. Look-alike names and Instagram tricks ==');
  for (const [i, name] of LOOKALIKES.entries()) {
    const rp = reps[(i * 5) % reps.length];
    const x = await call('POST', '/api/claims', { name, categoryId: catId('Other') }, rp);
    notes.push(`"${name}" by ${rp.club.name}: ${x.data.result || x.data.error}`);
  }
  ok('look-alikes: ' + notes.splice(0).map(n => n.split(': ')[1]).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}) && 'done');
  const ig = [
    ['IG same handle, different name', { name: 'Totally Different Co', instagram: '@lunarlabs_test' }],
    ['IG post link', { name: 'Post Link Co', instagram: 'https://www.instagram.com/p/Cxyz123/' }],
    ['IG with spaces', { name: 'Space Handle Co', instagram: '@bad handle' }],
    ['IG website instead', { name: 'Website Co', instagram: 'www.example.com' }],
    ['IG profile link with query', { name: 'Query Link Co', instagram: 'https://instagram.com/QueryLinkCo?igsh=abc' }],
  ];
  // give Lunar Labs an Instagram first via SAO edit, then test the duplicate handle
  const lunar = (await call('GET', '/api/sponsors', null, sao)).data.find(s => s.name === 'Lunar Labs');
  await call('POST', '/api/sponsors/' + lunar.id, { name: 'Lunar Labs', categoryId: lunar.categoryId, instagram: '@lunarlabs_test', aliases: [] }, sao);
  for (const [label, b] of ig) {
    const x = await call('POST', '/api/claims', { ...b, categoryId: catId('Other') }, reps[16]);
    const want = { 'IG same handle, different name': 409, 'IG post link': 400, 'IG with spaces': 400, 'IG website instead': 400, 'IG profile link with query': 200 }[label];
    x.status === want ? ok(`${label}: ${x.status} ${x.data.error || x.data.result}`) : bug('instagram', `${label}: expected ${want}, got ${x.status}`, x.data);
  }

  console.log('\n== 4. Odd inputs ==');
  const odd = [
    ['empty name', { name: '', categoryId: catId('Other') }, 400],
    ['spaces only', { name: '    ', categoryId: catId('Other') }, 400],
    ['punctuation only', { name: '!!!', categoryId: catId('Other') }, 400],
    ['101 characters', { name: 'A'.repeat(101), categoryId: catId('Other') }, 400],
    ['no category', { name: 'No Category Co' }, 400],
    ['made-up category', { name: 'Fake Category Co', categoryId: 'nope' }, 400],
    ['script tag', { name: '<script>alert("x")</script> Hackers', categoryId: catId('Other'), notes: '<img src=x onerror=alert(1)>' }, 200],
    ['Arabic name', { name: 'بنك مصر للتجارة', categoryId: catId('Banking and Finance') }, 200],
    ['emoji', { name: '🍕 Pizza Station', categoryId: catId('Food and Beverage') }, 200],
    ['1000-char notes', { name: 'Long Notes Co', categoryId: catId('Other'), notes: 'n'.repeat(1000) }, 200],
    ['1001-char notes (cut to 1000)', { name: 'Longer Notes Co', categoryId: catId('Other'), notes: 'n'.repeat(1001) }, 200],
    ['not JSON body fields', { name: 12345, categoryId: catId('Other') }, 400],
  ];
  for (const [label, b, want] of odd) {
    const x = await call('POST', '/api/claims', b, reps[15]);
    const good = x.status === want || (want === 200 && x.status === 200);
    good ? ok(`${label}: ${x.status} ${x.data.error || x.data.result}`) : bug('input', `${label}: expected ${want}, got ${x.status}`, x.data);
  }
  const arab = (await call('GET', '/api/sponsors/search?q=' + encodeURIComponent('بنك مصر'), null, reps[2])).data;
  arab.some(s => s.name.startsWith('بنك مصر')) ? ok('Arabic name can be found by search') : bug('search', 'Arabic name not found by search', arab);
  const arab2 = await call('POST', '/api/claims', { name: 'بنك  مصر للتجارة', categoryId: catId('Banking and Finance') }, reps[3]);
  arab2.status === 409 ? ok('same Arabic name with extra space is blocked') : bug('match', 'Arabic duplicate not blocked', arab2.data);

  console.log('\n== 5. Status updates, dates, notes ==');
  let statusChecks = 0;
  await Promise.all(reps.map(async (rp, i) => {
    const mine = (await call('GET', '/api/claims?status=active', null, rp)).data;
    for (const [k, c] of mine.entries()) {
      if (c.status !== 'reserved') continue;
      if (k === 0) {
        const fut = await call('POST', `/api/claims/${c.id}/status`, { status: 'contacted', contactDate: '2099-01-01' }, rp);
        if (fut.status !== 400) bug('status', 'future contact date accepted', fut.data);
        const past = await call('POST', `/api/claims/${c.id}/status`, { status: 'contacted', contactDate: '2020-01-01' }, rp);
        if (past.status !== 400) bug('status', 'contact date before the reservation accepted', past.data);
        const none = await call('POST', `/api/claims/${c.id}/status`, { status: 'contacted' }, rp);
        if (none.status !== 400) bug('status', 'contact without a date accepted', none.data);
      }
      const to = ['contacted', 'negotiation', 'confirmed', 'contacted', 'rejected', 'released'][(i + k) % 6];
      const x = await call('POST', `/api/claims/${c.id}/status`, { status: to, contactDate: today(), note: `Moved to ${to}` }, rp);
      statusChecks++;
      if (x.status !== 200) bug('status', `reserved -> ${to} failed`, x.data);
      if (to === 'contacted' && k % 2 === 0) {
        const n = await call('POST', `/api/claims/${c.id}/note`, { text: 'Follow-up call booked' }, rp);
        if (n.status !== 200) bug('note', 'adding a note failed', n.data);
        const back = await call('POST', `/api/claims/${c.id}/status`, { status: 'reserved' }, rp);
        if (back.status !== 400) bug('status', 'rep moved a claim back to Reserved', back.data);
      }
    }
  }));
  ok(`${statusChecks} status changes made`);

  console.log('\n== 6. Privacy and access between clubs ==');
  const aClaims = (await call('GET', '/api/claims', null, reps[0])).data;
  const bClaims = (await call('GET', '/api/claims', null, reps[1])).data;
  aClaims.every(c => c.clubId === reps[0].club.id) ? ok("a club's list only has its own sponsors") : bug('privacy', 'club list contains other clubs');
  const target = bClaims[0];
  for (const [label, m, p, b] of [['open', 'GET', `/api/claims/${target.id}`], ['update', 'POST', `/api/claims/${target.id}/status`, { status: 'released' }],
    ['note', 'POST', `/api/claims/${target.id}/note`, { text: 'hi' }], ['delete', 'POST', `/api/claims/${target.id}/delete`],
    ['filter by club', 'GET', `/api/claims?club=${reps[1].club.id}`], ['dashboard', 'GET', '/api/dashboard'], ['export', 'GET', '/api/export.csv'],
    ['users', 'GET', '/api/users'], ['reviews', 'GET', '/api/reviews'], ['registry', 'GET', '/api/sponsors'], ['audit', 'GET', '/api/audit'],
    ['delete sponsor', 'POST', `/api/sponsors/${target.sponsorId}/delete`], ['assign', 'POST', `/api/sponsors/${target.sponsorId}/assign`, { clubId: reps[0].club.id, reason: 'mine' }],
    ['settings', 'POST', '/api/settings', { maxActive: 200 }], ['logo', 'POST', `/api/clubs/${reps[1].club.id}/logo`, { data: null }]]) {
    const x = await call(m, p, b, reps[0]);
    const blocked = x.status === 403 || (label === 'filter by club' && Array.isArray(x.data) && x.data.every(c => c.clubId === reps[0].club.id));
    blocked ? ok(`another club's ${label}: refused`) : bug('access', `club A could ${label} club B's data`, { status: x.status });
  }

  console.log('\n== 7. Requests to SAO and the 20-sponsor limit ==');
  for (const rp of reps.slice(0, 5)) {
    const x = await call('POST', '/api/requests', { sponsorName: 'Lunar Labs', message: 'We have worked with Lunar Labs for two years.' }, rp);
    if (x.status !== 200) bug('request', 'sending a request failed', x.data);
  }
  const big = reps[16];
  let held = (await call('GET', '/api/claims?status=active', null, big)).data.length, n = 0, limitHit = false;
  while (held < 25 && n < 40) {
    const x = await call('POST', '/api/claims', { name: `Limit Brand ${String.fromCharCode(65 + n)}${n * 37} Holdings Unit${n}`, categoryId: catId('Other') }, big);
    n++;
    if (x.status === 200) held++;
    else if (x.data.code === 'limit') { limitHit = true; break; }
  }
  limitHit && held === 20 ? ok('limit: stopped at 20 active sponsors') : bug('limit', `limit not enforced as expected (held ${held}, hit ${limitHit})`);
  const own = (await call('GET', '/api/claims?status=active', null, big)).data[0];
  await call('POST', `/api/claims/${own.id}/delete`, null, big);
  const after = await call('POST', '/api/claims', { name: 'After Delete Brand', categoryId: catId('Other') }, big);
  after.status === 200 ? ok('deleting one frees a place') : bug('limit', 'could not add after deleting', after.data);

  console.log('\n== 8. SAO works the queue ==');
  const reviews = (await call('GET', '/api/reviews', null, sao)).data;
  const dups = reviews.filter(x => x.kind === 'duplicate' && x.state === 'open'), reqs = reviews.filter(x => x.kind === 'request' && x.state === 'open');
  ok(`${dups.length} possible duplicates, ${reqs.length} club requests waiting`);
  for (const [i, rv] of dups.entries()) {
    const action = ['approve', 'merge', 'reject'][i % 3];
    const body = { action, reason: `Demo decision ${i}` };
    if (action === 'merge') body.targetId = rv.detail.candidates.find(c => !c.gone)?.id;
    if (action === 'approve' && rv.detail.conflict) body.action = 'reject';
    const x = await call('POST', `/api/reviews/${rv.id}/resolve`, body, sao);
    if (x.status !== 200) bug('review', `${body.action} failed`, x.data);
  }
  for (const rq of reqs.slice(0, 3)) {
    const x = await call('POST', `/api/reviews/${rq.id}/resolve`, { action: 'close', reason: 'Lunar Labs stays with its current club.' }, sao);
    if (x.status !== 200) bug('request', 'answering failed', x.data);
  }
  // reassign Lunar Labs to the club that asked first
  const asg = await call('POST', `/api/sponsors/${lunar.id}/assign`, { clubId: reps[1].club.id, status: 'contacted', reason: 'Long-standing relationship' }, sao);
  asg.status === 200 || asg.status === 409 ? ok('reassign Lunar Labs: ' + (asg.data.error || 'done')) : bug('assign', 'reassign failed', asg.data);
  const one = (await call('GET', '/api/claims?status=reserved', null, sao)).data[0];
  if (one) {
    const e = await call('POST', `/api/claims/${one.id}/extend`, { days: 7, reason: 'Exam week' }, sao);
    e.status === 200 ? ok('extend a reservation') : bug('extend', 'failed', e.data);
    const rl = await call('POST', `/api/claims/${one.id}/release`, { reason: 'Demo release' }, sao);
    rl.status === 200 ? ok('release a claim') : bug('release', 'failed', rl.data);
  }
  const csv = await call('GET', '/api/export.csv', null, sao);
  const all = (await call('GET', '/api/claims', null, sao)).data;
  const rows = String(csv.data).trim().split(/\r?\n/).length - 1;
  rows === all.length ? ok(`CSV export has all ${rows} claims`) : bug('export', `CSV has ${rows} rows but there are ${all.length} claims`);
  String(csv.data).includes("'=") || !all.some(c => /^[=+@-]/.test(c.sponsor)) ? ok('CSV is safe to open in Excel') : bug('export', 'formula not neutralised');

  console.log('\n== 9. Dashboard numbers vs the data ==');
  const d = (await call('GET', '/api/dashboard', null, sao)).data;
  const active = all.filter(c => c.active).length;
  d.activeClaims === active ? ok(`dashboard active claims = ${active}`) : bug('dashboard', `dashboard says ${d.activeClaims} active, list has ${active}`);
  const clubSum = d.clubs.reduce((a, c) => a + c.total, 0);
  clubSum === active ? ok('club tiles add up') : bug('dashboard', `club tiles add up to ${clubSum}, expected ${active}`);
  for (const rp of reps) {
    const mine = (await call('GET', '/api/claims?status=active', null, rp)).data.length;
    const tile = d.clubs.find(c => c.id === rp.club.id).total;
    if (mine !== tile) bug('dashboard', `${rp.club.name}: tile says ${tile}, club sees ${mine}`);
  }

  console.log('\n== 10. Privacy: did any club ever receive another club\'s name? ==');
  const names = clubs.map(c => c.name);
  let leaks = 0;
  for (const rp of reps) {
    const others = names.filter(nm => nm !== rp.club.name && nm.length > 4);
    for (const body of seen.get(rp.email) || []) for (const nm of others) {
      if (body.includes(`"${nm}"`) || body.includes(`held by ${nm}`) || body.includes(`club":"${nm}`)) { leaks++; if (leaks < 4) bug('privacy', `${rp.club.name} saw "${nm}"`, body.slice(0, 200)); }
    }
  }
  if (!leaks) ok('no club ever saw another club\'s name');

  if (DB) {
    console.log('\n== 11. Database checks ==');
    const db = new DatabaseSync(DB, { readOnly: true });
    const dbl = db.prepare('SELECT sponsor_id, COUNT(*) n FROM sp_claims WHERE active = 1 GROUP BY sponsor_id HAVING n > 1').all();
    dbl.length ? bug('db', 'a sponsor has two active claims', dbl) : ok('every sponsor has at most one active claim');
    const over = db.prepare(`SELECT c.club_id, COUNT(*) n FROM sp_claims c WHERE active = 1 GROUP BY club_id HAVING n > 20`).all();
    over.length ? notes.push('over 20 (allowed only through SAO assign): ' + JSON.stringify(over)) : ok('no club over 20');
    const orphanEv = db.prepare('SELECT COUNT(*) n FROM sp_events e LEFT JOIN sp_claims c ON c.id = e.claim_id WHERE c.id IS NULL').get().n;
    orphanEv ? bug('db', `${orphanEv} history lines without a claim`) : ok('no stray history lines');
    const orphanCl = db.prepare('SELECT COUNT(*) n FROM sp_claims c LEFT JOIN sp_sponsors s ON s.id = c.sponsor_id WHERE s.id IS NULL').get().n;
    orphanCl ? bug('db', `${orphanCl} claims point to a missing sponsor`) : ok('every claim has its sponsor');
    const merged = db.prepare("SELECT COUNT(*) n FROM sp_claims c JOIN sp_sponsors s ON s.id = c.sponsor_id WHERE c.active = 1 AND s.state <> 'active'").get().n;
    merged ? bug('db', `${merged} active claims on a merged sponsor`) : ok('no active claim on a merged sponsor');
    const pend = db.prepare("SELECT COUNT(*) n FROM sp_claims c WHERE c.status = 'pending_review' AND NOT EXISTS (SELECT 1 FROM sp_reviews r WHERE r.claim_id = c.id AND r.state = 'open')").get().n;
    pend ? bug('db', `${pend} claims stuck in Pending SAO Review with no open review`) : ok('every pending claim has an open review');
    const exp = db.prepare("SELECT COUNT(*) n FROM sp_claims WHERE status = 'reserved' AND expires_at IS NULL").get().n;
    exp ? bug('db', `${exp} reserved claims without a deadline`) : ok('every reserved claim has a deadline');
    const stuckAct = db.prepare("SELECT COUNT(*) n FROM sp_claims WHERE active = 1 AND status IN ('rejected','released','expired')").get().n;
    stuckAct ? bug('db', `${stuckAct} closed claims still marked active`) : ok('closed claims are not active');
  }

  console.log('\n== Summary ==');
  if (slow.length) console.log('  slow requests (>2 s):', slow.length, slow.slice(0, 3));
  else ok('no request took over 2 seconds');
  for (const n of notes) console.log('  note ' + n);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S) FOUND` : '\nNO PROBLEMS FOUND');
})().catch(e => { console.error('Run crashed:', e); process.exit(1); });
