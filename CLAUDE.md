# CineCollab addon for Stremio and Nuvio

Serves CineCollab watchlists as Stremio/Nuvio catalogs. `traktSync.js` is a CLI that copies Trakt watch history into CineCollab. User setup is in README.md.

## Commands

- `npm test` runs `node --test` over the files listed in package.json, so add any new test file to that list. Tests stay offline.
  Without npm, `node --test test/*.test.js` runs the same suite.
- `npm start` serves the addon on port 7860 (or `PORT`), with the install page at `/configure`.
- Only `traktSync.js` reads `.env`. For the server, export `ADDON_SECRET` and other variables in the shell.
- The `sync*` and `watchlist` scripts act on real Trakt and CineCollab accounts, and `npm run watchlist -- --clear` deletes rows. Don't run them unless asked.

## How a change ships

Every push to `main` deploys straight to production on Vercel, which is what installed manifest URLs point at. CI (Node 18, 20 and 22) runs on the same push but doesn't hold the deploy back, so run `npm test` first. The release-gated deploy in FUTURE_INFRASTRUCTURE_IMPROVEMENTS.md is only a plan.

Vercel runs the app through `server.js` and hands it the rewritten URL (`/api/index?…&__path=<encoded path>`), so
`vercel.json` passes the original path as `__path` and `originalUrl` in `handler.js` restores it. Keep both, or
every route but `/` returns 404. JSON answers, 404s included, are cached for 60 s at the edge: add `?cb=<random>`
when checking a deploy.

## Rules

- No runtime dependencies. Use built-ins only, and keep Node 18 working.
- `.env` and `.trakt-sync-state.json` hold live tokens and are gitignored. Check they are untracked before committing.
- The CineCollab anon key and the fallback TMDB key in `addon.js` are there on purpose.
- Don't break bare-UUID installs (`/<uuid>/manifest.json`, with no account and no `ADDON_SECRET`). They are the most common setup.

## The installed-addon contract

- `parseConfig` in `addon.js` reads the config segment of installed URLs. Its tokens:
  - `<uuid>`, comma-separated for several lists;
  - `a_<blob>`, the encrypted account token;
  - `d_on`, the Discover catalog;
  - `o_<uuid>.<uuid>…`, which keeps only those of the account's lists.
- Users keep these URLs, so you can add tokens but must never change what an existing one means.
- `parseConfig` returns `{ authBlob, ids, discover, only }`. Some tests in `test/parseConfig.test.js` compare the whole object, so update them when the shape changes.
- The `a_` blob is AES-256-GCM, keyed by `scrypt(ADDON_SECRET, 'cinecollab-addon-v1')` with N=16384, r=8, p=1. Changing the salt or parameters breaks every account install.
- With `ADDON_SECRET` unset, account features turn off quietly and `a_` tokens are ignored.

## External APIs

- Supabase rotates the refresh token on every use, so always keep the new one. The server keeps it in `tokenCache`; `traktSync.js` keeps it in its state file.
- Trakt is behind Cloudflare, which returns 403 without a `User-Agent`. Also send `trakt-api-version` and `trakt-api-key`.
- The sync must stay safe to re-run:
  - one `user_watched` row per `(media_type, media_id)`;
  - inserts use `on_conflict=user_id,media_id,media_type` and `Prefer: resolution=ignore-duplicates`;
  - a `watched_at` cursor tracks progress.
- `populate-watchlist` sets `added_at` from `last_watched_at` so the list keeps watch order.

## Versioning

`version` in package.json and the manifest version in `addon.js` change together. Bump them by what installed addons see:

- minor for a new segment token, catalog or optional env var;
- major for anything that breaks existing install URLs;
- patch for other fixes.

Tests and refactors get no bump.
