// SAO Sponsors — the website. Talks to the server (supabase/functions/_shared/core/app.mjs) at window.SP_API.
// The server decides what each person may see and do; this page only shows what it is given.
'use strict';
const API = window.SP_API || '';
const TZ = 'Africa/Cairo';
const DAY = 86400000;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private window */ } },
};
let token = store.get('sp-token');
let S = null;            // the session: user, clubs, categories, statuses
let pollTimer = null;

// ---------- server ----------
async function api(method, path, body) {
  let r;
  try {
    r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw Object.assign(new Error('Can\'t reach the server. Check your connection and try again.'), { data: {} }); }
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && token && path !== '/api/login') { signedOut(); throw Object.assign(new Error('Please sign in again.'), { data }); }
  if (!r.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong.'), { status: r.status, data });
  return data;
}
const GET = p => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});
function signedOut() { token = null; store.set('sp-token', null); S = null; clearInterval(pollTimer); location.hash = '#/'; boot(); }

// ---------- formatting ----------
const fmtD = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fmtDT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const date = ms => ms ? fmtD.format(new Date(ms)) : '—';
const dateTime = ms => ms ? fmtDT.format(new Date(ms)) : '—';
const ymd = s => s ? fmtD.format(new Date(s + 'T12:00:00Z')) : '—';
function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + ' min ago';
  if (d < DAY) return Math.round(d / 3600000) + ' h ago';
  if (d < 7 * DAY) { const n = Math.round(d / DAY); return n + (n === 1 ? ' day ago' : ' days ago'); }
  return date(ms);
}
function left(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'ending now';
  if (d < DAY) return `${Math.max(1, Math.round(d / 3600000))} h left`;
  const n = Math.ceil(d / DAY);
  return `${n} day${n === 1 ? '' : 's'} left`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// ---------- icons and status chips (shape + colour + word) ----------
const I = {
  reserved: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  contacted: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4 7l8 6 8-6"/>',
  negotiation: '<path d="M4 9h14l-3-3M20 15H6l3 3"/>',
  confirmed: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pending_review: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>',
  rejected: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  released: '<circle cx="12" cy="12" r="7.5"/>',
  expired: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 5 8 4.5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 4.5-8 8.5s8 3.5 8 8.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c1.5-4 4.5-5.5 7.5-5.5s6 1.5 7.5 5.5"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  ig: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.8"/><path d="M17 7v.01"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  review: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/><path d="M9 12l2 2 4-4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5h6V7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
};
const svg = (name, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${I[name] || ''}</svg>`;
const label = st => (S && S.statuses && S.statuses[st]) || st;
const chip = st => `<span class="chip ${esc(st)}">${svg(st)}${esc(label(st))}</span>`;
const availChip = s => s.mine ? `<span class="chip mine">${svg('confirmed')}Your club</span>`
  : s.available ? `<span class="chip avail">${svg('confirmed')}Available</span>` : `<span class="chip unavail">${svg('lock')}Unavailable</span>`;
const igLink = h => h ? `<a href="https://www.instagram.com/${encodeURIComponent(h)}/" target="_blank" rel="noopener noreferrer">@${esc(h)}</a>` : '';
function deadline(c) {
  if (c.status === 'reserved' && c.expiresAt) {
    const soon = c.expiresAt - Date.now() < 3 * DAY;
    return `<span class="due ${soon ? 'soon' : ''}">${esc(left(c.expiresAt))}</span><div class="sub">until ${date(c.expiresAt)}</div>`;
  }
  if (c.firstContact) return `<span class="sub">First contact</span><div>${ymd(c.firstContact)}</div>`;
  if (c.status === 'pending_review') return '<span class="sub">Waiting for SAO</span>';
  return '<span class="sub">—</span>';
}

// ---------- small UI helpers ----------
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}
// A form in a dialog. onSubmit(values, dialog) may throw; its message shows in the dialog.
function dialog({ title, intro = '', body, submit = 'Save', key = false, danger = false, onSubmit }) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form novalidate><h2>${esc(title)}</h2>${intro ? `<p class="muted small">${intro}</p>` : ''}
    <div class="stack" style="margin-top:16px">${body}</div><p class="err" role="alert"></p>
    <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button>
    <button class="btn ${key ? 'key' : danger ? 'danger' : ''}">${esc(submit)}</button></div></form>`;
  document.body.appendChild(d);
  const form = $('form', d);
  $('[data-close]', d).onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('.actions .btn:last-child', d); btn.disabled = true; $('.err', d).textContent = '';
    try { await onSubmit(Object.fromEntries(new FormData(form)), d); d.close(); }
    catch (err) { $('.err', d).textContent = err.message; }
    finally { btn.disabled = false; }
  };
  d.showModal();
  const first = $('input:not([type=hidden]), select, textarea', d); if (first) first.focus();
  return d;
}
const field = (lbl, inner, hint = '') => `<label class="field"><span>${lbl}</span>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</label>`;
const opts = (list, sel, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
  list.map(o => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}${o.active === false ? ' (off)' : ''}</option>`).join('');
const reasonField = (lbl = 'Reason', hint = 'Saved in the audit log.') => field(lbl + ' <em>(required)</em>', '<textarea class="input" name="reason" required maxlength="500"></textarea>', hint);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const qs = () => new URLSearchParams((location.hash.split('?')[1]) || '');
const clubName = id => (S.clubs.find(c => c.id === id) || {}).name || '';
const clubOf = id => S.clubs.find(c => c.id === id) || {};
// A club's logo, or its initials when it has none
function logo(club, size = 32) {
  const src = club.logoApi ? API + club.logoApi : club.logo;
  const st = `width:${size}px;height:${size}px`;
  if (src) return `<img class="club-logo" src="${esc(src)}" alt="" style="${st}" loading="lazy">`;
  const ini = String(club.name || '?').replace(/\bGUC\b/g, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="club-logo ph" aria-hidden="true" style="${st};font-size:${Math.round(size * .38)}px">${esc(ini)}</span>`;
}
// Shrink a picture to at most 256 px before uploading
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let out = c.toDataURL('image/png'); if (out.length > 380000) out = c.toDataURL('image/webp', 0.9);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can read.')); };
    img.src = url;
  });
}
// Ask before deleting for good, then call the server
function confirmDelete({ title, text, url, done }) {
  dialog({ title, intro: text + ' <b>This cannot be undone.</b>', body: '', submit: 'Delete', danger: true,
    onSubmit: async () => { await POST(url); toast('Deleted'); if (done) done(); else render(); } });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-del-claim]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const sao = S.user.role === 'sao';
  confirmDelete({ title: `Delete ${b.dataset.name}?`, url: `/api/claims/${b.dataset.delClaim}/delete`,
    text: sao ? 'The claim, its notes and its history are erased. If no other club ever had this sponsor, the sponsor record goes too.'
      : 'It is removed from your club\'s list with its notes and history, for everyone including SAO, and the sponsor becomes free for other clubs.' });
}, true);
const delBtn = c => `<button class="icon-act" data-del-claim="${esc(c.id)}" data-name="${esc(c.sponsor)}" aria-label="Delete ${esc(c.sponsor)}" title="Delete">${svg('trash')}</button>`;
const empty = (title, text = '') => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;

// ---------- start ----------
const lockup = `<div class="login-head"><img src="assets/brand/sponsors-mark.svg" alt="">
  <div class="lockup"><b>SAO</b><span class="brand-bars" aria-hidden="true"><i></i><i></i><i></i></span><span>Sponsor Registry</span>
  <span class="ar" lang="ar" dir="rtl">مكتب الأنشطة الطلابية</span></div></div>`;

async function loadSession() { S = await GET('/api/session'); return S; }

async function boot() {
  let s;
  try { s = await loadSession(); }
  catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}<h2>Can't reach the server</h2>
      <p class="muted" style="margin:8px 0 20px">${esc(e.message)} If it keeps happening, the server may be starting up — wait a minute.</p>
      <button class="btn key block" onclick="location.reload()">Try again</button></div></div>`;
    return;
  }
  if (s.needsSetup) return renderSetup(s);
  if (s.setupDisabled) {
    $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}<h2>Not set up yet</h2>
      <p class="muted" style="margin-top:8px">The SAO Office has to create the first account. See the README ("Put it online").</p></div></div>`;
    return;
  }
  if (!s.user) return renderLogin(s);
  if (s.user.mustChange) return renderMustChange();
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => { try { await loadSession(); updateBell(); } catch (e) { /* offline for a moment */ } }, 60000);
  render();
}

