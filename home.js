// SAO Portal — the rep's Home page, the "+ New" menu, and the rooms card on SAO's dashboard. Uses the helpers in app.js and rooms.js.
'use strict';

// ---------- "+ New" ----------
function openNewMenu() {
  if ($('.pop.newmenu')) return closePop();
  closePop();
  const sao = S.user.role === 'sao';
  const items = sao
    ? [['cal', 'Book a room for a club', 'Pick a day and tap a free room', () => { location.hash = '#/rooms?view=day'; }],
       ['user', 'Add an account', 'A rep or an SAO Head', () => { window._openNext = 'add-account'; if (location.hash === '#/admin/users') render(); else location.hash = '#/admin/users'; }],
       ['lock', 'Block rooms', 'Exams, holidays, events', () => { window._openNext = 'block'; if (location.hash === '#/admin/rooms') render(); else location.hash = '#/admin/rooms'; }]]
    : [['plus', 'Add a sponsor', 'Reserve a sponsor for your club', () => { location.hash = '#/add'; }],
       ['cal', 'Book a room', 'After hours or fifth slot', () => { location.hash = '#/rooms?view=day'; }],
       ['chat', 'Ask SAO', 'About a sponsor or anything else', () => askSao('', null)]];
  const p = document.createElement('div');
  p.className = 'pop newmenu';
  p.innerHTML = `<div class="pop-head"><b>New</b></div>` + items.map(([ic, t, sub], i) =>
    `<button class="pop-btn nm-item" data-i="${i}"><span class="nm-ic">${svg(ic, 'ic')}</span><span><b>${esc(t)}</b><span class="muted small">${esc(sub)}</span></span></button>`).join('');
  ($('.top') || document.body).appendChild(p);
  $$('.nm-item', p).forEach(b => b.onclick = () => { closePop(); items[+b.dataset.i][3](); });
}

// ---------- the rep's Home ----------
async function viewHome() {
  const [claims, bookings, requests] = await Promise.all([GET('/api/claims?status=active'), GET('/api/bookings/mine'), GET('/api/requests')]);
  const today = S.today, max = S.settings.maxActive, club = clubOf(S.user.clubId);
  const DAY = 86400000;
  const n = st => claims.filter(c => c.status === st).length;
  const first = String(S.user.name || '').split(/\s+/)[0];

  // what needs the rep's attention
  const todo = [];
  for (const c of claims.filter(c => c.status === 'reserved' && c.expiresAt - Date.now() < 3 * DAY).sort((a, b) => a.expiresAt - b.expiresAt))
    todo.push(['warn', 'k-red', `${c.sponsor}: ${left(c.expiresAt)}`, 'Log your first contact or the sponsor is released.', `#/claim/${c.id}`]);
  for (const c of claims.filter(c => c.status === 'pending_review'))
    todo.push(['pending_review', 'k-yellow', `${c.sponsor} is waiting for SAO`, 'The name looks like another sponsor; SAO checks it first.', `#/claim/${c.id}`]);
  if (claims.length >= max) todo.push(['lock', 'k-red', `Your club holds ${claims.length} of ${max} sponsors`, 'Close one before adding another.', '#/mine']);
  for (const r of requests.filter(r => r.reply && r.resolvedAt && Date.now() - r.resolvedAt < 14 * DAY))
    todo.push(['chat', 'k-blue', `SAO replied about ${r.sponsorName}`, r.reply, '#/requests']);
  if (S.unread) todo.push(['bell', 'k-blue', `${plural(S.unread, 'new notification')}`, 'Open the bell at the top to read them.', null]);

  // rooms coming up
  const up = bookings.filter(b => b.active && b.date >= today);
  const byDay = {};
  for (const b of up) (byDay[b.date] = byDay[b.date] || []).push(b);
  const days = Object.keys(byDay).sort().slice(0, 4);
  const dayName = d => d === today ? 'Today' : rDay(d).split(' ')[0] + ' ' + rDMY(d).slice(0, 5);

  $('#main').innerHTML = `
    <div class="home-hero">
      <div class="club-title">${logo(club, 60)}<div><div class="label">${esc(club.name || '')}</div><h1>Hi${first ? ', ' + esc(first) : ''}</h1></div></div>
      <div class="home-actions">
        <a class="btn key" href="#/add">${svg('plus', 'ic')}Add a sponsor</a>
        <a class="btn ghost" href="#/rooms?view=day">${svg('cal', 'ic')}Book a room</a>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="col">
        <section class="card"><div class="card-head"><h2>Needs your attention</h2>${todo.length ? `<span class="count">${todo.length}</span>` : ''}</div>
          ${todo.length ? `<ul class="todo">${todo.map(([ic, k, t, sub, href]) => `<li class="${k}">${href ? `<a href="${href}">` : '<div>'}
              <span class="todo-ic">${svg(ic)}</span><span class="grow"><b>${esc(t)}</b><span class="muted small">${esc(sub)}</span></span>${href ? `${svg('back', 'ic todo-go')}</a>` : '</div>'}</li>`).join('')}</ul>`
            : `<div class="home-ok">${svg('confirmed')}<div><b>All good</b><span class="muted small">Nothing needs you right now.</span></div></div>`}
        </section>
        <section class="card"><div class="card-head"><h2>Your rooms</h2><a class="small" href="#/rooms/mine">All bookings</a></div>
          ${days.length ? days.map(d => `<div class="hr-day"><div class="hr-date ${d === today ? 'is-today' : ''}"><b>${esc(dayName(d))}</b></div><ul class="hr-list">
              ${byDay[d].map(b => `<li><span class="hr-room">${esc(b.room)}</span><span class="rs ${b.slotId === 'after' ? 'rs-booked' : 'rs-mine'}">${esc(b.slot)}</span>
                <span class="muted small">${rT12(b.start)} – ${rT12(b.end)}${b.purpose ? ' · ' + esc(b.purpose) : ''}${b.seriesId ? ' · weekly' : ''}</span></li>`).join('')}</ul></div>`).join('')
            : `<div class="home-empty">${svg('cal', 'ic')}<div><b>No rooms booked</b><span class="muted small">Book after-hours or fifth-slot rooms for your club.</span></div><a class="btn ghost sm" href="#/rooms?view=day">Book a room</a></div>`}
        </section>
      </div>
      <div class="col">
        <section class="card"><div class="card-head"><h2>Sponsors</h2><a class="small" href="#/mine">Open my sponsors</a></div>
          <div class="home-kpis">
            <a href="#/mine?status=active" class="${claims.length >= max ? 'alert' : ''}"><b>${claims.length}<small class="of"> / ${max}</small></b><span>Active</span></a>
            <a href="#/mine?status=reserved"><b>${n('reserved')}</b><span>Reserved</span></a>
            <a href="#/mine?status=negotiation"><b>${n('contacted') + n('negotiation')}</b><span>In progress</span></a>
            <a href="#/mine?status=confirmed"><b>${n('confirmed')}</b><span>Confirmed</span></a>
          </div>
          <div class="home-meter" aria-hidden="true"><i style="width:${Math.min(100, claims.length / max * 100)}%"></i></div>
          <p class="muted small" style="margin-top:6px">${claims.length >= max ? 'Your club is at the limit.' : `${max - claims.length} more sponsor${max - claims.length === 1 ? '' : 's'} can be added.`}</p>
        </section>
        <section class="card"><div class="card-head"><h2>Quick links</h2></div>
          <div class="quick">
            <a href="#/add">${svg('plus', 'ic')}<span>Add a sponsor</span></a>
            <a href="#/rooms?view=day">${svg('cal', 'ic')}<span>Book a room</span></a>
            <a href="#/rooms/mine">${svg('list', 'ic')}<span>My club's bookings</span></a>
            <button type="button" id="hq-ask">${svg('chat', 'ic')}<span>Ask SAO</span></button>
          </div>
        </section>
      </div>
    </div>`;
  $('#hq-ask').onclick = () => askSao('', null);
}

