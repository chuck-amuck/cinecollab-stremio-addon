# CineCollab → Stremio / Nuvio

Imports any **public CineCollab watchlist** into Stremio or Nuvio as a live catalog.
Each title resolves to its IMDB id, so your installed stream addons match every movie.

- **Live**: re-fetches the watchlist from CineCollab on each load (cached ~60s).
- **Zero dependencies**: pure Node 18+. Run locally or deploy free to Vercel.
- **Multi-list**: one deployment serves any watchlist — the list ID lives in the install URL.

---

## How it works

CineCollab is a Supabase-backed app. The addon reads two public REST tables
(`watchlists`, `watchlist_movies`) using CineCollab's anon key, then converts each
TMDB id to an IMDB id via the TMDB API. It speaks the standard Stremio addon
protocol (`manifest.json`, `catalog`, `meta`), which Nuvio also understands.

---

## Option A — Run locally (self-host)

```bash
cd cinecollab-stremio-addon
node server.js
```

Then open <http://127.0.0.1:7860/configure>, paste your watchlist link, and click
**Install in Stremio**. For Nuvio, copy the manifest URL and add it under
Settings → Addons.

The manifest URL looks like:

```
http://127.0.0.1:7860/<WATCHLIST_ID>/manifest.json
```

> Local hosting only works while your computer is on and only for apps on the same
> machine/network. For phones/TVs, use Option B.

## Option B — Deploy free to Vercel (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/cinecollab-stremio-addon)

> Edit the link above to point at your repo (replace `YOUR_USERNAME`) for one-click deploys.

1. Put this folder in a GitHub repo.
2. Go to <https://vercel.com>, **Add New → Project**, import the repo, and deploy
   (no settings needed — `vercel.json` handles routing).
3. Visit `https://<your-project>.vercel.app/configure`, paste your watchlist link,
   and install. Your manifest URL will be:

```
https://<your-project>.vercel.app/<WATCHLIST_ID>/manifest.json
```

This gives you a public URL that works on any device, anytime.

> Other free hosts work too (Render, Railway, Deno Deploy, a home server). Anything
> that can run `node server.js` and expose a public HTTPS URL.

---

## Installing in each app

**Stremio**: open the `/configure` page and click *Install in Stremio*, or paste the
manifest URL into Stremio's search/addons bar.

**Nuvio**: Settings → Addons → Add addon → paste the `…/manifest.json` URL.

After installing, the list shows up as a catalog called
`<List name> (Movies)` on the Discover/Board screen.

---

## Finding a watchlist ID

It's the UUID in the CineCollab URL:

```
https://www.cinecollab.app/watchlists/7892f8ba-80b9-4c5d-ad20-899ed5556fb2
                                       └──────────── this part ────────────┘
```

The `/configure` page accepts the **full link** or just the UUID.

---

## Configuration (optional env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | Local server port |
| `TMDB_API_KEY` | a public key | Use your own free TMDB key (themoviedb.org → Settings → API) |
| `DEFAULT_WATCHLIST` | _empty_ | Pin one list so root `/manifest.json` works without an ID in the path |
| `CINECOLLAB_ANON_KEY` | CineCollab's public anon key | Override if CineCollab rotates it |
| `CINECOLLAB_SUPABASE_URL` | CineCollab's project URL | Override if it changes |

---

## Notes & limits

- Works with **public** watchlists. Private/collaborative-only lists aren't readable
  without a logged-in session.
- TV entries in a list map to Stremio "series"; movie-only lists leave the Series
  catalog empty (harmless).
- If CineCollab changes its backend or rotates its anon key, update the env vars above.
- This is an unofficial integration and not affiliated with CineCollab.

## Files

```
addon.js      Core logic: fetch list, TMDB→IMDB, build manifest/catalog/meta
handler.js    HTTP routing + the /configure page (shared by local & serverless)
server.js     Local Node server  (node server.js)
api/index.js  Vercel serverless entry
vercel.json   Vercel routing
```