function renderLogin(s) {
  $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}
    <h1 style="font-size:26px">Sign in</h1><p class="muted" style="margin:6px 0 20px">Club representatives and SAO Heads.</p>
    <form id="login" class="stack" novalidate>
      ${field('Email', '<input class="input" name="email" type="email" autocomplete="username" required>')}
      ${field('Password', '<input class="input" name="password" type="password" autocomplete="current-password" required>')}
      <p class="err" role="alert"></p>
      <button class="btn key block">Sign in</button>
    </form>
    <div class="or"><span>New here?</span></div>
    <button type="button" class="btn ghost block" id="first">First time signing in?</button>
    <p class="muted small" style="margin-top:14px">Forgot your password? Ask the SAO Office to reset it, then use "First time signing in?".</p>
    ${s.demo ? `<div class="demo"><b>Demo accounts</b> <span class="muted">(password ${esc(s.demo.password)})</span>
      ${s.demo.accounts.map(a => `<button type="button" data-email="${esc(a.email)}">${esc(a.name)} — ${esc(a.email)}</button>`).join('')}</div>` : ''}
  </div></div>`;
  const form = $('#login');
  $('#first').onclick = () => renderFirstTime(s, form.email.value);
  form.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    $('.err', form).textContent = '';
    try { const r = await POST('/api/login', v); token = r.token; store.set('sp-token', token); location.hash = '#/'; boot(); }
    catch (err) {
      $('.err', form).textContent = err.message;
      if (err.data && err.data.code === 'not-set-up') renderFirstTime(s, v.email);
    }
  };
  $$('.demo button').forEach(b => b.onclick = () => { form.email.value = b.dataset.email; form.password.value = s.demo.password; form.requestSubmit(); });
}

// First time signing in: email -> choose a password (SAO added it) or ask SAO for access (unknown email)
function renderFirstTime(s, email = '') {
  const card = inner => { $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}${inner}
    <button type="button" class="link-btn small" id="back" style="margin-top:14px;display:block">← Back to sign in</button></div></div>`;
    $('#back').onclick = () => renderLogin(s); };
  const stepEmail = (msg = '') => {
    card(`<h1 style="font-size:26px">First time signing in</h1>
      <p class="muted" style="margin:6px 0 20px">Enter the email the SAO Office added for you. If it isn't added yet, you can ask for access.</p>
      <form id="ft" class="stack" novalidate>
        ${field('Your email', `<input class="input" name="email" type="email" autocomplete="username" required value="${esc(email)}">`)}
        <p class="err" role="alert">${esc(msg)}</p>
        <button class="btn key block">Continue</button></form>`);
    const f = $('#ft');
    f.email.focus();
    f.onsubmit = async e => {
      e.preventDefault(); $('.err', f).textContent = '';
      email = f.email.value.trim();
      try {
        const r = await POST('/api/first-time/check', { email });
        if (r.state === 'set-password') stepPassword();
        else if (r.state === 'unknown') stepRequest(r);
        else if (r.state === 'pending') stepInfo('Your request is waiting', 'The SAO Office has your request. Once they approve it, come back here and choose your password.');
        else if (r.state === 'already') stepInfo('You already have a password', 'Sign in with it. If you forgot it, ask the SAO Office to reset it, then come back here.');
        else stepInfo('This account is turned off', 'Contact the SAO Office if you think this is a mistake.');
      } catch (err) { $('.err', f).textContent = err.message; }
    };
  };
  const stepPassword = () => {
    card(`<h1 style="font-size:26px">Choose your password</h1>
      <p class="muted" style="margin:6px 0 20px">Welcome! Your account for <b>${esc(email)}</b> is ready. Choose a password to finish.</p>
      <form id="ft" class="stack" novalidate>
        <input type="email" name="email" value="${esc(email)}" autocomplete="username" hidden>
        ${field('New password', '<input class="input" name="password" type="password" autocomplete="new-password" required>', 'At least 8 characters, with letters and numbers.')}
        ${field('Type it again', '<input class="input" name="confirm" type="password" autocomplete="new-password" required>')}
        <p class="err" role="alert"></p>
        <button class="btn key block">Save and sign in</button></form>`);
    const f = $('#ft');
    f.password.focus();
    f.onsubmit = async e => {
      e.preventDefault(); $('.err', f).textContent = '';
      if (f.password.value !== f.confirm.value) { $('.err', f).textContent = 'The two passwords are not the same.'; return; }
      try {
        const r = await POST('/api/first-time/password', { email, password: f.password.value, confirm: f.confirm.value });
        token = r.token; store.set('sp-token', token); location.hash = '#/'; toast('Password saved — welcome!'); boot();
      } catch (err) { $('.err', f).textContent = err.message; }
    };
  };
  const stepRequest = r => {
    card(`<h1 style="font-size:26px">Ask for access</h1>
      <p class="muted" style="margin:6px 0 16px"><b>${esc(email)}</b> isn't added yet. Tell the SAO Office who you are and they'll add you.</p>
      ${r.declined ? `<div class="banner warn">${svg('info')}<div><b>Your last request was declined</b>${esc(r.declined.reason || 'Contact the SAO Office for details.')}</div></div>` : ''}
      <form id="ft" class="stack" novalidate>
        ${field('Your full name', '<input class="input" name="name" autocomplete="name" required maxlength="100">')}
        ${field('Your club', `<select class="input" name="clubId" required>${opts(r.clubs, '', 'Choose your club')}</select>`)}
        ${field('Message to SAO <em>(optional)</em>', '<textarea class="input" name="message" maxlength="500" placeholder="For example: I\'m the new sponsorship head."></textarea>')}
        <p class="err" role="alert"></p>
        <button class="btn key block">Send request</button></form>
      <button type="button" class="link-btn small" id="other" style="margin-top:12px;display:block">Use a different email</button>`);
    const f = $('#ft');
    f.name.focus();
    $('#other').onclick = () => stepEmail();
    f.onsubmit = async e => {
      e.preventDefault(); $('.err', f).textContent = '';
      const v = Object.fromEntries(new FormData(f));
      if (!v.clubId) { $('.err', f).textContent = 'Choose your club.'; return; }
      try {
        await POST('/api/first-time/request', { email, ...v });
        stepInfo('Request sent', `The SAO Office will check it. Once they approve <strong>${esc(email)}</strong>, come back, tap "First time signing in?" and choose your password.`, true);
      } catch (err) { $('.err', f).textContent = err.message; }
    };
  };
  const stepInfo = (title, text, ok) => card(`<div class="banner ${ok ? 'ok' : 'info'}" style="margin-bottom:0">${svg(ok ? 'confirmed' : 'info')}<div><b>${esc(title)}</b>${text}</div></div>`);
  stepEmail();
}

