# ELEGSO Website Repository Rules

## Supported workspace

- The only supported development and test workspace is
  `/srv/wlab/projects/elegso.tilda` on WLAB. The convenient user path
  `/home/queen/Projects/elegso.tilda` is a symlink to that directory.
- The operator Mac is only a connection and display client. Do not build,
  test, generate assets, keep project caches, or continue development there.
- Before working, read `docs/WLAB_DEVELOPMENT.md` and the current sanitized
  handoff under `.codex/project-context/` when it exists.
- Current code, tests, documented module contracts, and verified production
  behavior take precedence over historical chat notes.

## Git and deployment

- `origin` is the GitHub repository. `vm` is the deployment repository on
  VM240. Develop on a `codex/` branch, verify on WLAB, and push that branch to
  GitHub for preservation/review.
- A push to `vm` branch `main` is a production deployment. Never push it
  merely to save work. Production deployment requires the user's explicit
  authorization in the current task and all documented preflight checks.
- Never edit `/srv/www/elegso.ru/current`, generated production projections,
  databases, or service configuration by hand. The VM240 post-receive hook is
  the only normal publication path and performs atomic switching and rollback.
- Do not commit credentials, private customer materials, database copies,
  backups, browser profiles, or private SSH keys.

## Build and content ownership

- `www/` and tracked source assets are the public source projection.
- ERP case data is published as static HTML, JSON, images, and documents under
  the generated case projection. Public visitors must not depend on a live ERP
  request. Preserve the case publisher contract and the independent generated
  projection.
- Legal documents edited in the site administration system are database-owned
  and exported by the legal publisher. Do not replace current database content
  with an old Git seed.
- Preserve the approved dark-emerald visual system, long-form SEO content,
  responsive behavior, consent-based Yandex analytics, contact-reveal goals,
  recruitment section, and existing calculator/admin integrations unless the
  user explicitly changes the requirement.
- Do not invent case facts, amounts, qualifications, testimonials, statistics,
  or court results.

## Verification

- Run the complete Node and Python test suites on WLAB for material changes.
- Run the SEO audit and check broken local references after public-page builds.
- Test desktop, tablet, and mobile layouts. Respect `prefers-reduced-motion`.
- Keep unrelated user files and concurrent changes intact.

## Backups and infrastructure

- Do not create backup payloads on the WLAB system disk, production root disk,
  or operator Mac. Follow the current central Archive VM920 policy for any
  infrastructure or data backup task.
- Do not copy old Mac backup trees or old worktrees into this project. Restore
  or migrate only explicitly approved current artifacts with checksums.
- Do not change firewall, routes, shared storage, or unrelated services while
  working on this repository.
