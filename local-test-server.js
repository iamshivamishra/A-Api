/**
 * Local test runner for the Vercel serverless functions in /api, without
 * needing the Vercel CLI. Run with:
 *
 *   node local-test-server.js
 *
 * Then visit http://localhost:3000/ , /status , /anime , etc. in your
 * browser, and http://localhost:3000/api/sync?key=YOUR_SYNC_SECRET to
 * trigger a sync. This wraps the same handler functions Vercel would call,
 * so if it works here it will work on Vercel too.
 */

const http = require('http');
const { URL } = require('url');

// --- load .env manually (same approach as scripts/migrate-to-mongo.js) ----
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const slugHandler = require('./api/[...slug].js');
const syncHandler = require('./api/sync.js');

function wrapResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  res.send = (body) => {
    res.end(body);
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  wrapResponse(res);
  const parsed = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(parsed.searchParams.entries());

  try {
    if (parsed.pathname === '/api/sync') {
      await syncHandler(req, res);
      return;
    }

    // Mimic Vercel's [...slug] catch-all: split the path into segments.
    const segments = parsed.pathname.split('/').filter(Boolean);
    req.query.slug = segments;
    await slugHandler(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[local-test] Serving api/ handlers on http://localhost:${PORT}`);
  console.log(`[local-test] Try: http://localhost:${PORT}/status`);
  console.log(`[local-test] Try: http://localhost:${PORT}/api/sync?key=${process.env.SYNC_SECRET || 'YOUR_SYNC_SECRET'}`);
});