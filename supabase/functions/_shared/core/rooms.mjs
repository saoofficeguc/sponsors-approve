// Club room booking (from "Club Room Booking Platform — Requirements", 6 Nov 2026).
//   - Two slot types: After hours (max 2 rooms per club per day) and Fifth slot (max 5). Limits are per day and per type.
//   - One club per room per slot (a unique index backs this up), rooms and days can be blocked by SAO.
//   - Reps book only for their own club; SAO can book for any club and override the limits.
//   - The calendar is public (read-only); the security Google Sheet gets a fresh copy after every change.
import { newId } from './auth.mjs';
import { localDate, isDate } from './time.mjs';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toUTC = d => Date.parse(d + 'T12:00:00Z');
export const addDays = (d, n) => new Date(toUTC(d) + n * 86400000).toISOString().slice(0, 10);
export const weekday = d => new Date(toUTC(d)).getUTCDay();
export const ddmmyyyy = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
export const dayLabel = d => `${DAY_NAMES[weekday(d)]} ${ddmmyyyy(d)}`;
const isTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const t12 = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// Starting rooms and slot times. Times are placeholders until SAO confirms them (Admin > Rooms).
const AFTER_HOURS_ROOMS = ['C5.101', 'C5.102', 'C5.104', 'C5.105', 'C5.106', 'C5.108', 'C5.112', 'H12', 'H13'];
const FIFTH_ROOMS = [...Array.from({ length: 12 }, (_, i) => `C5.1${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `C5.2${String(i + 1).padStart(2, '0')}`), 'H10', 'H12', 'H13'];

export async function seedRooms(db) {
  await roomsV2(db);
  if ((await db.meta('rooms_v1')) === '1') return;
  if (!(await db.one('SELECT id FROM sp_clubs LIMIT 1'))) return;   // not set up yet; setup runs this again
  if (!(await db.one('SELECT id FROM sp_slots LIMIT 1'))) {
    // After hours is listed first (sort 0), the fifth slot under it
    await db.q(`INSERT INTO sp_slots (id, name, start_time, end_time, max_per_day, sort) VALUES ('after', 'After hours', '17:30', '20:00', 2, 0)`);
    await db.q(`INSERT INTO sp_slots (id, name, start_time, end_time, max_per_day, sort) VALUES ('fifth', 'Fifth slot', '15:15', '17:30', 5, 1)`);
  }
  if (!(await db.one('SELECT id FROM sp_rooms LIMIT 1'))) {
    const codes = [...new Set([...AFTER_HOURS_ROOMS, ...FIFTH_ROOMS])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    let i = 0;
    for (const code of codes)
      await db.q('INSERT INTO sp_rooms (id, code, building, after_hours, fifth, active, sort) VALUES ($1, $2, $3, $4, $5, 1, $6)',
        [newId(), code, code.startsWith('H') ? 'H' : code.split('.')[0], AFTER_HOURS_ROOMS.includes(code) ? 1 : 0, FIFTH_ROOMS.includes(code) ? 1 : 0, i++]);
  }
  if (!(await db.meta('term_start'))) {
    await db.meta('term_start', '2026-09-13'); await db.meta('term_end', '2026-12-31'); await db.meta('weekdays', '0,1,2,3');
  }
  await db.meta('rooms_v1', '1');
  await db.meta('rooms_v2', '1');
}

// Once, on sites made with the first placeholder times: After hours first, and the confirmed times
// (after hours 17:30–20:00, fifth slot 15:15–17:30). Times SAO already changed are left alone.
async function roomsV2(db) {
  if ((await db.meta('rooms_v2')) === '1' || (await db.meta('rooms_v1')) !== '1') return;
  await db.q(`UPDATE sp_slots SET sort = 0 WHERE id = 'after'`);
  await db.q(`UPDATE sp_slots SET sort = 1 WHERE id = 'fifth'`);
  await db.q(`UPDATE sp_slots SET start_time = '17:30', end_time = '20:00' WHERE id = 'after' AND start_time = '18:30' AND end_time = '21:30'`);
  await db.q(`UPDATE sp_slots SET start_time = '15:15', end_time = '17:30' WHERE id = 'fifth' AND start_time = '15:45' AND end_time = '18:30'`);
  // bookings for the whole old fifth slot become the whole new one; others are kept inside the new times
  await db.q(`UPDATE sp_bookings SET start_time = '15:15', end_time = '17:30' WHERE slot_id = 'fifth' AND start_time = '15:45' AND end_time = '18:30'`);
  await db.q(`UPDATE sp_bookings SET end_time = '17:30' WHERE slot_id = 'fifth' AND end_time > '17:30'`);
  await db.q(`UPDATE sp_bookings SET start_time = '15:15' WHERE slot_id = 'fifth' AND start_time < '15:15'`);
  await db.q(`UPDATE sp_bookings SET start_time = '15:15' WHERE slot_id = 'fifth' AND start_time >= end_time`);
  await db.q(`UPDATE sp_bookings SET start_time = '17:30', end_time = '20:00' WHERE slot_id = 'after'`);
  await db.meta('rooms_v2', '1');
}

export function registerRooms(x) {
  const { on, q, one, db, fail, need, str, now, audit, notifyClub, rateLimit, CLUB_COLS, clubOut } = x;

  const term = async () => ({
    start: (await db.meta('term_start')) || '2026-09-13', end: (await db.meta('term_end')) || '2026-12-31',
    weekdays: ((await db.meta('weekdays')) || '0,1,2,3').split(',').filter(Boolean).map(Number),
  });
  const slotsAll = async () => (await q('SELECT * FROM sp_slots ORDER BY sort')).map(s => ({ id: s.id, name: s.name, start: s.start_time, end: s.end_time, maxPerDay: Number(s.max_per_day) }));
  const roomView = r => ({ id: r.id, code: r.code, building: r.building, afterHours: !!Number(r.after_hours), fifth: !!Number(r.fifth),
    capacity: r.capacity == null ? null : Number(r.capacity), active: !!Number(r.active) });
  const allows = (room, slotId) => Number(slotId === 'after' ? room.after_hours : room.fifth) === 1;
  const termDays = t => { const out = []; for (let d = t.start; d <= t.end && out.length < 400; d = addDays(d, 1)) if (t.weekdays.includes(weekday(d))) out.push(d); return out; };
  const slotWord = id => id === 'after' ? 'after-hours' : 'fifth-slot';

  async function blockFor(date, roomId, slotId) {
    return one(`SELECT * FROM sp_blocks WHERE date = $1 AND (room_id IS NULL OR room_id = $2) AND (slot_id IS NULL OR slot_id = $3) LIMIT 1`, [date, roomId, slotId]);
  }
  async function freeRooms(date, slotId, limit = 5) {
    const rooms = (await q('SELECT * FROM sp_rooms WHERE active = 1 ORDER BY sort')).filter(r => allows(r, slotId));
    const taken = new Set((await q('SELECT room_id FROM sp_bookings WHERE date = $1 AND slot_id = $2 AND active = 1', [date, slotId])).map(b => b.room_id));
    const out = [];
    for (const r of rooms) { if (taken.has(r.id) || await blockFor(date, r.id, slotId)) continue; out.push(r.code); if (out.length >= limit) break; }
    return out;
  }

  // Everything a booking must pass (both for new bookings and edits of the time)
  async function checkDay(date, user) {
    if (!isDate(date)) fail(400, 'Choose a date.');
    const t = await term();
    if (date < t.start || date > t.end) fail(400, `Bookings are open from ${ddmmyyyy(t.start)} to ${ddmmyyyy(t.end)}.`);
    if (!t.weekdays.includes(weekday(date))) fail(400, `Rooms can only be booked on ${t.weekdays.map(w => DAY_NAMES[w]).join(', ')}.`);
    if (date < localDate(now())) fail(400, 'That day is in the past.');
    return t;
  }
  function checkTimes(slot, start, end) {
    if (slot.id !== 'fifth') return { start: slot.start_time, end: slot.end_time };
    const s = start || slot.start_time, e = end || slot.end_time;
    if (!isTime(s) || !isTime(e)) fail(400, 'Times look like 16:30.');
    if (s >= e) fail(400, 'The end time must be after the start time.');
    if (s < slot.start_time || e > slot.end_time) fail(400, `The fifth slot runs from ${t12(slot.start_time)} to ${t12(slot.end_time)}; choose times inside it.`);
    return { start: s, end: e };
  }

  // ---------- public calendar ----------
  on('GET', '/api/rooms/calendar', 'none', async ({ user, params, ip }) => {
    rateLimit(`cal:${ip}`, 240, 60000, now());
    const t = await term();
    const from = isDate(params.get('from')) ? params.get('from') : localDate(now());
    let to = isDate(params.get('to')) ? params.get('to') : addDays(from, 6);
    if (to < from) fail(400, 'Bad date range.');
    if (toUTC(to) - toUTC(from) > 62 * 86400000) to = addDays(from, 62);
    const sao = user?.role === 'sao';
    const bookings = await q(`SELECT b.*, u.name AS by_name, u.email AS by_email FROM sp_bookings b LEFT JOIN sp_users u ON u.id = b.created_by
      WHERE b.active = 1 AND b.date >= $1 AND b.date <= $2`, [from, to]);
    const blocks = await q('SELECT * FROM sp_blocks WHERE date >= $1 AND date <= $2', [from, to]);
    const clubs = await q(`SELECT ${CLUB_COLS} FROM sp_clubs`);
    return {
      today: localDate(now()), from, to, term: t, slots: await slotsAll(),
      rooms: (await q(`SELECT * FROM sp_rooms ${sao ? '' : 'WHERE active = 1'} ORDER BY sort`)).map(roomView),
      clubs: clubs.map(clubOut),
      bookings: bookings.map(b => ({ id: b.id, date: b.date, roomId: b.room_id, slotId: b.slot_id, clubId: b.club_id, start: b.start_time, end: b.end_time,
        purpose: b.purpose || '', override: !!Number(b.override), createdAt: Number(b.created_at),
        // a rep's personal details are for SAO only
        ...(sao ? { by: b.by_name || null, byEmail: b.by_email || null } : {}) })),
      blocks: blocks.map(k => ({ id: k.id, date: k.date, roomId: k.room_id, slotId: k.slot_id, reason: k.reason || '' })),
      me: user ? { role: user.role, clubId: user.club_id || null } : null,
    };
  });

  // ---------- booking ----------
  on('POST', '/api/bookings', 'any', async ({ user, body, defer }) => {
    rateLimit(`book:${user.id}`, 60, 60000, now());
    const sao = user.role === 'sao';
    const clubId = sao ? String(body.clubId || '') : user.club_id;
    const club = await one('SELECT id, name FROM sp_clubs WHERE id = $1 AND active = 1', [clubId || '']);
    if (!club) fail(400, sao ? 'Choose the club.' : 'Your account is not linked to an active club. Ask SAO.');
    const date = String(body.date || '');
    await checkDay(date, user);
    const slot = await one('SELECT * FROM sp_slots WHERE id = $1', [String(body.slotId || '')]);
    if (!slot) fail(400, 'Choose after hours or fifth slot.');
    const room = await one('SELECT * FROM sp_rooms WHERE id = $1 AND active = 1', [String(body.roomId || '')]);
    if (!room) fail(400, 'Choose a room.');
    if (!allows(room, slot.id)) fail(400, `${room.code} can't be booked for the ${slot.name.toLowerCase()}.`);
    const blk = await blockFor(date, room.id, slot.id);
    if (blk) fail(409, `${room.code} is blocked on ${dayLabel(date)}${blk.reason ? ': ' + blk.reason : ''}.`, { code: 'blocked', suggest: await freeRooms(date, slot.id) });
    const { start, end } = checkTimes(slot, str(body.start, 5), str(body.end, 5));
    const purpose = str(body.purpose, 200);
    const holder = await one(`SELECT b.id, c.name FROM sp_bookings b JOIN sp_clubs c ON c.id = b.club_id WHERE b.date = $1 AND b.room_id = $2 AND b.slot_id = $3 AND b.active = 1`, [date, room.id, slot.id]);
    if (holder) fail(409, `${room.code} is already booked by ${holder.name} for the ${slot.name.toLowerCase()} on ${dayLabel(date)}.`, { code: 'taken', suggest: await freeRooms(date, slot.id) });
    const used = Number((await one('SELECT COUNT(*) AS n FROM sp_bookings WHERE club_id = $1 AND date = $2 AND slot_id = $3 AND active = 1', [club.id, date, slot.id]))?.n || 0);
    const max = Number(slot.max_per_day), override = sao && !!body.override;
    if (used >= max && !override)
      fail(409, sao ? `${club.name} already has ${used} ${slotWord(slot.id)} room${used === 1 ? '' : 's'} on ${dayLabel(date)} (the limit is ${max}). Tick "Admin override" to book anyway.`
        : `Your club already has ${max} ${slotWord(slot.id)} room${max === 1 ? '' : 's'} on ${dayLabel(date)}, the most allowed.`, { code: 'limit' });
    const id = newId();
    try {
      await q(`INSERT INTO sp_bookings (id, date, room_id, slot_id, club_id, created_by, start_time, end_time, purpose, active, override, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)`, [id, date, room.id, slot.id, club.id, user.id, start, end, purpose || null, used >= max ? 1 : 0, now()]);
    } catch (e) { if (e && (e.code === '23505' || /UNIQUE/i.test(e.message || ''))) fail(409, `${room.code} was just booked by another club. Choose another room.`, { code: 'taken', suggest: await freeRooms(date, slot.id) }); throw e; }
    await audit(user, 'booking.create', `booking:${id}`, null, { club: club.name, room: room.code, slot: slot.name, date: ddmmyyyy(date), start, end, override: used >= max });
    if (sao && user.club_id !== club.id) await notifyClub(club.id, `SAO booked ${room.code} (${slot.name}) for your club on ${dayLabel(date)}.`, '#/rooms/mine');
    defer(pushSheet);
    return { ok: true, id, used: used + 1, max };
  });

  async function bookingFor(user, id) {
    const b = await one(`SELECT b.*, r.code, s.name AS slot_name, s.start_time AS s_start, s.end_time AS s_end, c.name AS club_name FROM sp_bookings b
      JOIN sp_rooms r ON r.id = b.room_id JOIN sp_slots s ON s.id = b.slot_id JOIN sp_clubs c ON c.id = b.club_id WHERE b.id = $1`, [String(id)]);
    if (!b || (user.role !== 'sao' && b.club_id !== user.club_id)) fail(403, 'Access denied.');
    return b;
  }

  // change the purpose, or the times inside the fifth slot
  on('POST', '/api/bookings/:id', 'any', async ({ user, args, body, defer }) => {
    const b = await bookingFor(user, args.id);
    if (!Number(b.active)) fail(409, 'This booking is cancelled.');
    if (b.date < localDate(now())) fail(400, 'Past bookings cannot be changed.');
    const { start, end } = checkTimes({ id: b.slot_id, start_time: b.s_start, end_time: b.s_end }, str(body.start, 5) || b.start_time, str(body.end, 5) || b.end_time);
    const purpose = body.purpose === undefined ? b.purpose : (str(body.purpose, 200) || null);
    await q('UPDATE sp_bookings SET start_time = $1, end_time = $2, purpose = $3 WHERE id = $4', [start, end, purpose, b.id]);
    await audit(user, 'booking.edit', `booking:${b.id}`, { start: b.start_time, end: b.end_time, purpose: b.purpose }, { start, end, purpose });
    defer(pushSheet);
    return { ok: true };
  });

  on('POST', '/api/bookings/:id/cancel', 'any', async ({ user, args, body, defer }) => {
    const b = await bookingFor(user, args.id);
    if (!Number(b.active)) fail(409, 'This booking is already cancelled.');
    if (b.date < localDate(now())) fail(400, 'Past bookings cannot be cancelled.');
    const reason = str(body.reason, 300) || null;
    await q('UPDATE sp_bookings SET active = 0, cancelled_at = $1, cancelled_by = $2, cancel_reason = $3 WHERE id = $4', [now(), user.id, reason, b.id]);
    await audit(user, 'booking.cancel', `booking:${b.id}`, { club: b.club_name, room: b.code, slot: b.slot_name, date: ddmmyyyy(b.date) }, null, reason);
    if (user.role === 'sao' && user.club_id !== b.club_id)
      await notifyClub(b.club_id, `SAO cancelled your ${b.slot_name.toLowerCase()} booking of ${b.code} on ${dayLabel(b.date)}${reason ? ': ' + reason : '.'}`, '#/rooms/mine');
    defer(pushSheet);
    return { ok: true };
  });

  // the club's own list (upcoming and the last 30 days, cancellations included)
  on('GET', '/api/bookings/mine', 'any', async ({ user }) => {
    if (!user.club_id) return [];
    const rows = await q(`SELECT b.*, r.code, s.name AS slot_name, u.name AS by_name FROM sp_bookings b JOIN sp_rooms r ON r.id = b.room_id
      JOIN sp_slots s ON s.id = b.slot_id LEFT JOIN sp_users u ON u.id = b.created_by
      WHERE b.club_id = $1 AND b.date >= $2 ORDER BY b.date, s.sort, r.sort`, [user.club_id, addDays(localDate(now()), -30)]);
    return rows.map(b => ({ id: b.id, date: b.date, room: b.code, roomId: b.room_id, slotId: b.slot_id, slot: b.slot_name, start: b.start_time, end: b.end_time,
      purpose: b.purpose || '', active: !!Number(b.active), override: !!Number(b.override), by: b.by_name || 'SAO', createdAt: Number(b.created_at),
      cancelReason: b.cancel_reason || null }));
  });

  // ---------- SAO: rooms, slot times, term, blocks ----------
  async function roomFields(body, existing) {
    const code = need(body.code, 'Room code', 2, 20).toUpperCase().replace(/\s+/g, '');
    const dupe = await one('SELECT id FROM sp_rooms WHERE UPPER(code) = $1', [code]);
    if (dupe && dupe.id !== existing?.id) fail(409, `There is already a room ${code}.`);
    const building = str(body.building, 20) || (code.startsWith('H') ? 'H' : code.split('.')[0]);
    const afterHours = body.afterHours ? 1 : 0, fifth = body.fifth ? 1 : 0;
    if (!afterHours && !fifth) fail(400, 'Choose at least one slot type for the room.');
    const cap = body.capacity === '' || body.capacity == null ? null : Math.round(Number(body.capacity));
    if (cap != null && !(cap >= 1 && cap <= 2000)) fail(400, 'Capacity must be a number of people.');
    return { code, building, afterHours, fifth, cap };
  }
  on('POST', '/api/rooms', 'sao', async ({ user, body, defer }) => {
    const f = await roomFields(body);
    const sort = Number((await one('SELECT COALESCE(MAX(sort), 0) AS m FROM sp_rooms'))?.m || 0) + 1, id = newId();
    await q('INSERT INTO sp_rooms (id, code, building, after_hours, fifth, capacity, active, sort) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)', [id, f.code, f.building, f.afterHours, f.fifth, f.cap, sort]);
    await audit(user, 'room.create', `room:${id}`, null, { code: f.code });
    defer(pushSheet);
    return { ok: true, id };
  });
  on('POST', '/api/rooms/:id', 'sao', async ({ user, args, body, defer }) => {
    const r = await one('SELECT * FROM sp_rooms WHERE id = $1', [args.id]);
    if (!r) fail(404, 'Room not found.');
    const f = await roomFields(body, r), active = body.active === false ? 0 : 1;
    await q('UPDATE sp_rooms SET code = $1, building = $2, after_hours = $3, fifth = $4, capacity = $5, active = $6 WHERE id = $7', [f.code, f.building, f.afterHours, f.fifth, f.cap, active, r.id]);
    await audit(user, 'room.edit', `room:${r.id}`, { code: r.code, active: !!Number(r.active) }, { code: f.code, active: !!active });
    defer(pushSheet);
    return { ok: true };
  });
  on('POST', '/api/slots/:id', 'sao', async ({ user, args, body, defer }) => {
    const s = await one('SELECT * FROM sp_slots WHERE id = $1', [args.id]);
    if (!s) fail(404, 'Slot not found.');
    const name = need(body.name, 'Name', 2, 40), start = str(body.start, 5), end = str(body.end, 5), max = Math.round(Number(body.maxPerDay));
    if (!isTime(start) || !isTime(end) || start >= end) fail(400, 'Set a start time before the end time, like 15:45 and 18:30.');
    if (!(max >= 1 && max <= 50)) fail(400, 'The limit per club per day must be between 1 and 50.');
    await q('UPDATE sp_slots SET name = $1, start_time = $2, end_time = $3, max_per_day = $4 WHERE id = $5', [name, start, end, max, s.id]);
    await audit(user, 'slot.edit', `slot:${s.id}`, { name: s.name, start: s.start_time, end: s.end_time, maxPerDay: Number(s.max_per_day) }, { name, start, end, maxPerDay: max });
    defer(pushSheet);
    return { ok: true };
  });

  on('GET', '/api/rooms-settings', 'sao', async () => ({
    term: await term(), sheetUrl: (await db.meta('sheet_url')) || '', sheetSecret: await sheetSecret(),
    lastSync: JSON.parse((await db.meta('sheet_last')) || 'null'),
    blocks: (await q(`SELECT k.*, r.code FROM sp_blocks k LEFT JOIN sp_rooms r ON r.id = k.room_id WHERE k.date >= $1 ORDER BY k.date`, [localDate(now())]))
      .map(k => ({ id: k.id, date: k.date, roomId: k.room_id, room: k.code || null, slotId: k.slot_id, reason: k.reason || '' })),
  }));
  on('POST', '/api/rooms-settings', 'sao', async ({ user, body, defer }) => {
    const before = await term();
    const start = body.termStart, end = body.termEnd;
    if (!isDate(start) || !isDate(end) || start > end) fail(400, 'Set the first and last day of the term.');
    const days = (Array.isArray(body.weekdays) ? body.weekdays : []).map(Number).filter(d => d >= 0 && d <= 6);
    if (!days.length) fail(400, 'Choose at least one weekday.');
    const url = str(body.sheetUrl, 500);
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) fail(400, 'The sheet link is the web app URL from Apps Script (it starts with https://script.google.com/).');
    await db.meta('term_start', start); await db.meta('term_end', end); await db.meta('weekdays', [...new Set(days)].sort().join(','));
    await db.meta('sheet_url', url);
    await audit(user, 'rooms.settings', 'settings', before, { start, end, weekdays: days, sheet: !!url });
    defer(pushSheet);
    return { ok: true };
  });
  on('POST', '/api/rooms-settings/secret', 'sao', async ({ user }) => {
    await db.meta('sheet_secret', newId() + newId());
    await audit(user, 'rooms.sheet-secret', 'settings');
    return { secret: await sheetSecret() };
  });

  // Block a room (or all rooms) for one day or a range; bookings already there are cancelled and their clubs told
  on('POST', '/api/blocks', 'sao', async ({ user, body, defer }) => {
    const from = String(body.date || ''), to = isDate(body.dateTo) ? body.dateTo : from;
    if (!isDate(from) || to < from) fail(400, 'Choose the day (or first and last day) to block.');
    if (toUTC(to) - toUTC(from) > 120 * 86400000) fail(400, 'Block at most 120 days at once.');
    const roomId = body.roomId ? String(body.roomId) : null, slotId = body.slotId ? String(body.slotId) : null;
    const room = roomId ? await one('SELECT * FROM sp_rooms WHERE id = $1', [roomId]) : null;
    if (roomId && !room) fail(400, 'Room not found.');
    if (slotId && !(await one('SELECT id FROM sp_slots WHERE id = $1', [slotId]))) fail(400, 'Slot not found.');
    const reason = need(body.reason, 'A reason', 2, 200);
    let days = 0, cancelled = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      await q('INSERT INTO sp_blocks (id, date, room_id, slot_id, reason, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [newId(), d, roomId, slotId, reason, user.id, now()]);
      days++;
      const hit = await q(`SELECT b.id, b.club_id, b.slot_id, r.code FROM sp_bookings b JOIN sp_rooms r ON r.id = b.room_id
        WHERE b.date = $1 AND b.active = 1 ${roomId ? 'AND b.room_id = $2' : ''} ${slotId ? `AND b.slot_id = $${roomId ? 3 : 2}` : ''}`, [d, ...(roomId ? [roomId] : []), ...(slotId ? [slotId] : [])]);
      for (const b of hit) {
        await q('UPDATE sp_bookings SET active = 0, cancelled_at = $1, cancelled_by = $2, cancel_reason = $3 WHERE id = $4', [now(), user.id, `Blocked: ${reason}`, b.id]);
        await notifyClub(b.club_id, `Your booking of ${b.code} on ${dayLabel(d)} was cancelled because SAO blocked it: ${reason}`, '#/rooms/mine');
        cancelled++;
      }
    }
    await audit(user, 'rooms.block', 'blocks', null, { from: ddmmyyyy(from), to: ddmmyyyy(to), room: room?.code || 'all rooms', slot: slotId || 'both', cancelled }, reason);
    defer(pushSheet);
    return { ok: true, days, cancelled };
  });
  on('POST', '/api/blocks/:id/delete', 'sao', async ({ user, args, defer }) => {
    const k = await one('SELECT * FROM sp_blocks WHERE id = $1', [args.id]);
    if (!k) fail(404, 'Not found.');
    await q('DELETE FROM sp_blocks WHERE id = $1', [k.id]);
    await audit(user, 'rooms.unblock', 'blocks', { date: ddmmyyyy(k.date), reason: k.reason }, null);
    defer(pushSheet);
    return { ok: true };
  });

  // CSV of the term in the sheet's grid layout: a row per day, a column per after-hours room, then the fifth-slot bookings
  on('GET', '/api/rooms/export.csv', 'sao', async ({ user }) => {
    const t = await term(), days = termDays(t);
    const rooms = await q('SELECT * FROM sp_rooms WHERE active = 1 ORDER BY sort');
    const after = rooms.filter(r => Number(r.after_hours));
    const clubs = Object.fromEntries((await q('SELECT id, name FROM sp_clubs')).map(c => [c.id, c.name]));
    const all = await q('SELECT * FROM sp_bookings WHERE active = 1 AND date >= $1 AND date <= $2', [t.start, t.end]);
    const code = Object.fromEntries(rooms.map(r => [r.id, r.code]));
    const fifthMax = Math.max(1, ...days.map(d => all.filter(b => b.date === d && b.slot_id === 'fifth').length));
    const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [['Date', 'Day', ...after.map(r => r.code), ...Array.from({ length: fifthMax }, (_, i) => `Fifth slot ${i + 1}`)].map(cell).join(',')];
    for (const d of days) {
      const row = [ddmmyyyy(d), DAY_NAMES[weekday(d)]];
      for (const r of after) row.push(clubs[all.find(b => b.date === d && b.slot_id === 'after' && b.room_id === r.id)?.club_id] || '');
      const fifth = all.filter(b => b.date === d && b.slot_id === 'fifth').map(b => `${code[b.room_id] || ''} ${clubs[b.club_id] || ''} ${b.start_time}-${b.end_time}`);
      for (let i = 0; i < fifthMax; i++) row.push(fifth[i] || '');
      lines.push(row.map(cell).join(','));
    }
    await audit(user, 'rooms.export', 'bookings', null, { days: days.length });
    return new x.Reply(200, '﻿' + lines.join('\r\n') + '\r\n');
  });

  // ---------- the security Google Sheet ----------
  async function sheetSecret() {
    let s = await db.meta('sheet_secret');
    if (!s) { s = newId() + newId(); await db.meta('sheet_secret', s); }
    return s;
  }

  // Ready-to-write tabs: values plus colours, so the Apps Script in the sheet only has to paste them
  async function buildSheet() {
    const t = await term(), today = localDate(now());
    const rooms = await q('SELECT * FROM sp_rooms WHERE active = 1 ORDER BY sort');
    const slots = await slotsAll(), slotName = Object.fromEntries(slots.map(s => [s.id, s.name]));
    const clubs = Object.fromEntries((await q('SELECT id, name FROM sp_clubs')).map(c => [c.id, c.name]));
    const code = Object.fromEntries((await q('SELECT id, code FROM sp_rooms')).map(r => [r.id, r.code]));
    const from = t.start < today ? t.start : today, to = t.end > addDays(today, 7) ? t.end : addDays(today, 7);
    const all = await q('SELECT * FROM sp_bookings WHERE active = 1 AND date >= $1 AND date <= $2', [from, to]);
    const blocks = await q('SELECT * FROM sp_blocks WHERE date >= $1 AND date <= $2', [from, to]);
    const blockOf = (d, roomId, slotId) => blocks.find(k => k.date === d && (!k.room_id || k.room_id === roomId) && (!k.slot_id || k.slot_id === slotId));
    const C = { head: '#121212', headFc: '#FFFFFF', booked: '#E7EEF8', bookedFc: '#1F3B63', override: '#FDE3E4', blocked: '#ECECE6', blockedFc: '#5C5C5C',
      today: '#FFF4B3', past: '#9A9A94', white: '#FFFFFF', ink: '#121212' };
    const updated = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(now()));
    const startOf = b => b.start_time || (slots.find(s => s.id === b.slot_id) || {}).start;
    const endOf = b => b.end_time || (slots.find(s => s.id === b.slot_id) || {}).end;

    // list of bookings (and blocks) for some days, sorted by day, time and room
    const listTab = (name, title, days) => {
      const rows = [], bg = [], fc = [];
      for (const d of days) {
        const items = all.filter(b => b.date === d).map(b => ({ d, time: `${t12(startOf(b))} – ${t12(endOf(b))}`, sortT: startOf(b), slot: slotName[b.slot_id] || b.slot_id,
          room: code[b.room_id] || '', club: clubs[b.club_id] || '', purpose: b.purpose || '', note: Number(b.override) ? 'Admin override' : '', kind: Number(b.override) ? 'override' : 'booked' }));
        for (const k of blocks.filter(k => k.date === d))
          items.push({ d, time: k.slot_id ? `${t12((slots.find(s => s.id === k.slot_id) || {}).start || '00:00')} – ${t12((slots.find(s => s.id === k.slot_id) || {}).end || '23:59')}` : 'All day',
            sortT: k.slot_id ? (slots.find(s => s.id === k.slot_id) || {}).start : '00:00', slot: k.slot_id ? slotName[k.slot_id] : 'Both', room: k.room_id ? code[k.room_id] : 'All rooms',
            club: 'BLOCKED', purpose: k.reason || '', note: '', kind: 'blocked' });
        items.sort((a, b) => a.sortT.localeCompare(b.sortT) || a.room.localeCompare(b.room, 'en', { numeric: true }));
        for (const it of items) {
          rows.push([dayLabel(d), it.time, it.slot, it.room, it.club, it.purpose, it.note]);
          const back = it.kind === 'blocked' ? C.blocked : it.kind === 'override' ? C.override : d === today ? C.today : C.white;
          bg.push(Array(7).fill(back)); fc.push(Array(7).fill(it.kind === 'blocked' ? C.blockedFc : C.ink));
        }
      }
      if (!rows.length) { rows.push(['No room bookings', '', '', '', '', '', '']); bg.push(Array(7).fill(C.white)); fc.push(Array(7).fill(C.past)); }
      return { name, title, subtitle: `Updated ${updated} (Cairo time) · from the SAO booking site — do not edit, changes are overwritten`,
        header: ['Day', 'Time', 'Slot', 'Room', 'Club', 'Purpose / reason', 'Note'], rows, bg, fc, widths: [130, 150, 100, 90, 190, 260, 120], freezeCols: 1 };
    };
    // term grid: a row per teaching day, a column per room of that slot type
    const gridTab = (name, title, slotId) => {
      // from the start of this week (security doesn't need past weeks; the CSV export has the whole term)
      const weekStart = addDays(today, -weekday(today));
      const cols = rooms.filter(r => allows(r, slotId)), days = termDays(t).filter(d => d >= weekStart);
      const rows = [], bg = [], fc = [];
      for (const d of days) {
        const row = [dayLabel(d)], rbg = [d === today ? C.today : C.white], rfc = [d < today ? C.past : C.ink];
        for (const r of cols) {
          const b = all.find(x => x.date === d && x.slot_id === slotId && x.room_id === r.id), k = !b && blockOf(d, r.id, slotId);
          if (b) {
            const custom = slotId === 'fifth' && (b.start_time !== (slots.find(s => s.id === 'fifth') || {}).start || b.end_time !== (slots.find(s => s.id === 'fifth') || {}).end);
            row.push((clubs[b.club_id] || '') + (custom ? ` ${t12(b.start_time)}–${t12(b.end_time)}` : ''));
            rbg.push(Number(b.override) ? C.override : d === today ? C.today : C.booked); rfc.push(d < today ? C.past : C.bookedFc);
          } else if (k) { row.push('Blocked'); rbg.push(C.blocked); rfc.push(C.blockedFc); }
          else { row.push(''); rbg.push(d === today ? C.today : C.white); rfc.push(C.ink); }
        }
        rows.push(row); bg.push(rbg); fc.push(rfc);
      }
      const s = slots.find(x => x.id === slotId) || {};
      if (!rows.length) { rows.push(['The term has ended', ...cols.map(() => '')]); bg.push(Array(cols.length + 1).fill(C.white)); fc.push(Array(cols.length + 1).fill(C.past)); }
      return { name, title, subtitle: `${s.start ? t12(s.start) + ' – ' + t12(s.end) + ' · ' : ''}This week to ${ddmmyyyy(t.end)} · updated ${updated} · today in yellow, blocked in grey, admin overrides in pink`,
        header: ['Day', ...cols.map(r => r.code)], rows, bg, fc, widths: [130, ...cols.map(() => slotId === 'fifth' ? 120 : 140)], freezeCols: 1 };
    };
    const week = []; for (let i = 0; i < 7; i++) week.push(addDays(today, i));
    return {
      generatedAt: now(),
      tabs: [listTab('Today', `Room bookings — today, ${dayLabel(today)}`, [today]), listTab('Next 7 days', 'Room bookings — next 7 days', week),
        gridTab('After hours', 'After hours — rest of term', 'after'), gridTab('Fifth slot', 'Fifth slot — rest of term', 'fifth')],
    };
  }

  // Send the sheet a fresh copy (after every change, and from the "Sync now" button)
  async function pushSheet() {
    const url = await db.meta('sheet_url');
    if (!url) return { ok: false, error: 'No sheet connected yet.' };
    let result;
    try {
      const body = JSON.stringify({ secret: await sheetSecret(), ...(await buildSheet()) });
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch { /* the sheet answered with a page, not JSON */ }
      result = data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || `The sheet answered ${r.status}. Check that the web app is deployed with access "Anyone".` };
    } catch (e) { result = { ok: false, error: 'Could not reach the sheet: ' + (e.message || e) }; }
    await db.meta('sheet_last', JSON.stringify({ at: now(), ...result }));
    return result;
  }
  x.pushSheet = pushSheet;

  on('POST', '/api/rooms-sheet/sync', 'sao', async ({ user }) => {
    const r = await pushSheet();
    await audit(user, 'rooms.sheet-sync', 'sheet', null, r);
    return r;
  });
  // The sheet can also fetch its copy itself (every few minutes, and from its own "Sync now" menu)
  on('GET', '/api/rooms-sheet/data', 'none', async ({ params, ip }) => {
    rateLimit(`sheet:${ip}`, 30, 60000, now());
    if (params.get('secret') !== (await sheetSecret())) fail(403, 'Wrong sheet key.');
    return buildSheet();
  });

  return { buildSheet, pushSheet };
}
