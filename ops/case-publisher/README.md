# Public case publisher

`publish.py` reads only the anonymous public API of INELSIBI.PRAVO. Drafts,
unreviewed announcements and unpublished material nodes cannot enter the site
because the source API does not return them.

The publisher renders `/cases/`, one static page per case and a combined
`sitemap.xml`. Each build is written to a content-addressed release directory;
the `current` symlink is switched only after every page has been generated.
The previous release therefore remains live if the API or rendering fails.

Published PDF and raster-image materials keep their folder hierarchy and are
shown in one lazy-loaded carousel. Only the active document is requested from
the source API; visitors can move between files, open the original or download
it.

Production paths:

- source template: `/srv/www/elegso.ru/current/www`;
- generated releases: `/srv/www/elegso.ru/generated/releases`;
- active generated release: `/srv/www/elegso.ru/generated/current`;
- source API: `https://law.elegso.ru/api/v1/public/legal-case-announcements`.

Manual refresh:

```bash
sudo systemctl start elegso-case-publisher.service
sudo journalctl -u elegso-case-publisher.service -n 100 --no-pager
```
