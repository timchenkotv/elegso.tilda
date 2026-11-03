import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("illustration_publisher", Path(__file__).resolve().parents[1] / "ops/case-publisher/publish.py")
publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = publisher
spec.loader.exec_module(publisher)


class IllustrationTests(unittest.TestCase):
    def case(self):
        data = b"RIFF0000WEBPoriginal-not-reencoded"
        return {"public_slug": "example", "illustration": {
            "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data),
            "content_type": "image/webp", "illustration_alt": '<script>not markup</script>',
            "content_url": "/api/v1/public/legal-case-announcements/example/illustration?v=sha",
        }}, data

    def test_render_local_small_image_without_resizing_original(self):
        case, _ = self.case()
        rendered = publisher.render_illustration(case)
        self.assertIn("case-illustration", rendered)
        self.assertIn("/cases/example/illustration-", rendered)
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("srcset", rendered)
        self.assertEqual(publisher.render_illustration({}), "")

    def test_exact_original_reused_by_sha(self):
        case, data = self.case()
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / "previous"
            source = previous / "cases/example"
            source.mkdir(parents=True)
            name = publisher.illustration_filename(case)
            (source / name).write_bytes(data)
            target = Path(tmp) / "next"
            target.mkdir()
            with patch.object(publisher.urllib.request, "urlopen") as request:
                publisher.download_illustration(case, publisher.DEFAULT_API_BASE, target, previous)
                request.assert_not_called()
            self.assertEqual((target / name).read_bytes(), data)

    def test_corruption_and_external_url_fail_closed(self):
        case, data = self.case()
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / "previous"
            source = previous / "cases/example"
            source.mkdir(parents=True)
            (source / publisher.illustration_filename(case)).write_bytes(data + b"changed")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                publisher.download_illustration(case, publisher.DEFAULT_API_BASE, Path(tmp), previous)
            case["illustration"]["content_url"] = "https://example.org/secret"
            with self.assertRaisesRegex(ValueError, "outside"):
                publisher.download_illustration(case, publisher.DEFAULT_API_BASE, Path(tmp))


if __name__ == "__main__":
    unittest.main()
