'use strict';

/**
 * CineCollab -> Stremio/Nuvio addon (zero dependencies, Node 18+)
 *
 * Exposes CineCollab watchlists as Stremio catalogs.
 * Config segment in URL:
 *   <uuid>[,<uuid>…]              — public lists (anon key)
 *   a_<blob>[,<uuid>…]            — authenticated account (auto-discovers all lists)
 *   d_on                          — include the Discover (featured lists) catalog
 *
 * Account token is AES-256-GCM encrypted using ADDON_SECRET. Without that
 * env var the account features are disabled and a_… segments are ignored.
 */

const crypto = require('crypto');

const SUPABASE_URL = (process.env.CINECOLLAB_SUPABASE_URL || 'https://fnsklauaxovbvatfquil.supabase.co').trim();

const SUPABASE_ANON = process.env.CINECOLLAB_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuc2tsYXVheG92YnZhdGZxdWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MzI2MzIsImV4cCI6MjA5MjA5MjYzMn0.NfwVFGH13dT_dRQcOdMMmAqS1J1e0O1gicPyUTeGHRg';

const TMDB_KEY = process.env.TMDB_API_KEY || 'a42286d5ac5971752bfcf0e3f807e383';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

// ---- genre maps ---------------------------------------------------------
const MOVIE_GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western'
};
const TV_GENRES = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 37: 'Western'
};

// ---- caches -------------------------------------------------------------
const imdbCache    = new Map();  // `${kind}:${tmdbId}` -> imdb id | null
const listCache    = new Map();  // watchlistId -> { ts, data }
const discoverCache = { ts: 0, data: null };
const userListCache = new Map(); // username -> { ts, data }
const tokenCache   = new Map();  // originalRefreshToken -> { accessToken, exp, currentRT }
const LIST_TTL_MS  = 60 * 1000;

// ---- AES-256-GCM blob encryption ----------------------------------------
// Key is derived once from ADDON_SECRET; null when secret is unset.
let _encKey = null;
function getEncKey() {
  if (_encKey !== null) return _encKey;
  const secret = process.env.ADDON_SECRET;
  if (!secret) { _encKey = false; return false; }
  // scrypt: N=2^14, r=8, p=1 → 32 bytes
  _encKey = crypto.scryptSync(secret, 'cinecollab-addon-v1', 32, { N: 16384, r: 8, p: 1 });
  return _encKey;
}

function encryptBlob(obj) {
  const key = getEncKey();
  if (!key) throw new Error('ADDON_SECRET not set');
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // base64url(iv[12] | tag[16] | ciphertext)
  return Buffer.concat([iv, tag, enc])
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decryptBlob(b64url) {
  const key = getEncKey();
  if (!key) return null;
  try {
    const buf = Buffer.from(
      b64url.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    );
    if (buf.length < 29) return null; // iv(12)+tag(16)+min 1 byte
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (_) {
    return null;
  }
}

// ---- Supabase helpers ---------------------------------------------------
function sbHeaders(accessToken) {
  const bearer = accessToken || SUPABASE_ANON;
  return { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + bearer };
}

// ---- Auth: password login -----------------------------------------------
async function loginPassword(email, password) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && json.msg) || (json && json.error_description) || 'Login failed';
    throw Object.assign(new Error(msg), { status: 401 });
  }
  const refreshToken = json.refresh_token;
  const uid = json.user && json.user.id;
  // prime the token cache so the first request doesn't hit the refresh endpoint
  tokenCache.set(refreshToken, {
    accessToken: json.access_token,
    exp: Date.now() + (json.expires_in || 3600) * 1000 - 60000,
    currentRT: refreshToken
  });
  const lists = await discoverWatchlists(json.access_token, uid).catch(() => []);
  return { refreshToken, uid, lists };
}

