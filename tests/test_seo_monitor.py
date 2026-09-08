from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "ops" / "seo-monitor" / "seo_monitor.py"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "yandex_search_top100.xml"
SPEC = importlib.util.spec_from_file_location("elegso_seo_monitor", MODULE_PATH)
assert SPEC and SPEC.loader
monitor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = monitor
SPEC.loader.exec_module(monitor)


def write_config(
    directory: Path,
    two_sites: bool = False,
    regions: list[str] | None = None,
) -> Path:
    sites = [
        {
            "id": "elegso.ru",
            "name": "ЭЛЕГСО",
            "domains": ["elegso.ru", "www.elegso.ru"],
            "discovery_seeds": ["юрист по лизингу"],
            "keywords": [
                {
                    "query": "юрист по лизингу",
                    "cluster": "лизинг",
                    "target_url": "/leasing_lawyer/",
                }
            ],
        }
    ]
    if two_sites:
        sites.append(
            {
                "id": "office27-7.ru",
                "name": "Офис 27/7",
                "domains": ["office27-7.ru"],
                "keywords": [
                    {
                        "query": "ЮРИСТ   ПО ЛИЗИНГУ",
                        "cluster": "лизинг",
                        "target_url": "/services/leasing/",
                    }
                ],
            }
        )
    path = directory / "keywords.json"
    payload = {"schema_version": 1, "sites": sites}
    if regions is not None:
        payload["regions"] = regions
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


class QueueTransport:
    def __init__(self, responses: list[dict]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def request_json(self, method, url, headers, payload, timeout):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "payload": payload,
                "timeout": timeout,
            }
        )
        return self.responses.pop(0)


class ImmediateClient:
    def __init__(self, xml: bytes):
        self.xml = xml
        self.submissions: list[tuple[str, str, str]] = []

    def submit_search(self, query: str, device: str, region_id: str = "213") -> dict:
        self.submissions.append((query, device, region_id))
        return {
            "id": f"operation-{len(self.submissions)}",
            "done": True,
            "response": {"rawData": base64.b64encode(self.xml).decode("ascii")},
        }

    def get_operation(self, operation_id: str) -> dict:
        raise AssertionError("immediate operations must not be polled")


class WordstatClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str]] = []

    def wordstat_top(
        self, phrase: str, *, num_phrases: int, region_id: str = "213"
    ) -> dict:
        self.calls.append((phrase, num_phrases, region_id))
        return {
            "totalCount": "100",
            "results": [
                {"phrase": phrase, "count": "100"},
                {"phrase": "нулевой запрос", "count": "0"},
            ],
            "associations": [{"phrase": "лизинговый юрист", "count": "17"}],
        }


class RejectingClient:
    def submit_search(
        self, query: str, device: str, region_id: str = "213"
    ) -> dict:
        raise monitor.APIError("mocked API rejection")

    def get_operation(self, operation_id: str) -> dict:
        raise AssertionError("a rejected submission cannot be polled")


class SeoMonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.xml = FIXTURE_PATH.read_bytes()

    def test_history_database_uses_readonly_dashboard_compatible_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with monitor.Database(Path(temporary) / "history.sqlite3") as database:
                mode = database.connection.execute("PRAGMA journal_mode").fetchone()[0]
        self.assertEqual(mode, "delete")

    def test_namespaced_xml_preserves_organic_order(self) -> None:
        documents = monitor.parse_serp_xml(self.xml)
        self.assertEqual([document.position for document in documents], [1, 2, 3])
        self.assertEqual(documents[1].hostname, "www.elegso.ru")
        site = monitor.Site(
            "elegso.ru",
            "ЭЛЕГСО",
            frozenset({"elegso.ru", "www.elegso.ru"}),
            False,
            (),
            (),
        )
        self.assertEqual(monitor.find_site_rank(documents, site).position, 2)
        self.assertTrue(
            monitor.target_url_matches(
                documents[1].url, "/leasing_lawyer/"
            )
        )

    def test_async_request_uses_official_top100_moscow_parameters(self) -> None:
        encoded = base64.b64encode(self.xml).decode("ascii")
        transport = QueueTransport(
            [
                {"id": "op-123", "done": False},
                {
                    "id": "op-123",
                    "done": True,
                    "response": {"rawData": encoded},
                },
            ]
        )
        client = monitor.YandexSearchClient(
            monitor.Credentials("folder-123", "Api-Key secret-not-logged"),
            "155.212.215.203",
            transport=transport,
            sleep=lambda _seconds: None,
            monotonic=lambda: 100.0,
        )
        operation = client.submit_search("юрист по лизингу", "mobile")
        self.assertFalse(operation["done"])
        request = transport.calls[0]
        self.assertEqual(request["url"], monitor.SEARCH_ASYNC_URL)
        self.assertEqual(request["payload"]["region"], "213")
        self.assertEqual(request["payload"]["groupSpec"]["groupMode"], "GROUP_MODE_FLAT")
        self.assertEqual(request["payload"]["groupSpec"]["groupsOnPage"], "100")
        self.assertEqual(request["payload"]["groupSpec"]["docsInGroup"], "1")
        self.assertEqual(request["payload"]["responseFormat"], "FORMAT_XML")
        self.assertEqual(request["payload"]["period"], "PERIOD_ALL_TIME")
        self.assertIn("Mobile", request["payload"]["userAgent"])
        self.assertEqual(
            request["payload"]["metadata"]["fields"]["X-Forwarded-For-Y"],
            "155.212.215.203",
        )
        completed = client.get_operation("op-123")
        documents = monitor.operation_documents(completed)
        self.assertEqual(len(documents), 3)
        self.assertNotIn("secret-not-logged", json.dumps(request["payload"]))

    def test_configured_regions_create_independent_search_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = monitor.load_config(
                write_config(Path(temporary), regions=["225", "213", "2"])
            )
        tasks = monitor.build_tasks(config)
        self.assertEqual(len(tasks), 6)
        self.assertEqual({task.region_id for task in tasks}, {"225", "213", "2"})

        transport = QueueTransport([
            {"id": "ru", "done": False},
            {"id": "msk", "done": False},
            {"id": "spb", "done": False},
        ])
        client = monitor.YandexSearchClient(
            monitor.Credentials(None, "Api-Key secret-not-logged"),
            "155.212.215.203",
            transport=transport,
            sleep=lambda _seconds: None,
            monotonic=lambda: 100.0,
        )
        for region_id in ("225", "213", "2"):
            client.submit_search("юрист по лизингу", "desktop", region_id)
        self.assertNotIn("metadata", transport.calls[0]["payload"])
        self.assertEqual(
            transport.calls[1]["payload"]["metadata"]["fields"]["X-Forwarded-For-Y"],
            "155.212.215.203",
        )
        self.assertNotIn("metadata", transport.calls[2]["payload"])

    def test_service_account_api_key_can_infer_folder(self) -> None:
        credentials = monitor.load_credentials({
            "YANDEX_SEARCH_API_KEY": "secret-not-logged",
            "YANDEX_FOLDER_ID": "",
            "YANDEX_IAM_TOKEN": "",
        })
        transport = QueueTransport([{"id": "op-123", "done": False}])
        client = monitor.YandexSearchClient(
            credentials,
            "155.212.215.203",
            transport=transport,
            sleep=lambda _seconds: None,
            monotonic=lambda: 100.0,
        )
        client.submit_search("юрист по лизингу", "desktop")
        self.assertIsNone(credentials.folder_id)
        self.assertNotIn("folderId", transport.calls[0]["payload"])

        wordstat_transport = QueueTransport([{"results": [], "associations": []}])
        wordstat_client = monitor.YandexSearchClient(
            credentials,
            "155.212.215.203",
            transport=wordstat_transport,
            sleep=lambda _seconds: None,
            monotonic=lambda: 100.0,
        )
        wordstat_client.wordstat_top(
            "юрист по лизингу", num_phrases=100, region_id="225"
        )
        self.assertNotIn("folderId", wordstat_transport.calls[0]["payload"])

    def test_folder_id_is_sent_to_search_and_wordstat(self) -> None:
        transport = QueueTransport([
            {"id": "op-1", "done": False},
            {"results": [], "associations": []},
        ])
        client = monitor.YandexSearchClient(
            monitor.Credentials("folder-123", "Api-Key secret-not-logged"),
            "155.212.215.203",
            transport=transport,
            sleep=lambda _seconds: None,
            monotonic=lambda: 100.0,
        )
        client.submit_search("юрист по лизингу", "desktop", "225")
        client.wordstat_top("юрист по лизингу", num_phrases=100, region_id="2")
        self.assertEqual(transport.calls[0]["payload"]["folderId"], "folder-123")
        self.assertEqual(transport.calls[1]["payload"]["folderId"], "folder-123")

    def test_iam_token_still_requires_folder(self) -> None:
        with self.assertRaisesRegex(monitor.ConfigError, "YANDEX_FOLDER_ID"):
            monitor.load_credentials({
                "YANDEX_SEARCH_API_KEY": "",
                "YANDEX_FOLDER_ID": "",
                "YANDEX_IAM_TOKEN": "short-lived-token",
            })

    def test_shared_queries_and_same_day_rerun_do_not_duplicate_or_resubmit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = monitor.load_config(write_config(root, two_sites=True))
            tasks = monitor.build_tasks(config)
            self.assertEqual(len(tasks), 2)
            self.assertTrue(all(len(task.plans) == 2 for task in tasks))

            client = ImmediateClient(self.xml)
            with monitor.Database(root / "history.sqlite3") as database:
                first = monitor.collect_rankings(
                    config, database, client, date(2026, 9, 8)
                )
                second = monitor.collect_rankings(
                    config, database, client, date(2026, 9, 8)
                )
                snapshot_count = database.connection.execute(
                    "SELECT COUNT(*) FROM rank_snapshots"
                ).fetchone()[0]
                job_count = database.connection.execute(
                    "SELECT COUNT(*) FROM search_jobs"
                ).fetchone()[0]
                positions = database.connection.execute(
                    "SELECT site_id, device, position FROM rank_snapshots "
                    "ORDER BY site_id, device"
                ).fetchall()
            self.assertEqual(first["submitted_tasks"], 2)
            self.assertEqual(second["submitted_tasks"], 0)
            self.assertEqual(second["reused_tasks"], 2)
            self.assertEqual(len(client.submissions), 2)
            self.assertEqual(job_count, 2)
            self.assertEqual(snapshot_count, 4)
            self.assertEqual(
                [(row["site_id"], row["position"]) for row in positions],
                [
                    ("elegso.ru", 2),
                    ("elegso.ru", 2),
                    ("office27-7.ru", 3),
                    ("office27-7.ru", 3),
                ],
            )

    def test_wordstat_keeps_only_positive_rows_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = monitor.load_config(write_config(root))
            with monitor.Database(root / "history.sqlite3") as database:
                for _ in range(2):
                    result = monitor.discover_wordstat(
                        config,
                        database,
                        WordstatClient(),
                        date(2026, 9, 8),
                        "elegso.ru",
                        [],
                        100,
                    )
                stored = database.connection.execute(
                    "SELECT phrase, count FROM wordstat_snapshots ORDER BY count DESC"
                ).fetchall()
            self.assertEqual(result["status"], "completed")
            self.assertEqual([(row["phrase"], row["count"]) for row in stored], [
                ("юрист по лизингу", 100),
                ("лизинговый юрист", 17),
            ])

    def test_wordstat_queue_is_region_isolated_and_hourly_limited(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = monitor.load_config(
                write_config(root, regions=["225", "213", "2"])
            )
            current = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)
            client = WordstatClient()
            with monitor.Database(root / "history.sqlite3") as database:
                first = monitor.discover_wordstat(
                    config,
                    database,
                    client,
                    date(2026, 9, 8),
                    "elegso.ru",
                    [],
                    100,
                    hourly_limit=2,
                    batch_size=90,
                    now=lambda: current,
                )
                second = monitor.process_wordstat_queue(
                    config,
                    database,
                    client,
                    date(2026, 9, 8),
                    hourly_limit=2,
                    batch_size=90,
                    now=lambda: current,
                )
                current += timedelta(hours=1, minutes=2)
                third = monitor.process_wordstat_queue(
                    config,
                    database,
                    client,
                    date(2026, 9, 8),
                    hourly_limit=2,
                    batch_size=90,
                    now=lambda: current,
                )
                stored_regions = {
                    row[0]
                    for row in database.connection.execute(
                        "SELECT DISTINCT region_id FROM wordstat_snapshots"
                    )
                }
                queue = database.wordstat_queue_summary()
            self.assertEqual(first["attempted"], 2)
            self.assertTrue(first["throttled"])
            self.assertEqual(second["attempted"], 0)
            self.assertTrue(second["throttled"])
            self.assertEqual(third["attempted"], 1)
            self.assertEqual(queue["pending"], 0)
            self.assertEqual(stored_regions, {"225", "213", "2"})
            self.assertEqual(len(client.calls), 3)

    def test_current_run_counts_ignore_removed_same_day_regions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = write_config(root, regions=["225", "213", "2"])
            wide = monitor.load_config(config_path)
            client = ImmediateClient(self.xml)
            with monitor.Database(root / "history.sqlite3") as database:
                first = monitor.collect_rankings(
                    wide, database, client, date(2026, 9, 8)
                )
                narrow = monitor.load_config(
                    write_config(root, regions=["213"])
                )
                second = monitor.collect_rankings(
                    narrow, database, client, date(2026, 9, 8)
                )
            self.assertEqual(first["status"], "completed")
            self.assertEqual(second["status"], "completed")
            self.assertEqual(second["planned_observations"], 2)
            self.assertEqual(second["found"], 2)

    def test_api_failure_is_not_recorded_as_not_found(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = monitor.load_config(write_config(root))
            with monitor.Database(root / "history.sqlite3") as database:
                result = monitor.collect_rankings(
                    config, database, RejectingClient(), date(2026, 9, 8)
                )
                statuses = database.connection.execute(
                    "SELECT DISTINCT status FROM rank_snapshots"
                ).fetchall()
                job_states = database.connection.execute(
                    "SELECT DISTINCT state FROM search_jobs"
                ).fetchall()
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["errors"], 2)
            self.assertEqual([row["status"] for row in statuses], ["error"])
            self.assertEqual([row["state"] for row in job_states], ["error"])

    def test_reports_are_atomic_and_available_without_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = write_config(root)
            config = monitor.load_config(config_path)
            client = ImmediateClient(self.xml)
            database_path = root / "history.sqlite3"
            report_dir = root / "reports"
            with monitor.Database(database_path) as database:
                monitor.collect_rankings(config, database, client, date(2026, 9, 1))
                monitor.collect_rankings(config, database, client, date(2026, 9, 8))
                paths = monitor.write_reports(database, report_dir, date(2026, 9, 8))
                report = monitor.build_report(database, date(2026, 9, 8), 7)
            self.assertEqual(len(paths), 10)
            self.assertTrue((report_dir / "rank-today.json").exists())
            self.assertTrue((report_dir / "rank-7d.csv").exists())
            self.assertTrue((report_dir / "rank-30d.html").exists())
            self.assertIn("noindex,nofollow", (report_dir / "index.html").read_text())
            self.assertEqual(report["summary"]["unchanged"], 2)

            with mock.patch.dict(os.environ, {}, clear=True):
                payload = monitor.status_payload(config_path, database_path)
            self.assertFalse(payload["credentials"]["valid_shape"])
            self.assertEqual(payload["latest_snapshot_date"], "2026-09-08")

    def test_missing_key_fails_before_database_or_network(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = write_config(root)
            database_path = root / "should-not-exist.sqlite3"
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(stderr):
                exit_code = monitor.main(
                    [
                        "run",
                        "--config",
                        str(config_path),
                        "--db",
                        str(database_path),
                        "--report-dir",
                        str(root / "reports"),
                    ]
                )
            self.assertEqual(exit_code, 78)
            self.assertFalse(database_path.exists())
            self.assertIn("YANDEX_SEARCH_API_KEY", stderr.getvalue())

    def test_status_command_works_without_key_and_without_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = write_config(root)
            output = io.StringIO()
            with mock.patch.dict(os.environ, {}, clear=True), redirect_stdout(output):
                exit_code = monitor.main(
                    [
                        "status",
                        "--config",
                        str(config_path),
                        "--db",
                        str(root / "absent.sqlite3"),
                    ]
                )
            self.assertEqual(exit_code, 0)
            self.assertIn("Credentials configured: no", output.getvalue())


if __name__ == "__main__":
    unittest.main()
