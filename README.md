# CineCollab → Stremio / Nuvio

Imports CineCollab watchlists into Stremio or Nuvio as live catalogs.
Each title resolves to its IMDB id, so your installed stream addons match every movie.

- **Live**: re-fetches watchlists from CineCollab on each load (cached ~60s).
- **Zero dependencies**: pure Node 18+. Run locally or deploy free to Vercel.
- **Multiple watchlists**: add as many lists as you like — each shows up as its own catalog row.
- **Account integration**: connect your CineCollab account to auto-import private and members-only lists.
- **Search, sort & filter**: search by title, sort by date/name/year, and filter by genre within any catalog.
- **Discover**: browse CineCollab's featured public lists without an account.
- **Browse by user**: enter any CineCollab username to see and add their public lists.

---

## How it works

CineCollab is a Supabase-backed app. The addon reads from CineCollab's REST API, then
converts each TMDB id to an IMDB id via the TMDB API. It speaks the standard Stremio addon
protocol (`manifest.json`, `catalog`, `meta`), which Nuvio also understands.

---

## Option A — Run locally (self-host)

```bash
cd cinecollab-stremio-addon
node server.js
```

Then open <http://127.0.0.1:7860/configure> and use any of the three setup flows below.

> Local hosting only works while your computer is on and only for apps on the same
> machine/network. For phones/TVs, use Option B.

## Option B — Deploy free to Vercel (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/cinecollab-stremio-addon)

> Edit the link above to point at your repo (replace `YOUR_USERNAME`) for one-click deploys.

1. Put this folder in a GitHub repo.
2. Go to <https://vercel.com>, **Add New → Project**, import the repo, and deploy.
3. Visit `https://<your-project>.vercel.app/configure` to set up your install.

---

## Setup flows

### Flow 1 — Public lists by URL or ID

Paste one or more CineCollab watchlist links (one per line) on the `/configure` page
and click **Generate install link**. Works without an account.

```
# one list
http://127.0.0.1:7860/<WATCHLIST_ID>/manifest.json

# several lists (comma-separated) — each becomes its own catalog row
http://127.0.0.1:7860/<ID_1>,<ID_2>,<ID_3>/manifest.json
```

### Flow 2 — Browse another user's public lists

On the `/configure` page, enter a CineCollab username or profile URL in the
**Browse another user's lists** section. Their public watchlists appear as a
checklist — select the ones you want and click **Add selected lists**.

> Only **public** lists are visible this way. Private and members-only lists belonging
> to another user require them to share their own install link.

### Flow 3 — Connect your own CineCollab account

