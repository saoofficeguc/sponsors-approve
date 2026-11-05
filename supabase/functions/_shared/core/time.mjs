// Dates in the institution's local time (Cairo). Reservations end at the same local clock time,
// 14 calendar days after they start, even across a daylight-saving change.
export const TZ = 'Africa/Cairo';
const DAY = 86400000;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
// How far Cairo's clock is ahead of UTC at a moment (ms)
function offset(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}
// The moment when Cairo's clock shows a given wall time (wall time written as if it were UTC)
function fromWall(wall) {
  let guess = wall - offset(wall);
  guess = wall - offset(guess);
  return guess;
}
export function addLocalDays(ms, days) {
  const wall = ms + offset(ms);
  return fromWall(wall + days * DAY);
}
// 'YYYY-MM-DD' of a moment in Cairo
export function localDate(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// The moment a local day 'YYYY-MM-DD' starts in Cairo
export function localDayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return fromWall(Date.UTC(y, m - 1, d));
}
export const isDate =s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
