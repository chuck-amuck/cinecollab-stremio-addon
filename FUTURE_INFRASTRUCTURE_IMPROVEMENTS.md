# Future infrastructure improvements

Planned but not-yet-implemented infra/ops changes. Each entry is a plan, not a commitment —
implement when there's a reason to.

---

## 1. Gate Vercel production deploys to GitHub Releases

**Status:** planned · **Type:** ops/CI · **Version impact:** none (no app code changes)

### Goal

Stop every push to `main` from instantly redeploying production. Production is what users'
installed manifest URLs point at, so it should change only on a deliberate release. After
this change the deploy contract becomes:

> **Publish a GitHub Release → production deploys.** Pushing to `main` no longer touches
> production; branch/PR **preview** deploys keep working as before.

This also aligns deploys with the version discipline in [AGENTS.md](AGENTS.md): the moment you
cut a release is the same moment the lockstep `package.json` / manifest version bump goes live.

### How it works

1. Vercel's automatic production deploy on `main` is **disabled** via `vercel.json`.
2. A **Vercel Deploy Hook** (a secret URL bound to the production branch) becomes the only way
   to trigger a production deploy.
3. A GitHub Actions workflow fires on `release: published` and `curl`s that hook.

Preview deploys for other branches/PRs are unaffected — `git.deploymentEnabled` only disables
the named branch, and the production branch never got previews anyway.

### Prerequisites (manual, in the Vercel dashboard — done once)

1. **Create the deploy hook:** Project → Settings → Git → **Deploy Hooks**. Name it e.g.
   `release-prod`, bind it to the **production branch** (`main`). Vercel returns a URL like
   `https://api.vercel.com/v1/integrations/deploy/prj_xxx/yyy`. Treat it as a secret — anyone
   with it can trigger a production deploy.
2. **Store it as a repo secret:** GitHub → repo → Settings → Secrets and variables → Actions →
   New repository secret → name `VERCEL_DEPLOY_HOOK_URL`, value = the hook URL.

> Note: disabling auto-deploy (step in the next section) is done in `vercel.json`, committed —
> no dashboard toggle needed. If you'd rather use the dashboard, the equivalent is Settings →
> Git → turn off automatic deployments for `main`. Pick one, not both.

### Implementation steps (in the repo)

**a. Disable automatic production deploys** — add a `git` block to `vercel.json`:

```json
{
  "git": {
    "deploymentEnabled": {
      "main": false
    }
  }
}
```

(Merge this into the existing `vercel.json`; keep the current `rewrites`/routing config.)

**b. Add the release→deploy workflow** at `.github/workflows/deploy.yml`:

```yaml
name: Deploy production on release

on:
  release:
    types: [published]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Vercel production deploy
        run: |
          curl -fsS -X POST "$DEPLOY_HOOK" -o /dev/null -w "triggered: HTTP %{http_code}\n"
        env:
          DEPLOY_HOOK: ${{ secrets.VERCEL_DEPLOY_HOOK_URL }}
```

`-f` makes `curl` exit non-zero on an HTTP error so a failed trigger fails the job.

### Caveats / assumptions

- **The deploy hook deploys the latest commit on `main`, not the tagged commit.** For a solo
  project that always tags from the tip of `main`, these are the same commit. If you ever tag
  an *older* commit and release it, the hook still ships `main`'s HEAD. To deploy an exact
  tag you'd need the Vercel CLI path (token + `ORG_ID`/`PROJECT_ID`, `vercel deploy --prod`
  against a checkout) — more moving parts; out of scope unless that case becomes real.
- **Releasing is now a required step to ship.** A fix merged to `main` is *not* live until a
  release is published. Document this so a hotfix isn't assumed-live.
- The deploy hook URL is a production-deploy credential — keep it in Actions secrets only,
  never in the repo or logs.

### Verification

1. Push a trivial commit to `main`; confirm **no** new production deployment appears in Vercel
   (preview deploys on branches still appear).
2. Publish a GitHub Release; confirm the `Deploy production on release` workflow runs green and
   a new **production** deployment shows up in Vercel within ~a minute.
3. Hit the live addon's `/manifest.json` and confirm the `version` matches the released bump.

### Rollback

Re-enable auto-deploy by removing the `git.deploymentEnabled` block from `vercel.json` (or
flipping the dashboard toggle back on). The `deploy.yml` workflow can stay — it's harmless
without releases — or be deleted. Revoke the deploy hook in Vercel if it's no longer used.
