'use strict';

/**
 * Trakt → CineCollab watched-state sync (zero dependencies, Node 18+).
 *
 * The flow is: you watch something in Nuvio → Nuvio's built-in Trakt scrobbler
 * marks it watched on Trakt → this tool pulls your Trakt history and records it
 * in CineCollab's `user_watched` table. One-way (Trakt → CineCollab), incremental,
 * and idempotent (it de-dupes against what's already recorded).
 *
 * Nuvio itself needs no plugin: just connect Trakt inside the Nuvio app and turn
 * on scrobbling. Trakt's public API is the integration point here.
 *
 * Config via environment (see README "Trakt → CineCollab sync"):
 *   TRAKT_CLIENT_ID       (required)  Trakt API app client id
 *   TRAKT_CLIENT_SECRET   (required)  Trakt API app client secret
 *   CINECOLLAB_EMAIL      (required*) CineCollab account email
 *   CINECOLLAB_PASSWORD   (required*) CineCollab account password
 *   CINECOLLAB_REFRESH_TOKEN          alternative to email/password
 *   SYNC_SHOWS            (optional)  "true" to also mark watched TV shows
 *                                     (title-level) from episode history
 *   SYNC_STATE_FILE       (optional)  path to the state file
 *                                     (default: .trakt-sync-state.json)
 *   SYNC_INTERVAL_MS      (optional)  poll interval for `watch` (default 900000)
 *
 * Usage:
 *   node traktSync.js login    # one-time Trakt device-code authorization
 *   node traktSync.js run      # single incremental sync pass
 *   node traktSync.js watch    # run forever, syncing every SYNC_INTERVAL_MS
 *   node traktSync.js status   # show stored state
 */

const fs = require('fs');
const path = require('path');

// ---- minimal .env loader (zero-dep) -------------------------------------
// Loads KEY=VALUE lines from .env in the project dir, without overriding any
// var already set in the real environment. Quotes are stripped; # comments
// and blank lines are ignored.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const addon = require('./addon');

const TRAKT_BASE = 'https://api.trakt.tv';
const STATE_FILE = process.env.SYNC_STATE_FILE ||
  path.join(__dirname, '.trakt-sync-state.json');

// ---- state persistence --------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { trakt: null, cursor: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- small helpers ------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing required env var: ' + name);
  return v;
}

// ---- Trakt API client ---------------------------------------------------
function traktHeaders(accessToken) {
  const h = {
    'Content-Type': 'application/json',
    // Trakt is behind Cloudflare, which 403s requests with no User-Agent
    // (Node's fetch sends none by default).
    'User-Agent': 'cinecollab-stremio-addon',
    'trakt-api-version': '2',
    'trakt-api-key': requireEnv('TRAKT_CLIENT_ID')
  };
  if (accessToken) h.Authorization = 'Bearer ' + accessToken;
  return h;
}

// Device-code flow: returns { device_code, user_code, verification_url, interval, expires_in }
async function traktDeviceCode() {
  const res = await fetch(TRAKT_BASE + '/oauth/device/code', {
    method: 'POST',
    headers: traktHeaders(),
    body: JSON.stringify({ client_id: requireEnv('TRAKT_CLIENT_ID') })
  });
  if (!res.ok) throw new Error('Trakt device-code request failed: ' + res.status);
  return res.json();
}

// Polls until the user authorizes (or the code expires). Returns a token object.
async function traktPollToken(deviceCode, intervalSec, expiresInSec) {
  const deadline = Date.now() + expiresInSec * 1000;
  let intervalMs = intervalSec * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await fetch(TRAKT_BASE + '/oauth/device/token', {
      method: 'POST',
      headers: traktHeaders(),
      body: JSON.stringify({
        code: deviceCode,
        client_id: requireEnv('TRAKT_CLIENT_ID'),
        client_secret: requireEnv('TRAKT_CLIENT_SECRET')
      })
    });
    if (res.status === 200) return res.json();      // authorized
    if (res.status === 400) continue;               // still pending
    if (res.status === 429) { intervalMs += 1000; continue; } // slow down
    if (res.status === 418) throw new Error('Trakt authorization was denied.');
    if (res.status === 410) throw new Error('Trakt code expired — run `login` again.');
    if (res.status === 409) throw new Error('Trakt code already used.');
    throw new Error('Trakt token poll failed: ' + res.status);
  }
  throw new Error('Trakt authorization timed out — run `login` again.');
}

async function traktRefresh(refreshToken) {
  const res = await fetch(TRAKT_BASE + '/oauth/token', {
    method: 'POST',
    headers: traktHeaders(),
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: requireEnv('TRAKT_CLIENT_ID'),
      client_secret: requireEnv('TRAKT_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
    })
  });
  if (!res.ok) throw new Error('Trakt token refresh failed — run `login` again.');
  return res.json();
}