// ---- Auth: exchange / refresh -------------------------------------------
async function exchangeRefreshToken(refreshToken) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = (json && json.msg) || 'Token refresh failed';
    throw Object.assign(new Error(msg), { status: 401 });
  }
  const uid = json.user && json.user.id;
  const lists = await discoverWatchlists(json.access_token, uid).catch(() => []);
  tokenCache.set(refreshToken, {
    accessToken: json.access_token,
    exp: Date.now() + (json.expires_in || 3600) * 1000 - 60000,
    currentRT: json.refresh_token
  });
  return { refreshToken: json.refresh_token, uid, lists };
}

// Get (or refresh) an access token, handling Supabase's refresh-token rotation.
// Uses the original blob refresh token as the stable cache key.
async function getAccessToken(originalRT) {
  const cached = tokenCache.get(originalRT);
  if (cached && Date.now() < cached.exp) return { accessToken: cached.accessToken, currentRT: cached.currentRT };

  const rtToUse = cached ? cached.currentRT : originalRT;
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rtToUse })
  });
  if (!res.ok) throw new Error('Session expired — please reconnect your CineCollab account');
  const json = await res.json();
  const entry = {
    accessToken: json.access_token,
    exp: Date.now() + (json.expires_in || 3600) * 1000 - 60000,
    currentRT: json.refresh_token
  };
  tokenCache.set(originalRT, entry);
  return { accessToken: entry.accessToken, currentRT: entry.currentRT };
}

// ---- Config parsing -------------------------------------------------------
// Returns { authBlob: string|null, ids: string[], discover: boolean }
// authBlob is the raw `a_…` token string (without the `a_` prefix).
// ids are manually-specified watchlist UUIDs.
// discover is true when the `d_on` token is present.
const UUID_RE     = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const AUTH_RE     = /(?:^|,)a_([A-Za-z0-9_-]+)/;
const DISCOVER_RE = /(?:^|,)d_on(?:,|$)/;

function parseConfig(seg) {
  if (!seg) return { authBlob: null, ids: [], discover: false };
  const s = decodeURIComponent(seg);
  const authMatch = s.match(AUTH_RE);
  const authBlob  = authMatch ? authMatch[1] : null;
  const found     = s.match(UUID_RE) || [];
  const ids       = [...new Set(found.map(x => x.toLowerCase()))];
  const discover  = DISCOVER_RE.test(s);
  return { authBlob, ids, discover };
}

// Resolves an authBlob to { accessToken, uid } or null.
async function resolveAuth(authBlob) {
  if (!authBlob || !getEncKey()) return null;
  const payload = decryptBlob(authBlob);
  if (!payload || !payload.refreshToken || !payload.uid) return null;
  try {
    const { accessToken } = await getAccessToken(payload.refreshToken);
    return { accessToken, uid: payload.uid };
  } catch (_) {
    return null;
  }
}

// ---- Watch list discovery -----------------------------------------------
async function discoverWatchlists(accessToken, uid) {
  const url = SUPABASE_URL + '/rest/v1/watchlist_members?select=watchlist_id,role&user_id=eq.' +
    encodeURIComponent(uid);
  const res = await fetch(url, { headers: sbHeaders(accessToken) });
  if (!res.ok) return [];
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map(r => r.watchlist_id);
}

// ---- User profile + public lists ----------------------------------------
async function fetchUserLists(username) {
  if (!username) return null;
  const cached = userListCache.get(username);
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) return cached.data;

  const base = SUPABASE_URL + '/rest/v1';
  const profileRes = await fetch(
    base + '/user_profiles?select=id,username,avatar_url,is_public&username=eq.' +
    encodeURIComponent(username),
    { headers: sbHeaders() }
  );
  if (!profileRes.ok) return null;
  const profiles = await profileRes.json();
  const profile = Array.isArray(profiles) && profiles[0];
  if (!profile) return null;

  const listsRes = await fetch(
    base + '/watchlists?select=id,name,description,visibility&owner_id=eq.' +
    encodeURIComponent(profile.id) + '&visibility=eq.public',
    { headers: sbHeaders() }
  );
  const lists = listsRes.ok ? await listsRes.json() : [];

  const data = {
    user: { username: profile.username, avatarUrl: profile.avatar_url },
    lists: (Array.isArray(lists) ? lists : []).map(l => ({
      id: l.id, name: l.name, description: l.description || ''
    }))
  };
  userListCache.set(username, { ts: Date.now(), data });
  return data;
}

