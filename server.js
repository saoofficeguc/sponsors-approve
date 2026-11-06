// Sponsor Management on a normal computer:  node server.js  ->  http://localhost:5174
// Runs the same server code as the Supabase version (supabase/functions/_shared/core), with SQLite in data/sponsors.db.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { sqliteDriver } = require('./scripts/sqlite-driver.js');

const root = __dirname;
const port = Number(process.env.PORT) || 5174;
const DATA_DIR = process.env.SP_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
// Only these files are served to browsers - never the server code or the database
const PUBLIC = new Set(['/index.html', '/app.js', '/rooms.js', '/styles.css', '/config.js', '/manifest.webmanifest']);
const PUBLIC_DIRS = ['/assets/'];
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

function serveStatic(res, urlPath) {
  const p = urlPath === '/' ? '/index.html' : urlPath;
  if (p.includes('..') || (!PUBLIC.has(p) && !PUBLIC_DIRS.some(d => p.startsWith(d)))) { res.writeHead(404, SECURITY); return res.end('Not found'); }
  fs.readFile(path.join(root, p), (err, data) => {
    if (err) { res.writeHead(404, SECURITY); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY, 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function readAll(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

(async () => {
  const { createApp } = await import('./supabase/functions/_shared/core/app.mjs');
  const app = createApp({ driver: sqliteDriver(path.join(DATA_DIR, 'sponsors.db')) });
  await app.ready();
  // end overdue reservations even if nobody opens the site
  setInterval(() => app.handle(new Request('http://localhost/api/tick', { method: 'POST' })).catch(console.error), 5 * 60000);

  http.createServer(async (req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (!urlPath.startsWith('/api/')) return serveStatic(res, urlPath);
    try {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readAll(req, 200000);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const response = await app.handle(new Request(`http://localhost${req.url}`, { method: req.method, headers, body }),
        { ip: req.socket.remoteAddress || '' });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      if (!res.headersSent) res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Something went wrong on the server.' }));
      if (!e.status) console.error(e);
    }
  }).listen(port, process.env.HOST || undefined, () => {
    console.log(`Sponsor Management running at http://localhost:${port}`);
    console.log(`  Database: ${path.join(DATA_DIR, 'sponsors.db')}`);
  });
})().catch(e => { console.error('Could not start:', e); process.exit(1); });
