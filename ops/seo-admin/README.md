# ELEGSO private marketing dashboard

The dashboard is available only through `https://elegso.ru/admin/`. It is not
linked from public pages, is absent from the sitemap and carries both HTML and
HTTP `noindex,nofollow,noarchive` directives.

## Access model

- nginx validates HTTP Basic Auth against
  `/var/lib/elegso-seo-admin/auth/users.htpasswd`;
- the application accepts traffic only through
  `/run/elegso-seo-admin/admin.sock`, never a public TCP port;
- nginx replaces `X-Admin-User` with the authenticated username and removes
  the `Authorization` header before proxying;
- the application verifies the same username in its isolated role database;
- `viewer` can inspect all reports but cannot modify keywords or users;
- `admin` can also edit the keyword plan;
- only the configured owner can create, update or remove accounts; the owner
  account cannot be demoted or deleted.

The owner adds a marketer in **Система → Пользователи панели**. Passwords are
sent only over HTTPS to `htpasswd` stdin and stored as bcrypt cost-12 hashes.
Plain-text passwords are never written to SQLite, logs, Git or process
arguments.

## Process and data isolation

The long-running web UI uses `elegso-seo-admin`. External Yandex responses and
nginx logs are handled by the separate `elegso-seo-ingest` identity. The ingest
identity can write only aggregate analytics and cannot traverse the role or
password directories.

Production paths:

- application releases: `/opt/elegso-seo-admin/releases/`;
- non-secret owner setting: `/etc/elegso-seo-admin/admin.env` (`0600`);
- OAuth secrets used only by the oneshot sync:
  `/etc/elegso-seo-admin/yandex.env` (`0600`);
- roles and audit: `/var/lib/elegso-seo-admin/access/`;
- bcrypt file: `/var/lib/elegso-seo-admin/auth/users.htpasswd`;
- editable keyword plan: `/var/lib/elegso-seo-admin/config/keywords.json`;
- aggregate traffic/marketing data:
  `/var/lib/elegso-seo-admin/data/analytics.sqlite3`.

The nginx-log aggregator never stores IP addresses or raw user-agent strings.
It keeps only daily counts by page, referring host, device group and HTTP
error, with a 400-day retention window. Metrica and Webmaster synchronization
stores aggregate reports only.

## Services

- `elegso-seo-admin.service`: private UI, enabled at boot;
- `elegso-seo-traffic.timer`: refreshes server aggregates every 15 minutes;
- `elegso-yandex-analytics.timer`: refreshes Metrica and Webmaster aggregate
  reports four times daily when OAuth is configured;
- `elegso-seo-monitor.timer`: daily independent ranking snapshot;
- `elegso-seo-wordstat-enqueue.timer`: weekly demand-discovery enqueue;
- `elegso-seo-wordstat-worker.timer`: quota-aware queue worker.

OAuth tokens must be created for an account that can read counter `87831358`
and the `elegso.ru` Webmaster host. The Search API key is separate and does not
grant access to these private analytics APIs.
