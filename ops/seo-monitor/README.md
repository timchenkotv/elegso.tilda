# ELEGSO SEO monitor

This is a dependency-free, multi-site position monitor for the official Yandex
Search API. It intentionally does **not** scrape Yandex result pages and does
not request or store Yandex Webmaster API data.

The collector submits deferred XML searches, polls Yandex Cloud operations and
stores daily regional snapshots in SQLite. ELEGSO tracks Russia (`225`), Moscow
(`213`) and Saint Petersburg (`2`). One API request is shared by every
configured site that tracks the same query, region and device. The stored
result is limited to result URLs and the derived position; snippets and page
content are not retained.

Official references:

- [deferred web search](https://aistudio.yandex.ru/ru/docs/search-api/operations/web-search);
- [Search API REST request](https://aistudio.yandex.ru/ru/docs/search-api/api-ref/WebSearchAsync/search);
- [Moscow region 213](https://aistudio.yandex.ru/ru/docs/search-api/reference/regions);
- [Wordstat GetTop](https://aistudio.yandex.ru/ru/docs/search-api/operations/wordstat-gettop);
- [pricing](https://aistudio.yandex.ru/ru/docs/search-api/pricing).

## What is measured

Every enabled keyword is checked for both desktop and mobile user agents:

- Russian search type;
- Russia `225`, Moscow `213` and Saint Petersburg `2` as independent results;
- for Moscow only, `metadata.fields.X-Forwarded-For-Y` is set to the configured
  public Moscow IP; the nationwide and Saint Petersburg checks rely on their
  explicit Yandex region IDs and are not biased by the Moscow address;
- relevance sort and all-time period;
- flat groups, 100 groups, one document per group;
- XML output containing organic search results.

`position=NULL, status=not_found` means that none of the configured hostnames
was found in the first 100 results. `status=error` is separate, so an API or
network failure can never be mistaken for a lost position.

Search API snapshots are controlled, reproducible measurements. They can differ
from a personalized manual search and should primarily be compared with earlier
snapshots made using the same settings.

## Files and data

Recommended production paths:

- program: `/opt/elegso-seo-monitor/seo_monitor.py`;
- keyword configuration: `/var/lib/elegso-seo-admin/config/keywords.json`
  (edited atomically by the private dashboard and readable by `seo-monitor`);
- secrets: `/etc/elegso-seo-monitor/seo-monitor.env` (`0600`);
- history: `/var/lib/elegso-seo-monitor/history.sqlite3`;
- reports: `/var/lib/elegso-seo-monitor/reports/`.

SQLite uses WAL mode, foreign keys and unique daily keys. Async operation IDs
are persisted before polling. Restarting the same date resumes unfinished jobs
and reuses completed API results instead of creating duplicate snapshots or
unnecessary paid searches. A manual retry of a same-day operation that Yandex
has definitively rejected requires `run --retry-errors`.

## Keyword configuration

Copy `keywords.example.json` and edit the copy outside Git. A keyword may be a
plain string or an object with `query`, `cluster`, `target_url` and optional
`enabled`. A site can be disabled with `"enabled": false`.

JSON is valid YAML 1.2, so the same JSON-shaped document can have a `.yaml`
extension. The program deliberately does not implement permissive YAML object
construction and requires this JSON-compatible form to remain standard-library
only.

```json
{
  "schema_version": 1,
  "regions": ["225", "213", "2"],
  "sites": [
    {
      "id": "elegso.ru",
      "name": "ЮК «ЭЛЕГСО»",
      "domains": ["elegso.ru", "www.elegso.ru"],
      "include_subdomains": false,
      "discovery_seeds": ["юрист по лизингу"],
      "keywords": [
        {
          "query": "юрист по лизингу",
          "cluster": "лизинговые споры",
          "target_url": "/leasing_lawyer/"
        }
      ]
    }
  ]
}
```

`regions` contains official numeric Yandex region IDs. If omitted, the
backward-compatible default is Moscow `213`.

Matching is exact by hostname. Add every legitimate alias explicitly, or set
`include_subdomains` when all subdomains belong to the same monitored site.
`target_url` does not constrain ranking: it lets the report detect when Yandex
shows an unexpected page.

## Yandex Cloud access

Create a service account with `search-api.webSearch.user` and an API key with
the `yc.search-api.execute` scope, or provide a valid IAM token. The folder must
have active billing for Search API. A service-account API key can omit
`YANDEX_FOLDER_ID`: Search API infers the service account's folder. An IAM token
still requires an explicit folder ID.

Copy `seo-monitor.env.example` to the production path and set real values. Never
put the production file, API key, IAM token, SQLite database or generated
reports into Git. The supplied `.gitignore` excludes common accidental local
copies.

The program accepts exactly one authentication mechanism:

```text
YANDEX_FOLDER_ID=... # optional with a service-account API key
YANDEX_SEARCH_API_KEY=...
YANDEX_IAM_TOKEN=
YANDEX_SEARCH_GEO_IP=155.212.215.203
```

The key is sent only in the HTTPS `Authorization` header and is never printed.
The public IP is metadata for the official API; the service never connects to a
Yandex SERP page.

## Safe local checks

`status` never needs a Yandex credential and never performs a network request:

```bash
python3 seo_monitor.py status \
  --config ./keywords.example.json \
  --db /tmp/elegso-seo-monitor.sqlite3
```

It reports only whether credential environment variables are present, never
their values. `report` and `init-db` also work without API access:

```bash
python3 seo_monitor.py init-db --db /tmp/elegso-seo-monitor.sqlite3
python3 seo_monitor.py report --db /tmp/elegso-seo-monitor.sqlite3 \
  --output-dir /tmp/elegso-seo-reports --window all
```

Without a configured key/token, `run` and `discover` stop before any network
request with exit code 78 and a short configuration error.

## Manual collection and reports

Loading the environment file in a protected administrative shell:

```bash
set -a
. /etc/elegso-seo-monitor/seo-monitor.env
set +a
python3 /opt/elegso-seo-monitor/seo_monitor.py run \
  --config /var/lib/elegso-seo-admin/config/keywords.json \
  --db /var/lib/elegso-seo-monitor/history.sqlite3 \
  --report-dir /var/lib/elegso-seo-monitor/reports
```

Each collection writes atomic UTF-8 JSON, UTF-8-with-BOM CSV and responsive
HTML reports for today, seven days and 30 days. The files are named
`rank-today.*`, `rank-7d.*` and `rank-30d.*`; `index.html` is the latest daily
view. HTML carries `noindex,nofollow` and should still remain behind
authentication or a VPN.

Deferred operations can take from several minutes to several hours. The
default timeout is three hours. A timeout retains the operation ID; rerunning on
the same Moscow date resumes polling without submitting another paid search.

## Wordstat discovery

Wordstat GetTop is synchronous and is used only for finding phrases with a
positive count. It does not measure the site's position and never edits the
keyword configuration automatically. Discovery runs each seed independently
for every configured region so nationwide demand is not mixed with Moscow or
Saint Petersburg:

```bash
python3 /opt/elegso-seo-monitor/seo_monitor.py discover \
  --config /var/lib/elegso-seo-admin/config/keywords.json \
  --db /var/lib/elegso-seo-monitor/history.sqlite3 \
  --site elegso.ru \
  --seed 'юрист по лизингу' \
  --num-phrases 100 \
  --format csv \
  --output /var/lib/elegso-seo-monitor/reports/wordstat-candidates.csv
```

If `--seed` is omitted, the site's `discovery_seeds` are used. Results and
associations with count zero are excluded. Repeated imports update the unique
same-day row rather than duplicate it.

Production discovery is persistent: the weekly enqueue timer records every
seed/region job in SQLite and the worker resumes it every 20 minutes. Physical
Wordstat calls are capped at 90 in any rolling hour, below Yandex's official
100-per-hour limit. A repeated enqueue or retry reuses completed snapshots and
does not duplicate rows or calls.

## Production installation on Debian

The following is an installation outline, not an automatic deployment script:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin seo-monitor
sudo install -d -o root -g root -m 0755 /opt/elegso-seo-monitor
sudo install -d -o root -g seo-monitor -m 0750 /etc/elegso-seo-monitor
sudo install -d -o seo-monitor -g seo-monitor -m 0750 /var/lib/elegso-seo-monitor
sudo install -o root -g root -m 0755 seo_monitor.py /opt/elegso-seo-monitor/
sudo install -d -o elegso-seo-admin -g seo-monitor -m 2750 /var/lib/elegso-seo-admin/config
sudo install -o elegso-seo-admin -g seo-monitor -m 0640 keywords.example.json /var/lib/elegso-seo-admin/config/keywords.json
sudo install -o root -g seo-monitor -m 0600 seo-monitor.env.example /etc/elegso-seo-monitor/seo-monitor.env
sudo install -o root -g root -m 0644 elegso-seo-monitor.service /etc/systemd/system/
sudo install -o root -g root -m 0644 elegso-seo-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

Fill the production environment file before enabling the timer:

```bash
sudo systemctl enable --now elegso-seo-monitor.timer
```

The
timer fires at 02:17 `Europe/Moscow`, with a small randomized delay, when the
deferred API tariff is lower. `Persistent=true` catches a missed run after VM
downtime.

Operational commands:

```bash
systemctl list-timers elegso-seo-monitor.timer
sudo systemctl start elegso-seo-monitor.service
sudo journalctl -u elegso-seo-monitor.service -n 100 --no-pager
```

The unit runs without privileges, locks concurrent executions, restricts its
filesystem and kernel access, and writes only to its systemd state directory.
A partial collection exits non-zero so monitoring can alert on API failures.

Back up the SQLite database with SQLite's online backup mechanism or while the
service is stopped. Keep the backup encrypted because query strategy and site
history are internal business data.

## Tests

Tests use mocked HTTP responses and a static XML fixture; they never call
Yandex:

```bash
python3 -m unittest tests/test_seo_monitor.py -v
```
