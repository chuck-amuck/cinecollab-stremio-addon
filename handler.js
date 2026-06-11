'use strict';

/**
 * HTTP request handler shared by the local server and the Vercel function.
 * Pure Node (req, res) — works anywhere.
 */

const addon = require('./addon');

const DEFAULT_WATCHLIST = process.env.DEFAULT_WATCHLIST || '';

// ---- response helpers ---------------------------------------------------
function send(res, status, body, contentType) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'max-age=60, public');
  send(res, status, obj, 'application/json; charset=utf-8');
}
function sendJsonNoCache(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, obj, 'application/json; charset=utf-8');
}

// ---- body reader --------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ---- extra params from Stremio catalog path segment ---------------------
// Stremio appends extras as the last segment: …/<extraStr>.json
// where extraStr is like "search=foo&genre=Action&sort=Title%20A%E2%80%93Z"
function parseExtras(extraStr) {
  if (!extraStr) return {};
  const raw = decodeURIComponent(extraStr);
  const out = {};
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

// ---- configure page HTML ------------------------------------------------
function configurePage(prefill) {
  const value = prefill || '';
  const supabaseUrl = addon.SUPABASE_URL;
  const hasSecret = !!process.env.ADDON_SECRET;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CineCollab → Stremio / Nuvio</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root{color-scheme:dark}
  body{font-family:Inter,system-ui,sans-serif;background:#0d0f14;color:#e8eaf0;
       margin:0;padding:20px 0 40px;display:flex;flex-direction:column;align-items:center}
  .card{max-width:580px;width:90%;background:#161922;border:1px solid #262b38;
        border-radius:16px;padding:28px 32px;box-shadow:0 10px 40px rgba(0,0,0,.4);margin-bottom:16px}
  h1{font-size:20px;margin:0 0 6px}
  h2{font-size:15px;margin:20px 0 6px;color:#c5cad8}
  p,label{color:#9aa3b2;font-size:14px;line-height:1.5}
  input,textarea{width:100%;box-sizing:border-box;padding:10px 14px;margin:6px 0 4px;
        border-radius:10px;border:1px solid #313748;background:#0e1118;color:#e8eaf0;
        font-size:14px;font-family:inherit}
  textarea{min-height:80px;resize:vertical}
  .row{display:flex;gap:8px;margin-top:6px}
  button{background:#6d5efc;color:#fff;border:0;border-radius:10px;padding:11px 18px;
         font-size:14px;font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#7d70ff}
  button.sec{background:#262b38}
  button.sec:hover{background:#313748}
  button.google{background:#fff;color:#222;display:flex;align-items:center;
                justify-content:center;gap:8px}
  button.google:hover{background:#f0f0f0}
  .hint{font-size:12px;color:#6b7280;margin:2px 0 8px}
  .out{margin-top:18px;display:none}
  a.btn{display:block;text-align:center;text-decoration:none}
  code{word-break:break-all;background:#0e1118;padding:8px 10px;border-radius:8px;
       display:block;font-size:12px;color:#a9b4ff;border:1px solid #262b38}
  .err{color:#f87171;font-size:13px;margin:6px 0 0;display:none}
  .checklist{margin:10px 0 0;display:flex;flex-direction:column;gap:6px}
  .check-item{display:flex;align-items:center;gap:10px;background:#0e1118;
              border:1px solid #262b38;border-radius:8px;padding:10px 12px;cursor:pointer}
  .check-item input[type=checkbox]{width:16px;height:16px;cursor:pointer;flex-shrink:0}
  .check-item-info{flex:1;min-width:0}
  .check-item-name{font-size:14px;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .check-item-desc{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge{font-size:11px;padding:2px 7px;border-radius:10px;background:#262b38;color:#9aa3b2;flex-shrink:0}
  .divider{border:0;border-top:1px solid #262b38;margin:24px 0}
  .user-card{display:flex;align-items:center;gap:12px;margin-bottom:10px}
  .user-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#262b38}
  .user-name{font-size:14px;font-weight:600}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid #6d5efc;
           border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
  <h1>CineCollab → Stremio / Nuvio</h1>

  <!-- ── Section 1: Public lists by UUID ─────────────────────────── -->
  <h2>Public lists by URL or ID</h2>
  <p>Paste one or more CineCollab watchlist links (or IDs) — one per line.
     Each becomes its own catalog row.</p>
  <textarea id="src" placeholder="https://www.cinecollab.app/watchlists/…&#10;https://www.cinecollab.app/watchlists/…">${value}</textarea>
  <p class="hint" id="count"></p>
  <button onclick="gen()">Generate install link</button>

  <!-- ── Section 2: Browse another user's lists ─────────────────── -->
  <hr class="divider">
  <h2>Browse another user's lists</h2>
  <p>Enter a CineCollab username or profile URL to see their public watchlists.</p>
  <div class="row">
    <input id="profileInput" type="text" placeholder="username or https://www.cinecollab.app/u/username" style="flex:1">
    <button class="sec" style="width:auto;padding:11px 16px" onclick="lookupUser()">Look up</button>
  </div>
  <p class="err" id="profileErr"></p>
  <div id="profileResult" style="display:none">
    <div class="user-card">
      <img id="profileAvatar" class="user-avatar" src="" alt="">
      <span class="user-name" id="profileName"></span>
    </div>
    <div class="checklist" id="profileLists"></div>
    <button style="margin-top:10px" onclick="addCheckedUserLists()">Add selected lists</button>
  </div>

  <!-- ── Section 3: Connect your account ─────────────────────────── -->
  <hr class="divider">
  ${hasSecret ? `
  <h2>Connect your CineCollab account</h2>
  <p>Log in to auto-discover all your watchlists — public, members-only, and private.
     Your credentials are never stored; only an encrypted token is embedded in the install URL.</p>
  <div id="loginForm">
    <input id="email" type="email" placeholder="Email" autocomplete="username">
    <input id="pass"  type="password" placeholder="Password" autocomplete="current-password" style="margin-top:6px">
    <p class="err" id="loginErr"></p>
    <div class="row" style="margin-top:10px">
      <button style="flex:1" onclick="doLogin()">Sign in with email</button>
      <button class="google" style="flex:0 0 auto;width:auto;padding:11px 14px" onclick="doGoogle()">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Google
      </button>
    </div>
  </div>
  <div id="accountLists" style="display:none">
    <p style="margin:0 0 8px;font-size:13px;color:#9aa3b2">Your watchlists — uncheck any to exclude:</p>
    <div class="checklist" id="accountChecklist"></div>
    <button style="margin-top:10px" onclick="genAccount()">Generate account install link</button>
  </div>
  ` : `
  <h2>Connect your CineCollab account</h2>
  <p style="color:#f87171">Account features require <code style="display:inline;background:none;border:none;padding:0;color:#f87171">ADDON_SECRET</code>
  to be set on the server. See the README for setup instructions.</p>
  `}

  <!-- ── Install link output ─────────────────────────────────────── -->
  <div class="out" id="out">
    <hr class="divider" style="margin:0 0 18px">
    <p style="margin:0 0 6px;font-size:13px">Manifest URL:</p>
    <code id="manifest"></code>
    <div class="row" style="margin-top:8px">
      <a class="btn" id="install" style="flex:1"><button>Install in Stremio</button></a>
      <button class="sec" style="flex:0 0 auto;width:auto;padding:11px 14px" onclick="copyM()">Copy</button>
    </div>
    <p style="font-size:12px;margin-top:10px;color:#6b7280">In Nuvio: Settings → Addons → Add addon → paste the manifest URL above.</p>
  </div>
</div>

<script>
var RE=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function uuids(str){
  var m=(str.match(RE)||[]).map(function(x){return x.toLowerCase();});
  return m.filter(function(v,i){return m.indexOf(v)===i;});
}
function srcUuids(){ return uuids(document.getElementById('src').value); }

function refresh(){
  var n=srcUuids().length;
  document.getElementById('count').textContent=n?(n+' watchlist'+(n>1?'s':'')+' detected'):'';
}

function showInstall(segment){
  var base=location.origin+'/'+segment;
  var manifest=base+'/manifest.json';
  document.getElementById('manifest').textContent=manifest;
  document.getElementById('install').href='stremio://'+manifest.replace(/^https?:\\/\\//,'');
  document.getElementById('out').style.display='block';
  window._m=manifest;
  document.getElementById('out').scrollIntoView({behavior:'smooth',block:'nearest'});
}

// ── public UUID flow ──────────────────────────────────────────────
function gen(){
  var list=srcUuids();
  if(!list.length){return;}
  showInstall(list.join(','));
}

// ── user profile lookup ───────────────────────────────────────────
function extractUsername(raw){
  raw=raw.trim();
  // strip trailing slash, then take last path segment
  var parts=raw.replace(/\\/+$/,'').split('/');
  return parts[parts.length-1]||'';
}
function lookupUser(){
  var raw=document.getElementById('profileInput').value.trim();
  var username=extractUsername(raw);
  if(!username){return;}
  var errEl=document.getElementById('profileErr');
  var resultEl=document.getElementById('profileResult');
  errEl.style.display='none';
  resultEl.style.display='none';
  document.getElementById('profileInput').disabled=true;
  fetch('/api/user-lists?username='+encodeURIComponent(username))
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(res){
      document.getElementById('profileInput').disabled=false;
      if(!res.ok||!res.d.lists){
        errEl.textContent=res.d.error||'User not found or has no public lists.';
        errEl.style.display='block';
        return;
      }
      var u=res.d.user;
      document.getElementById('profileName').textContent='@'+u.username;
      var av=document.getElementById('profileAvatar');
      if(u.avatarUrl){av.src=u.avatarUrl;av.style.display='block';}
      else{av.style.display='none';}
      var listEl=document.getElementById('profileLists');
      listEl.innerHTML='';
      res.d.lists.forEach(function(l){
        var item=document.createElement('label');
        item.className='check-item';
        item.innerHTML='<input type="checkbox" checked value="'+l.id+'">'
          +'<div class="check-item-info">'
          +'<div class="check-item-name">'+escHtml(l.name)+'</div>'
          +(l.description?'<div class="check-item-desc">'+escHtml(l.description)+'</div>':'')
          +'</div>';
        listEl.appendChild(item);
      });
      resultEl.style.display='block';
    })
    .catch(function(){
      document.getElementById('profileInput').disabled=false;
      errEl.textContent='Request failed. Check your connection.';
      errEl.style.display='block';
    });
}
function addCheckedUserLists(){
  var checked=[].slice.call(document.querySelectorAll('#profileLists input[type=checkbox]:checked'))
    .map(function(c){return c.value;});
  if(!checked.length)return;
  var ta=document.getElementById('src');
  var existing=srcUuids();
  var toAdd=checked.filter(function(id){return existing.indexOf(id)===-1;});
  if(toAdd.length){
    ta.value=(ta.value.trim()?ta.value.trim()+'\\n':'')+toAdd.join('\\n');
  }
  refresh();
  document.getElementById('profileResult').style.display='none';
  document.getElementById('profileInput').value='';
}

// ── account login flow ────────────────────────────────────────────
var _accountSegment=null;
function doLogin(){
  var email=document.getElementById('email').value.trim();
  var pass=document.getElementById('pass').value;
  var errEl=document.getElementById('loginErr');
  errEl.style.display='none';
  if(!email||!pass){errEl.textContent='Enter email and password.';errEl.style.display='block';return;}
  fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:email,password:pass})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(res){
      if(!res.ok){errEl.textContent=res.d.error||'Login failed.';errEl.style.display='block';return;}
      _accountSegment=res.d.segment;
      showAccountLists(res.d.lists);
    })
    .catch(function(){errEl.textContent='Request failed.';errEl.style.display='block';});
}
function doGoogle(){
  var cb=location.origin+'/auth/callback';
  location.href=${JSON.stringify(supabaseUrl)}+'/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent(cb);
}
function showAccountLists(lists){
  var cl=document.getElementById('accountChecklist');
  cl.innerHTML='';
  (lists||[]).forEach(function(l){
    var vis=l.visibility==='private'?'Private':l.visibility==='members_only'?'Members only':'Public';
    var item=document.createElement('label');
    item.className='check-item';
    item.innerHTML='<input type="checkbox" checked value="'+l.id+'">'
      +'<div class="check-item-info">'
      +'<div class="check-item-name">'+escHtml(l.name)+'</div>'
      +'</div>'
      +'<span class="badge">'+vis+'</span>';
    cl.appendChild(item);
  });
  document.getElementById('loginForm').style.display='none';
  document.getElementById('accountLists').style.display='block';
}
function genAccount(){
  if(!_accountSegment)return;
  var extra=srcUuids();
  var seg=extra.length?_accountSegment+','+extra.join(','):_accountSegment;
  showInstall(seg);
}

// ── helpers ───────────────────────────────────────────────────────
function copyM(){navigator.clipboard.writeText(window._m);}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
document.getElementById('src').addEventListener('input',refresh);
refresh();
${value ? 'gen();' : ''}
</script></body></html>`;
}

// ---- Google OAuth callback page -----------------------------------------
function callbackPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CineCollab – Signing in…</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root{color-scheme:dark}
  body{font-family:Inter,system-ui,sans-serif;background:#0d0f14;color:#e8eaf0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#161922;border:1px solid #262b38;border-radius:16px;
        padding:32px 36px;text-align:center;max-width:400px;width:90%}
  .spinner{display:inline-block;width:32px;height:32px;border:3px solid #6d5efc;
           border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:#9aa3b2;font-size:14px}
  .err{color:#f87171}
  code{word-break:break-all;background:#0e1118;padding:8px 10px;border-radius:8px;
       display:block;font-size:12px;color:#a9b4ff;border:1px solid #262b38;margin-top:10px}
  button{background:#6d5efc;color:#fff;border:0;border-radius:10px;padding:11px 18px;
         font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;width:100%}
  button:hover{background:#7d70ff}
</style></head><body>
<div class="card">
  <div class="spinner" id="spin"></div>
  <p id="msg">Completing sign-in…</p>
</div>
<script>
(function(){
  // Supabase returns the session in the URL fragment after Google OAuth.
  var hash=location.hash.replace(/^#/,'');
  var params={};
  hash.split('&').forEach(function(p){
    var eq=p.indexOf('=');
    if(eq>-1) params[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));
  });
  var rt=params.refresh_token;
  if(!rt){
    document.getElementById('spin').style.display='none';
    document.getElementById('msg').className='err';
    document.getElementById('msg').textContent='Sign-in failed: no token in redirect. Try again from the configure page.';
    return;
  }
  fetch('/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:rt})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
    .then(function(res){
      document.getElementById('spin').style.display='none';
      if(!res.ok){
        document.getElementById('msg').className='err';
        document.getElementById('msg').textContent=res.d.error||'Sign-in failed.';
        return;
      }
      document.getElementById('msg').textContent='Signed in! Your manifest URL:';
      var seg=res.d.segment;
      var manifest=location.origin+'/'+seg+'/manifest.json';
      var c=document.createElement('code');c.textContent=manifest;
      var b=document.createElement('button');
      b.textContent='Install in Stremio';
      b.onclick=function(){location.href='stremio://'+manifest.replace(/^https?:\\/\\//,'');};
      var cp=document.createElement('button');
      cp.textContent='Copy manifest URL';cp.style.background='#262b38';
      cp.onclick=function(){navigator.clipboard.writeText(manifest);};
      document.querySelector('.card').appendChild(c);
      document.querySelector('.card').appendChild(b);
      document.querySelector('.card').appendChild(cp);
    })
    .catch(function(){
      document.getElementById('spin').style.display='none';
      document.getElementById('msg').className='err';
      document.getElementById('msg').textContent='Request failed. Please try again.';
    });
})();
</script></body></html>`;
}

// ---- main handler -------------------------------------------------------
async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const url   = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    // Root or /configure -> config page
    if (parts.length === 0) {
      return send(res, 200, configurePage(DEFAULT_WATCHLIST), 'text/html; charset=utf-8');
    }
    if (parts[0] === 'configure') {
      return send(res, 200, configurePage(DEFAULT_WATCHLIST), 'text/html; charset=utf-8');
    }
    if (parts[0] === 'health') return sendJson(res, 200, { ok: true });
    if (parts[0] === 'favicon.ico' || parts[0] === 'favicon.svg') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#161922"/><rect x="3" y="3" width="4" height="5" rx="1" fill="#6d5efc"/><rect x="25" y="3" width="4" height="5" rx="1" fill="#6d5efc"/><rect x="3" y="24" width="4" height="5" rx="1" fill="#6d5efc"/><rect x="25" y="24" width="4" height="5" rx="1" fill="#6d5efc"/><polygon points="11,9 11,23 24,16" fill="#6d5efc"/></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return res.end(svg);
    }

    // ── Auth endpoints ───────────────────────────────────────────────
    if (parts[0] === 'auth') {
      if (parts[1] === 'callback') {
        return send(res, 200, callbackPage(), 'text/html; charset=utf-8');
      }

      if (parts[1] === 'login' && req.method === 'POST') {
        const { email, password } = await readBody(req);
        if (!email || !password) return sendJsonNoCache(res, 400, { error: 'email and password required' });
        try {
          const { refreshToken, uid, lists } = await addon.loginPassword(email, password);
          const blob    = addon.encryptBlob({ refreshToken, uid });
          const segment = 'a_' + blob;
          return sendJsonNoCache(res, 200, { segment, lists });
        } catch (err) {
          return sendJsonNoCache(res, err.status || 401, { error: err.message });
        }
      }

      if (parts[1] === 'google' && req.method === 'POST') {
        const { refresh_token } = await readBody(req);
        if (!refresh_token) return sendJsonNoCache(res, 400, { error: 'refresh_token required' });
        try {
          const { refreshToken, uid, lists } = await addon.exchangeRefreshToken(refresh_token);
          const blob    = addon.encryptBlob({ refreshToken, uid });
          const segment = 'a_' + blob;
          return sendJsonNoCache(res, 200, { segment, lists });
        } catch (err) {
          return sendJsonNoCache(res, err.status || 401, { error: err.message });
        }
      }

      return sendJson(res, 404, { err: 'not found' });
    }

    // ── API endpoints ────────────────────────────────────────────────
    if (parts[0] === 'api') {
      if (parts[1] === 'user-lists') {
        const username = url.searchParams.get('username') || '';
        if (!username) return sendJsonNoCache(res, 400, { error: 'username required' });
        const data = await addon.fetchUserLists(username);
        if (!data) return sendJsonNoCache(res, 404, { error: 'User not found or has no public lists' });
        return sendJson(res, 200, data);
      }
      return sendJson(res, 404, { err: 'not found' });
    }

    // ── Stremio addon routes ─────────────────────────────────────────
    const RESOURCES = ['manifest.json', 'catalog', 'meta', 'configure'];
    let parsed, rest;
    if (RESOURCES.includes(parts[0]) && DEFAULT_WATCHLIST) {
      parsed = addon.parseConfig(DEFAULT_WATCHLIST);
      rest   = parts;
    } else {
      parsed = addon.parseConfig(parts[0]);
      rest   = parts.slice(1);
    }

    if (rest[0] === 'configure') {
      const prefill = parsed.ids.join('\n');
      return send(res, 200, configurePage(prefill), 'text/html; charset=utf-8');
    }

    // Resolve auth context once per request
    const auth = await addon.resolveAuth(parsed.authBlob);

    // /<config>/manifest.json
    if (rest[0] === 'manifest.json') {
      const manifest = await addon.buildManifest(parsed, auth);
      return sendJson(res, 200, manifest);
    }

    // /<config>/catalog/<type>/<catalogId>[/<extraStr>].json
    if (rest[0] === 'catalog') {
      const type = rest[1];
      // rest[2] is always catalogId.json or catalogId when no extras
      // rest[3] (optional) is extraStr.json when Stremio uses the 4-segment form
      let catalogId, extraStr;
      if (rest[3] !== undefined) {
        catalogId = decodeURIComponent(rest[2]);
        extraStr  = decodeURIComponent(rest[3].replace(/\.json$/, ''));
      } else {
        const raw = decodeURIComponent((rest[2] || '').replace(/\.json$/, ''));
        // Stremio may also encode extras inline: catalogId/search=foo&genre=X
        const slashPos = raw.indexOf('/');
        if (slashPos !== -1) {
          catalogId = raw.slice(0, slashPos);
          extraStr  = raw.slice(slashPos + 1);
        } else {
          catalogId = raw;
          extraStr  = '';
        }
      }
      const extras = parseExtras(extraStr);
      const catalog = await addon.buildCatalog(catalogId, type, extras, auth && auth.accessToken);
      return sendJson(res, 200, catalog);
    }

    // /<config>/meta/<type>/<id>.json
    if (rest[0] === 'meta') {
      const type  = rest[1];
      const idRaw = decodeURIComponent((rest[2] || '').replace(/\.json$/, ''));
      // For cc: ids we need all ids (discovered + manual)
      let allIds = parsed.ids;
      if (auth) {
        const discovered = await addon.discoverWatchlists(auth.accessToken, auth.uid).catch(() => []);
        allIds = [...new Set([...discovered, ...parsed.ids])];
      }
      const meta = await addon.buildMeta(allIds, type, idRaw, auth && auth.accessToken);
      return sendJson(res, 200, meta);
    }

    return sendJson(res, 404, { err: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { err: String(err && err.message || err) });
  }
}

handler.parseExtras = parseExtras;
module.exports = handler;
