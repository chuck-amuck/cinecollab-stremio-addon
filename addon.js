'use strict';

/**
 * CineCollab -> Stremio/Nuvio addon (zero dependencies, Node 18+)
 *
 * Exposes a CineCollab public watchlist as a Stremio catalog.
 * The watchlist UUID is passed as configuration in the install URL, e.g.
 *   https://your-host/7892f8ba-80b9-4c5d-ad20-899ed5556fb2/manifest.json
 *
 * Data source: CineCollab's public Supabase REST API.
 * IMDB ids are resolved from TMDB so that stream addons match each title.
 */

const SUPABASE_URL = process.env.CINECOLLAB_SUPABASE_URL ||
  'https://fnsklauaxovbvatfquil.supabase.co';

// CineCollab's public anon key (role: anon). Read-only; safe to ship.
const SUPABASE_ANON = process.env.CINECOLLAB_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuc2tsYXVheG92YnZhdGZxdWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MzI2MzIsImV4cCI6MjA5MjA5MjYzMn0.NfwVFGH13dT_dRQcOdMMmAqS1J1e0O1gicPyUTeGHRg';

// Free public TMDB key (override with your own via TMDB_API_KEY env var).
const TMDB_KEY = process.env.TMDB_API_KEY ||
  'a42286d5ac5971752bfcf0e3f807e383';

const TMDB_IMG = 'https://image.tmdb.org/t/p';

// ---- TMDB genre maps ----------------------------------------------------
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

// ---- tiny caches --------------------------------------------------------
const imdbCache = new Map();           // `${type}:${tmdbId}` -> 'tt...' | null
const listCache = new Map();           // watchlistId -> { ts, data }
const LIST_TTL_MS = 60 * 1000;         // re-fetch list at most once per minute

// ---- helpers ------------------------------------------------------------
function sbHeaders() {
  return { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON };
}

async function fetchWatchlist(watchlistId) {
  const cached = listCache.get(watchlistId);
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) return cached.data;

  const base = SUPABASE_URL + '/rest/v1';
  const metaUrl = base + '/watchlists?select=name,description,visibility&id=eq.' +
    encodeURIComponent(watchlistId);
  const moviesUrl = base + '/watchlist_movies?select=media_id,media_type,title,' +
    'poster_path,backdrop_path,release_date,genre_ids,runtime&watchlist_id=eq.' +
    encodeURIComponent(watchlistId) + '&order=added_at.desc';

  const [metaRes, movRes] = await Promise.all([
    fetch(metaUrl, { headers: sbHeaders() }),
    fetch(moviesUrl, { headers: sbHeaders() })
  ]);
  if (!metaRes.ok || !movRes.ok) {
    throw new Error('CineCollab fetch failed (' + metaRes.status + '/' + movRes.status + ')');
  }
  const meta = (await metaRes.json())[0] || null;
  const items = await movRes.json();
  const data = { meta, items: Array.isArray(items) ? items : [] };
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
  } catch (e) {
    imdbCache.set(key, null);
    return null;
  }
}

function genreNames(mediaType, ids) {
  const map = mediaType === 'tv' ? TV_GENRES : MOVIE_GENRES;
  return (ids || []).map(function (g) { return map[g]; }).filter(Boolean);
}

// Build a Stremio meta-preview object for the catalog.
async function toMeta(item) {
  const isTv = item.media_type === 'tv';
  const stremioType = isTv ? 'series' : 'movie';
  const imdb = await tmdbToImdb(item.media_type, item.media_id);
  const id = imdb || ('cc:' + item.media_type + ':' + item.media_id);
  const year = item.release_date ? String(item.release_date).slice(0, 4) : undefined;
  return {
    id: id,
    type: stremioType,
    name: item.title,
    poster: item.poster_path ? TMDB_IMG + '/w342' + item.poster_path : undefined,
    background: item.backdrop_path ? TMDB_IMG + '/w780' + item.backdrop_path : undefined,
    posterShape: 'poster',
    releaseInfo: year,
    genres: genreNames(item.media_type, item.genre_ids),
    runtime: item.runtime ? item.runtime + ' min' : undefined,
    // keep originals for our own meta fallback
    _tmdb: item.media_id,
    _mediaType: item.media_type
  };
}

// ---- public builders ----------------------------------------------------
function buildManifest(watchlistId, listName) {
  const name = listName || 'CineCollab Watchlist';
  return {
    id: 'com.cinecollab.watchlist.' + (watchlistId || 'default'),
    version: '1.0.0',
    name: 'CineCollab: ' + name,
    description: 'Imports the CineCollab watchlist "' + name +
      '" as a Stremio/Nuvio catalog. Updates live from CineCollab.',
    logo: 'https://www.cinecollab.app/logo.svg',
    background: 'https://www.cinecollab.app/opengraph.png',
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['cc:'] }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'cc:'],
    catalogs: [
      { type: 'movie', id: 'cinecollab-movies', name: name + ' (Movies)' },
      { type: 'series', id: 'cinecollab-series', name: name + ' (Series)' }
    ],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

async function buildCatalog(watchlistId, type) {
  const { items } = await fetchWatchlist(watchlistId);
  const wanted = type === 'series' ? 'tv' : 'movie';
  const filtered = items.filter(function (i) { return (i.media_type || 'movie') === wanted; });
  const metas = await Promise.all(filtered.map(toMeta));
  // strip internal fields
  return { metas: metas.map(function (m) { var c = Object.assign({}, m); delete c._tmdb; delete c._mediaType; return c; }) };
}

// Meta fallback only for cc:<mediaType>:<tmdbId> ids (titles without an IMDB id).
async function buildMeta(watchlistId, type, id) {
  const { items } = await fetchWatchlist(watchlistId);
  const parts = id.split(':'); // cc, mediaType, tmdbId
  const mediaType = parts[1];
  const tmdbId = parts[2];
  const item = items.find(function (i) {
    return String(i.media_id) === String(tmdbId) && i.media_type === mediaType;
  });
  if (!item) return { meta: null };
  const m = await toMeta(item);
  delete m._tmdb; delete m._mediaType;
  return { meta: m };
}

module.exports = {
  buildManifest, buildCatalog, buildMeta, fetchWatchlist,
  SUPABASE_URL, TMDB_KEY
};