Requires `ADDON_SECRET` to be set (see [Configuration](#configuration) below).

On the `/configure` page, sign in with your CineCollab email and password.
After login, all your watchlists — public, members-only, and private — are auto-discovered
and shown as a checklist. The generated install URL embeds an encrypted token; no plaintext
credentials are ever stored.

**Security note:** treat your account install URL as a secret. Anyone who has it can read
your CineCollab watchlists through this addon.

#### Refresh-token rotation on Vercel

Supabase rotates refresh tokens on use. The addon keeps a warm in-memory rotation cache,
but Vercel cold starts can cause a "session expired" error. When this happens, simply
reconnect your account from `/configure`. For uninterrupted service prefer the local
`node server.js` server (which stays warm). Alternatively you can disable refresh-token
rotation in the CineCollab Supabase project settings if you control it.

---

## Search, sort & filter

Stremio and Nuvio support extra params on any catalog. In the app's catalog row you can:

- **Search** — type to filter titles within a watchlist.
- **Sort** — Added (newest), Added (oldest), Title A–Z, Title Z–A, Year.
- **Genre** — filter to a single genre (derived from the items in each list).

These work on all catalogs including the Discover catalog.

---

## Discover catalog

When installed without an account, the addon includes a **CineCollab: Discover** catalog
populated from CineCollab's featured public lists. No account or UUID needed.

---

## Installing in each app

**Stremio**: open the `/configure` page and click *Install in Stremio*, or paste the
manifest URL into Stremio's search/addons bar.

**Nuvio**: Settings → Addons → Add addon → paste the `…/manifest.json` URL.

---

## Finding a watchlist ID

It's the UUID in the CineCollab URL:

```
https://www.cinecollab.app/watchlists/7892f8ba-80b9-4c5d-ad20-899ed5556fb2
                                       └──────────── this part ────────────┘
```

The `/configure` page accepts the **full link** or just the UUID.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | Local server port |
| `ADDON_SECRET` | _unset_ | **Required for account features.** Any random secret string (min 16 chars). Encrypts the Supabase token embedded in account install URLs. Rotating this value invalidates all existing account installs. |
| `TMDB_API_KEY` | a public key | Use your own free TMDB key (themoviedb.org → Settings → API) |
| `DEFAULT_WATCHLIST` | _empty_ | Pin one list so root `/manifest.json` works without an ID in the path |
| `CINECOLLAB_ANON_KEY` | CineCollab's public anon key | Override if CineCollab rotates it |
| `CINECOLLAB_SUPABASE_URL` | CineCollab's project URL | Override if it changes |

---

## Trakt → CineCollab sync (watched tracking)

Keep CineCollab's **watched** state in sync with what you actually watch in Nuvio —
the equivalent of a Trakt scrobble, flowing back into CineCollab.

**How the pieces fit:** Nuvio has a built-in Trakt integration that scrobbles what you
watch. This repo ships `traktSync.js`, a small one-way sync that pulls your Trakt watch
history and records it in CineCollab's `user_watched` table. So the chain is:

```
Nuvio (built-in Trakt scrobble) ──▶ Trakt ──▶ traktSync.js ──▶ CineCollab user_watched
```

There is **no Nuvio plugin to write** — Nuvio "plugins" are stream scrapers and have no
watched-state hook. You just connect Trakt inside Nuvio (Settings → Trakt) and enable
scrobbling. Trakt's public API is the integration point.

### Setup

1. **Register a Trakt API app** (free): <https://trakt.tv/oauth/applications> → *New
   Application*. Redirect URI can be `urn:ietf:wg:oauth:2.0:oob`. Note the **client id**
   and **client secret**.
2. **Set env vars** (e.g. in `.env` or your shell):

   ```bash
   export TRAKT_CLIENT_ID=…
   export TRAKT_CLIENT_SECRET=…
   export CINECOLLAB_EMAIL=you@example.com
   export CINECOLLAB_PASSWORD=…
   # optional: also mark watched TV shows (title-level) from episode history
   export SYNC_SHOWS=true
   ```

   > **Signed up with Google?** You have no password, so set `CINECOLLAB_REFRESH_TOKEN`
   > instead of email/password. Find it in your browser: open CineCollab while logged in,
   > DevTools → Application → Local Storage → the `sb-…-auth-token` entry → copy the
   > `refresh_token` value. You only set it once; the sync persists the rotated token after.

3. **Authorize Trakt once** (device-code flow — no browser callback needed):

   ```bash
   npm run sync:login          # prints a code + URL; visit trakt.tv/activate
   ```

4. **Sync:**

   ```bash
   npm run sync                # one incremental pass
   npm run sync:watch          # run forever (every SYNC_INTERVAL_MS, default 15 min)
   node traktSync.js status    # show stored token + cursor
   ```

The sync is **incremental** (tracks a `watched_at` cursor) and **idempotent** (de-dupes
against titles already recorded in CineCollab), so re-running is always safe. State lives
in `.trakt-sync-state.json` (gitignored).

### Populate a watchlist from your Trakt history

In addition to syncing watched state, you can bulk-populate a CineCollab watchlist with
everything you've watched on Trakt — movies and TV shows — sorted by watch date so the
list reflects your actual viewing timeline.

1. Set `TARGET_WATCHLIST_ID` in your `.env` to the UUID of the CineCollab watchlist you
   want to populate (find it in the CineCollab URL, e.g. `.../watchlists/<uuid>`).
2. Run:

   ```bash
   npm run watchlist               # add anything not already in the list
   npm run watchlist -- --clear    # wipe the list first, then re-populate
   npm run watchlist -- --movies-only   # skip TV shows
   npm run watchlist -- --shows-only    # skip movies
   npm run watchlist -- --watchlist <uuid>  # override TARGET_WATCHLIST_ID for this run
   ```

Items are inserted in watch-date order (`last_watched_at` → `added_at`), so your watchlist
displays them oldest-to-newest watched. Titles with no TMDB record are logged by name so
you can investigate them manually.

### Sync env vars

| Variable | Default | Purpose |
|---|---|---|
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` | _unset_ | **Required.** From your Trakt API app |
| `CINECOLLAB_EMAIL` / `CINECOLLAB_PASSWORD` | _unset_ | CineCollab account to record watched titles against |
| `CINECOLLAB_REFRESH_TOKEN` | _unset_ | Alternative to email/password — **required if you signed up via Google** (no password). Read once on first run, then the rotated token is saved to the state file, so you only set it once. |
| `SYNC_SHOWS` | `false` | `true` also marks watched **TV shows** (title-level) from episode history |
| `SYNC_INTERVAL_MS` | `900000` | Poll interval for `sync:watch` (15 min) |
| `SYNC_STATE_FILE` | `.trakt-sync-state.json` | Where the Trakt token + cursor are stored |
| `TARGET_WATCHLIST_ID` | _unset_ | **Required for `npm run watchlist`.** UUID of the CineCollab watchlist to populate from your Trakt history. Can also be overridden per-run with `--watchlist <uuid>`. |

> **Notes.** Trakt returns TMDB ids, which CineCollab stores natively — no id conversion
> needed on this path. Marking a TV show watched is **title-level** (one `user_watched`
> row per show on its first scrobbled episode), so leave `SYNC_SHOWS` off if you only
> want movies. Best run as a long-lived process (`npm run sync:watch`) or a cron; on
> Vercel you'd need durable storage for the state file, so a self-hosted process is simpler.

---

## Notes & limits

- Works with **public** watchlists without an account. Private/collaborative-only lists
  require connecting your account (Flow 3).
- TV entries map to Stremio "series"; movie-only lists leave the Series catalog empty (harmless).
- If CineCollab changes its backend or rotates its anon key, update the env vars above.
- This is an unofficial integration and not affiliated with CineCollab.

---

## Planned features

- **Google sign-in** — currently blocked because self-hosted deployments can't add their `/auth/callback` URL to the CineCollab Supabase project's redirect allowlist. Use email/password login in the meantime.
- **"Already seen" filtering** — hide titles you've already watched (from `user_watched`, now
  populated by the [Trakt → CineCollab sync](#trakt--cinecollab-sync-watched-tracking)) from
  your watchlist catalogs.

---

## Files

```
addon.js      Core logic: fetch lists, auth, TMDB→IMDB, build manifest/catalog/meta/discover
handler.js    HTTP routing + configure page + auth endpoints
server.js     Local Node server  (node server.js)
traktSync.js  Trakt → CineCollab watched-state sync + watchlist populate (CLI: login/run/watch/status/populate-watchlist)
api/index.js  Vercel serverless entry
vercel.json   Vercel routing
```
