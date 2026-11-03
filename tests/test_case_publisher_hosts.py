import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("case_hosts", Path(__file__).resolve().parents[1] / "ops/case-publisher/configure-hosts.py")
hosts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosts)


class PublisherHostsTests(unittest.TestCase):
    def test_preserves_entries_and_is_idempotent(self):
        source = "127.0.0.1 localhost\n172.16.8.40 tilda-sites\n"
        mapping = "172.16.8.1 law.elegso.ru\n"
        updated = hosts.configured_hosts(source, mapping)
        self.assertIn(source.strip(), updated)
        self.assertEqual(updated, hosts.configured_hosts(updated, mapping))

    def test_refuses_unmanaged_conflict_and_other_hosts(self):
        with self.assertRaises(ValueError):
            hosts.configured_hosts("10.0.0.2 law.elegso.ru\n", "172.16.8.1 law.elegso.ru")
        with self.assertRaises(ValueError):
            hosts.configured_hosts("127.0.0.1 localhost\n", "172.16.8.1 example.org")


if __name__ == "__main__":
    unittest.main()
