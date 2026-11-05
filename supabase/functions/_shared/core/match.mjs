// Sponsor names and Instagram handles, turned into forms that can be compared.
//   exact:    same letters and numbers after ignoring case, spaces, punctuation and accents ("Pepsi Co." = "pepsico")
//   possible: a typo, an "Egypt" style suffix, or one name inside the other ("Vodafone" / "Vodafone Cash")

const ARABIC = [[/[إأآا]/g, 'ا'], [/ى/g, 'ي'], [/ة/g, 'ه'], [/[ؤ]/g, 'و'], [/[ئ]/g, 'ي'], [/[ً-ْـ]/g, '']];
// Words that often get added to a brand name without changing which brand it is
const FILLER = new Set(['the', 'egypt', 'eg', 'egy', 'egyptian', 'misr', 'masr', 'cairo', 'official', 'co', 'company', 'group', 'inc', 'ltd',
  'llc', 'sae', 'corp', 'corporation', 'international', 'intl', 'mena', 'middle', 'east', 'مصر', 'ايجيبت', 'شركه', 'جروب']);

function words(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
  for (const [re, to] of ARABIC) t = t.replace(re, to);
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// Exact form: "Pepsi Co." -> "pepsico"
export const normName = s => words(s).join('');
// Core form without filler words: "Pepsi Egypt" -> "pepsi"
export function coreName(s) {
  const w = words(s).filter(x => x !== 'and');
  const kept = w.filter(x => !FILLER.has(x));
  return (kept.length ? kept : w).join('');
}
const coreWords = s => { const w = words(s).filter(x => x !== 'and'); const k = w.filter(x => !FILLER.has(x)); return k.length ? k : w; };

// Typing distance (insert, delete, change, swap two letters)
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

// Why two names might be the same sponsor, or null
export function possibleMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return null;
  if (na === nb) return 'Same name';
  const ca = coreName(a), cb = coreName(b);
  if (ca && ca === cb) return 'Same name apart from words like "Egypt" or "Group"';
  const len = Math.min(ca.length, cb.length);
  const allowed = len >= 8 ? 2 : len >= 4 ? 1 : 0;
  if (allowed && distance(ca, cb) <= allowed) return 'Very similar spelling';
  const [wa, wb] = [coreWords(a), coreWords(b)];
  const [short, long] = wa.join('').length <= wb.join('').length ? [wa, wb] : [wb, wa];
  const s = short.join(''), l = long.join('');
  if (s.length >= 3 && short.every(w => long.includes(w))) return 'One name contains the other';
  if (s.length >= 5 && l.startsWith(s)) return 'One name contains the other';
  return null;
}

// Instagram: accepts "@name", "name" or a profile link. Returns { handle } or { error }.
const NOT_PROFILES = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'direct', 'about', 'developer', 'legal']);
export function parseInstagram(input) {
  let s = String(input || '').trim();
  if (!s) return { handle: null };
  if (/^(https?:\/\/)?(www\.|m\.)?(instagram\.com|instagr\.am)(\/|$)/i.test(s)) {
    let url;
    try { url = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch { return { error: 'This Instagram link is not valid.' }; }
    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    if (!first || NOT_PROFILES.has(first.toLowerCase())) return { error: 'Paste the link to the sponsor\'s profile page, not a post or reel.' };
    s = first;
  } else if (/^https?:\/\//i.test(s) || s.includes('/') || /^(www\.)|\.(com|net|org)(\.eg)?$/i.test(s)) {
    return { error: 'Use an Instagram profile link (instagram.com/...) or the @handle.' };
  }
  const h = s.replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h) || /^\.|\.$|\.\./.test(h)) return { error: 'An Instagram handle uses only letters, numbers, "." and "_" (up to 30).' };
  return { handle: h };
}