// Normalize a Trakt token response into our stored shape.
function normalizeTraktToken(tok) {
  const created = (tok.created_at || Math.floor(Date.now() / 1000));
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: (created + (tok.expires_in || 7776000)) * 1000
  };
}

// Returns a valid access token, refreshing (and persisting) if near expiry.
async function ensureTraktToken(state) {
  if (!state.trakt || !state.trakt.access_token) {
    throw new Error('Not authorized with Trakt — run `node traktSync.js login` first.');
  }
  if (Date.now() < state.trakt.expires_at - 60000) return state.trakt.access_token;
  const refreshed = normalizeTraktToken(await traktRefresh(state.trakt.refresh_token));
  state.trakt = refreshed;
  saveState(state);
  return refreshed.access_token;
}

// Pull all pages of watched history for a kind ('movies' | 'episodes').
async function traktHistory(kind, startAt, accessToken) {
  const out = [];
  let page = 1;
  const limit = 100;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (startAt) qs.set('start_at', startAt);
    const res = await fetch(TRAKT_BASE + '/sync/history/' + kind + '?' + qs.toString(), {
      headers: traktHeaders(accessToken)
    });
    if (!res.ok) throw new Error('Trakt history (' + kind + ') failed: ' + res.status);
    const rows = await res.json();
    out.push(...(Array.isArray(rows) ? rows : []));
    const pageCount = Number(res.headers.get('x-pagination-page-count') || '1');
    if (page >= pageCount || rows.length === 0) break;
    page += 1;
  }
  return out;
}

// ---- pure mapping (unit-tested) -----------------------------------------
// Turn Trakt history rows into CineCollab user_watched rows.
// CineCollab has a unique constraint on (user_id, media_id, media_type), so we
// collapse to one row per title — for both repeated movie plays (rewatches) and
// multiple episodes of the same show — keeping the most recent watched_at.
function traktHistoryToRows(movieRows, episodeRows, uid, includeShows) {
  const byKey = new Map(); // `${media_type}:${media_id}` -> row
  const add = (media_id, media_type, watched_at) => {
    if (!media_id || !watched_at) return;
    const key = media_type + ':' + media_id;
    const prev = byKey.get(key);
    if (!prev || watched_at > prev.watched_at) {
      byKey.set(key, { user_id: uid, media_id, media_type, watched_at });
    }
  };
  for (const r of movieRows || []) {
    add(r && r.movie && r.movie.ids && r.movie.ids.tmdb, 'movie', r && r.watched_at);
  }
  if (includeShows) {
    for (const r of episodeRows || []) {
      add(r && r.show && r.show.ids && r.show.ids.tmdb, 'tv', r && r.watched_at);
    }
  }
  return [...byKey.values()];
}

// Filter out rows already present in CineCollab (keyed on media_id + media_type).
function dedupeAgainstExisting(rows, existingKeys) {
  return rows.filter(r => !existingKeys.has(r.media_id + ':' + r.media_type));
}

// The newest watched_at across rows, or null. Used to advance the cursor.
function newestWatchedAt(rows) {
  let max = null;
  for (const r of rows) {
    if (r.watched_at && (!max || r.watched_at > max)) max = r.watched_at;
  }
  return max;
}

// ---- CineCollab side (reuses addon.js helpers) --------------------------
// Resolves a CineCollab access token + uid. The refresh token comes from the
// state file if present (it rotates on every use, so we persist the latest),
// otherwise from CINECOLLAB_REFRESH_TOKEN (first run), or email/password.
async function cineCollabAuth(state) {
  const storedRT = (state.cinecollab && state.cinecollab.refresh_token) ||
    process.env.CINECOLLAB_REFRESH_TOKEN;

  let inputRT, uid, rotatedRT;
  if (storedRT) {
    const r = await addon.exchangeRefreshToken(storedRT);
    inputRT = storedRT;
    uid = r.uid;
    rotatedRT = r.refreshToken;
  } else {
    const email = requireEnv('CINECOLLAB_EMAIL');
    const password = requireEnv('CINECOLLAB_PASSWORD');
    const r = await addon.loginPassword(email, password);
    inputRT = r.refreshToken;
    uid = r.uid;
    rotatedRT = r.refreshToken;
  }
  if (!uid) throw new Error('Could not resolve CineCollab user id.');

  // exchange/login primed the token cache keyed on inputRT; this won't re-hit the network.
  const { accessToken } = await addon.getAccessToken(inputRT);

  // Persist the rotated refresh token so the next run survives rotation —
  // you only ever paste CINECOLLAB_REFRESH_TOKEN once.
  if (rotatedRT) {
    state.cinecollab = { refresh_token: rotatedRT };
    saveState(state);
  }
  return { accessToken, uid };
}

