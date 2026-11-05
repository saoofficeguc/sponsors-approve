// Database tables. The same SQL runs on Supabase (Postgres) and on one computer (SQLite) through a small driver:
//   driver.query(sql, params) -> rows   ($1, $2 ... placeholders)
//   driver.exec(sql)                    (several statements, no parameters)
//   driver.transaction(fn)              (runs fn alone and all-or-nothing)
//   driver.dialect                      ('pg' or 'sqlite')
// Every table starts with sp_ so it can share a Supabase project with the SAO Portal.
// Times are milliseconds since 1970 (BIGINT). Yes/no values are 0 or 1.

const TABLES = ['sp_users', 'sp_clubs', 'sp_categories', 'sp_sponsors', 'sp_aliases', 'sp_claims', 'sp_reviews', 'sp_events',
  'sp_audit', 'sp_notices', 'sp_sessions', 'sp_failures', 'sp_meta'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sp_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  club_id TEXT, pass TEXT, active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sp_clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sp_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sp_sponsors (id TEXT PRIMARY KEY, name TEXT NOT NULL, norm_name TEXT NOT NULL, category_id TEXT,
  ig_handle TEXT, state TEXT NOT NULL DEFAULT 'active', merged_into TEXT, created_at BIGINT NOT NULL, created_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS sp_sponsor_name ON sp_sponsors(norm_name) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS sp_sponsor_ig ON sp_sponsors(ig_handle) WHERE state = 'active' AND ig_handle IS NOT NULL;
CREATE TABLE IF NOT EXISTS sp_aliases (id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL, name TEXT NOT NULL, norm_name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sp_claims (id TEXT PRIMARY KEY, sponsor_id TEXT NOT NULL, club_id TEXT NOT NULL, status TEXT NOT NULL,
  active INTEGER NOT NULL, reserved_at BIGINT, expires_at BIGINT, first_contact TEXT, last_activity_at BIGINT NOT NULL,
  notes TEXT, created_by TEXT, created_at BIGINT NOT NULL, closed_at BIGINT, close_reason TEXT, warned INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS sp_one_active_claim ON sp_claims(sponsor_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS sp_claims_club ON sp_claims(club_id);
CREATE INDEX IF NOT EXISTS sp_claims_due ON sp_claims(status, expires_at);
CREATE TABLE IF NOT EXISTS sp_reviews (id TEXT PRIMARY KEY, kind TEXT NOT NULL, claim_id TEXT, club_id TEXT NOT NULL, sponsor_id TEXT,
  sponsor_name TEXT, detail TEXT, message TEXT, state TEXT NOT NULL, created_at BIGINT NOT NULL, created_by TEXT,
  resolved_at BIGINT, resolved_by TEXT, resolution TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS sp_events (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, at BIGINT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
  from_status TEXT, to_status TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS sp_events_claim ON sp_events(claim_id);
CREATE TABLE IF NOT EXISTS sp_audit (id TEXT PRIMARY KEY, at BIGINT NOT NULL, actor_id TEXT, action TEXT NOT NULL, record TEXT,
  before_value TEXT, after_value TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS sp_audit_at ON sp_audit(at);
CREATE TABLE IF NOT EXISTS sp_notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at BIGINT NOT NULL, text TEXT NOT NULL, link TEXT,
  seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS sp_notices_user ON sp_notices(user_id);
CREATE TABLE IF NOT EXISTS sp_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sp_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sp_meta (key TEXT PRIMARY KEY, value TEXT);
`;
// On Supabase, lock every table so the project's public API keys can neither read nor change them.
// Only the Edge Function (connected as the database owner) can.
const PG_LOCK = TABLES.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n') +
  `\nREVOKE ALL ON ${TABLES.join(', ')} FROM anon, authenticated;`;

// Columns added after the first version: [table, column, type]
const ADDED = [['sp_clubs', 'logo', 'TEXT'], ['sp_clubs', 'logo_data', 'TEXT'], ['sp_clubs', 'logo_v', 'INTEGER NOT NULL DEFAULT 0']];

export const ensureSchema = driver => driver.transaction(async () => {
  await driver.exec(SCHEMA + (driver.dialect === 'pg' ? PG_LOCK : ''));
  for (const [table, col, type] of ADDED) {
    if (driver.dialect === 'pg') await driver.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type};`);
    else if (!(await driver.query(`SELECT name FROM pragma_table_info('${table}') WHERE name = $1`, [col])).length)
      await driver.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
  }
});

export const isUniqueError = e => e && (e.code === '23505' || /UNIQUE constraint failed/i.test(e.message || ''));

export function createDb(driver) {
  const q = (sql, params = []) => driver.query(sql, params);
  const one = async (sql, params) => (await q(sql, params))[0] || null;
  return {
    driver, q, one,
    tx: fn => driver.transaction(fn),
    async meta(key, value) {
      if (value === undefined) return (await one('SELECT value FROM sp_meta WHERE key = $1', [key]))?.value ?? null;
      await q('INSERT INTO sp_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, String(value)]);
    },
  };
}
