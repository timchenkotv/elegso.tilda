# ELEGSO development on WLAB

Updated: 2026-11-11 (Europe/Moscow).

## Canonical paths

| Purpose | Path |
| --- | --- |
| Canonical WLAB checkout | `/srv/wlab/projects/elegso.tilda` |
| User-facing project link | `/home/queen/Projects/elegso.tilda` |
| Public production site | `https://elegso.ru/` |
| VM240 bare deployment repository | `/srv/git/elegso.tilda.git` |
| VM240 active frontend pointer | `/srv/www/elegso.ru/current` |
| VM240 generated cases pointer | `/srv/www/elegso.ru/generated/current` |
| VM240 generated legal pointer | `/srv/www/elegso.ru/generated-legal/current` |

The Mac checkout is retained only as an untouched fallback until the operator
removes it. It is not a supported build or test workspace after this migration.

## Repository and remotes

The migration baseline is production/GitHub `main` commit
`21481f4d916e3fab815981bfe33e42931a1d8c06`.

- `origin`: `https://github.com/timchenkotv/elegso.tilda.git`
- `vm`: `tilda-sites:/srv/git/elegso.tilda.git`

WLAB already has a dedicated VM240 host key. The `vm` remote runs Git upload
and receive processes as the repository owner `queen`; no Mac private key is
copied to WLAB. Confirm before work:

```bash
cd /srv/wlab/projects/elegso.tilda
git fetch --all --prune
git status --short --branch
git rev-parse HEAD origin/main vm/main
```

Use a feature branch for development:

```bash
git switch -c codex/<task-name> origin/main
```

Pushing a feature branch to GitHub preserves work without deploying:

```bash
git push -u origin HEAD
```

Only an explicitly authorized production release may update VM240 `main`:

```bash
git push vm HEAD:main
```

The server post-receive hook validates and atomically publishes the frontend,
case projection, legal projection, services, and health checks. Do not bypass
it with direct file copies.

## File-transfer throughput

Run authorized downloads, uploads, `rsync`, and other file copies at the
maximum throughput available to WLAB and the approved endpoints. Do not add
artificial client-side caps such as `--bwlimit`, `--limit-rate`, or `scp -l`
when they are not technically required. Endpoint quotas and necessary safety
controls still apply; this rule does not authorize a transfer, deployment, or
movement of excluded data by itself.

## Local build and preview

The project uses Node.js standard-library scripts and Python standard-library
tests; it has no root `package.json` or dependency installation step.

Build all public source pages:

```bash
node scripts/build-public-site.mjs
```

Start the review-only server on WLAB loopback:

```bash
PORT=4180 node scripts/serve-design-preview.mjs
```

The server deliberately disables production APIs and serves generated cases
from `work/redesign-2026-11-04/generated/current`. From a connection client,
use SSH port forwarding when a visual review is needed; the browser is only a
display surface, while build and test processes remain on WLAB.

## Required verification

Run from the WLAB project root:

```bash
node --test tests/*.test.mjs tests/test_contact_popups.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
node scripts/audit-seo.mjs
git diff --check
```

For targeted work, run the relevant focused tests first, then the complete
suites before publication. For public layout changes, verify desktop, tablet,
small mobile, and reduced-motion behavior.

## Runtime architecture that must remain intact

1. Git tracks the public source and generators.
2. ERP publishes cases into a separate immutable static projection. The public
   site reads static HTML/JSON/assets; visitors do not query ERP at runtime.
3. The legal-document CMS owns current offer/privacy text in its database and
   publishes a separate static legal projection.
4. VM240 exposes the frontend plus both static projections through atomic
   symlinks. Deployment validates candidate projections before switching.
5. Private SEO/admin state, credentials, analytics history, and databases live
   outside Git and must never be replaced by local fixtures.

## Production safety

- Inspect the working tree and compare `origin/main`, `vm/main`, and the active
  production release before any deployment.
- Preserve unrelated work. Never force-push or deploy a dirty tree.
- Use only the current approved backup/archive process. Do not create new
  payloads under production roots or the WLAB system disk.
- After deployment, verify the public site, internal references, service health,
  case count/materials, legal documents, and responsive layouts.

## Context for new Codex sessions

The detailed sanitized handoff is stored locally on WLAB at
`.codex/project-context/CURRENT_HANDOFF.md`. It is intentionally excluded from
Git because it contains operational history that is useful to the agent but is
not part of the product source. It contains no private keys or customer data.