async function fetchExistingWatched(accessToken, uid) {
  const url = addon.SUPABASE_URL + '/rest/v1/user_watched?select=media_id,media_type&user_id=eq.' +
    encodeURIComponent(uid);
  const res = await fetch(url, { headers: addon.sbHeaders(accessToken) });
  if (!res.ok) throw new Error('Failed to read existing user_watched: ' + res.status);
  const rows = await res.json();
  const keys = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    keys.add(r.media_id + ':' + r.media_type);
  }
  return keys;
}

async function insertWatched(accessToken, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    // on_conflict + ignore-duplicates makes inserts idempotent against the
    // (user_id, media_id, media_type) unique constraint, so re-runs and
    // cursor-boundary overlaps never error.
    const res = await fetch(
      addon.SUPABASE_URL + '/rest/v1/user_watched?on_conflict=user_id,media_id,media_type', {
        method: 'POST',
        headers: {
          ...addon.sbHeaders(accessToken),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal,resolution=ignore-duplicates'
        },
        body: JSON.stringify(chunk)
      });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Insert into user_watched failed (' + res.status + '): ' + body.slice(0, 300));
    }
    inserted += chunk.length;
  }
  return inserted;
}

// ---- orchestration ------------------------------------------------------
async function runSync(log = console.log) {
  const includeShows = String(process.env.SYNC_SHOWS || '').toLowerCase() === 'true';
  const state = loadState();
  const traktToken = await ensureTraktToken(state);

  log('Pulling Trakt history' + (state.cursor ? ' since ' + state.cursor : ' (full, first run)') + '…');
  const movies = await traktHistory('movies', state.cursor, traktToken);
  const episodes = includeShows ? await traktHistory('episodes', state.cursor, traktToken) : [];
  log('  Trakt returned ' + movies.length + ' movie play(s)' +
    (includeShows ? ', ' + episodes.length + ' episode play(s)' : ''));

  const { accessToken, uid } = await cineCollabAuth(state);
  const mapped = traktHistoryToRows(movies, episodes, uid, includeShows);
  const existing = await fetchExistingWatched(accessToken, uid);
  const fresh = dedupeAgainstExisting(mapped, existing);

  if (fresh.length) {
    const n = await insertWatched(accessToken, fresh);
    log('  Recorded ' + n + ' new watched title(s) in CineCollab.');
  } else {
    log('  Nothing new to record.');
  }

  // Advance the cursor to the newest play we saw (across both kinds), so the
  // next run only fetches later history. Dedupe handles the boundary overlap.
  const newest = newestWatchedAt([...movies.map(r => ({ watched_at: r.watched_at })),
    ...episodes.map(r => ({ watched_at: r.watched_at }))]);
  if (newest && (!state.cursor || newest > state.cursor)) {
    state.cursor = newest;
    saveState(state);
  }
  return { fetched: movies.length + episodes.length, recorded: fresh.length };
}

async function doLogin(log = console.log) {
  const dc = await traktDeviceCode();
  log('');
  log('  1. Open: ' + dc.verification_url);
  log('  2. Enter code: ' + dc.user_code);
  log('');
  log('Waiting for authorization…');
  const tok = normalizeTraktToken(await traktPollToken(dc.device_code, dc.interval, dc.expires_in));
  const state = loadState();
  state.trakt = tok;
  saveState(state);
  log('Trakt connected. Run `node traktSync.js run` to sync.');
}

function showStatus(log = console.log) {
  const state = loadState();
  log('State file: ' + STATE_FILE);
  log('Trakt:      ' + (state.trakt && state.trakt.access_token
    ? 'connected (token expires ' + new Date(state.trakt.expires_at).toISOString() + ')'
    : 'not connected — run `login`'));
  log('Cursor:     ' + (state.cursor || '(none — next run is a full sync)'));
  log('Show sync:  ' + (String(process.env.SYNC_SHOWS || '').toLowerCase() === 'true' ? 'on' : 'off'));
}

async function watchLoop(log = console.log) {
  const interval = Number(process.env.SYNC_INTERVAL_MS || 15 * 60 * 1000);
  log('Watch mode: syncing every ' + Math.round(interval / 1000) + 's. Ctrl-C to stop.');
  for (;;) {
    try {
      await runSync(log);
    } catch (err) {
      log('Sync error: ' + err.message);
    }
    await sleep(interval);
  }
}

// ---- CLI ----------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] || 'run';
  switch (cmd) {
    case 'login':  return doLogin();
    case 'run':    return void (await runSync());
    case 'watch':  return watchLoop();
    case 'status': return showStatus();
    default:
      console.error('Unknown command: ' + cmd);
      console.error('Usage: node traktSync.js [login|run|watch|status]');
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error(String(err.message || err)); process.exit(1); });
}

module.exports = {
  traktHistoryToRows, dedupeAgainstExisting, newestWatchedAt, normalizeTraktToken
};