function renderSetup(s) {
  $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}
    <h1 style="font-size:26px">Set up the registry</h1>
    <p class="muted" style="margin:6px 0 20px">Create the first SAO Head account. The clubs (with their logos) and the category list are added for you; you can change them later.</p>
    <form id="setup" class="stack" novalidate>
      ${s.setupNeedsCode ? field('Setup code', '<input class="input" name="code" required autocomplete="off">', 'The SP_SETUP_CODE secret set on the server.') : ''}
      ${field('Your name', '<input class="input" name="name" required autocomplete="name">')}
      ${field('Email', '<input class="input" name="email" type="email" required autocomplete="username">')}
      ${field('Password', '<input class="input" name="password" type="password" required autocomplete="new-password">', 'At least 8 characters, with letters and numbers.')}
      <label class="check"><input type="checkbox" name="demo"> Fill with demo data (one demo rep per club and a few sponsors)</label>
      <p class="err" role="alert"></p>
      <button class="btn key block">Create account</button>
    </form></div></div>`;
  const form = $('#setup');
  form.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form)); v.demo = !!v.demo;
    try { const r = await POST('/api/setup', v); token = r.token; store.set('sp-token', token); boot(); }
    catch (err) { $('.err', form).textContent = err.message; }
  };
}

function renderMustChange() {
  $('#app').innerHTML = `<div class="login"><div class="login-card">${lockup}
    <h1 style="font-size:26px">Choose your password</h1>
    <p class="muted" style="margin:6px 0 20px">You signed in with a starting password from SAO. Choose your own to continue.</p>
    <form id="pw" class="stack" novalidate>
      ${field('Starting password', '<input class="input" name="current" type="password" required autocomplete="current-password">')}
      ${field('New password', '<input class="input" name="next" type="password" required autocomplete="new-password">', 'At least 8 characters, with letters and numbers.')}
      <p class="err" role="alert"></p>
      <button class="btn key block">Save and continue</button>
    </form>
    <button class="link-btn small" style="margin-top:14px" id="out">Sign out</button></div></div>`;
  const form = $('#pw');
  form.onsubmit = async e => {
    e.preventDefault();
    try { await POST('/api/password', Object.fromEntries(new FormData(form))); toast('Password saved'); boot(); }
    catch (err) { $('.err', form).textContent = err.message; }
  };
  $('#out').onclick = async () => { try { await POST('/api/logout'); } catch (e) { /* signed out anyway */ } signedOut(); };
}

// ---------- the frame: header, menu, footer ----------
// [link, label, short label for the phone tab bar, icon, badge]
function navItems() {
  if (S.user.role === 'sao') return [['#/', 'Dashboard', 'Home', 'home'], ['#/claims', 'All claims', 'Claims', 'list'], ['#/reviews', 'Reviews', 'Reviews', 'review', S.openReviews],
    ['#/sponsors', 'Sponsors', 'Sponsors', 'grid'], ['#/admin', 'Admin', 'Admin', 'gear', S.openAccess]];
  return [['#/', 'My sponsors', 'Sponsors', 'home'], ['#/add', 'Add sponsor', 'Add', 'plus'], ['#/requests', 'Requests to SAO', 'Requests', 'chat']];
}
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
function frame() {
  const path = location.hash.split('?')[0] || '#/';
  const top = path.split('/').slice(0, 2).join('/');
  const isOn = href => href === '#/' ? (path === '#/' || path === '#' || path === '') : (top === href || (href === '#/claims' && top === '#/club'));
  const items = navItems();
  const cur = h => isOn(h) ? 'class="on" aria-current="page"' : '';
  $('#app').innerHTML = `
    <header class="top"><div class="top-in">
      <a class="brand" href="#/" aria-label="SAO Sponsors home"><img src="assets/brand/sponsors-mark.svg" alt=""><b>SAO <span>Sponsors</span></b></a>
      <nav class="nav" aria-label="Main">${items.map(([h, t, , , n]) => `<a href="${h}" ${cur(h)}>${t}${n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</nav>
      <div class="top-tools">
        <button class="icon-btn" id="bell" aria-label="Notifications">${svg('bell')}<span class="dot" ${S.unread ? '' : 'hidden'}>${S.unread || ''}</span></button>
        <button class="icon-btn" id="me" aria-label="Account: ${esc(S.user.name)}"><span class="avatar">${esc(initials(S.user.name))}</span></button>
      </div>
    </div></header>
    <main id="main"></main>
    <nav class="tabbar" aria-label="Main">${items.map(([h, , short, ic, n]) => `<a href="${h}" ${isOn(h) ? 'aria-current="page"' : ''} class="${h === '#/add' ? 'add' : ''} ${isOn(h) ? 'on' : ''}">${svg(ic, 'ic')}<span>${short}</span>${n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</nav>
    <footer class="foot"><img src="assets/guc-logo.jpg" alt="German University in Cairo"><span>Student Activities Office · Times in Cairo time</span></footer>`;
  $('#bell').onclick = openNotices;
  $('#me').onclick = openAccount;
}
function updateBell() { const d = $('#bell .dot'); if (d) { d.hidden = !S.unread; d.textContent = S.unread || ''; } }
function closePop() { const p = $('.pop'); if (p) p.remove(); }
document.addEventListener('click', e => { const p = $('.pop'); if (p && !p.contains(e.target) && !e.target.closest('#bell, #me')) p.remove(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

async function openNotices() {
  if ($('.pop.notices')) return closePop();
  closePop();
  const p = document.createElement('div'); p.className = 'pop notices'; p.innerHTML = '<div class="pop-head"><b>Notifications</b></div><p class="muted" style="padding:16px">Loading…</p>';
  $('.top').appendChild(p);
  try {
    const list = await GET('/api/notices');
    p.innerHTML = `<div class="pop-head"><b>Notifications</b><span class="muted small">${list.length ? '' : 'Nothing yet'}</span></div>` +
      (list.length ? list.map(n => `<a class="pop-item ${n.seen ? '' : 'unread'}" href="${esc(n.link || '#/')}">${esc(n.text)}<div class="muted">${ago(n.at)}</div></a>`).join('')
        : '<p class="muted" style="padding:16px">Reminders about ending reservations and SAO decisions appear here.</p>');
    $$('.pop-item', p).forEach(a => a.addEventListener('click', closePop));
    if (S.unread) { await POST('/api/notices/seen'); S.unread = 0; updateBell(); }
  } catch (e) { p.innerHTML = `<p class="err" style="padding:16px">${esc(e.message)}</p>`; }
}
function openAccount() {
  if ($('.pop.account')) return closePop();
  closePop();
  const p = document.createElement('div'); p.className = 'pop account';
  const where = S.user.role === 'rep' ? clubName(S.user.clubId) : 'SAO Head';
  p.innerHTML = `<div class="pop-head"><div><b>${esc(S.user.name)}</b><div class="muted small">${esc(where)} · ${esc(S.user.email)}</div></div></div>
    <button class="pop-btn" id="theme-btn">${svg(isDark() ? 'sun' : 'moon', 'ic')}${isDark() ? 'Light mode' : 'Dark mode'}</button>
    <button class="pop-btn" id="pw-btn">${svg('key', 'ic')}Change password</button><button class="pop-btn" id="out-btn">${svg('out', 'ic')}Sign out</button>`;
  $('.top').appendChild(p);
  $('#theme-btn').onclick = () => { const t = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('sp-theme', t); closePop(); };
  $('#pw-btn').onclick = () => { closePop(); dialog({ title: 'Change password', submit: 'Save password',
    body: field('Current password', '<input class="input" type="password" name="current" required autocomplete="current-password">') +
      field('New password', '<input class="input" type="password" name="next" required autocomplete="new-password">', 'At least 8 characters, with letters and numbers. You stay signed in here; other devices are signed out.'),
    onSubmit: async v => { await POST('/api/password', v); toast('Password changed'); } }); };
  $('#out-btn').onclick = async () => { try { await POST('/api/logout'); } catch (e) { /* signed out anyway */ } signedOut(); };
}

// ---------- routing ----------
const ROUTES = [
  [/^#?\/?$/, () => S.user.role === 'sao' ? viewDashboard() : viewMyClub()],
  [/^#\/add$/, () => viewAdd()],
  [/^#\/claim\/([^/]+)$/, m => viewClaim(m[1])],
  [/^#\/requests$/, () => viewRequests()],
  [/^#\/claims$/, () => viewAllClaims(), 'sao'],
  [/^#\/club\/([^/]+)$/, m => viewClub(m[1]), 'sao'],
  [/^#\/reviews$/, () => viewReviews(), 'sao'],
  [/^#\/sponsors$/, () => viewSponsors(), 'sao'],
  [/^#\/sponsor\/([^/]+)$/, m => viewSponsor(m[1]), 'sao'],
  [/^#\/admin(?:\/(\w+))?$/, m => viewAdmin(m[1] || 'users'), 'sao'],
];
let renderSeq = 0;
async function render() {
  if (!S || !S.user) return;
  closePop();
  const seq = ++renderSeq;
  frame();
  const main = $('#main');
  main.innerHTML = '<p class="muted">Loading…</p>';
  const path = location.hash.split('?')[0];
  const route = ROUTES.find(([re, , role]) => re.test(path) && (!role || role === S.user.role));
  try {
    const html = route ? await route[1](path.match(route[0])) : `<div class="card">${empty('Page not found', 'Use the menu above.')}</div>`;
    if (seq !== renderSeq) return;
    if (typeof html === 'string') main.innerHTML = html;
    window.scrollTo(0, 0);
  } catch (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = `<div class="card">${empty(e.status === 403 ? 'You don\'t have access to this' : 'This page could not load', e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
const refresh = async () => { await loadSession(); render(); };

// ---------- claims table (used on several pages) ----------
function claimsTable(list, { club = false, del = true } = {}) {
  if (!list.length) return empty('No sponsors match', 'Try other filters.');
  return `<div class="table-wrap"><table class="stackable"><thead><tr><th>Sponsor</th>${club ? '<th>Club</th>' : ''}<th>Category</th><th>Status</th><th>Deadline</th><th>Last activity</th>${del ? '<th><span class="sr">Delete</span></th>' : ''}</tr></thead><tbody>
    ${list.map(c => `<tr class="go" data-href="#/claim/${esc(c.id)}">
      <td class="first"><a class="nm" href="#/claim/${esc(c.id)}">${esc(c.sponsor)}</a>${c.instagram ? `<div class="sub">@${esc(c.instagram)}</div>` : ''}</td>
      ${club ? `<td data-l="Club" class="clubtd"><span class="club-cell">${logo(clubOf(c.clubId), 24)}${esc(c.club || '')}</span></td>` : ''}
      <td data-l="Category" class="hide-sm">${esc(c.category)}</td>
      <td class="st">${chip(c.status)}${c.stalled ? ' <span class="tag">Stalled</span>' : ''}</td>
      <td data-l="Deadline">${deadline(c)}</td>
      <td data-l="Last activity" class="hide-sm"><span class="sub">${ago(c.lastActivityAt)}</span></td>${del ? `<td class="act">${delBtn(c)}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}
document.addEventListener('click', e => {
  const tr = e.target.closest('tr.go');
  if (tr && !e.target.closest('a, button, input, select')) location.hash = tr.dataset.href;
});
const statusFilter = sel => `<select class="input" name="status" aria-label="Status">
  ${[['', 'All statuses'], ['active', 'Active'], ['closed', 'Closed'], ['expiring', 'Ending within 3 days'], ...(S.user.role === 'sao' ? [['stalled', 'Stalled']] : []),
    ...Object.entries(S.statuses)].map(([v, t]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;

// Filters + table that reloads as filters change. fixed = filters that can't be changed (club page).
function filteredClaims(container, { fixed = {}, club = false, exportBtn = false } = {}) {
  const p = qs();
  const sao = S.user.role === 'sao';
  container.innerHTML = `<form class="filters" role="search">
      <input class="input grow" name="q" type="search" placeholder="Search sponsor" value="${esc(p.get('q') || '')}" aria-label="Search sponsor">
      ${statusFilter(p.get('status') || '')}
      <button type="button" class="btn ghost flt-toggle" aria-expanded="false">Filters</button>
      <select class="input opt" name="category" aria-label="Category">${opts(S.categories, p.get('category') || '', 'All categories')}</select>
      ${sao && !fixed.club ? `<select class="input opt" name="club" aria-label="Club">${opts(S.clubs, p.get('club') || '', 'All clubs')}</select>` : ''}
      ${sao ? `<input class="input opt" type="date" name="from" value="${esc(p.get('from') || '')}" aria-label="Added from" title="Added from"><input class="input opt" type="date" name="to" value="${esc(p.get('to') || '')}" aria-label="Added until" title="Added until">` : ''}
      ${exportBtn ? '<button type="button" class="btn ghost opt" id="csv">Export CSV</button>' : ''}
    </form><div class="list-body"><p class="muted" style="padding:20px">Loading…</p></div>`;
  const form = $('form', container);
  // phones: extra filters fold away behind a "Filters" button (opened already if one is in use)
  const used = ['category', 'club', 'from', 'to'].some(k => p.get(k));
  if (used) form.classList.add('open');
  const tg = $('.flt-toggle', form); tg.setAttribute('aria-expanded', String(used));
  tg.onclick = () => { const o = form.classList.toggle('open'); tg.setAttribute('aria-expanded', String(o)); };
  const params = () => { const v = new URLSearchParams(); for (const [k, x] of new FormData(form)) if (x) v.set(k, x); for (const [k, x] of Object.entries(fixed)) v.set(k, x); return v; };
  const load = async () => {
    const v = params();
    const base = location.hash.split('?')[0];
    const shown = new URLSearchParams(v); for (const k of Object.keys(fixed)) shown.delete(k);
    history.replaceState(null, '', base + (shown.toString() ? '?' + shown : ''));
    try { $('.list-body', container).innerHTML = claimsTable(await GET('/api/claims?' + v), { club }); }
    catch (e) { $('.list-body', container).innerHTML = `<p class="err" style="padding:20px">${esc(e.message)}</p>`; }
  };
  form.addEventListener('input', debounce(load, 250));
  form.addEventListener('change', load);
  form.addEventListener('submit', e => { e.preventDefault(); load(); });
  if (exportBtn) $('#csv', container).onclick = async () => {
    try {
      const r = await fetch(API + '/api/export.csv?' + params(), { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `sponsors-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message || 'Export failed', true); }
  };
  load();
}

// ================= Club representative pages =================
async function viewMyClub() {
  const all = await GET('/api/claims?status=active');
  const n = st => all.filter(c => c.status === st).length;
  const soon = all.filter(c => c.status === 'reserved' && c.expiresAt - Date.now() < 3 * DAY);
  const max = S.settings.maxActive, full = all.length >= max;
  const main = $('#main');
  main.innerHTML = `
    <div class="page-head"><div><div class="club-title">${logo(clubOf(S.user.clubId), 56)}<div><div class="label">Club</div><h1>${esc(clubName(S.user.clubId))}</h1></div></div>
      <p class="muted">New sponsors are held for ${S.reserveDays} days — log your first contact before then.</p></div>
      <a class="btn ${full ? 'ghost' : 'key'}" href="#/add">Add sponsor</a></div>
    ${full ? `<div class="banner warn" role="alert">${svg('lock')}<div><b>Your club holds ${all.length} of ${max} sponsors — the limit.</b>
      To add another, close one first: mark it Rejected if the sponsor declined, or Released if your club is letting it go.</div></div>` : ''}
    ${soon.map(c => `<div class="banner warn" role="alert">${svg('warn')}<div><b>${esc(c.sponsor)}: ${esc(left(c.expiresAt))}</b>
      Log the first contact before ${dateTime(c.expiresAt)} or the sponsor is released. <a href="#/claim/${esc(c.id)}">Update it</a></div></div>`).join('')}
    <div class="kpis">
      <a class="kpi ${full ? 'alert' : ''}" href="#/?status=active"><b>${all.length}<small class="of"> / ${max}</small></b><span>Active</span></a>
      <a class="kpi" href="#/?status=reserved"><b>${n('reserved')}</b><span>Reserved</span></a>
      <a class="kpi" href="#/?status=negotiation"><b>${n('contacted') + n('negotiation')}</b><span>In progress</span></a>
      <a class="kpi" href="#/?status=confirmed"><b>${n('confirmed')}</b><span>Confirmed</span></a>
      ${n('pending_review') ? `<a class="kpi" href="#/?status=pending_review"><b>${n('pending_review')}</b><span>Waiting for SAO review</span></a>` : ''}
    </div>
    <div class="card flush" id="claims"></div>`;
  filteredClaims($('#claims'));
}

async function viewAdd() {
  if (S.user.role !== 'rep') { location.hash = '#/sponsors'; return ''; }
  const held = (await GET('/api/claims?status=active')).length, max = S.settings.maxActive;
  const main = $('#main');
  main.innerHTML = `
    <div class="narrow"><a class="crumb" href="#/">${svg('back', 'ic')}My sponsors</a>
    <div class="page-head"><div><h1>Add sponsor</h1>
      <p class="muted">Type the name to check the registry. A free sponsor is held for your club for ${S.reserveDays} days. Your club holds ${held} of ${max}.</p></div></div>
    ${held >= max ? `<div class="banner warn" role="alert">${svg('lock')}<div><b>Your club already holds ${max} sponsors — the limit.</b>
      Close one on <a href="#/">My sponsors</a> (Rejected or Released) before adding another. You can still search the registry below.</div></div>` : ''}
      <form class="card stack" id="add" novalidate>
        <div id="picked" hidden></div>
        <div class="suggest-wrap">${field('Sponsor name', '<input class="input" name="name" required maxlength="100" autocomplete="off" aria-describedby="name-err" aria-controls="sugs">')}
          <p class="err" id="name-err"></p><div class="suggest" id="sugs" aria-live="polite"></div></div>
        <div id="newbits" class="stack">
          ${field('Category', `<select class="input" name="categoryId" required>${opts(S.categories, '', 'Choose a category')}</select>`)}
          <label class="field"><span>Instagram <em>(optional)</em></span><input class="input" name="instagram" placeholder="@handle or instagram.com/…" autocomplete="off" aria-describedby="ig-hint ig-err">
            <div class="hint" id="ig-hint">Paste the sponsor's profile link or @handle. <a id="ig-search" href="#" target="_blank" rel="noopener noreferrer">Search Instagram for this name</a></div>
            <p class="err" id="ig-err"></p></label>
        </div>
        ${field('Notes <em>(optional)</em>', '<textarea class="input" name="notes" maxlength="1000" placeholder="Contact person, plans, anything useful for your club"></textarea>', 'Only your club and SAO see notes.')}
        <div id="result"></div>
        <button class="btn key block" id="go" ${held >= max ? 'disabled' : ''}>Reserve sponsor</button>
      </form>
      <p class="muted small" style="margin-top:14px">Another club's sponsor shows as "unavailable" — you never see which club. Look-alike names go to SAO for a quick check first.</p>
    </div>`;
  const form = $('#add'), sugs = $('#sugs');
  let picked = null, lastList = [];
  const updateIgLink = () => { $('#ig-search').href = 'https://www.google.com/search?q=' + encodeURIComponent('site:instagram.com ' + (form.name.value || 'sponsor')); };
  const showPicked = () => {
    $('#picked').hidden = !picked; $('#newbits').hidden = !!picked; form.name.closest('.suggest-wrap').hidden = !!picked;
    if (picked) $('#picked').innerHTML = `<div class="banner ok">${svg('confirmed')}<div><b>${esc(picked.name)}</b>${esc(picked.category)}${picked.instagram ? ' · @' + esc(picked.instagram) : ''}
      — already in the registry and available. <button type="button" class="link-btn" id="unpick">Change</button></div></div>`;
    if (picked) $('#unpick').onclick = () => { picked = null; showPicked(); form.name.focus(); };
  };
  const search = debounce(async () => {
    const v = form.name.value.trim(); updateIgLink();
    if (v.length < 2) { sugs.innerHTML = ''; return; }
    try {
      lastList = await GET('/api/sponsors/search?q=' + encodeURIComponent(v));
      sugs.innerHTML = lastList.length ? `<div class="suggest-head">Already in the registry</div>` + lastList.map((s, i) =>
        `<button type="button" class="sug" data-i="${i}" ${s.available ? '' : 'disabled'}><div class="grow" style="flex:1"><div class="nm">${esc(s.name)}</div>
          <div class="meta">${esc(s.category)}${s.instagram ? ' · @' + esc(s.instagram) : ''}${s.available ? ' · choose to reserve' : ''}</div></div>${availChip(s)}</button>`).join('') : '';
      $$('.sug', sugs).forEach(b => b.onclick = () => { picked = lastList[+b.dataset.i]; sugs.innerHTML = ''; showPicked(); });
    } catch (e) { sugs.innerHTML = ''; }
  }, 200);
  form.name.addEventListener('input', search);
  form.instagram.addEventListener('input', () => {
    const v = form.instagram.value.trim(); const err = $('#ig-err');
    err.textContent = !v || /^@?[A-Za-z0-9._]{1,30}$/.test(v) || /instagram\.com\/[A-Za-z0-9._]+/i.test(v) || /instagr\.am\//i.test(v) ? '' : 'Use the @handle or the profile link (instagram.com/…).';
    form.instagram.setAttribute('aria-invalid', err.textContent ? 'true' : 'false');
  });
  updateIgLink();
  form.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    $('#name-err').textContent = ''; $('#ig-err').textContent = ''; $('#result').innerHTML = '';
    if (!picked && !v.name.trim()) { $('#name-err').textContent = 'Enter the sponsor name.'; form.name.focus(); return; }
    if (!picked && !v.categoryId) { $('#result').innerHTML = '<p class="err">Choose a category.</p>'; form.categoryId.focus(); return; }
    const btn = $('#go'); btn.disabled = true;
    try {
      const r = await POST('/api/claims', picked ? { sponsorId: picked.id, notes: v.notes } : v);
      if (r.result === 'reserved') toast(`Reserved for ${S.reserveDays} days`);
      else toast('Held for SAO review');
      location.hash = '#/claim/' + r.claimId;
    } catch (err) {
      const d = err.data || {};
      if (d.code === 'unavailable') {
        $('#result').innerHTML = `<div class="banner warn" role="alert">${svg('lock')}<div><b>This sponsor is currently unavailable.</b>
          Another club is already working with this sponsor. If you think your club should have it, ask SAO to review.
          <div style="margin-top:10px"><button type="button" class="btn sm" id="ask">Ask SAO to review</button></div></div></div>`;
        $('#ask').onclick = () => askSao(picked ? picked.name : v.name, d.sponsorId);
      } else if (d.code === 'limit') {
        $('#result').innerHTML = `<div class="banner warn" role="alert">${svg('lock')}<div><b>Your club is at its sponsor limit.</b>${esc(err.message)}</div></div>`;
      } else if (d.code === 'own') {
        $('#result').innerHTML = `<div class="banner ok">${svg('info')}<div><b>Your club already has this sponsor.</b> <a href="#/claim/${esc(d.claimId)}">Open it</a></div></div>`;
      } else if (d.field === 'instagram') { $('#ig-err').textContent = err.message; form.instagram.focus(); }
      else $('#result').innerHTML = `<p class="err" role="alert">${esc(err.message)}</p>`;
    } finally { btn.disabled = false; }
  };
  form.name.focus();
}

function askSao(name, sponsorId) {
  dialog({ title: 'Ask SAO to review', key: true, submit: 'Send to SAO',
    intro: 'SAO sees your message and who holds the sponsor. They will reply here and in your notifications.',
    body: field('Sponsor', `<input class="input" name="sponsorName" value="${esc(name || '')}" required maxlength="100">`) +
      field('Why should your club have it?', '<textarea class="input" name="message" required maxlength="1000" placeholder="For example: we have worked with them for two years and have a contact there."></textarea>'),
    onSubmit: async v => { await POST('/api/requests', { ...v, sponsorId }); toast('Sent to SAO'); if (location.hash.startsWith('#/requests')) render(); } });
}

async function viewRequests() {
  if (S.user.role === 'sao') { location.hash = '#/reviews'; return ''; }
  const list = await GET('/api/requests');
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Requests to SAO</h1><p class="muted">Ask SAO to review a sponsor that is unavailable to your club, or anything else about a sponsor.</p></div>
      <button class="btn key" id="new">New request</button></div>
    <div class="card">${list.length ? `<ul class="list">${list.map(r => `<li><div class="grow"><div class="nm">${esc(r.sponsorName)}</div>
        <div class="small">${esc(r.message)}</div><div class="muted small">Sent ${dateTime(r.createdAt)}</div>
        ${r.reply ? `<div class="banner ok" style="margin:10px 0 0">${svg('info')}<div><b>SAO replied ${date(r.resolvedAt)}</b>${esc(r.reply)}</div></div>` : ''}</div>
        <span class="chip ${r.state === 'open' ? 'pending_review' : 'confirmed'}">${svg(r.state === 'open' ? 'pending_review' : 'confirmed')}${r.state === 'open' ? 'Waiting' : 'Answered'}</span></li>`).join('')}</ul>`
      : empty('No requests yet', 'When a sponsor shows as unavailable you can ask SAO to review it.')}</div>`;
  $('#new').onclick = () => askSao('', null);
}

// ---------- one claim (club and SAO) ----------
async function viewClaim(id) {
  const d = await GET('/api/claims/' + encodeURIComponent(id));
  const c = d.claim, sao = S.user.role === 'sao';
  const soon = c.status === 'reserved' && c.expiresAt - Date.now() < 3 * DAY;
  let banner = '';
  if (c.status === 'reserved') banner = `<div class="banner ${soon ? 'warn' : 'ok'}">${svg(soon ? 'warn' : 'reserved')}<div><b>Reserved until ${dateTime(c.expiresAt)} (${esc(left(c.expiresAt))})</b>
    ${sao ? 'The club must log a first contact before then, or the sponsor is released.' : 'Log the date of your first contact before then, or the sponsor is released for other clubs.'}</div></div>`;
  else if (c.status === 'pending_review') banner = `<div class="banner info">${svg('pending_review')}<div><b>Waiting for SAO review</b>
    ${sao ? `The name looks like a sponsor already in the registry. <a href="#/reviews">Open the review</a>` : 'The name looks like a sponsor already in the registry, so SAO checks it first. Don\'t contact them yet — you\'ll get a notification when SAO decides.'}</div></div>`;
  else if (!c.active) banner = `<div class="banner ${c.status === 'rejected' ? 'warn' : 'info'}">${svg(c.status)}<div><b>${esc(label(c.status))}${c.closedAt ? ' on ' + date(c.closedAt) : ''}</b>${esc(c.closeReason || '')}</div></div>`;
  if (c.stalled) banner += `<div class="banner info">${svg('info')}<div><b>Stalled</b>No activity for over ${S.settings.stallDays} days.</div></div>`;

  const needsDate = !c.firstContact;
  const statusOpts = c.next.map(s => `<option value="${s}">${esc(label(s))}${s === 'rejected' ? ' (sponsor declined)' : s === 'released' ? (sao ? '' : ' (we are letting it go)') : ''}</option>`).join('');
  const update = c.next.length ? `<form class="card stack" id="upd" novalidate><h2>Update status</h2>
      ${field('New status', `<select class="input" name="status">${statusOpts}</select>`)}
      <div id="cd" ${needsDate ? '' : 'hidden'}>${field('Date of first contact', `<input class="input" type="date" name="contactDate" max="${esc(S.today)}" value="${esc(S.today)}">`, 'The day you first reached out (call, email, message or meeting). No proof needed.')}</div>
      ${field('Note <em id="note-req">(optional)</em>', '<textarea class="input" name="note" maxlength="1000"></textarea>')}
      <p class="err" role="alert"></p>
      <button class="btn key">Save update</button></form>` : '';

  const facts = `<div class="card"><h2 style="margin-bottom:14px">Details</h2><div class="facts">
      ${sao ? `<div><span class="label">Club</span><span class="v"><a href="#/club/${esc(c.clubId)}">${esc(c.club)}</a></span></div>` : ''}
      <div><span class="label">Category</span><span class="v">${esc(c.category)}</span></div>
      <div><span class="label">Instagram</span><span class="v">${c.instagram ? igLink(c.instagram) : '—'}</span></div>
      <div><span class="label">Reserved</span><span class="v">${date(c.reservedAt)}</span></div>
      <div><span class="label">First contact</span><span class="v">${ymd(c.firstContact)}</span></div>
      <div><span class="label">Last activity</span><span class="v">${dateTime(c.lastActivityAt)}</span></div>
    </div>${c.notes ? `<div style="margin-top:16px"><span class="label">Notes</span><p style="white-space:pre-wrap;margin-top:4px">${esc(c.notes)}</p></div>` : ''}
    <div class="danger-zone"><button class="btn danger sm" id="del-claim">${svg('trash', 'ic')}Delete ${sao ? 'this claim' : 'this sponsor'}</button></div></div>`;

  const history = `<div class="card"><div class="card-head"><h2>History</h2></div>
      <ul class="timeline">${d.events.map(e => `<li class="${e.kind === 'note' ? 'note' : ['expired', 'rejected', 'released'].includes(e.kind) ? 'bad' : ''}">
        <div>${e.kind === 'note' ? `<b>Note:</b> ${esc(e.text)}` : esc(e.text || label(e.to))}</div>
        <div class="when">${dateTime(e.at)} · ${esc(e.by)}</div></li>`).join('')}</ul>
      <form id="note" class="row" style="margin-top:8px" novalidate><input class="input" name="text" placeholder="Add a note" maxlength="1000" style="flex:1;min-width:200px" aria-label="Add a note">
        <button class="btn ghost">Add note</button></form></div>`;

  const saoTools = sao ? `<div class="card"><h2 style="margin-bottom:12px">SAO actions</h2><div class="actions-list">
      ${c.status === 'pending_review' ? '<a class="btn ghost" href="#/reviews">Open in Reviews</a>' : ''}
      ${c.active && c.status !== 'pending_review' ? '<button class="btn ghost" id="reassign">Reassign to another club</button>' : ''}
      ${c.status === 'reserved' ? '<button class="btn ghost" id="extend">Extend the reservation</button>' : ''}
      <a class="btn ghost" href="#/sponsor/${esc(c.sponsorId)}">Sponsor record</a>
      ${c.active ? '<button class="btn danger" id="release">Release the claim</button>' : ''}
      </div></div>
      ${d.history && d.history.length ? `<div class="card"><h2 style="margin-bottom:10px">Other clubs' claims on this sponsor</h2><ul class="list">${d.history.map(h =>
        `<li><div class="grow"><a href="#/claim/${esc(h.id)}" class="nm">${esc(h.club)}</a><div class="muted small">${date(h.createdAt)}${h.closeReason ? ' · ' + esc(h.closeReason) : ''}</div></div>${chip(h.status)}</li>`).join('')}</ul></div>` : ''}` : '';

  $('#main').innerHTML = `
    <a class="crumb" href="${sao ? '#/claims' : '#/'}">${svg('back', 'ic')}${sao ? 'All claims' : 'My sponsors'}</a>
    <div class="page-head"><div><div class="row" style="margin-bottom:6px">${chip(c.status)}<span class="tag">${esc(c.category)}</span></div>
      <h1>${esc(c.sponsor)}</h1>${c.instagram ? `<p class="muted">${igLink(c.instagram)}</p>` : ''}</div></div>
    ${banner}
    <div class="grid cols-2"><div class="col">${update}${history}</div><div class="col">${facts}${saoTools}</div></div>`;

  const upd = $('#upd');
  if (upd) {
    const sync = () => {
      const st = upd.status.value;
      $('#cd').hidden = !(needsDate && ['contacted', 'negotiation', 'confirmed'].includes(st));
      $('#note-req').textContent = sao && ['released', 'rejected', 'reserved'].includes(st) ? '(required — the club sees it)' : ['released', 'rejected'].includes(st) ? '(reason, optional)' : '(optional)';
    };
    upd.status.onchange = sync; sync();
    upd.onsubmit = async e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(upd));
      if (['released', 'rejected'].includes(v.status) && !confirm(`Close this claim as ${label(v.status)}? The sponsor becomes free for other clubs.`)) return;
      try { await POST(`/api/claims/${c.id}/status`, v); toast('Saved'); render(); }
      catch (err) { $('.err', upd).textContent = err.message; }
    };
  }
  $('#del-claim').onclick = () => confirmDelete({ title: `Delete ${c.sponsor}?`, url: `/api/claims/${c.id}/delete`,
    text: sao ? 'The claim, its notes and its history are erased. If no other club ever had this sponsor, the sponsor record goes too.'
      : 'It is removed from your club\'s list with its notes and history, for everyone including SAO, and the sponsor becomes free for other clubs.',
    done: () => { location.hash = sao ? '#/claims' : '#/'; } });
  $('#note').onsubmit = async e => {
    e.preventDefault(); const t = e.target.text.value.trim(); if (!t) return;
    try { await POST(`/api/claims/${c.id}/note`, { text: t }); render(); } catch (err) { toast(err.message, true); }
  };
  if (sao) {
    const rel = $('#release');
    if (rel) rel.onclick = () => dialog({ title: `Release ${c.sponsor}`, danger: true, submit: 'Release',
      intro: `${esc(c.club)} loses the claim and the sponsor becomes free for any club. The club sees your reason.`, body: reasonField(),
      onSubmit: async v => { await POST(`/api/claims/${c.id}/release`, v); toast('Released'); render(); } });
    const ext = $('#extend');
    if (ext) ext.onclick = () => dialog({ title: 'Extend the reservation', submit: 'Extend',
      body: field('Extra days', '<input class="input" type="number" name="days" min="1" max="30" value="7" required>') + reasonField(),
      onSubmit: async v => { await POST(`/api/claims/${c.id}/extend`, v); toast('Extended'); render(); } });
    const re = $('#reassign');
    if (re) re.onclick = () => assignDialog({ id: c.sponsorId, name: c.sponsor }, c.clubId);
  }
}

// SAO: give a sponsor to a club (closes any active claim first)
function assignDialog(sponsor, currentClubId, presetClubId, after) {
  const clubs = S.clubs.filter(x => x.active && x.id !== currentClubId);
  dialog({ title: `Assign ${sponsor.name}`, key: true, submit: 'Assign',
    intro: currentClubId ? `${esc(clubName(currentClubId))}'s claim closes and they see your reason, but not which club gets the sponsor.` : 'The club gets an exclusive claim.',
    body: field('Club', `<select class="input" name="clubId" required>${opts(clubs, presetClubId || '', 'Choose a club')}</select>`) +
      field('Start as', `<select class="input" name="status">${['reserved', 'contacted', 'negotiation', 'confirmed'].map(s => `<option value="${s}">${esc(label(s))}${s === 'reserved' ? ` (${S.reserveDays}-day clock)` : ''}</option>`).join('')}</select>`) +
      reasonField('Reason', 'Saved in the audit log. Don\'t name the new club — the old club sees this.'),
    onSubmit: async v => { const r = await POST(`/api/sponsors/${sponsor.id}/assign`, v); if (after) await after(v); toast('Assigned'); location.hash = '#/claim/' + r.claimId; } });
}

// SAO: delete a club with its claims and rep accounts
async function delClub(club, repCount) {
  if (repCount == null) repCount = (await GET('/api/users')).filter(u => u.clubId === club.id).length;
  confirmDelete({ title: `Delete ${club.name}?`, url: `/api/clubs/${club.id}/delete`,
    text: `The club, all its sponsor claims${repCount ? ` and its ${plural(repCount, 'rep account')}` : ''} are erased. To hide it but keep its history, turn it off in Admin > Clubs instead.`,
    done: async () => { await loadSession(); location.hash = '#/admin/clubs'; render(); } });
}

// ================= SAO pages =================
async function viewDashboard() {
  const d = await GET('/api/dashboard');
  S.openReviews = d.openReviews + d.openRequests;
  const bs = d.byStatus;
  const kp = (n, t, href, cls = '') => `<a class="kpi ${cls}" href="${href}"><b>${n}</b><span>${t}</span></a>`;
  const colors = { reserved: 'var(--info-fg)', contacted: 'var(--yellow)', negotiation: '#C9A800', confirmed: 'var(--ink)', pending_review: 'var(--red)' };
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p class="muted">${d.clubs.length} clubs · ${plural(d.sponsors, 'sponsor')} in the registry</p></div>
      <a class="btn ${d.openReviews + d.openRequests ? 'key' : 'ghost'}" href="#/reviews">Review queue (${d.openReviews + d.openRequests})</a></div>
    <div class="kpis six">
      ${kp(d.activeClaims, 'Active claims', '#/claims?status=active')}
      ${kp(bs.reserved || 0, 'Reserved', '#/claims?status=reserved')}
      ${kp((bs.contacted || 0) + (bs.negotiation || 0), 'In progress', '#/claims?status=active')}
      ${kp(bs.confirmed || 0, 'Confirmed', '#/claims?status=confirmed')}
      ${kp(d.expiring.length, 'Ending within 3 days', '#/claims?status=expiring', d.expiring.length ? 'alert' : '')}
      ${kp(d.openReviews + d.openRequests, 'Waiting for review', '#/reviews', d.openReviews + d.openRequests ? 'alert' : '')}
    </div>
    <div class="grid cols-2">
      <div class="col">
        <div class="card"><div class="card-head"><h2>Clubs</h2><span class="muted small">Active claims per club</span></div>
          <div class="clubs">${d.clubs.map(c => `<a class="club-tile ${c.active ? '' : 'off'}" href="#/club/${esc(c.id)}"><div class="club-tile-head">${logo(c, 40)}<b>${esc(c.name)}</b></div>
            <span class="small ${c.total >= S.settings.maxActive ? 'due soon' : 'muted'}">${c.total} of ${S.settings.maxActive} sponsors${c.total >= S.settings.maxActive ? ' · full' : ''}${c.active ? '' : ' · turned off'}</span>
            <div class="bar" aria-hidden="true">${Object.entries(c.byStatus).map(([s, n]) => `<i style="width:${(n / Math.max(1, c.total)) * 100}%;background:${colors[s] || 'var(--grey)'}"></i>`).join('')}</div></a>`).join('')}</div></div>
        <div class="card"><div class="card-head"><h2>Recent activity</h2></div>
          ${d.recent.length ? `<ul class="list">${d.recent.map(e => `<li><div class="grow"><a href="#/claim/${esc(e.claim_id)}"><span class="nm">${esc(e.sponsor)}</span> · ${esc(e.club || '')}</a>
            <div class="small">${esc(e.text || label(e.to_status))}</div><div class="muted small">${ago(e.at)} · ${esc(e.by)}</div></div></li>`).join('')}</ul>` : empty('Nothing yet')}</div>
      </div>
      <div class="col">
        <div class="card"><div class="card-head"><h2>Ending soon</h2><a class="small" href="#/claims?status=expiring">See all</a></div>
          ${d.expiring.length ? `<ul class="list">${d.expiring.map(c => `<li><div class="grow"><a href="#/claim/${esc(c.id)}" class="nm">${esc(c.sponsor)}</a>
            <div class="muted small">${esc(c.club)}</div></div><span class="due soon">${esc(left(c.expiresAt))}</span></li>`).join('')}</ul>` : empty('No reservation ends in the next 3 days')}</div>
        <div class="card"><div class="card-head"><h2>Stalled</h2><span class="muted small">No activity for ${d.stallDays}+ days</span></div>
          ${d.stalled.length ? `<ul class="list">${d.stalled.map(c => `<li><div class="grow"><a href="#/claim/${esc(c.id)}" class="nm">${esc(c.sponsor)}</a>
            <div class="muted small">${esc(c.club)} · last activity ${date(c.lastActivityAt)}</div></div>${chip(c.status)}</li>`).join('')}</ul>` : empty('Nothing stalled')}</div>
      </div>
    </div>`;
}

async function viewAllClaims() {
  $('#main').innerHTML = `<div class="page-head"><div><h1>All claims</h1><p class="muted">Every club's sponsors.</p></div></div>
    <div class="card flush" id="claims"></div>`;
  filteredClaims($('#claims'), { club: true, exportBtn: true });
}

async function viewClub(id) {
  const club = S.clubs.find(c => c.id === id);
  if (!club) throw Object.assign(new Error('Club not found.'), { status: 404 });
  const reps = (await GET('/api/users')).filter(u => u.clubId === id);
  $('#main').innerHTML = `<a class="crumb" href="#/">${svg('back', 'ic')}Dashboard</a>
    <div class="page-head"><div><div class="club-title">${logo(club, 64)}<div><div class="label">Club</div><h1>${esc(club.name)}</h1></div></div>
      <p class="muted">${reps.length ? 'Representatives: ' + reps.map(u => esc(u.name) + (u.active ? '' : ' (off)')).join(', ') : 'No representative accounts yet.'} <a href="#/admin/users">Manage</a></p></div>
      <button class="btn danger sm" id="del-club">${svg('trash', 'ic')}Delete club</button></div>
    <div class="card flush" id="claims"></div>`;
  filteredClaims($('#claims'), { fixed: { club: id }, exportBtn: true });
  $('#del-club').onclick = () => delClub(club, reps.length);
}

async function viewReviews() {
  const tab = qs().get('tab') || 'duplicates';
  const all = await GET('/api/reviews');
  const dups = all.filter(r => r.kind === 'duplicate' && r.state === 'open');
  const reqs = all.filter(r => r.kind === 'request' && r.state === 'open');
  const closed = all.filter(r => r.state !== 'open');
  S.openReviews = dups.length + reqs.length;
  const tabs = `<nav class="tabs" aria-label="Reviews">
    <a href="#/reviews" class="${tab === 'duplicates' ? 'on' : ''}">Possible duplicates${dups.length ? `<span class="count">${dups.length}</span>` : ''}</a>
    <a href="#/reviews?tab=requests" class="${tab === 'requests' ? 'on' : ''}">Club requests${reqs.length ? `<span class="count">${reqs.length}</span>` : ''}</a>
    <a href="#/reviews?tab=closed" class="${tab === 'closed' ? 'on' : ''}">Closed</a></nav>`;
  const dupCard = r => `<div class="card" data-id="${esc(r.id)}">
      <div class="card-head"><div><div class="label">${esc(r.club)} · ${esc(r.by || '')} · ${ago(r.createdAt)}</div><h2 style="margin-top:4px">${esc(r.sponsorName)}</h2>
        <div class="muted small">${r.detail && r.detail.instagram ? '@' + esc(r.detail.instagram) + ' · ' : ''}${esc((S.categories.find(c => c.id === (r.detail || {}).categoryId) || {}).name || '')}</div></div>
        <a class="btn ghost sm" href="#/claim/${esc(r.claimId)}">Open claim</a></div>
      <p class="label" style="margin-bottom:6px">${r.detail && r.detail.conflict ? 'Its name and Instagram point to different records' : 'Looks like'}</p>
      <ul class="list">${(r.detail.candidates || []).map(cd => `<li><div class="grow"><a class="nm" href="#/sponsor/${esc(cd.id)}">${esc(cd.name)}</a>
        <div class="muted small">${esc(cd.reason)} · ${cd.gone ? 'merged or removed' : cd.holder ? `held by ${esc(cd.holder.club)} (${esc(cd.holder.status)})` : 'free'}</div></div>
        ${cd.gone ? '' : `<button class="btn ghost sm" data-merge="${esc(cd.id)}" data-name="${esc(cd.name)}" data-held="${cd.holder ? 1 : 0}">Same sponsor</button>`}</li>`).join('')}</ul>
      <div class="row" style="margin-top:14px">${r.detail && r.detail.conflict ? '' : '<button class="btn key" data-approve>Different sponsor — approve</button>'}
        <button class="btn danger" data-reject>Reject</button><span class="spacer"></span><button class="icon-act" data-del-review aria-label="Delete" title="Delete">${svg('trash')}</button></div></div>`;
  const reqCard = r => `<div class="card" data-id="${esc(r.id)}">
      <div class="card-head"><div><div class="label">${esc(r.club)} · ${esc(r.by || '')} · ${ago(r.createdAt)}</div><h2 style="margin-top:4px">${esc(r.sponsorName)}</h2></div></div>
      <p style="white-space:pre-wrap">${esc(r.message)}</p>
      <p class="muted small" style="margin-top:8px">${r.sponsorId ? (r.holder ? `Held by <a href="#/claim/${esc(r.holder.claimId)}">${esc(r.holder.club)}</a> (${esc(r.holder.status)})` : 'In the registry, currently free') : 'Not found in the registry under this name'}</p>
      <div class="row" style="margin-top:14px">${r.sponsorId ? `<button class="btn ghost" data-assign="${esc(r.sponsorId)}" data-holder="${esc(r.holder ? S.clubs.find(c => c.name === r.holder.club)?.id || '' : '')}">Assign to ${esc(r.club)}</button>` : ''}
        <button class="btn key" data-reply>Reply and close</button><span class="spacer"></span><button class="icon-act" data-del-review aria-label="Delete" title="Delete">${svg('trash')}</button></div></div>`;
  const closedRow = r => `<li data-id="${esc(r.id)}"><div class="grow"><span class="nm">${esc(r.sponsorName)}</span> <span class="tag">${r.kind === 'request' ? 'Request' : 'Duplicate'}</span>
      <div class="muted small">${esc(r.club)} · ${esc({ approved: 'Approved', merged: 'Matched to an existing sponsor', 'merged-unavailable': 'Matched — sponsor unavailable',
        rejected: 'Rejected', answered: 'Answered', closed: 'Closed' }[r.resolution] || r.resolution || '')} by ${esc(r.resolvedBy || 'the club')} ${r.resolvedAt ? date(r.resolvedAt) : ''}${r.reason ? ' · ' + esc(r.reason) : ''}</div></div>
      ${r.claimId ? `<a class="small" href="#/claim/${esc(r.claimId)}">Claim</a>` : ''}<button class="icon-act" data-del-review aria-label="Delete" title="Delete">${svg('trash')}</button></li>`;
  $('#main').innerHTML = `<div class="page-head"><div><h1>Reviews</h1><p class="muted">Names that look like an existing sponsor, and clubs asking SAO to step in.</p></div></div>
    ${tabs}
    ${tab === 'duplicates' ? (dups.length ? dups.map(dupCard).join('') : `<div class="card">${empty('No possible duplicates waiting')}</div>`) : ''}
    ${tab === 'requests' ? (reqs.length ? reqs.map(reqCard).join('') : `<div class="card">${empty('No club requests waiting')}</div>`) : ''}
    ${tab === 'closed' ? `<div class="card">${closed.length ? `<ul class="list">${closed.map(closedRow).join('')}</ul>` : empty('Nothing closed yet')}</div>` : ''}`;
  const byId = Object.fromEntries(all.map(r => [r.id, r]));
  const resolve = (r, action, extra = {}) => POST(`/api/reviews/${r.id}/resolve`, { action, ...extra });
  $$('[data-id]').forEach(card => {
    const r = byId[card.dataset.id];
    const del = $('[data-del-review]', card);
    if (del) del.onclick = () => confirmDelete({ title: `Delete this ${r.kind === 'request' ? 'request' : 'review'}?`, url: `/api/reviews/${r.id}/delete`,
      text: r.kind === 'duplicate' && r.state === 'open' ? `The review and the claim it is holding for ${esc(r.club)} are erased.` : 'It is removed from the list.', done: refresh });
    $$('[data-merge]', card).forEach(b => b.onclick = () => dialog({ title: `Same sponsor as ${b.dataset.name}?`, submit: 'Confirm',
      intro: b.dataset.held === '1' ? `${esc(b.dataset.name)} is held by another club, so ${esc(r.club)} is told the sponsor is unavailable. "${esc(r.sponsorName)}" is saved as another name for it.`
        : `"${esc(r.sponsorName)}" is saved as another name for ${esc(b.dataset.name)}, and ${esc(r.club)} gets the ${S.reserveDays}-day reservation.`,
      body: reasonField(), onSubmit: async v => { await resolve(r, 'merge', { targetId: b.dataset.merge, reason: v.reason }); toast('Done'); refresh(); } }));
    const ap = $('[data-approve]', card);
    if (ap) ap.onclick = () => dialog({ title: 'Approve as a different sponsor', key: true, submit: 'Approve',
      intro: `"${esc(r.sponsorName)}" becomes its own sponsor and ${esc(r.club)} gets the ${S.reserveDays}-day reservation, starting now.`, body: reasonField(),
      onSubmit: async v => { await resolve(r, 'approve', v); toast('Approved'); refresh(); } });
    const rj = $('[data-reject]', card);
    if (rj) rj.onclick = () => dialog({ title: 'Reject this request', danger: true, submit: 'Reject', intro: `${esc(r.club)} sees your reason.`, body: reasonField(),
      onSubmit: async v => { await resolve(r, 'reject', v); toast('Rejected'); refresh(); } });
    const rp = $('[data-reply]', card);
    if (rp) rp.onclick = () => dialog({ title: `Reply to ${r.club}`, key: true, submit: 'Send and close',
      body: reasonField('Reply', 'The club sees this. Don\'t name the club that holds the sponsor.'), onSubmit: async v => { await resolve(r, 'close', v); toast('Sent'); refresh(); } });
    const as = $('[data-assign]', card);
    if (as) as.onclick = () => assignDialog({ id: as.dataset.assign, name: r.sponsorName }, as.dataset.holder || null, r.clubId,
      v => resolve(r, 'close', { reason: 'SAO assigned this sponsor to your club. ' + v.reason }));
  });
}

async function viewSponsors() {
  const list = await GET('/api/sponsors');
  const p = qs();
  $('#main').innerHTML = `<div class="page-head"><div><h1>Sponsor registry</h1><p class="muted">${plural(list.length, 'sponsor')}. Fix names, add other spellings, merge duplicates or assign a sponsor to a club.</p></div></div>
    <div class="card flush"><form class="filters" role="search"><input class="input grow" type="search" name="q" placeholder="Search name, other name or @handle" aria-label="Search" value="${esc(p.get('q') || '')}">
      <select class="input" name="category" aria-label="Category">${opts(S.categories, p.get('category') || '', 'All categories')}</select>
      <select class="input" name="held" aria-label="Held"><option value="">Held or free</option><option value="held">Held by a club</option><option value="free">Free</option></select></form>
      <div id="rows"></div></div>`;
  const form = $('form.filters');
  const draw = () => {
    const v = Object.fromEntries(new FormData(form));
    const term = (v.q || '').toLowerCase().replace(/^@/, '');
    const rows = list.filter(s => (!v.category || s.categoryId === v.category) && (!v.held || (v.held === 'held') === !!s.holder) &&
      (!term || [s.name, ...s.aliases, s.instagram || ''].some(x => x.toLowerCase().includes(term))));
    $('#rows').innerHTML = rows.length ? `<div class="table-wrap"><table class="stackable"><thead><tr><th>Sponsor</th><th>Category</th><th>Instagram</th><th>Held by</th><th>Claims</th></tr></thead><tbody>
      ${rows.map(s => `<tr class="go" data-href="#/sponsor/${esc(s.id)}"><td class="first"><a class="nm" href="#/sponsor/${esc(s.id)}">${esc(s.name)}</a>${s.aliases.length ? `<div class="sub">Also: ${esc(s.aliases.join(', '))}</div>` : ''}</td>
        <td data-l="Category">${esc(s.category)}</td><td data-l="Instagram">${s.instagram ? '@' + esc(s.instagram) : '—'}</td>
        <td data-l="Held by">${s.holder ? `${esc(s.holder)} ${chip(s.holderStatus)}` : '<span class="muted">Free</span>'}</td><td data-l="Claims">${s.claims}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No sponsors match');
  };
  form.addEventListener('input', draw); form.addEventListener('submit', e => e.preventDefault()); draw();
}

async function viewSponsor(id) {
  const s = await GET('/api/sponsors/' + encodeURIComponent(id));
  if (s.state === 'merged') { location.hash = '#/sponsor/' + s.mergedInto; return ''; }
  const active = s.claims.find(c => c.active);
  $('#main').innerHTML = `<a class="crumb" href="#/sponsors">${svg('back', 'ic')}Sponsor registry</a>
    <div class="page-head"><div><div class="row" style="margin-bottom:6px"><span class="tag">${esc(s.category)}</span></div><h1>${esc(s.name)}</h1>
      <p class="muted">${active ? `Held by <a href="#/claim/${esc(active.id)}">${esc(active.club)}</a> · ${esc(label(active.status))}` : 'Free — any club can reserve it'} · added ${date(s.createdAt)}</p></div></div>
    <div class="grid cols-2">
      <div class="col">
        <form class="card stack" id="edit" novalidate><h2>Sponsor record</h2>
          <div class="form-grid">
            ${field('Name', `<input class="input" name="name" value="${esc(s.name)}" required maxlength="100">`)}
            ${field('Category', `<select class="input" name="categoryId">${opts(S.categories, s.categoryId)}</select>`)}
            <div class="wide">${field('Instagram', `<input class="input" name="instagram" value="${s.instagram ? '@' + esc(s.instagram) : ''}" placeholder="@handle">`)}</div>
            <div class="wide">${field('Other names', `<textarea class="input" name="aliases" placeholder="One per line">${esc(s.aliases.join('\n'))}</textarea>`, 'Spellings that mean the same sponsor. Clubs typing any of these are blocked the same way.')}</div>
          </div>
          <p class="err" role="alert"></p><div class="row"><button class="btn key">Save changes</button></div></form>
        <div class="card"><div class="card-head"><h2>Claims history</h2></div>${s.claims.length ? claimsTable(s.claims, { club: true }) : empty('No claims yet')}</div>
      </div>
      <div><div class="card"><h2 style="margin-bottom:12px">SAO actions</h2><div class="actions-list">
        <button class="btn ghost" id="assign">${active ? 'Reassign to another club' : 'Assign to a club'}</button>
        <button class="btn ghost" id="merge">Merge into another sponsor</button>
        <button class="btn danger" id="del-sponsor">${svg('trash', 'ic')}Delete sponsor</button></div></div></div>
    </div>`;
  const form = $('#edit');
  form.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    v.aliases = v.aliases.split(/\n|,/).map(x => x.trim()).filter(Boolean);
    try { await POST('/api/sponsors/' + s.id, v); toast('Saved'); render(); } catch (err) { $('.err', form).textContent = err.message; }
  };
  $('#assign').onclick = () => assignDialog(s, active && active.clubId);
  $('#del-sponsor').onclick = () => confirmDelete({ title: `Delete ${s.name}?`, url: `/api/sponsors/${s.id}/delete`,
    text: `The sponsor, its other names and all ${plural(s.claims.length, 'claim')} on it are erased.`, done: () => { location.hash = '#/sponsors'; } });
  $('#merge').onclick = async () => {
    const all = (await GET('/api/sponsors')).filter(x => x.id !== s.id);
    dialog({ title: `Merge ${s.name} into…`, danger: true, submit: 'Merge',
      intro: `${esc(s.name)} becomes another name of the sponsor you choose, and its history moves there. If both have an active claim, release one first.`,
      body: field('Keep this sponsor', `<select class="input" name="targetId" required>${opts(all.map(x => ({ id: x.id, name: x.name + (x.holder ? ` — ${x.holder}` : '') })), '', 'Choose')}</select>`) + reasonField(),
      onSubmit: async v => { const r = await POST(`/api/sponsors/${s.id}/merge`, v); toast('Merged'); location.hash = '#/sponsor/' + r.id; } });
  };
}

async function viewAdmin(tab) {
  const tabs = [['users', 'People', S.openAccess], ['clubs', 'Clubs'], ['categories', 'Categories'], ['settings', 'Rules'], ['audit', 'Audit log']];
  const head = `<div class="page-head"><div><h1>Admin</h1><p class="muted">Accounts, clubs, categories and the full log of changes.</p></div></div>
    <nav class="tabs" aria-label="Admin">${tabs.map(([k, t, n]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${t}${n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</nav>`;
  const main = $('#main');
  if (tab === 'users') {
    const [users, access] = await Promise.all([GET('/api/users'), GET('/api/access-requests')]);
    const open = access.filter(a => a.state === 'open');
    if (S.openAccess !== open.length) { S.openAccess = open.length; }
    const accessCard = open.length ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Asking for access <span class="count">${open.length}</span></h2>
        <span class="muted small">They used "First time signing in?" with an email you hadn't added.</span></div>
      ${open.map(a => `<div class="access-card" data-access="${esc(a.id)}">${logo(clubOf(a.clubId), 40)}<div class="grow"><b>${esc(a.name)}</b> · ${esc(a.email)}
          <div class="muted small">Wants to represent <b>${esc(a.club || 'a club')}</b> · ${ago(a.createdAt)}</div>${a.message ? `<div class="small" style="margin-top:4px">“${esc(a.message)}”</div>` : ''}</div>
        <div class="row" style="gap:6px"><button class="btn key sm" data-approve>Approve</button><button class="btn ghost sm" data-decline>Decline</button>
          <button class="icon-act" data-del-access aria-label="Delete request" title="Delete">${svg('trash')}</button></div></div>`).join('')}</div>` : '';
    main.innerHTML = head + accessCard + `<div class="card flush"><div class="card-head" style="padding-bottom:14px"><h2>${plural(users.length, 'account')}</h2><button class="btn key" id="add">Add account</button></div>
      <div class="table-wrap"><table class="stackable"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Club</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td class="first"><b>${esc(u.name)}</b></td><td data-l="Email">${esc(u.email)}</td><td data-l="Role">${u.role === 'sao' ? 'SAO Head' : 'Club rep'}</td>
        <td data-l="Club">${esc(u.club || '—')}</td><td class="st">${!u.active ? '<span class="chip released">' + svg('released') + 'Off</span>'
          : !u.setUp ? `<span class="chip pending_review">${svg('pending_review')}Not set up yet</span>` : u.mustChange ? '<span class="tag">Starting password</span>' : '<span class="tag">Active</span>'}</td>
        <td class="act"><div class="row" style="flex-wrap:nowrap;gap:4px"><button class="btn ghost sm" data-edit="${esc(u.id)}">Edit</button>${u.id === S.user.id ? '' : `<button class="icon-act" data-del-user="${esc(u.id)}" aria-label="Delete ${esc(u.name)}" title="Delete">${svg('trash')}</button>`}</div></td></tr>`).join('')}</tbody></table></div></div>`;
    const form = (u = {}) => field('Name', `<input class="input" name="name" value="${esc(u.name || '')}" required maxlength="100">`) +
      field('Email', `<input class="input" type="email" name="email" value="${esc(u.email || '')}" required>`) +
      field('Role', `<select class="input" name="role"><option value="rep" ${u.role !== 'sao' ? 'selected' : ''}>Club representative</option><option value="sao" ${u.role === 'sao' ? 'selected' : ''}>SAO Head</option></select>`) +
      `<div data-clubfield>${field('Club', `<select class="input" name="clubId">${opts(S.clubs, u.clubId || '', 'Choose a club')}</select>`)}</div>` +
      (u.id ? (u.id === S.user.id ? '' : `<label class="check"><input type="checkbox" name="resetToFirstTime"> Forgot their password: let them choose a new one with "First time signing in?"</label>`)
        : `<p class="banner ok" style="margin:0">${svg('info')}<span>No password needed. They open the site, tap <strong>First time signing in?</strong>, enter this email and choose their own password.</span></p>`) +
      `<details${u.id ? '' : ''}><summary class="small" style="cursor:pointer;color:var(--grey);font-weight:600">${u.id ? 'Or set a password yourself' : 'Or give them a starting password instead'}</summary>
        <div style="margin-top:10px">${field(u.id ? 'New password' : 'Starting password', `<div class="row"><input class="input" name="password" style="flex:1" autocomplete="new-password"><button type="button" class="btn ghost sm" data-gen>Make one</button></div>`,
        'Share it with them yourself; they must change it after signing in.')}</div></details>` +
      (u.id ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Can sign in</label>` : '');
    const wire = d => {
      const sync = () => { $('[data-clubfield]', d).hidden = $('[name=role]', d).value === 'sao'; };
      $('[name=role]', d).onchange = sync; sync();
      $('[data-gen]', d).onclick = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', n = '23456789'; let p = '';
        const r = new Uint32Array(10); crypto.getRandomValues(r); r.forEach((x, i) => { p += i % 4 === 3 ? n[x % n.length] : a[x % a.length]; }); $('[name=password]', d).value = p + '7'; };
    };
    $('#add').onclick = () => wire(dialog({ title: 'Add account', key: true, submit: 'Add account', body: form(),
      onSubmit: async v => { if (!v.password) delete v.password; await POST('/api/users', v); toast('Account added'); render(); } }));
    $$('[data-access]').forEach(card => {
      const a = open.find(x => x.id === card.dataset.access);
      $('[data-approve]', card).onclick = () => dialog({ title: `Approve ${a.name}?`, key: true, submit: 'Approve',
        intro: `This adds <b>${esc(a.email)}</b> as a club representative. They then tap "First time signing in?" and choose their password.`,
        body: field('Name', `<input class="input" name="name" value="${esc(a.name)}" required maxlength="100">`) +
          field('Club', `<select class="input" name="clubId">${opts(S.clubs.filter(c => c.active), a.clubId || '')}</select>`, 'Change it if they picked the wrong club.'),
        onSubmit: async v => { await POST(`/api/access-requests/${a.id}/approve`, v); toast('Approved'); await loadSession(); render(); } });
      $('[data-decline]', card).onclick = () => dialog({ title: `Decline ${a.name}?`, danger: true, submit: 'Decline',
        intro: 'They are shown your reason the next time they try "First time signing in?".',
        body: field('Reason <em>(optional)</em>', '<textarea class="input" name="reason" maxlength="300"></textarea>'),
        onSubmit: async v => { await POST(`/api/access-requests/${a.id}/decline`, v); toast('Declined'); await loadSession(); render(); } });
      $('[data-del-access]', card).onclick = () => confirmDelete({ title: 'Delete this request?', url: `/api/access-requests/${a.id}/delete`,
        text: 'It is removed without an answer.', done: async () => { await loadSession(); render(); } });
    });
    $$('[data-del-user]').forEach(b => b.onclick = () => { const u = users.find(x => x.id === b.dataset.delUser);
      confirmDelete({ title: `Delete ${u.name}'s account?`, url: `/api/users/${u.id}/delete`, text: `${esc(u.email)} can no longer sign in. Their club's sponsors stay.` }); });
    $$('[data-edit]').forEach(b => b.onclick = () => { const u = users.find(x => x.id === b.dataset.edit);
      wire(dialog({ title: 'Edit ' + u.name, body: form(u), onSubmit: async v => { v.active = !!v.active; v.resetToFirstTime = !!v.resetToFirstTime; if (!v.password) delete v.password;
        await POST('/api/users/' + u.id, v); toast(v.resetToFirstTime ? 'Saved — they can now choose a new password' : 'Saved'); render(); } })); });
  } else if (tab === 'clubs' || tab === 'categories') {
    const list = tab === 'clubs' ? S.clubs : S.categories, one = tab === 'clubs' ? 'club' : 'category';
    main.innerHTML = head + `<div class="card"><div class="card-head"><h2>${plural(list.filter(x => x.active).length, one, tab)} in use</h2><button class="btn key" id="add">Add ${one}</button></div>
      <ul class="list">${list.map(x => `<li>${tab === 'clubs' ? logo(x, 40) : ''}<div class="grow"><span class="nm">${esc(x.name)}</span>${x.active ? '' : ' <span class="tag">Turned off</span>'}</div>
        ${tab === 'clubs' ? `<button class="btn ghost sm" data-logo="${esc(x.id)}">Logo</button>` : ''}<button class="btn ghost sm" data-edit="${esc(x.id)}">Edit</button><button class="icon-act" data-del-item="${esc(x.id)}" aria-label="Delete ${esc(x.name)}" title="Delete">${svg('trash')}</button></li>`).join('')}</ul>
      <p class="muted small" style="margin-top:12px">Turning a ${one} off hides it from new ${tab === 'clubs' ? 'accounts and assignments' : 'sponsors'}; its history stays.</p></div>`;
    $$('[data-logo]').forEach(b => b.onclick = () => { const x = list.find(y => y.id === b.dataset.logo);
      dialog({ title: 'Logo for ' + x.name, key: true, submit: 'Save logo', intro: 'A PNG, JPG or WebP picture. It is shrunk to 256 pixels; square pictures look best.',
        body: `<div class="row">${logo(x, 72)}<input type="file" name="file" accept="image/png,image/jpeg,image/webp" class="input" style="flex:1;min-width:180px;padding-top:9px"></div>` +
          (x.logoApi ? '<label class="check"><input type="checkbox" name="remove"> Remove the uploaded logo</label>' : ''),
        onSubmit: async (v, d) => {
          if (v.remove) await POST(`/api/clubs/${x.id}/logo`, { data: null });
          else { const f = $('[name=file]', d).files[0]; if (!f) throw new Error('Choose a picture.'); await POST(`/api/clubs/${x.id}/logo`, { data: await shrink(f) }); }
          toast('Logo saved'); refresh();
        } }); });
    $$('[data-del-item]').forEach(b => b.onclick = () => { const x = list.find(y => y.id === b.dataset.delItem);
      if (tab === 'clubs') return delClub(x);
      confirmDelete({ title: `Delete the category ${x.name}?`, url: `/api/categories/${x.id}/delete`, text: 'Sponsors in it move to "Other".', done: refresh }); });
    $('#add').onclick = () => dialog({ title: 'Add ' + one, key: true, submit: 'Add', body: field('Name', '<input class="input" name="name" required maxlength="100">'),
      onSubmit: async v => { await POST(`/api/${tab}`, v); toast('Added'); refresh(); } });
    $$('[data-edit]').forEach(b => b.onclick = () => { const x = list.find(y => y.id === b.dataset.edit);
      dialog({ title: 'Edit ' + one, body: field('Name', `<input class="input" name="name" value="${esc(x.name)}" required maxlength="100">`) + `<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> In use</label>`,
        onSubmit: async v => { await POST(`/api/${tab}/${x.id}`, { name: v.name, active: !!v.active }); toast('Saved'); refresh(); } }); });
  } else if (tab === 'settings') {
    main.innerHTML = head + `<div class="narrow">
      <form class="card stack" id="set" novalidate><h2>Limits</h2>
        ${field('Sponsors one club may hold at once', `<div class="row"><input class="input" type="number" name="maxActive" min="1" max="200" value="${S.settings.maxActive}" style="width:110px"> <span>sponsors</span></div>`,
          'Counts Reserved, Contacted, In Negotiation, Confirmed and Pending SAO Review. A full club must close one before adding another. SAO can still assign a sponsor to a full club.')}
        ${field('Flag Contacted and In Negotiation claims after', `<div class="row"><input class="input" type="number" name="stallDays" min="7" max="180" value="${S.settings.stallDays}" style="width:110px"> <span>days without activity</span></div>`,
          'They are only flagged for SAO on the dashboard — never released automatically. (Policy still to be approved.)')}
        <p class="err" role="alert"></p><div><button class="btn key">Save</button></div></form>
      <p class="muted small" style="margin-top:14px">Fixed rules: reservations last ${S.reserveDays} days (Cairo time), one club per sponsor, other clubs only see "unavailable", reminders 3 days and 1 day before the end.</p></div>`;
    $('#set').onsubmit = async e => { e.preventDefault(); try { await POST('/api/settings', Object.fromEntries(new FormData(e.target))); toast('Saved'); refresh(); } catch (err) { $('.err', e.target).textContent = err.message; } };
  } else {
    let offset = 0;
    main.innerHTML = head + `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Change</th><th>Reason</th></tr></thead><tbody id="log"></tbody></table></div>
      <div style="padding:14px 20px"><button class="btn ghost" id="more">Load more</button></div></div>`;
    // Plain-English names for the log's codes and fields; ids and empty values are left out
    const ACT = { login: 'Signed in', setup: 'Set up the site', 'claim.reserve': 'Reserved a sponsor', 'claim.hold': 'Look-alike sent to review',
      'claim.blocked': 'Tried an unavailable sponsor', 'claim.status': 'Changed a status', 'claim.note': 'Added a note', 'claim.release': 'Released a claim',
      'claim.extend': 'Extended a reservation', 'claim.assign': 'Assigned a sponsor', 'claim.reassign': 'Reassigned a sponsor', 'claim.expire': 'Reservation ended',
      'claim.delete': 'Deleted a sponsor claim', 'sponsor.create': 'New sponsor in the registry', 'sponsor.edit': 'Edited a sponsor', 'sponsor.merge': 'Merged sponsors',
      'sponsor.delete': 'Deleted a sponsor', 'review.approve': 'Approved a look-alike', 'review.merge': 'Matched a look-alike', 'review.reject': 'Rejected a look-alike',
      'review.delete': 'Deleted a review item', 'request.create': 'Asked SAO', 'request.answer': 'Answered a request', 'user.create': 'Added an account',
      'user.edit': 'Edited an account', 'user.password': 'Changed own password', 'user.delete': 'Deleted an account', 'club.create': 'Added a club',
      'club.edit': 'Edited a club', 'club.logo': 'Uploaded a club logo', 'club.logo.remove': 'Removed a club logo', 'club.delete': 'Deleted a club',
      'category.create': 'Added a category', 'category.edit': 'Edited a category', 'category.delete': 'Deleted a category', 'settings.edit': 'Changed the rules',
      export: 'Exported CSV', 'clubs.sync': 'Clubs and logos updated', 'user.first': 'Chose their password (first sign-in)',
      'access.request': 'Asked for access', 'access.approve': 'Approved an access request', 'access.decline': 'Declined an access request',
      'access.delete': 'Deleted an access request' };
    const FIELD = { categoryId: 'category', clubId: 'club', firstContact: 'first contact', expiresAt: 'ends', stallDays: 'stalled after (days)',
      maxActive: 'sponsor limit', passwordReset: 'password reset', targetId: 'matched to', firstTimeSignIn: 'chooses own password' };
    const val = (k, v) => {
      if (k === 'categoryId') return (S.categories.find(c => c.id === v) || {}).name || '';
      if (k === 'clubId') return clubName(v);
      if (k === 'status') return label(v);
      if (k === 'expiresAt') return v ? dateTime(v) : '';
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      if (Array.isArray(v)) return v.join(', ');
      return typeof v === 'object' && v ? '' : String(v);
    };
    const short = o => o ? esc(Object.entries(o).filter(([k, v]) => v != null && v !== '' && !['claim', 'targetId', 'id'].includes(k))
      .map(([k, v]) => [FIELD[k] || k, val(k, v)]).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join(' · ')) : '';
    const more = async () => {
      const rows = await GET('/api/audit?offset=' + offset); offset += rows.length;
      $('#log').insertAdjacentHTML('beforeend', rows.map(a => `<tr><td class="first"><span class="sub">${dateTime(a.at)}</span></td><td data-l="Who">${esc(a.by)}</td>
        <td data-l="What"><b>${esc(ACT[a.action] || a.action)}</b></td>
        <td data-l="Change" class="small">${a.before ? `<span class="muted">${short(a.before)}</span> → ` : ''}${short(a.after)}</td><td data-l="Reason" class="small">${esc(a.reason || '')}</td></tr>`).join(''));
      $('#more').hidden = rows.length < 100;
    };
    $('#more').onclick = more; await more();
  }
}

boot();