// ---- Watchlist data fetching --------------------------------------------
async function fetchWatchlist(watchlistId, accessToken) {
  const cached = listCache.get(watchlistId);
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) return cached.data;

  const base = SUPABASE_URL + '/rest/v1';
  const metaUrl = base + '/watchlists?select=name,description,visibility&id=eq.' +
    encodeURIComponent(watchlistId);
  const moviesUrl = base + '/watchlist_movies?select=media_id,media_type,title,' +
    'poster_path,backdrop_path,release_date,genre_ids,runtime&watchlist_id=eq.' +
    encodeURIComponent(watchlistId) + '&order=added_at.desc';

  const headers = sbHeaders(accessToken);
  const [metaRes, movRes] = await Promise.all([
    fetch(metaUrl, { headers }),
    fetch(moviesUrl, { headers })
  ]);
  if (!metaRes.ok || !movRes.ok) {
    throw new Error('CineCollab fetch failed (' + metaRes.status + '/' + movRes.status + ')');
  }
  const meta  = (await metaRes.json())[0] || null;
  const items = await movRes.json();
  const data  = { meta, items: Array.isArray(items) ? items : [] };
  listCache.set(watchlistId, { ts: Date.now(), data });
  return data;
}

async function tmdbToImdb(mediaType, tmdbId) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const key = kind + ':' + tmdbId;
  if (imdbCache.has(key)) return imdbCache.get(key);
  try {
    const url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
      '/external_ids?api_key=' + TMDB_KEY;
    const res = await fetch(url);
    const json = await res.json();
    const imdb = json && json.imdb_id ? json.imdb_id : null;
    imdbCache.set(key, imdb);
    return imdb;
  } catch (_) {
    imdbCache.set(key, null);
    return null;
  }
}

function genreNames(mediaType, ids) {
  const map = mediaType === 'tv' ? TV_GENRES : MOVIE_GENRES;
  return (ids || []).map(g => map[g]).filter(Boolean);
}

async function toMeta(item) {
  const isTv = item.media_type === 'tv';
  const stremioType = isTv ? 'series' : 'movie';
  const imdb = await tmdbToImdb(item.media_type, item.media_id);
  const id   = imdb || ('cc:' + item.media_type + ':' + item.media_id);
  const year = item.release_date ? String(item.release_date).slice(0, 4) : undefined;
  return {
    id, type: stremioType, name: item.title,
    poster:     item.poster_path   ? TMDB_IMG + '/w342' + item.poster_path   : undefined,
    background: item.backdrop_path ? TMDB_IMG + '/w780' + item.backdrop_path : undefined,
    posterShape: 'poster',
    releaseInfo: year,
    genres: genreNames(item.media_type, item.genre_ids),
    runtime: item.runtime ? item.runtime + ' min' : undefined,
    _tmdb: item.media_id, _mediaType: item.media_type
  };
}

function stripInternal(m) {
  const c = Object.assign({}, m);
  delete c._tmdb; delete c._mediaType;
  return c;
}

// ---- extra params helpers -----------------------------------------------
// Stremio encodes extra as a single URI-encoded query string segment in the path.
// e.g. catalog/movie/cc_xxx/search=foo&genre=Action.json
// handler.js decodes and passes { search, sort, genre } here.

