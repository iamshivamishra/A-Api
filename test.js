// block-proxy.js
// A tiny local proxy that refuses connections to blocked hosts.
// Works for any request from any page or iframe, because it blocks at the network level.
//
// Run:  node block-proxy.js
// Then set your browser/system proxy to 127.0.0.1:8080 (HTTP proxy, also used for HTTPS).
// No dependencies, no certificate needed.

const http = require('http');
const net = require('net');
const { URL } = require('url');

const PORT = 8080;

// Exact hosts (subdomains are blocked too)
const BLOCKED_HOSTS = [
  'udasijerkish.qpon',
];

// Regex patterns, useful because these ad domains rotate.
// This blocks every .qpon domain. Remove it if it breaks something you need.
const BLOCKED_PATTERNS = [
  /\.qpon$/i,
];

function isBlocked(host) {
  host = host.toLowerCase().replace(/:\d+$/, '');
  return (
    BLOCKED_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ||
    BLOCKED_PATTERNS.some((re) => re.test(host))
  );
}

// ---------------------------------------------------------------------------
// Wrapper page:  http://127.0.0.1:8080/?src=<url-encoded URL>
// Serves a full-window iframe pointing at the URL. Because the iframe's traffic
// goes through this proxy (when your browser uses it), blocked hosts stay blocked.
//   &sandbox=0  -> turn off the iframe sandbox (use if the player refuses to run)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function handleLocal(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') {
    res.writeHead(404);
    return res.end('Not found');
  }

  const src = u.searchParams.get('src');

  // No src: show a small form that encodes the URL for you
  if (!src) {
    return sendHtml(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>Block proxy</title>
<body style="font:16px system-ui;max-width:640px;margin:10vh auto;padding:0 16px">
<h3>Open a page in a protected iframe</h3>
<input id="u" placeholder="https://example.com/page" style="width:100%;padding:8px;box-sizing:border-box">
<label style="display:block;margin:8px 0"><input id="s" type="checkbox" checked> (blocks pop-ups and redirects of this page)</label>
<button onclick="location.href='/?src='+encodeURIComponent(u.value)+(s.checked?'':'&sandbox=0')">Open</button>
</body>`
    );
  }

  let target;
  try {
    target = new URL(src);
  } catch {
    return sendHtml(res, 400, 'Invalid src URL. Make sure it is URL-encoded.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return sendHtml(res, 400, 'Only http and https URLs are allowed.');
  }
  if (isBlocked(target.hostname)) {
    return sendHtml(res, 403, `Blocked host: ${escapeHtml(target.hostname)}`);
  }

  const sandbox =
    u.searchParams.get('sandbox') === '0'
      ? ''
      : 'sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"';

  sendHtml(
    res,
    200,
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(target.hostname)}</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}</style>
<iframe src="${escapeHtml(target.href)}" ${sandbox} allowfullscreen
  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
  referrerpolicy="origin"></iframe>`
  );
}

// Plain HTTP requests
const server = http.createServer((req, res) => {
  // Request addressed to the proxy itself (path only, e.g. "/?src=...")
  if (req.url.startsWith('/')) return handleLocal(req, res);

  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (isBlocked(target.hostname)) {
    console.log('BLOCKED (http) ', target.hostname);
    res.writeHead(403);
    return res.end();
  }

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: req.headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

// HTTPS: the browser sends CONNECT host:443, so we can see the hostname
// and refuse it before any encrypted traffic starts.
server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');

  if (isBlocked(host)) {
    console.log('BLOCKED (https)', host);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.end());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Blocking proxy listening on 127.0.0.1:${PORT}`);
});








