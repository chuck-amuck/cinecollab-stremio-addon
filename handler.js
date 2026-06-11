'use strict';

/**
 * HTTP request handler shared by the local server and the Vercel function.
 * Pure Node (req, res) so it works anywhere.
 */

const addon = require('./addon');

const DEFAULT_WATCHLIST = process.env.DEFAULT_WATCHLIST || '';

function send(res, status, body, contentType) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'max-age=60, public');
  send(res, status, obj, 'application/json; charset=utf-8');
}

// Extract a watchlist UUID from a raw config segment that might be a full
// CineCollab URL, a "watchlists/<uuid>" path, or just the UUID.
function parseWatchlistId(seg) {
  if (!seg) return '';
  let s = decodeURIComponent(seg);
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : s;
}

function configurePage(prefilledId) {
  const id = prefilledId || '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CineCollab → Stremio / Nuvio</title>
<style>
  :root{color-scheme:dark}
  body{font-family:Inter,system-ui,sans-serif;background:#0d0f14;color:#e8eaf0;
       margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:560px;width:90%;background:#161922;border:1px solid #262b38;
        border-radius:16px;padding:32px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 6px} p{color:#9aa3b2;font-size:14px;line-height:1.5}
  input{width:100%;box-sizing:border-box;padding:12px 14px;margin:14px 0;border-radius:10px;
        border:1px solid #313748;background:#0e1118;color:#e8eaf0;font-size:14px}
  button{background:#6d5efc;color:#fff;border:0;border-radius:10px;padding:12px 18px;
         font-size:14px;font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#7d70ff}
  .out{margin-top:18px;display:none}
  .row{display:flex;gap:8px;margin-top:8px}
  .row input{margin:0}
  a.btn{display:block;text-align:center;text-decoration:none}
  code{word-break:break-all;background:#0e1118;padding:8px 10px;border-radius:8px;
       display:block;font-size:12px;color:#a9b4ff;border:1px solid #262b38}
</style></head><body>
<div class="card">
  <h1>CineCollab → Stremio / Nuvio</h1>
  <p>Paste a CineCollab watchlist link (or its ID) to generate your install link.</p>
  <input id="src" placeholder="https://www.cinecollab.app/watchlists/…" value="${id}">
  <button onclick="gen()">Generate install link</button>
  <div class="out" id="out">
    <p style="margin-bottom:6px">Manifest URL:</p>
    <code id="manifest"></code>
    <div class="row">
      <a class="btn" id="install" style="flex:1"><button>Install in Stremio</button></a>
      <button style="flex:0 0 auto;width:auto" onclick="copyM()">Copy</button>
    </div>
    <p style="font-size:12px;margin-top:10px">In Nuvio: Settings → Addons → Add addon → paste the manifest URL.</p>
  </div>
</div>
<script>
function uuid(s){var m=s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);return m?m[0]:s.trim();}
function gen(){
  var id=uuid(document.getElementById('src').value);
  if(!id){return;}
  var base=location.origin+'/'+encodeURIComponent(id);
  var manifest=base+'/manifest.json';
  document.getElementById('manifest').textContent=manifest;
  document.getElementById('install').href='stremio://'+manifest.replace(/^https?:\\/\\//,'');
  document.getElementById('out').style.display='block';
  window._m=manifest;
}
function copyM(){navigator.clipboard.writeText(window._m);}
${id ? 'gen();' : ''}
</script></body></html>`;
}

async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const url = new URL(req.url, 'http://x');
    // strip trailing slash, split
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    // Root or /configure -> config page
    if (parts.length === 0) {
      return send(res, 200, configurePage(DEFAULT_WATCHLIST), 'text/html; charset=utf-8');
    }
    if (parts[0] === 'configure') {
      return send(res, 200, configurePage(DEFAULT_WATCHLIST), 'text/html; charset=utf-8');
    }
    if (parts[0] === 'health') return sendJson(res, 200, { ok: true });

    // First segment is the config (watchlist id) unless it's a known resource
    // and a DEFAULT_WATCHLIST is set.
    const RESOURCES = ['manifest.json', 'catalog', 'meta', 'configure'];
    let watchlistId, rest;
    if (RESOURCES.includes(parts[0]) && DEFAULT_WATCHLIST) {
      watchlistId = DEFAULT_WATCHLIST;
      rest = parts;
    } else {
      watchlistId = parseWatchlistId(parts[0]);
      rest = parts.slice(1);
    }

    if (rest[0] === 'configure') {
      return send(res, 200, configurePage(watchlistId), 'text/html; charset=utf-8');
    }

    // /<config>/manifest.json
    if (rest[0] === 'manifest.json') {
      let listName = null;
      try {
        const wl = await addon.fetchWatchlist(watchlistId);
        listName = wl.meta && wl.meta.name;
      } catch (e) { /* manifest still returns with a generic name */ }
      return sendJson(res, 200, addon.buildManifest(watchlistId, listName));
    }

    // /<config>/catalog/<type>/<id>.json (extra params after id are ignored)
    if (rest[0] === 'catalog') {
      const type = rest[1];
      const catalog = await addon.buildCatalog(watchlistId, type);
      return sendJson(res, 200, catalog);
    }

    // /<config>/meta/<type>/<id>.json  (only cc: ids reach us)
    if (rest[0] === 'meta') {
      const type = rest[1];
      const idRaw = decodeURIComponent((rest[2] || '').replace(/\.json$/, ''));
      const meta = await addon.buildMeta(watchlistId, type, idRaw);
      return sendJson(res, 200, meta);
    }

    return sendJson(res, 404, { err: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { err: String(err && err.message || err) });
  }
}

module.exports = handler;
