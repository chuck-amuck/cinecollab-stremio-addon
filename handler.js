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

function configurePage(prefill) {
  const value = prefill || '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CineCollab → Stremio / Nuvio</title>
<style>
  :root{color-scheme:dark}
  body{font-family:Inter,system-ui,sans-serif;background:#0d0f14;color:#e8eaf0;
       margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{max-width:580px;width:90%;background:#161922;border:1px solid #262b38;
        border-radius:16px;padding:32px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 6px} p{color:#9aa3b2;font-size:14px;line-height:1.5}
  textarea{width:100%;box-sizing:border-box;padding:12px 14px;margin:14px 0 4px;border-radius:10px;
        border:1px solid #313748;background:#0e1118;color:#e8eaf0;font-size:14px;
        min-height:96px;font-family:inherit;resize:vertical}
  button{background:#6d5efc;color:#fff;border:0;border-radius:10px;padding:12px 18px;
         font-size:14px;font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#7d70ff}
  .hint{font-size:12px;color:#6b7280;margin:0 0 10px}
  .out{margin-top:18px;display:none}
  .row{display:flex;gap:8px;margin-top:8px}
  a.btn{display:block;text-align:center;text-decoration:none}
  code{word-break:break-all;background:#0e1118;padding:8px 10px;border-radius:8px;
       display:block;font-size:12px;color:#a9b4ff;border:1px solid #262b38}
  .count{font-size:12px;color:#9aa3b2;margin:2px 0 0}
</style></head><body>
<div class="card">
  <h1>CineCollab → Stremio / Nuvio</h1>
  <p>Paste one or more CineCollab watchlist links (or IDs) — one per line.
     Each becomes its own catalog row.</p>
  <textarea id="src" placeholder="https://www.cinecollab.app/watchlists/…&#10;https://www.cinecollab.app/watchlists/…">${value}</textarea>
  <p class="hint" id="count"></p>
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
var RE=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function ids(){
  var m=(document.getElementById('src').value.match(RE)||[]).map(function(x){return x.toLowerCase();});
  return m.filter(function(v,i){return m.indexOf(v)===i;});
}
function refresh(){
  var n=ids().length;
  document.getElementById('count').textContent = n? (n+' watchlist'+(n>1?'s':'')+' detected') : '';
}
function gen(){
  var list=ids();
  if(!list.length){return;}
  var base=location.origin+'/'+list.join(',');
  var manifest=base+'/manifest.json';
  document.getElementById('manifest').textContent=manifest;
  document.getElementById('install').href='stremio://'+manifest.replace(/^https?:\\/\\//,'');
  document.getElementById('out').style.display='block';
  window._m=manifest;
}
function copyM(){navigator.clipboard.writeText(window._m);}
document.getElementById('src').addEventListener('input',refresh);
refresh();
${value ? 'gen();' : ''}
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

    // First segment is the config (one or more watchlist ids) unless it's a
    // known resource and a DEFAULT_WATCHLIST is set.
    const RESOURCES = ['manifest.json', 'catalog', 'meta', 'configure'];
    let ids, rest;
    if (RESOURCES.includes(parts[0]) && DEFAULT_WATCHLIST) {
      ids = addon.parseConfig(DEFAULT_WATCHLIST);
      rest = parts;
    } else {
      ids = addon.parseConfig(parts[0]);
      rest = parts.slice(1);
    }

    if (rest[0] === 'configure') {
      return send(res, 200, configurePage(ids.join('\n')), 'text/html; charset=utf-8');
    }

    // /<config>/manifest.json
    if (rest[0] === 'manifest.json') {
      const manifest = await addon.buildManifest(ids);
      return sendJson(res, 200, manifest);
    }

    // /<config>/catalog/<type>/<catalogId>.json (extra params after id ignored)
    if (rest[0] === 'catalog') {
      const type = rest[1];
      const catalogId = decodeURIComponent((rest[2] || '').replace(/\.json$/, ''));
      const catalog = await addon.buildCatalog(catalogId, type);
      return sendJson(res, 200, catalog);
    }

    // /<config>/meta/<type>/<id>.json  (only cc: ids reach us)
    if (rest[0] === 'meta') {
      const type = rest[1];
      const idRaw = decodeURIComponent((rest[2] || '').replace(/\.json$/, ''));
      const meta = await addon.buildMeta(ids, type, idRaw);
      return sendJson(res, 200, meta);
    }

    return sendJson(res, 404, { err: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { err: String(err && err.message || err) });
  }
}

module.exports = handler;