function applyExtras(metas, { search, sort, genre } = {}) {
  let out = metas;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(m => m.name && m.name.toLowerCase().includes(q));
  }
  if (genre) {
    out = out.filter(m => m.genres && m.genres.includes(genre));
  }
  if (sort === 'Title A–Z') {
    out = out.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'Title Z–A') {
    out = out.slice().sort((a, b) => (b.name || '').localeCompare(a.name || ''));
  } else if (sort === 'Year') {
    out = out.slice().sort((a, b) => (b.releaseInfo || '0') - (a.releaseInfo || '0'));
  } else if (sort === 'Added (oldest)') {
    out = out.slice().reverse();
  }
  // default: Added (newest) — already ordered by added_at.desc from Supabase
  return out;
}

// Collect all unique genre names across a set of items for the manifest extra def.
function collectGenres(mediaType, allItems) {
  const map = mediaType === 'tv' ? TV_GENRES : MOVIE_GENRES;
  const seen = new Set();
  for (const item of allItems) {
    for (const gid of (item.genre_ids || [])) {
      if (map[gid]) seen.add(map[gid]);
    }
  }
  return [...seen].sort();
}

// ---- catalog id helpers -------------------------------------------------
function catalogIdFor(watchlistId) { return 'cc_' + watchlistId; }
function watchlistFromCatalogId(catalogId) {
  return String(catalogId || '').replace(/^cc_/, '').replace(/\.json$/, '');
}

// ---- list summaries -----------------------------------------------------
async function listSummaries(ids, accessToken) {
  return Promise.all(ids.map(async id => {
    try {
      const { meta, items } = await fetchWatchlist(id, accessToken);
      const hasMovies = items.some(i => (i.media_type || 'movie') !== 'tv');
      const hasSeries = items.some(i => i.media_type === 'tv');
      const movieGenres  = collectGenres('movie', items.filter(i => (i.media_type || 'movie') !== 'tv'));
      const seriesGenres = collectGenres('tv',    items.filter(i => i.media_type === 'tv'));
      return {
        id, name: (meta && meta.name) || 'CineCollab Watchlist',
        hasMovies, hasSeries, movieGenres, seriesGenres, ok: true
      };
    } catch (_) {
      return { id, name: 'CineCollab Watchlist', hasMovies: true, hasSeries: false,
               movieGenres: [], seriesGenres: [], ok: false };
    }
  }));
}

// ---- extra definitions for a catalog ------------------------------------
const SORT_OPTIONS = ['Added (newest)', 'Added (oldest)', 'Title A–Z', 'Title Z–A', 'Year'];

function extraDefs(genres) {
  const defs = [
    { name: 'search', isRequired: false },
    { name: 'sort', isRequired: false, options: SORT_OPTIONS }
  ];
  if (genres && genres.length) {
    defs.push({ name: 'genre', isRequired: false, options: genres });
  }
  return defs;
}

// ---- discover catalog ---------------------------------------------------
const DISCOVER_ID = 'cc_discover';

async function buildDiscover(type, extras) {
  let data = discoverCache.data;
  if (!data || Date.now() - discoverCache.ts > LIST_TTL_MS) {
    const url = SUPABASE_URL + '/rest/v1/watchlists?select=id,name&is_featured=eq.true&limit=20';
    const res = await fetch(url, { headers: sbHeaders() });
    const rows = res.ok ? await res.json() : [];
    const lists = await Promise.all(
      (Array.isArray(rows) ? rows : []).map(r =>
        fetchWatchlist(r.id).catch(() => ({ items: [] }))
      )
    );
    const allItems = lists.flatMap(l => l.items || []);
    discoverCache.data = allItems;
    discoverCache.ts   = Date.now();
    data = allItems;
  }

  const wanted = type === 'series' ? 'tv' : 'movie';
  const filtered = data.filter(i => (i.media_type || 'movie') === wanted);
  const metas = await Promise.all(filtered.map(toMeta));
  return { metas: applyExtras(metas.map(stripInternal), extras) };
}

