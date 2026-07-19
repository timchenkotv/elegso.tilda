#!/bin/sh
set -eu
umask 077

dest=/var/backups/elegso/postgresql
install -d -o root -g postgres -m 750 /var/backups/elegso
install -d -o postgres -g postgres -m 700 "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
runuser -u postgres -- pg_dump --format=custom --file="$dest/elegso_calc-$stamp.dump" elegso_calc
find "$dest" -type f -name 'elegso_calc-*.dump' -mtime +30 -delete