// ---------- SAO dashboard: rooms ----------
async function fillDashRooms(box) {
  if (!box) return;
  try {
    const from = S.today, to = rAdd(from, 6);
    const cal = await GET(`/api/rooms/calendar?from=${from}&to=${to}`);
    const teaching = d => d >= cal.term.start && d <= cal.term.end && cal.term.weekdays.includes(rWd(d));
    let day = from; for (let i = 0; i < 7 && !teaching(day); i++) day = rAdd(day, 1);
    const onDay = cal.bookings.filter(b => b.date === day);
    const roomsFor = id => cal.rooms.filter(r => r.active !== false && (id === 'after' ? r.afterHours : r.fifth));
    const counts = {}; for (const b of cal.bookings) counts[b.clubId] = (counts[b.clubId] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const blocks = cal.blocks.filter(k => k.date === day);
    const clubOfId = id => cal.clubs.find(c => c.id === id) || { name: 'A club' };
    box.innerHTML = `<div class="card-head"><h2>Rooms</h2><a class="small" href="#/rooms?view=day&date=${day}">Open calendar</a></div>
      <p class="muted small" style="margin:-6px 0 12px">${day === S.today ? 'Today' : 'Next booking day'} · ${esc(rDay(day))}</p>
      <div class="dr-slots">${cal.slots.map(s => { const used = onDay.filter(b => b.slotId === s.id).length, all = roomsFor(s.id).length;
        return `<div class="dr-slot"><span class="label">${esc(s.name)}</span><b>${used}<small> / ${all}</small></b><span class="muted small">rooms in use</span>
          <div class="home-meter ${s.id}"><i style="width:${all ? used / all * 100 : 0}%"></i></div></div>`; }).join('')}</div>
      <div class="dr-foot"><span><b>${cal.bookings.length}</b> booking${cal.bookings.length === 1 ? '' : 's'} in the next 7 days</span>
        ${blocks.length ? `<span class="rs rs-blocked">${svg('lock')}${blocks.length} blocked</span>` : ''}</div>
      ${top.length ? `<p class="label" style="margin:14px 0 6px">Busiest clubs this week</p><ul class="list">${top.map(([id, n]) => `<li>${logo(clubOfId(id), 26)}<span class="grow nm">${esc(clubOfId(id).name)}</span><span class="tag">${plural(n, 'booking')}</span></li>`).join('')}</ul>` : ''}`;
  } catch (e) { box.innerHTML = `<div class="card-head"><h2>Rooms</h2></div><p class="muted small">${esc(e.message)}</p>`; }
}
