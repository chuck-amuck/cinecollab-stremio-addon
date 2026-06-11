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

// ---- config parsing -----------------------------------------------------
// A config segment may hold one or many watchlists: a comma/space separated
// list of UUIDs and/or full CineCollab links. Returns an ordered, de-duped
// array of watchlist UUIDs.
function parseConfig(seg) {
  if (!seg) return [];
  let s = decodeURIComponent(seg);
  const found = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  return [...new Set(found.map(function (x) { return x.toLowerCase(); }))];
}

// catalog id <-> watchlist id helpers (catalog id must be URL-safe)
function catalogIdFor(watchlistId) { return 'cc_' + watchlistId; }
function watchlistFromCatalogId(catalogId) {
  return String(catalogId || '').replace(/^cc_/, '').replace(/\.json$/, '');
}

// Summarise each list: name + which content types it actually contains.
async function listSummaries(ids) {
  return Promise.all(ids.map(async function (id) {
    try {
      const { meta, items } = await fetchWatchlist(id);
      const hasMovies = items.some(function (i) { return (i.media_type || 'movie') !== 'tv'; });
      const hasSeries = items.some(function (i) { return i.media_type === 'tv'; });
      return { id, name: (meta && meta.name) || 'CineCollab Watchlist', hasMovies, hasSeries, ok: true };
    } catch (e) {
      return { id, name: 'CineCollab Watchlist', hasMovies: true, hasSeries: false, ok: false };
    }
  }));
}

// ---- public builders ----------------------------------------------------
async function buildManifest(ids) {
  const list = ids.length ? ids : [];
  const summaries = await listSummaries(list);

  const catalogs = [];
  summaries.forEach(function (s) {
    const cid = catalogIdFor(s.id);
    // If we couldn't read the list, expose both types as a safe fallback.
    const showMovies = s.ok ? s.hasMovies : true;
    const showSeries = s.ok ? s.hasSeries : true;
    const both = showMovies && showSeries;
    if (showMovies) {
      catalogs.push({ type: 'movie', id: cid, name: s.name + (both ? ' (Movies)' : '') });
    }
    if (showSeries) {
      catalogs.push({ type: 'series', id: cid, name: s.name + (both ? ' (Series)' : '') });
    }
  });

  const title = summaries.length === 1
    ? summaries[0].name
    : summaries.length + ' watchlists';

  return {
    id: 'com.cinecollab.watchlist.' + (list.join('-').slice(0, 80) || 'default'),
    version: '1.1.0',
    name: 'CineCollab: ' + title,
    description: list.length
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
    catalogs: catalogs,
    behaviorHints: { configurable: true, configurationRequired: list.length === 0 }
  };
}

function stripInternal(m) { var c = Object.assign({}, m); delete c._tmdb; delete c._mediaType; return c; }

// One catalog == one watchlist; the requested `type` selects movie vs series.
async function buildCatalog(catalogId, type) {
  const watchlistId = watchlistFromCatalogId(catalogId);
  const { items } = await fetchWatchlist(watchlistId);
  const wanted = type === 'series' ? 'tv' : 'movie';
  const filtered = items.filter(function (i) { return (i.media_type || 'movie') === wanted; });
  const metas = await Promise.all(filtered.map(toMeta));
  return { metas: metas.map(stripInternal) };
}

// Meta fallback for cc:<mediaType>:<tmdbId> ids. Searches every configured list.
async function buildMeta(ids, type, id) {
  const parts = id.split(':'); // cc, mediaType, tmdbId
  const mediaType = parts[1];
  const tmdbId = parts[2];
  const lists = await Promise.all(ids.map(function (w) {
    return fetchWatchlist(w).catch(function () { return { items: [] }; });
  }));
  for (const { items } of lists) {
    const item = items.find(function (i) {
      return String(i.media_id) === String(tmdbId) && i.media_type === mediaType;
    });
    if (item) return { meta: stripInternal(await toMeta(item)) };
  }
  return { meta: null };
}

module.exports = {
  buildManifest, buildCatalog, buildMeta, fetchWatchlist,
  parseConfig, listSummaries,
  SUPABASE_URL, TMDB_KEY
};