// ---- public builders ----------------------------------------------------
async function buildManifest(parsed, auth) {
  const { authBlob, ids: manualIds } = parsed;

  // Discovered ids come first (account), then manual ids, de-duped.
  let discoveredIds = [];
  if (auth) {
    discoveredIds = await discoverWatchlists(auth.accessToken, auth.uid).catch(() => []);
  }
  const allIds = [...new Set([...discoveredIds, ...manualIds])];

  const summaries = await listSummaries(allIds, auth && auth.accessToken);
  const catalogs  = [];

  summaries.forEach(s => {
    const cid = catalogIdFor(s.id);
    const showMovies = s.ok ? s.hasMovies : true;
    const showSeries = s.ok ? s.hasSeries : true;
    const both = showMovies && showSeries;
    if (showMovies) {
      catalogs.push({
        type: 'movie', id: cid, name: s.name + (both ? ' (Movies)' : ''),
        extra: extraDefs(s.movieGenres)
      });
    }
    if (showSeries) {
      catalogs.push({
        type: 'series', id: cid, name: s.name + (both ? ' (Series)' : ''),
        extra: extraDefs(s.seriesGenres)
      });
    }
  });

  // Discover catalog — shown only when explicitly opted in via d_on token.
  if (parsed.discover) {
    catalogs.push({ type: 'movie',  id: DISCOVER_ID, name: 'CineCollab: Discover', extra: extraDefs([]) });
    catalogs.push({ type: 'series', id: DISCOVER_ID, name: 'CineCollab: Discover', extra: extraDefs([]) });
  }

  const title = auth
    ? 'My CineCollab'
    : summaries.length === 1
      ? summaries[0].name
      : summaries.length > 1
        ? summaries.length + ' watchlists'
        : 'CineCollab';

  return {
    id: 'com.cinecollab.watchlist.' + (allIds.join('-').slice(0, 80) || (authBlob ? 'account' : 'default')),
    version: '1.2.0',
    name: 'CineCollab: ' + title,
    description: auth
      ? 'Your CineCollab watchlists — private, members-only, and public. Updates live.'
      : allIds.length
        ? 'Imports ' + (summaries.length === 1
            ? 'the CineCollab watchlist "' + summaries[0].name + '"'
            : summaries.length + ' CineCollab watchlists') +
          ' as Stremio/Nuvio catalogs. Updates live from CineCollab.'
        : 'Add one or more CineCollab watchlists via the configure page.',
    logo: 'https://www.cinecollab.app/logo.svg',
    background: 'https://www.cinecollab.app/opengraph.png',
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['cc:'] }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'cc:'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !authBlob && allIds.length === 0 }
  };
}

async function buildCatalog(catalogId, type, extras, accessToken) {
  if (catalogId === DISCOVER_ID) return buildDiscover(type, extras);
  const watchlistId = watchlistFromCatalogId(catalogId);
  const { items } = await fetchWatchlist(watchlistId, accessToken);
  const wanted  = type === 'series' ? 'tv' : 'movie';
  const filtered = items.filter(i => (i.media_type || 'movie') === wanted);
  const metas    = await Promise.all(filtered.map(toMeta));
  return { metas: applyExtras(metas.map(stripInternal), extras) };
}

async function buildMeta(ids, type, id, accessToken) {
  const parts    = id.split(':');
  const mediaType = parts[1];
  const tmdbId   = parts[2];
  const lists    = await Promise.all(ids.map(w =>
    fetchWatchlist(w, accessToken).catch(() => ({ items: [] }))
  ));
  for (const { items } of lists) {
    const item = items.find(i =>
      String(i.media_id) === String(tmdbId) && i.media_type === mediaType
    );
    if (item) return { meta: stripInternal(await toMeta(item)) };
  }
  return { meta: null };
}

module.exports = {
  buildManifest, buildCatalog, buildMeta, buildDiscover,
  fetchWatchlist, fetchUserLists, listSummaries,
  loginPassword, exchangeRefreshToken,
  parseConfig, resolveAuth, encryptBlob, decryptBlob, applyExtras,
  discoverWatchlists,
  DISCOVER_ID, SUPABASE_URL, SUPABASE_ANON, TMDB_KEY
};
