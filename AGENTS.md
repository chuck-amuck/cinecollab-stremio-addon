# AGENTS.md

CineCollab → Stremio/Nuvio addon: imports CineCollab watchlists as catalogs, and syncs
Trakt watch history into CineCollab. **Zero runtime deps, Node 18+, CommonJS, 2-space indent.**

## Rules

- **No runtime dependencies.** Built-ins only (`fetch`, `crypto`, `node:test`, `http`, `fs`).
  `package.json` has no `dependencies` and must stay that way.
- **Never commit secrets.** `.env` and `.trakt-sync-state.json` are gitignored and hold live
  tokens. Verify they're untracked before committing. (The anon Supabase key and fallback
  TMDB key in `addon.js` are public — those are fine.)
- **Tests stay offline.** `npm test` (`node --test`) — no network. Add new test files to the
  `test` script.
- **Don't break bare-UUID public installs** (`…/<uuid>/manifest.json`, no `ADDON_SECRET`, no
  account). It's the most common path.

## Files

`addon.js` data layer (lists, auth, TMDB→IMDB, manifest/catalog/meta) · `handler.js` HTTP
routes + `/configure` page · `server.js` local server · `api/index.js` Vercel entry ·
`traktSync.js` Trakt→CineCollab sync + CLI · `test/*.test.js` offline unit tests.

## Non-obvious invariants (won't catch these from reading code)

- **Config-segment encoding** (`parseConfig`): `<uuid>`, `a_<blob>`, `d_on` and combos are
  persisted in users' installed addons. Additive changes only — never repurpose a token.
- **Encrypted blob**: AES-256-GCM, key = `scrypt(ADDON_SECRET, 'cinecollab-addon-v1', …)`.
  Changing the salt or KDF params invalidates every `a_…` install. Unset `ADDON_SECRET` must
  silently disable account features (ignore `a_…`).
- **Supabase rotates refresh tokens on every use.** Always capture the rotated token and
  persist it (in-memory `tokenCache` in `addon.js`; state file in `traktSync.js`).
- **Trakt requests need a `User-Agent`** (Cloudflare 403s without one) plus `trakt-api-version`
  and `trakt-api-key`. Sync uses the headless device-code flow.
- **`user_watched` writes**: collapse to one row per `(media_type, media_id)`, insert with
  `on_conflict=user_id,media_id,media_type` + `Prefer: resolution=ignore-duplicates`. Sync is
  incremental (a `watched_at` cursor) and must stay safe to re-run. Trakt gives TMDB ids
  directly — no conversion on the sync path.

## Versioning

`version` in `package.json` and `version:` in `addon.js`'s manifest must stay **in lockstep —
bump both or neither**. Semver against the *installed-addon contract*: PATCH = fixes/refactors
with no change to manifest, URL format, or env vars; MINOR = backward-compatible additions
(new catalog, optional env var, new segment token); MAJOR = breaks existing installs (segment
encoding, blob format, `idPrefixes`, removed env var). Don't bump for comments/tests/internal
renames. Only bump when shipping or when the contract actually changes.
