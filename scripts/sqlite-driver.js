// SQLite database driver for server.js and the tests: one transaction at a time, $1 placeholders become ?1.
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');

function sqliteDriver(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const als = new AsyncLocalStorage();
  let chain = Promise.resolve();
  const conv = sql => sql.replace(/\$(\d+)/g, '?$1');
  return {
    dialect: 'sqlite',
    async query(sql, params = []) {
      const st = db.prepare(conv(sql));
      const args = params.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) return st.all(...args);
      st.run(...args); return [];
    },
    async exec(sql) { db.exec(sql); },
    transaction(fn) {
      if (als.getStore()) return fn();
      const run = async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const out = await als.run(true, fn); db.exec('COMMIT'); return out; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
}
module.exports = { sqliteDriver };
