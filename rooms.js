// SAO Rooms — club room booking: the public calendar (day, week, month), booking, "My club's bookings"
// and Admin > Rooms (rooms, slot times, term, blocks, the security Google Sheet). Uses the helpers in app.js.
'use strict';

// ---------- dates (all 'YYYY-MM-DD', Cairo days) ----------
const R_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const R_DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const R_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rUTC = d => Date.parse(d + 'T12:00:00Z');
const rAdd = (d, n) => new Date(rUTC(d) + n * 86400000).toISOString().slice(0, 10);
const rWd = d => new Date(rUTC(d)).getUTCDay();
const rDMY = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const rDay = d => `${R_DAYS[rWd(d)]} ${rDMY(d)}`;
const rT12 = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const rIsDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ---------- live updates ----------
let roomsTimer = null;
function stopRoomsLive() { clearInterval(roomsTimer); roomsTimer = null; }

// ---------- the calendar ----------
// opts.publicView: signed-out visitors (read-only)
async function viewRooms(main, opts = {}) {
  const me = S && S.user ? S.user : null, sao = me && me.role === 'sao', rep = me && me.role === 'rep';
  const p = qs();
  const phone = matchMedia('(max-width: 860px)').matches;
  const st = {
    view: ['day', 'week', 'month'].includes(p.get('view')) ? p.get('view') : (phone ? 'day' : 'week'),
    date: rIsDate(p.get('date')) ? p.get('date') : null,
    slot: p.get('slot') || '', building: p.get('building') || '', club: p.get('club') || '', free: p.get('free') === '1',
  };
  let cal = null, lastJson = '';

  const range = () => {
    if (st.view === 'day') { const s0 = rAdd(st.date, -rWd(st.date)); return [s0, rAdd(s0, 13)]; }   // two weeks, for the day buttons
    if (st.view === 'week') { const s = rAdd(st.date, -rWd(st.date)); return [s, rAdd(s, 6)]; }
    const first = st.date.slice(0, 8) + '01';
    const last = rAdd(new Date(Date.UTC(+st.date.slice(0, 4), +st.date.slice(5, 7), 0, 12)).toISOString().slice(0, 10), 0);
    return [first, last];
  };
  const keepUrl = () => {
    const q = new URLSearchParams({ view: st.view, date: st.date });
    for (const k of ['slot', 'building', 'club']) if (st[k]) q.set(k, st[k]);
    if (st.free) q.set('free', '1');
    history.replaceState(null, '', '#/rooms?' + q);
  };
  const teaching = d => cal && d >= cal.term.start && d <= cal.term.end && cal.term.weekdays.includes(rWd(d));

  async function load() {
    if (!st.date) {   // first open: today, or the next teaching day
      const c0 = await GET('/api/rooms/calendar');
      let d = c0.today;
      for (let i = 0; i < 14 && !(d >= c0.term.start && d <= c0.term.end && c0.term.weekdays.includes(rWd(d))); i++) d = rAdd(d, 1);
      if (d < c0.term.start) d = c0.term.start;
      st.date = d;
    }
    const [from, to] = range();
    const c = await GET(`/api/rooms/calendar?from=${from}&to=${to}`);
    const j = JSON.stringify(c);
    const changed = j !== lastJson;
    lastJson = j; cal = c;
    return changed;
  }

  // ---- lookups ----
  const clubById = id => (cal.clubs.find(c => c.id === id) || { id, name: 'A club' });
  const slotById = id => cal.slots.find(s => s.id === id);
  const roomsFor = slotId => cal.rooms.filter(r => r.active !== false && (slotId === 'after' ? r.afterHours : r.fifth))
    .filter(r => !st.building || r.building === st.building);
  const bookingAt = (d, roomId, slotId) => cal.bookings.find(b => b.date === d && b.roomId === roomId && b.slotId === slotId);
  const blockAt = (d, roomId, slotId) => cal.blocks.find(k => k.date === d && (!k.roomId || k.roomId === roomId) && (!k.slotId || k.slotId === slotId));
  const myClub = me && me.clubId;
  const used = (d, slotId) => cal.bookings.filter(b => b.date === d && b.slotId === slotId && b.clubId === myClub).length;
  const quota = d => cal.slots.map(s => `${s.name}: <strong>${Math.max(0, s.maxPerDay - used(d, s.id))} of ${s.maxPerDay}</strong> left`).join(' · ');
  const canBook = (d, slotId) => (rep || sao) && teaching(d) && d >= cal.today && (sao || used(d, slotId) < slotById(slotId).maxPerDay);
  const slotsShown = () => cal.slots.filter(s => !st.slot || s.id === st.slot);

  // one cell's state
  function cellState(d, room, slotId) {
    const b = bookingAt(d, room.id, slotId);
    if (b) return { kind: b.clubId === myClub ? 'mine' : 'booked', b };
    const k = blockAt(d, room.id, slotId);
    if (k) return { kind: 'blocked', k };
    if (!teaching(d)) return { kind: 'closed' };
    return { kind: d < cal.today ? 'past' : 'free' };
  }
  const passesFilters = (stt) => {
    if (st.free && stt.kind !== 'free') return false;
    if (st.club && !(stt.b && stt.b.clubId === st.club)) return false;
    return true;
  };
  const clubChip = (b, small) => { const c = clubById(b.clubId);
    return `<span class="rc-club">${logo(c, small ? 18 : 22)}<span>${esc(c.name)}</span></span>`; };

  // ---- the three views ----
  function dayView() {
    const d = st.date;
    if (!teaching(d)) return `<div class="card">${empty('No room bookings on this day', d < cal.term.start || d > cal.term.end ? `The term runs ${rDMY(cal.term.start)} – ${rDMY(cal.term.end)}.` : `Rooms are booked on ${cal.term.weekdays.map(w => R_DAYS[w]).join(', ')}. Pick another day above.`)}</div>`;
    return slotsShown().map(s => {
      const all = roomsFor(s.id), boxes = all.map(r => ({ r, x: cellState(d, r, s.id) })).filter(({ x }) => passesFilters(x));
      const free = all.filter(r => cellState(d, r, s.id).kind === 'free').length;
      const left = rep ? Math.max(0, s.maxPerDay - used(d, s.id)) : null;
      const custom = b => s.id === 'fifth' && (b.start !== s.start || b.end !== s.end) ? rT12(b.start) + ' – ' + rT12(b.end) : '';
      const box = ({ r, x }) => {
        if (x.b) return `<button class="rt k-${x.kind}" data-info="${esc(x.b.id)}"><span class="rt-code">${esc(r.code)}</span>
          <span class="rt-club">${logo(clubById(x.b.clubId), 22)}<span>${esc(x.kind === 'mine' ? 'Your club' : clubById(x.b.clubId).name)}</span></span>
          <span class="rt-sub">${esc([custom(x.b), x.b.purpose].filter(Boolean).join(' · ') || (x.kind === 'mine' ? clubById(x.b.clubId).name : 'Booked'))}</span></button>`;
        if (x.k) return `<div class="rt k-blocked" title="${esc(x.k.reason)}"><span class="rt-code">${esc(r.code)}</span><span class="rt-state">${svg('lock')}Blocked</span><span class="rt-sub">${esc(x.k.reason)}</span></div>`;
        if (x.kind === 'free' && canBook(d, s.id)) return `<button class="rt k-free can" data-book="${esc(r.id)}" data-slot="${s.id}" data-date="${d}">
          <span class="rt-code">${esc(r.code)}</span><span class="rt-state">Free</span><span class="rt-cta">Tap to book</span></button>`;
        if (x.kind === 'free') return `<div class="rt k-free"><span class="rt-code">${esc(r.code)}</span><span class="rt-state">Free</span>${r.capacity ? `<span class="rt-sub">${r.capacity} seats</span>` : ''}</div>`;
        return `<div class="rt k-${x.kind}"><span class="rt-code">${esc(r.code)}</span><span class="rt-sub">${x.kind === 'past' ? 'Past' : '—'}</span></div>`;
      };
      return `<section class="rt-slot rt-${s.id}"><div class="rt-head">
          <div><h2>${esc(s.name)}</h2><div class="muted small">${rT12(s.start)} – ${rT12(s.end)} · <b class="rt-free-n">${free} of ${all.length} free</b></div></div>
          ${left !== null ? `<span class="rt-quota ${left ? '' : 'none'}">${left ? `${left} of ${s.maxPerDay} left for your club` : `Your club has used all ${s.maxPerDay}`}</span>` : ''}</div>
        <div class="rt-grid">${boxes.length ? boxes.map(box).join('') : `<p class="muted small">Nothing matches the filters.</p>`}</div></section>`;
    }).join('');
  }

  function weekView() {
    const s0 = rAdd(st.date, -rWd(st.date));
    const days = cal.term.weekdays.slice().sort((a, b) => a - b).map(w => rAdd(s0, w));
    const head = `<tr><th class="rw-room">Room</th>${days.map(d => `<th class="${d === cal.today ? 'is-today' : ''}"><button class="link-btn rw-day" data-goto="${d}">${R_DAYS[rWd(d)]}<span>${rDMY(d).slice(0, 5)}</span></button></th>`).join('')}</tr>`;
    const body = slotsShown().map(s => {
      const rooms = roomsFor(s.id).filter(r => days.some(d => passesFilters(cellState(d, r, s.id))));
      return `<tr class="rw-group"><td colspan="${days.length + 1}">${esc(s.name)} <span class="muted">${rT12(s.start)} – ${rT12(s.end)}</span></td></tr>` +
        (rooms.length ? rooms.map(r => `<tr><td class="rw-room"><b>${esc(r.code)}</b></td>${days.map(d => {
          const x = cellState(d, r, s.id), show = passesFilters(x);
          if (!show) return '<td class="rw-cell k-hidden"></td>';
          if (x.b) return `<td class="rw-cell k-${x.kind}"><button class="rw-btn" data-info="${esc(x.b.id)}" title="${esc(clubById(x.b.clubId).name)}">${clubChip(x.b, true)}</button></td>`;
          if (x.k) return `<td class="rw-cell k-blocked"><span title="${esc(x.k.reason)}">${svg('lock')}Blocked</span></td>`;
          if (x.kind === 'free') return `<td class="rw-cell k-free">${canBook(d, s.id) ? `<button class="rw-btn" data-book="${esc(r.id)}" data-slot="${s.id}" data-date="${d}">Free</button>` : '<span>Free</span>'}</td>`;
          return `<td class="rw-cell k-${x.kind}"></td>`;
        }).join('')}</tr>`).join('') : `<tr><td colspan="${days.length + 1}" class="muted small" style="padding:12px 16px">Nothing matches the filters</td></tr>`);
    }).join('');
    return `<div class="card flush"><div class="table-wrap"><table class="rw-table">${head}${body}</table></div></div>`;
  }

  function monthView() {
    const first = st.date.slice(0, 8) + '01';
    const start = rAdd(first, -rWd(first));
    const wds = cal.term.weekdays.slice().sort((a, b) => a - b);
    const weeks = [];
    for (let w = start; w.slice(0, 7) <= st.date.slice(0, 7); w = rAdd(w, 7)) weeks.push(w);
    const cell = d => {
      if (d.slice(0, 7) !== st.date.slice(0, 7)) return '<td class="rm-cell rm-out"></td>';
      const t = teaching(d);
      const counts = t && d < cal.today ? '<div class="muted small">Past</div>' : t ? slotsShown().map(s => { const rooms = roomsFor(s.id); const free = rooms.filter(r => cellState(d, r, s.id).kind === 'free').length;
        return `<div class="rm-count"><span>${esc(s.name)}</span><b>${free}/${rooms.length}</b> free</div>`; }).join('') : '<div class="muted small">No bookings</div>';
      const mine = myClub ? cal.bookings.filter(b => b.date === d && b.clubId === myClub).length : 0;
      return `<td class="rm-cell ${d === cal.today ? 'is-today' : ''} ${t ? '' : 'rm-closed'}"><button class="rm-btn" data-goto="${d}" ${t ? '' : 'disabled'}>
        <span class="rm-date">${+d.slice(8, 10)}</span>${counts}${mine ? `<span class="rm-mine">${mine} yours</span>` : ''}</button></td>`;
    };
    return `<div class="card flush"><div class="table-wrap"><table class="rm-table"><tr>${wds.map(w => `<th>${R_DAYS_LONG[w]}</th>`).join('')}</tr>
      ${weeks.map(w => `<tr>${wds.map(x => cell(rAdd(w, x))).join('')}</tr>`).join('')}</table></div></div>`;
  }

  // ---- page ----
  function title() {
    if (st.view === 'day') return rDay(st.date).replace(/^(\w+)/, m => R_DAYS_LONG[R_DAYS.indexOf(m)]);
    if (st.view === 'week') { const s0 = rAdd(st.date, -rWd(st.date)); const days = cal.term.weekdays.map(w => rAdd(s0, w)).sort(); return `Week of ${rDMY(days[0] || s0)}`; }
    return `${R_MONTHS[+st.date.slice(5, 7) - 1]} ${st.date.slice(0, 4)}`;
  }
  // this week's and next week's teaching days as big buttons
  function dateStrip() {
    const s0 = rAdd(st.date, -rWd(st.date));
    const days = [];
    for (let w = 0; w < 2; w++) for (const wd of cal.term.weekdays.slice().sort((a, b) => a - b)) days.push(rAdd(s0, w * 7 + wd));
    return `<div class="ds" role="tablist" aria-label="Days">${days.map(d => {
      const mine = myClub ? cal.bookings.filter(b => b.date === d && b.clubId === myClub).length : 0;
      const on = st.view === 'day' && d === st.date;
      return `<button class="ds-day ${on ? 'on' : ''} ${d === cal.today ? 'today' : ''} ${d < cal.today ? 'past' : ''}" data-day="${d}" role="tab" aria-selected="${on}">
        <span>${R_DAYS[rWd(d)]}</span><b>${+d.slice(8, 10)}</b><small>${R_MONTHS[+d.slice(5, 7) - 1].slice(0, 3)}</small>${mine ? `<i title="Your club's bookings">${mine}</i>` : ''}</button>`;
    }).join('')}</div>`;
  }
  function draw() {
    const buildings = [...new Set(cal.rooms.map(r => r.building).filter(Boolean))].sort();
    const legend = `<div class="r-legend"><span class="rs rs-free">Free</span><span class="rs rs-booked">Booked</span>${myClub ? '<span class="rs rs-mine">Your club</span>' : ''}<span class="rs rs-blocked">${svg('lock')}Blocked</span></div>`;
    main.innerHTML = `
      <div class="page-head"><div><h1>Rooms</h1><p class="muted">After-hours and fifth-slot rooms for every club. ${opts.publicView ? 'Club reps sign in to book.' : rep ? `Your club can hold up to ${cal.slots.map(s => `${s.maxPerDay} ${s.name.toLowerCase()}`).join(' and ')} rooms a day.` : 'Book for any club, block rooms, and manage settings in Admin > Rooms.'}</p></div>
        <div class="row">${rep ? '<a class="btn ghost" href="#/rooms/mine">My club\'s bookings</a>' : ''}${sao ? '<a class="btn ghost" href="#/admin/rooms">Room settings</a>' : ''}
          <button class="btn ghost" id="share">${svg('chat', 'ic')}Share link</button></div></div>
      <div class="r-bar card">
        <div class="r-nav"><button class="icon-act" id="prev" aria-label="Previous">${svg('back')}</button>
          <button class="btn ghost sm" id="today">Today</button>
          <button class="icon-act r-next" id="next" aria-label="Next">${svg('back')}</button>
          <label class="btn ghost sm r-pick" title="Pick a date">${svg('cal', 'ic')}<span>Pick a date</span>
            <input type="date" id="pickdate" value="${esc(st.date)}" min="${esc(cal.term.start)}" max="${esc(cal.term.end)}" aria-label="Pick a date"></label>
          <h2 class="r-title">${esc(title())}</h2></div>
        <div class="r-views" role="tablist">${['day', 'week', 'month'].map(v => `<button class="${st.view === v ? 'on' : ''}" data-view="${v}" role="tab" aria-selected="${st.view === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
        <form class="r-filters" id="rf">
          <select class="input" name="slot" aria-label="Slot"><option value="">Both slots</option>${cal.slots.map(s => `<option value="${s.id}" ${st.slot === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <select class="input" name="building" aria-label="Building"><option value="">All buildings</option>${buildings.map(b => `<option ${st.building === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <select class="input" name="club" aria-label="Club"><option value="">All clubs</option>${cal.clubs.filter(c => c.active).map(c => `<option value="${esc(c.id)}" ${st.club === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" name="free" ${st.free ? 'checked' : ''}> Only free</label>
        </form>
      </div>
      ${st.view !== 'month' ? dateStrip() : ''}
      ${legend}
      <div id="r-body">${st.view === 'day' ? dayView() : st.view === 'week' ? weekView() : monthView()}</div>
      <p class="muted small" style="margin-top:12px">Updates by itself every few seconds.</p>`;
    wire();
  }
  function go(n) {
    const step = st.view === 'day' ? 1 : st.view === 'week' ? 7 : 0;
    if (st.view === 'month') { const y = +st.date.slice(0, 4), m = +st.date.slice(5, 7) - 1 + n; st.date = new Date(Date.UTC(y, m, 1, 12)).toISOString().slice(0, 10); }
    else {
      let d = rAdd(st.date, n * step);
      if (st.view === 'day') for (let i = 0; i < 7 && !cal.term.weekdays.includes(rWd(d)); i++) d = rAdd(d, n);   // skip non-teaching days
      st.date = d;
    }
    refreshView();
  }
  async function refreshView() {
    keepUrl();
    $('#r-body') && ($('#r-body').innerHTML = loader(56));
    try { await load(); draw(); } catch (e) { main.innerHTML = `<div class="card">${empty('The calendar could not load', e.message)}</div>`; }
  }
  function wire() {
    $('#prev').onclick = () => go(-1); $('#next').onclick = () => go(1);
    $('#today').onclick = () => { st.date = cal.today; refreshView(); };
    const pick = $('#pickdate');
    pick.onchange = () => { if (rIsDate(pick.value)) { st.date = pick.value; st.view = 'day'; refreshView(); } };
    $('.r-pick').onclick = e => { if (e.target === pick) return; e.preventDefault(); try { pick.showPicker(); } catch (x) { pick.focus(); pick.click(); } };
    $$('[data-day]').forEach(b => b.onclick = () => { st.date = b.dataset.day; st.view = 'day'; refreshView(); });
    $$('[data-view]').forEach(b => b.onclick = () => { st.view = b.dataset.view; refreshView(); });
    $('#rf').onchange = () => { const f = new FormData($('#rf')); st.slot = f.get('slot') || ''; st.building = f.get('building') || ''; st.club = f.get('club') || ''; st.free = !!f.get('free'); keepUrl(); draw(); };
    $$('[data-goto]').forEach(b => b.onclick = () => { st.date = b.dataset.goto; st.view = phone || st.view === 'week' ? 'day' : 'week'; refreshView(); });
    $$('[data-book]').forEach(b => b.onclick = () => bookDialog(cal, { date: b.dataset.date, slotId: b.dataset.slot, roomId: b.dataset.book }, refreshView));
    $$('[data-info]').forEach(b => b.onclick = () => bookingInfo(cal, b.dataset.info, refreshView));
    $('#share').onclick = async () => {
      const url = location.href.split('#')[0] + '#/rooms?' + new URLSearchParams({ view: st.view, date: st.date });
      try { await navigator.clipboard.writeText(url); toast('Link copied — anyone can open the calendar with it'); } catch (e) { prompt('Copy this link:', url); }
    };
  }

  main.innerHTML = loader(64);
  try { await load(); } catch (e) { main.innerHTML = `<div class="card">${empty('The calendar could not load', e.message)}</div>`; return; }
  keepUrl(); draw();
  // live: check for changes every few seconds while the page is open and visible
  stopRoomsLive();
  roomsTimer = setInterval(async () => {
    if (document.hidden || $('dialog[open]') || !location.hash.startsWith('#/rooms') || location.hash.startsWith('#/rooms/')) return;
    try { if (await load()) draw(); } catch (e) { /* offline for a moment */ }
  }, 6000);
}

// ---------- booking ----------
function bookDialog(cal, pre, done) {
  const me = S.user, sao = me.role === 'sao';
  const slot = cal.slots.find(s => s.id === pre.slotId);
  let roomId = pre.roomId;
  const roomCode = id => (cal.rooms.find(r => r.id === id) || {}).code || '';
  const used = clubId => cal.bookings.filter(b => b.date === pre.date && b.slotId === slot.id && b.clubId === clubId).length;
  const leftLine = clubId => { const l = Math.max(0, slot.maxPerDay - used(clubId));
    return clubId ? `${l} of ${slot.maxPerDay} ${esc(slot.name.toLowerCase())} rooms left for ${clubId === me.clubId ? 'your club' : esc(clubName(clubId))} that day${l ? '' : sao ? ' — tick override to book anyway' : ''}` : ''; };
  const day = `${R_DAYS_LONG[rWd(pre.date)]} ${rDMY(pre.date)}`;
  const purposes = ['Session', 'Meeting', 'Workshop', 'Training', 'Rehearsal'];
  const d = dialog({ title: `Book ${roomCode(roomId)}`, key: true, submit: 'Book it',
    body: `<div class="bk-summary">
        <div><span class="label">Day</span><b>${esc(day)}</b></div>
        <div><span class="label">${esc(slot.name)}</span><b>${rT12(slot.start)} – ${rT12(slot.end)}</b></div>
        <div><span class="label">Room</span><b id="bk-room">${esc(roomCode(roomId))}</b></div></div>
      ${sao ? field('For which club?', `<select class="input" name="clubId" required>${opts(cal.clubs.filter(c => c.active), '', 'Choose a club')}</select>`) : ''}
      <p class="bk-left" id="bk-left">${sao ? '' : leftLine(me.clubId)}</p>
      <div class="field"><span>What is it for? <em>(optional)</em></span>
        <div class="bk-chips">${purposes.map(p => `<label class="bk-chip"><input type="radio" name="pp" value="${p}"><span>${p}</span></label>`).join('')}</div>
        <input class="input" name="purpose" maxlength="200" placeholder="…or write it here" style="margin-top:8px"></div>
      ${slot.id === 'fifth' ? `<label class="check"><input type="checkbox" name="part"> Only part of the slot</label>
        <div id="bk-times" class="form-grid" hidden>${field('From', `<input class="input" type="time" name="start" step="300" value="${slot.start}" min="${slot.start}" max="${slot.end}">`)}${field('To', `<input class="input" type="time" name="end" step="300" value="${slot.end}" min="${slot.start}" max="${slot.end}">`)}</div>` : ''}
      ${sao ? '<label class="check"><input type="checkbox" name="override"> Admin override (past the club\'s daily limit)</label>' : ''}
      <div id="bk-suggest"></div>`,
    onSubmit: async v => {
      const body = { date: pre.date, slotId: slot.id, roomId, purpose: (v.purpose || '').trim() || v.pp || '' };
      if (slot.id === 'fifth' && v.part) { body.start = v.start; body.end = v.end; }
      if (sao) { body.clubId = v.clubId; body.override = !!v.override; }
      try { await POST('/api/bookings', body); }
      catch (err) {
        const sug = err.data && err.data.suggest;
        if (sug && sug.length) {
          $('#bk-suggest', d).innerHTML = `<p class="small" style="margin:0 0 6px"><b>Take one of these instead:</b></p><div class="row">${sug.map(c => `<button type="button" class="btn ghost sm" data-pick="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
          $$('[data-pick]', d).forEach(b => b.onclick = () => {
            const r = cal.rooms.find(x => x.code === b.dataset.pick); if (!r) return;
            roomId = r.id; $('#bk-room', d).textContent = r.code; $('h2', d).textContent = 'Book ' + r.code; $('.err', d).textContent = ''; $('#bk-suggest', d).innerHTML = '';
          });
        }
        throw err;
      }
      toast(`Booked ${roomCode(roomId)} for ${day}`); done();
    } });
  const part = $('[name=part]', d); if (part) part.onchange = () => { $('#bk-times', d).hidden = !part.checked; };
  const club = $('[name=clubId]', d); if (club) club.onchange = () => { $('#bk-left', d).innerHTML = leftLine(club.value); };
  // a purpose button fills nothing else in; typing overrides it
  $$('[name=pp]', d).forEach(r => r.onchange = () => { $('[name=purpose]', d).value = ''; });
}

function bookingInfo(cal, id, done) {
  const b = cal.bookings.find(x => x.id === id); if (!b) return;
  const me = S && S.user, sao = me && me.role === 'sao', own = me && me.clubId === b.clubId;
  const room = cal.rooms.find(r => r.id === b.roomId) || {}, slot = cal.slots.find(s => s.id === b.slotId) || {};
  const club = cal.clubs.find(c => c.id === b.clubId) || { name: 'A club' };
  const canChange = (sao || own) && b.date >= cal.today;
  const d = dialog({ title: `${room.code} · ${slot.name}`, submit: canChange ? 'Save changes' : 'Close',
    body: `<div class="row" style="gap:12px">${logo(club, 44)}<div><b style="font-size:17px">${esc(club.name)}</b><div class="muted small">${esc(rDay(b.date))} · ${rT12(b.start)} – ${rT12(b.end)}</div></div></div>
      <div class="facts" style="margin-top:6px">
        <div><span class="label">Purpose</span><span class="v">${esc(b.purpose || '—')}</span></div>
        <div><span class="label">Booked</span><span class="v">${dateTime(b.createdAt)}</span></div>
        ${b.by !== undefined ? `<div><span class="label">Booked by</span><span class="v">${esc(b.by || '—')}${b.byEmail ? `<br><span class="muted small">${esc(b.byEmail)}</span>` : ''}</span></div>` : ''}
        ${b.override ? '<div><span class="label">Note</span><span class="v">Admin override</span></div>' : ''}
      </div>
      ${canChange ? `<details><summary class="small" style="cursor:pointer;font-weight:700">Change purpose${b.slotId === 'fifth' ? ' or times' : ''}</summary><div class="stack" style="margin-top:10px">
        ${b.slotId === 'fifth' ? `<div class="form-grid">${field('From', `<input class="input" type="time" name="start" value="${esc(b.start)}" min="${esc(slot.start)}" max="${esc(slot.end)}" step="300">`)}${field('To', `<input class="input" type="time" name="end" value="${esc(b.end)}" min="${esc(slot.start)}" max="${esc(slot.end)}" step="300">`)}</div>` : ''}
        ${field('Purpose', `<input class="input" name="purpose" value="${esc(b.purpose || '')}" maxlength="200">`)}</div></details>
        <div class="danger-zone"><button type="button" class="btn danger sm" id="bk-cancel">Cancel this booking</button></div>` : ''}`,
    onSubmit: async v => { if (!canChange) return; await POST('/api/bookings/' + b.id, { purpose: v.purpose, start: v.start, end: v.end }); toast('Saved'); done(); } });
  const c = $('#bk-cancel', d);
  if (c) c.onclick = () => { d.close(); cancelBooking(b.id, `${room.code} on ${rDay(b.date)}`, sao && !own, done); };
}

function cancelBooking(id, what, askReason, done) {
  dialog({ title: `Cancel ${what}?`, danger: true, submit: 'Cancel booking', intro: 'The room becomes free at once' + (askReason ? ' and the club is told.' : '.'),
    body: askReason ? field('Reason <em>(the club sees it)</em>', '<input class="input" name="reason" maxlength="300">') : '',
    onSubmit: async v => { await POST(`/api/bookings/${id}/cancel`, { reason: v.reason }); toast('Cancelled'); done(); } });
}

// ---------- My club's bookings ----------
async function viewMyBookings() {
  const list = await GET('/api/bookings/mine');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  const up = list.filter(b => b.active && b.date >= today), past = list.filter(b => !b.active || b.date < today).reverse();
  const row = (b, canCancel) => `<li class="${b.active ? '' : 'mb-off'}"><div class="mb-date"><b>${R_DAYS[rWd(b.date)]}</b><span>${rDMY(b.date).slice(0, 5)}</span></div>
      <div class="grow"><span class="nm">${esc(b.room)}</span> · ${esc(b.slot)} <span class="muted small">${rT12(b.start)} – ${rT12(b.end)}</span>
        <div class="muted small">${esc(b.purpose || 'No purpose given')} · by ${esc(b.by)}${b.override ? ' · admin override' : ''}${!b.active ? ` · cancelled${b.cancelReason ? ': ' + esc(b.cancelReason) : ''}` : ''}</div></div>
      ${canCancel ? `<button class="btn ghost sm" data-cancel="${esc(b.id)}" data-what="${esc(b.room + ' on ' + rDay(b.date))}">Cancel</button>` : ''}</li>`;
  $('#main').innerHTML = `<a class="crumb" href="#/rooms">${svg('back', 'ic')}Rooms</a>
    <div class="page-head"><div><h1>My club's bookings</h1><p class="muted">${esc(clubName(S.user.clubId))} · cancelling frees the room at once.</p></div>
      <a class="btn key" href="#/rooms">Book a room</a></div>
    <div class="card"><div class="card-head"><h2>Coming up</h2><span class="muted small">${plural(up.length, 'booking')}</span></div>
      ${up.length ? `<ul class="list mb-list">${up.map(b => row(b, true)).join('')}</ul>` : empty('No upcoming bookings', 'Open Rooms and tap a free room to book it.')}</div>
    ${past.length ? `<div class="card"><div class="card-head"><h2>Past and cancelled</h2><span class="muted small">last 30 days</span></div><ul class="list mb-list">${past.map(b => row(b, false)).join('')}</ul></div>` : ''}`;
  $$('[data-cancel]').forEach(b => b.onclick = () => cancelBooking(b.dataset.cancel, b.dataset.what, false, () => render()));
}

// ---------- the public calendar (no sign-in) ----------
function renderPublicRooms() {
  stopRoomsLive();
  $('#app').innerHTML = `<header class="top"><div class="top-in">
      <a class="brand" href="#/rooms" aria-label="SAO Rooms"><img src="assets/brand/sponsors-mark.svg" alt=""><b>SAO <span>Rooms</span></b></a>
      <div class="top-tools"><a class="btn key sm" href="#/" id="pub-signin">Club rep? Sign in</a></div></div></header>
    <main id="main"></main>
    <footer class="foot"><img src="assets/guc-logo.jpg" alt="German University in Cairo"><span>Student Activities Office · Times in Cairo time</span></footer>`;
  viewRooms($('#main'), { publicView: true });
}

// ---------- Admin > Rooms ----------
async function viewRoomsAdmin(box) {
  const [cal, set] = await Promise.all([GET('/api/rooms/calendar?from=' + new Date().toISOString().slice(0, 10)), GET('/api/rooms-settings')]);
  const apiBase = (API || location.origin).replace(/\/+$/, '');
  const last = set.lastSync;
  const status = !set.sheetUrl ? '<span class="chip released">' + svg('released') + 'Not connected</span>'
    : last && last.ok ? `<span class="chip confirmed">${svg('confirmed')}Connected</span> <span class="muted small">last update ${ago(last.at)}</span>`
    : `<span class="chip rejected">${svg('rejected')}Problem</span> <span class="muted small">${esc(last ? last.error : 'Not synced yet')}</span>`;
  box.innerHTML = `
    <div class="grid cols-even">
      <div class="col">
        <form class="card stack" id="ra-term" novalidate><h2>Term</h2>
          <div class="form-grid">${field('First day', `<input class="input" type="date" name="termStart" value="${esc(set.term.start)}">`)}${field('Last day', `<input class="input" type="date" name="termEnd" value="${esc(set.term.end)}">`)}</div>
          <div class="field"><span>Days rooms can be booked</span><div class="row">${R_DAYS.map((n, i) => `<label class="check small"><input type="checkbox" name="wd" value="${i}" ${set.term.weekdays.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
          <p class="err"></p><div><button class="btn key">Save term</button></div></form>
        ${cal.slots.map(s => `<form class="card stack" data-slot="${s.id}" novalidate><h2>${esc(s.name)}</h2>
          <div class="form-grid">${field('Starts', `<input class="input" type="time" name="start" value="${esc(s.start)}">`)}${field('Ends', `<input class="input" type="time" name="end" value="${esc(s.end)}">`)}</div>
          <div class="form-grid">${field('Name', `<input class="input" name="name" value="${esc(s.name)}" maxlength="40">`)}${field('Rooms per club per day', `<input class="input" type="number" name="maxPerDay" min="1" max="50" value="${s.maxPerDay}">`)}</div>
          <p class="err"></p><div><button class="btn ghost">Save ${esc(s.name.toLowerCase())}</button></div></form>`).join('')}
      </div>
      <div class="col">
        <div class="card stack" id="ra-sheet"><div class="card-head" style="margin:0"><h2>Security Google Sheet</h2><div>${status}</div></div>
          <p class="small">Every booking, cancellation and block is copied to a Google Sheet for security within seconds, as neat tabs: <b>Today</b>, <b>Next 7 days</b>, and term grids for <b>After hours</b> and <b>Fifth slot</b>.</p>
          <ol class="small ra-steps">
            <li>Create a new Google Sheet (<a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a>) and name it, e.g. "SAO Room Bookings — Security".</li>
            <li>In the sheet: <b>Extensions › Apps Script</b>. Delete what is there, paste the script, and save. <button type="button" class="btn ghost sm" id="ra-copy">${svg('key', 'ic')}Copy the script</button></li>
            <li>Pick <b>setup</b> in the function list at the top and press <b>Run</b>. Allow access when Google asks.</li>
            <li><b>Deploy › New deployment › Web app</b>: Execute as <b>Me</b>, Who has access <b>Anyone</b> › Deploy. Copy the <b>Web app URL</b>.</li>
            <li>Paste it here and press Save and sync. Share the sheet with security as <b>Viewer</b>.</li>
          </ol>
          <form class="stack" id="ra-sheetform" novalidate>${field('Web app URL', `<input class="input" name="sheetUrl" value="${esc(set.sheetUrl)}" placeholder="https://script.google.com/macros/s/…/exec">`)}
            <p class="err"></p><div class="row"><button class="btn key">Save and sync</button>${set.sheetUrl ? '<button type="button" class="btn ghost" id="ra-sync">Sync now</button>' : ''}
            <button type="button" class="link-btn small" id="ra-newkey">Make a new sheet key</button></div></form></div>
        <div class="card"><div class="card-head"><h2>Blocked rooms and days</h2><button class="btn ghost sm" id="ra-block">Block…</button></div>
          ${set.blocks.length ? `<ul class="list">${set.blocks.map(k => `<li><div class="grow"><span class="nm">${esc(rDay(k.date))}</span> · ${esc(k.room || 'All rooms')} · ${esc(k.slotId ? (cal.slots.find(s => s.id === k.slotId) || {}).name : 'Both slots')}
            <div class="muted small">${esc(k.reason)}</div></div><button class="icon-act" data-unblock="${esc(k.id)}" aria-label="Remove block" title="Remove">${svg('trash')}</button></li>`).join('')}</ul>` : empty('Nothing blocked from today on')}</div>
        <div class="card"><div class="card-head"><h2>Export</h2></div><p class="small muted" style="margin-bottom:12px">The whole term in the old sheet's layout: a row per day, a column per after-hours room, then the fifth-slot bookings.</p>
          <button class="btn ghost" id="ra-csv">Download CSV</button></div>
      </div>
    </div>
    <div class="card flush" style="margin-top:16px"><div class="card-head" style="padding-bottom:14px"><h2>${plural(cal.rooms.filter(r => r.active).length, 'room')} in use</h2><button class="btn key" id="ra-addroom">Add room</button></div>
      <div class="table-wrap"><table><thead><tr><th>Room</th><th>Building</th><th>After hours</th><th>Fifth slot</th><th>Seats</th><th>Status</th><th></th></tr></thead><tbody>
      ${cal.rooms.map(r => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.building || '')}</td><td>${r.afterHours ? '✓' : ''}</td><td>${r.fifth ? '✓' : ''}</td><td>${r.capacity || ''}</td>
        <td>${r.active ? '<span class="tag">In use</span>' : '<span class="tag">Archived</span>'}</td><td class="act"><button class="btn ghost sm" data-room="${esc(r.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div></div>`;

  const err = (f, e) => { $('.err', f).textContent = e.message; };
  $('#ra-term').onsubmit = async e => { e.preventDefault(); const f = e.target;
    try { await POST('/api/rooms-settings', { termStart: f.termStart.value, termEnd: f.termEnd.value, weekdays: $$('[name=wd]:checked', f).map(x => +x.value), sheetUrl: set.sheetUrl }); toast('Term saved'); viewRoomsAdmin(box); } catch (x) { err(f, x); } };
  $$('[data-slot]').forEach(f => f.onsubmit = async e => { e.preventDefault();
    try { await POST('/api/slots/' + f.dataset.slot, Object.fromEntries(new FormData(f))); toast('Saved'); viewRoomsAdmin(box); } catch (x) { err(f, x); } });
  $('#ra-copy').onclick = async () => {
    try {
      const tpl = await (await fetch('assets/sheet/security-sheet.gs.txt', { cache: 'no-store' })).text();
      const script = tpl.replace('__API_URL__', apiBase).replace('__SECRET__', set.sheetSecret);
      try { await navigator.clipboard.writeText(script); toast('Script copied — paste it in Apps Script'); }
      catch (e) { dialog({ title: 'Copy the script', submit: 'Done', body: `<textarea class="input" style="min-height:300px;font-family:monospace;font-size:12px" readonly>${esc(script)}</textarea>`, onSubmit: async () => {} }); }
    } catch (e) { toast('Could not load the script: ' + e.message, true); }
  };
  $('#ra-sheetform').onsubmit = async e => { e.preventDefault(); const f = e.target;
    try {
      await POST('/api/rooms-settings', { termStart: set.term.start, termEnd: set.term.end, weekdays: set.term.weekdays, sheetUrl: f.sheetUrl.value.trim() });
      if (f.sheetUrl.value.trim()) { const r = await POST('/api/rooms-sheet/sync'); r.ok ? toast('Connected — the sheet is up to date') : toast(r.error, true); }
      viewRoomsAdmin(box);
    } catch (x) { err(f, x); } };
  const sync = $('#ra-sync');
  if (sync) sync.onclick = async () => { sync.disabled = true; try { const r = await POST('/api/rooms-sheet/sync'); r.ok ? toast('Sheet updated') : toast(r.error, true); } catch (x) { toast(x.message, true); } viewRoomsAdmin(box); };
  $('#ra-newkey').onclick = () => dialog({ title: 'Make a new sheet key?', danger: true, submit: 'Make new key',
    intro: 'The sheet stops updating until you copy the script again, paste it in Apps Script and deploy a new version. Do this only if the old key leaked.',
    body: '', onSubmit: async () => { await POST('/api/rooms-settings/secret'); toast('New key made — copy the script again'); viewRoomsAdmin(box); } });
  $('#ra-csv').onclick = async () => {
    try {
      const r = await fetch(API + '/api/rooms/export.csv', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `room-bookings-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message || 'Export failed', true); }
  };
  $('#ra-block').onclick = () => dialog({ title: 'Block rooms', danger: true, submit: 'Block',
    intro: 'Blocked rooms show on the calendar and cannot be booked. Bookings already there are cancelled and their clubs are told.',
    body: `<div class="form-grid">${field('From', `<input class="input" type="date" name="date" required value="${esc(cal.today)}">`)}${field('To <em>(optional)</em>', '<input class="input" type="date" name="dateTo">')}</div>
      <div class="form-grid">${field('Room', `<select class="input" name="roomId"><option value="">All rooms</option>${cal.rooms.filter(r => r.active).map(r => `<option value="${esc(r.id)}">${esc(r.code)}</option>`).join('')}</select>`)}
        ${field('Slot', `<select class="input" name="slotId"><option value="">Both slots</option>${cal.slots.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`)}</div>
      ${field('Reason <em>(shown on the calendar)</em>', '<input class="input" name="reason" required maxlength="200" placeholder="Exams, holiday, university event…">')}`,
    onSubmit: async v => { const r = await POST('/api/blocks', v); toast(`Blocked ${plural(r.days, 'day')}${r.cancelled ? `, ${plural(r.cancelled, 'booking')} cancelled` : ''}`); viewRoomsAdmin(box); } });
  $$('[data-unblock]').forEach(b => b.onclick = () => confirmDelete({ title: 'Remove this block?', url: `/api/blocks/${b.dataset.unblock}/delete`, text: 'The room can be booked again. Cancelled bookings are not restored.', done: () => viewRoomsAdmin(box) }));
  const roomForm = (r = {}) => `<div class="form-grid">${field('Room code', `<input class="input" name="code" value="${esc(r.code || '')}" required maxlength="20" placeholder="C5.101">`)}${field('Building', `<input class="input" name="building" value="${esc(r.building || '')}" maxlength="20" placeholder="C5">`)}</div>
    <div class="row"><label class="check"><input type="checkbox" name="afterHours" ${r.afterHours ? 'checked' : ''}> After hours</label><label class="check"><input type="checkbox" name="fifth" ${r.fifth || !r.id ? 'checked' : ''}> Fifth slot</label></div>
    ${field('Seats <em>(optional)</em>', `<input class="input" type="number" name="capacity" min="1" value="${r.capacity || ''}">`)}
    ${r.id ? `<label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> In use (untick to archive)</label>` : ''}`;
  const roomBody = v => ({ code: v.code, building: v.building, afterHours: !!v.afterHours, fifth: !!v.fifth, capacity: v.capacity, active: v.active !== undefined ? !!v.active : undefined });
  $('#ra-addroom').onclick = () => dialog({ title: 'Add room', key: true, submit: 'Add room', body: roomForm(), onSubmit: async v => { await POST('/api/rooms', roomBody(v)); toast('Room added'); viewRoomsAdmin(box); } });
  $$('[data-room]').forEach(b => b.onclick = () => { const r = cal.rooms.find(x => x.id === b.dataset.room);
    dialog({ title: 'Edit ' + r.code, body: roomForm(r), onSubmit: async v => { await POST('/api/rooms/' + r.id, { ...roomBody(v), active: !!v.active }); toast('Saved'); viewRoomsAdmin(box); } }); });
}
