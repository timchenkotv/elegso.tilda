import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ops" / "seo-admin" / "traffic_aggregate.py"
MONITOR_DIR = ROOT / "ops" / "seo-monitor"
MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
]


def nginx_time(value: datetime) -> str:
    return (
        f"{value.day:02d}/{MONTHS[value.month - 1]}/{value.year:04d}:"
        f"{value.hour:02d}:{value.minute:02d}:{value.second:02d} +0000"
    )


class SeoTrafficTests(unittest.TestCase):
    def test_retention_is_enforced_and_raw_identity_data_is_not_stored(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "analytics.sqlite3"
            log = root / "access.log"
            now = datetime.now(timezone.utc).replace(microsecond=0)
            old = now - timedelta(days=401)
            ip = "203.0.113.77"
            user_agent = "PrivateBrowserIdentity/987654"
            log.write_text(
                "\n".join(
                    [
                        f'{ip} - - [{nginx_time(old)}] "GET /old-page/ HTTP/1.1" 200 123 "-" "{user_agent}"',
                        f'{ip} - - [{nginx_time(now)}] "GET /leasing_lawyer/ HTTP/1.1" 200 456 "https://yandex.ru/" "{user_agent}"',
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            environment = {
                **os.environ,
                "SEO_MONITOR_PROGRAM_DIR": str(MONITOR_DIR),
            }

            first = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--logs",
                    str(log),
                    "--db",
                    str(database),
                    "--retention-days",
                    "1000",
                ],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--logs",
                    str(log),
                    "--db",
                    str(database),
                    "--retention-days",
                    "400",
                ],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, second.stderr)

            with closing(sqlite3.connect(database)) as connection:
                dates = [
                    row[0]
                    for row in connection.execute(
                        "SELECT observed_date FROM traffic_daily ORDER BY observed_date"
                    )
                ]
                pages = [
                    row[0]
                    for row in connection.execute(
                        "SELECT path FROM traffic_pages ORDER BY path"
                    )
                ]
            self.assertEqual(dates, [now.date().isoformat()])
            self.assertEqual(pages, ["/leasing_lawyer/"])
            raw_database = database.read_bytes()
            self.assertNotIn(ip.encode(), raw_database)
            self.assertNotIn(user_agent.encode(), raw_database)


if __name__ == "__main__":
    unittest.main()
