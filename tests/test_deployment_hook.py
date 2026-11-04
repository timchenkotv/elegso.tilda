"""Static deployment ordering and sandboxed projection-rollback tests.

The production hook is never executed. Only its rollback/staging functions are
copied into a temporary script; every sudo operation is handled by a narrow
filesystem stub, and no server, service manager or Git remote is contacted.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "ops/hooks/post-receive"
SOURCE = HOOK.read_text(encoding="utf-8")
PREFIX = SOURCE[: SOURCE.index("trap rollback_deployment EXIT")]


class DeploymentHookTests(unittest.TestCase):
    def test_shell_syntax_and_safe_deployment_order(self):
        for shell in ["sh", "bash"]:
            binary = shutil.which(shell)
            if binary:
                subprocess.run([binary, "-n", str(HOOK)], check=True, capture_output=True, text=True)
        stop = SOURCE.index("systemctl stop elegso-case-publisher.timer")
        wait = SOURCE.index('case_service_state=$(sudo /bin/systemctl show')
        install = SOURCE.index('"$publisher/publish.py"\n')
        self.assertLess(stop, wait)
        self.assertLess(wait, install)
        generation = SOURCE.index('--source-root "$release/www"')
        legal_generation = SOURCE.index('--source "$release" --output "$legal_stage" --force')
        nginx_check = SOURCE.index("if ! sudo /usr/sbin/nginx -t")
        frontend_switch = SOURCE.index('mv -Tf "$site/current.new" "$site/current"')
        legal_switch = SOURCE.index('mv -Tf "$site/generated-legal/current.new" "$site/generated-legal/current"')
        case_switch = SOURCE.index('mv -Tf "$site/generated/current.new" "$site/generated/current"')
        self.assertLess(nginx_check, generation)
        self.assertLess(generation, frontend_switch)
        self.assertLess(legal_generation, frontend_switch)
        self.assertLess(frontend_switch, legal_switch)
        self.assertLess(legal_switch, case_switch)
        self.assertEqual(SOURCE.count('--source-root "$release/www"'), 1)
        self.assertIn('/usr/bin/flock 9', SOURCE)
        self.assertNotIn('/usr/bin/flock -w 180 9', SOURCE)
        self.assertIn('merge-base --is-ancestor "$old" "$new"', SOURCE)
        self.assertEqual(SOURCE.count('rev-parse refs/heads/main'), 2)
        last_ref_check = SOURCE.rindex('rev-parse refs/heads/main')
        self.assertLess(generation, last_ref_check)
        self.assertLess(last_ref_check, frontend_switch)
        self.assertNotIn("push --force", SOURCE)
        self.assertIn('git --git-dir="$repo" push origin refs/heads/main:refs/heads/main', SOURCE)
        for flag in ["frontend_changed=0", "cases_changed=0", "legal_changed=0", "case_publisher_changed=0"]:
            self.assertLess(case_switch, SOURCE.index(flag, frontend_switch))
        self.assertIn('case_projection_rollback="$site/generated/.deploy-rollback-', SOURCE)
        self.assertIn('--output-root "$cases_stage"', SOURCE)
        self.assertNotIn('--output-root "$site/generated"', SOURCE)
        self.assertIn('"$legal_previous" "$legal_stage/current"', SOURCE)
        self.assertIn('"$cases_previous" "$cases_stage/current"', SOURCE)
        self.assertIn('LEGAL_SITEMAP_MANIFEST=$case_legal_manifest', SOURCE)
        self.assertIn('case_legal_manifest="$legal_candidate/sitemap-legal.json"', SOURCE)
        self.assertNotIn('--allow-empty-fallback', SOURCE)
        self.assertIn('Case staging failed; all public projections remain unchanged', SOURCE)

    def test_no_public_projection_is_armed_during_staging(self):
        # Marker positions are guarded as well as command ordering: a failed
        # private build must not remove or restore an untouched public link.
        start = SOURCE.index('while read -r old new ref')
        frontend = SOURCE.index('    frontend_changed=1', start)
        self.assertNotIn('    legal_changed=1', SOURCE[start:frontend])
        self.assertNotIn('    cases_changed=1', SOURCE[start:frontend])
        self.assertIn('    cleanup_staging\n    legal_stage=\n    cases_stage=', SOURCE[frontend:])

    def sandbox(self, base: Path, *, fail_frontend_move: bool = False):
        base = base.resolve()
        site = base / "site"
        publisher = base / "publisher"
        units = base / "units"
        for directory in [site / "generated/releases", site / "generated-legal/releases", publisher / "backup", units, base / "bin"]:
            directory.mkdir(parents=True, exist_ok=True)
        paths = {
            "frontend_old": site / "old", "frontend_new": site / "new",
            "cases_old": site / "generated/releases/old", "cases_new": site / "generated/releases/new",
            "legal_old": site / "generated-legal/releases/old", "legal_new": site / "generated-legal/releases/new",
            "projection_backup": site / "generated/.deploy-rollback-test",
        }
        for key in ["frontend_old", "frontend_new", "cases_new", "legal_old", "legal_new"]:
            paths[key].mkdir()
        (paths["projection_backup"] / "cases-previous").mkdir(parents=True)
        (paths["projection_backup"] / "cases-previous/index.html").write_text("old case projection", encoding="utf-8")
        (site / "current").symlink_to(paths["frontend_new"])
        (site / "generated/current").symlink_to(paths["cases_new"])
        (site / "generated-legal/current").symlink_to(paths["legal_new"])
        (publisher / "publish.py").write_text("new publisher", encoding="utf-8")
        (publisher / "backup/publish.py").write_text("old publisher", encoding="utf-8")
        for name in ["elegso-case-publisher.service", "elegso-case-publisher.timer"]:
            (units / name).write_text("new unit", encoding="utf-8")
            (publisher / "backup" / name).write_text("old unit", encoding="utf-8")

        stub = base / "bin/sudo"
        stub.write_text(
            f"#!{sys.executable}\n" + r'''
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ["DEPLOY_TEST_ROOT"]).resolve()
args = sys.argv[1:]
with (root / "operations.jsonl").open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
command = Path(args[0]).name
values = [value for value in args[1:] if not value.startswith("-")]
if command == "systemctl":
    sys.exit(0)
for value in values:
    candidate = Path(value)
    if not candidate.is_absolute() or root not in candidate.absolute().parents:
        raise SystemExit("Refused out-of-sandbox path: " + value)
if command == "test":
    target = Path(values[-1])
    sys.exit(0 if (target.is_dir() if "-d" in args else target.is_file()) else 1)
if command == "ln":
    source, target = map(Path, values)
    if target.is_symlink() or target.exists(): target.unlink()
    target.symlink_to(source)
elif command == "mv":
    source, target = map(Path, values)
    if os.environ.get("FAIL_FRONTEND_MOVE") == "1" and str(target) == str(root / "site/current"):
        sys.exit(42)
    source.replace(target)
elif command == "cp":
    source, target = map(Path, values)
    shutil.copy2(source, target)
elif command == "rm":
    for value in values:
        target = Path(value)
        if target.is_symlink() or target.is_file(): target.unlink()
        elif target.is_dir(): shutil.rmtree(target)
else:
    raise SystemExit("Unsupported sudo command: " + command)
''',
            encoding="utf-8",
        )
        stub.chmod(0o755)
        prefix = PREFIX.replace("site=/srv/www/elegso.ru", f"site='{site}'")
        prefix = prefix.replace("publisher=/opt/elegso-case-publisher", f"publisher='{publisher}'")
        prefix = prefix.replace("/etc/systemd/system/", str(units) + "/")
        script = prefix + "\ntrap rollback_deployment EXIT\n" + "\n".join([
            "frontend_changed=1", f"frontend_previous='{paths['frontend_old']}'",
            "cases_changed=1", f"cases_previous='{paths['cases_old']}'",
            "legal_changed=1", f"legal_previous='{paths['legal_old']}'",
            "case_publisher_changed=1", f"case_publisher_rollback='{publisher / 'backup'}'",
            f"case_projection_rollback='{paths['projection_backup']}'",
            "case_timer_stopped=1", "case_timer_was_active=1",
            "legal_timer_stopped=1", "legal_timer_was_active=1",
        ])
        environment = {**os.environ, "PATH": str(base / "bin") + os.pathsep + os.defpath, "DEPLOY_TEST_ROOT": str(base), "FAIL_FRONTEND_MOVE": "1" if fail_frontend_move else "0"}
        return script, environment, paths, publisher, units

    def run_rollback(self, base: Path, script: str, environment: dict):
        self.assertNotIn("while read -r old new ref", script)
        test_script = base / "rollback-test.sh"
        test_script.write_text(script, encoding="utf-8")
        result = subprocess.run(["/bin/sh", str(test_script)], env=environment, capture_output=True, text=True)
        log = base / "operations.jsonl"
        operations = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
        return result, operations

    def test_failure_restores_frontend_cases_legal_program_units_and_active_timers(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            script, env, paths, publisher, units = self.sandbox(base)
            result, operations = self.run_rollback(base, script + "\nexit 7\n", env)
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertEqual((base / "site/current").resolve(), paths["frontend_old"])
            self.assertEqual((base / "site/generated/current").resolve(), paths["cases_old"])
            self.assertEqual((paths["cases_old"] / "index.html").read_text(), "old case projection")
            self.assertEqual((base / "site/generated-legal/current").resolve(), paths["legal_old"])
            self.assertEqual((publisher / "publish.py").read_text(), "old publisher")
            self.assertEqual((units / "elegso-case-publisher.service").read_text(), "old unit")
            self.assertEqual((units / "elegso-case-publisher.timer").read_text(), "old unit")
            reload_at = next(i for i, row in enumerate(operations) if row == ["/bin/systemctl", "daemon-reload"])
            case_start = operations.index(["/bin/systemctl", "start", "elegso-case-publisher.timer"])
            legal_start = operations.index(["/bin/systemctl", "start", "elegso-legal-publisher.timer"])
            self.assertLess(reload_at, case_start)
            self.assertLess(reload_at, legal_start)
            moves = [row[-1] for row in operations if Path(row[0]).name == "mv"]
            frontend_restore = moves.index(str(base.resolve() / "site/current"))
            self.assertLess(moves.index(str(base.resolve() / "site/generated/current")), frontend_restore)
            self.assertLess(moves.index(str(base.resolve() / "site/generated-legal/current")), frontend_restore)

    def test_failed_pointer_restore_does_not_skip_other_restores_or_timers(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            script, env, paths, publisher, _ = self.sandbox(base, fail_frontend_move=True)
            result, operations = self.run_rollback(base, script + "\nexit 8\n", env)
            self.assertEqual(result.returncode, 8)
            self.assertEqual((base / "site/current").resolve(), paths["frontend_new"])
            self.assertEqual((base / "site/generated/current").resolve(), paths["cases_old"])
            self.assertEqual((publisher / "publish.py").read_text(), "old publisher")
            self.assertIn(["/bin/systemctl", "start", "elegso-case-publisher.timer"], operations)

    def test_failure_after_commit_does_not_roll_back_published_site(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            script, env, paths, publisher, _ = self.sandbox(base)
            script += "\nfrontend_changed=0\ncases_changed=0\nlegal_changed=0\ncase_publisher_changed=0\ncase_timer_stopped=0\nlegal_timer_stopped=0\nexit 9\n"
            result, operations = self.run_rollback(base, script, env)
            self.assertEqual(result.returncode, 9)
            self.assertEqual((base / "site/current").resolve(), paths["frontend_new"])
            self.assertEqual((base / "site/generated/current").resolve(), paths["cases_new"])
            self.assertEqual((publisher / "publish.py").read_text(), "new publisher")
            self.assertEqual(operations, [])

    def test_first_install_failure_restores_previous_absence(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            script, env, _, publisher, units = self.sandbox(base)
            for saved in (publisher / "backup").iterdir():
                saved.unlink()
            script += "\nfrontend_previous=\ncases_previous=\nlegal_previous=\ncase_timer_was_active=0\nlegal_timer_was_active=0\nexit 10\n"
            result, operations = self.run_rollback(base, script, env)
            self.assertEqual(result.returncode, 10, result.stderr)
            for pointer in [base / "site/current", base / "site/generated/current", base / "site/generated-legal/current"]:
                self.assertFalse(pointer.is_symlink())
            self.assertFalse((publisher / "publish.py").exists())
            self.assertFalse((units / "elegso-case-publisher.service").exists())
            self.assertFalse((units / "elegso-case-publisher.timer").exists())
            self.assertFalse(any(row[:2] == ["/bin/systemctl", "start"] for row in operations))

    def test_early_staging_failure_preserves_public_links_and_cleans_stages(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            script, env, paths, publisher, _ = self.sandbox(base)
            legal_stage = base / "site/generated-legal/.deploy-stage-test"
            cases_stage = base / "site/generated/.deploy-stage-test"
            for stage in [legal_stage, cases_stage]:
                stage.mkdir()
                (stage / "candidate.txt").write_text("private candidate", encoding="utf-8")
            script += "\n" + "\n".join([
                "frontend_changed=0", "cases_changed=0", "legal_changed=0",
                f"legal_stage='{legal_stage}'", f"cases_stage='{cases_stage}'", "exit 11", "",
            ])
            result, operations = self.run_rollback(base, script, env)
            self.assertEqual(result.returncode, 11, result.stderr)
            self.assertEqual((base / "site/current").resolve(), paths["frontend_new"])
            self.assertEqual((base / "site/generated/current").resolve(), paths["cases_new"])
            self.assertEqual((base / "site/generated-legal/current").resolve(), paths["legal_new"])
            self.assertEqual((publisher / "publish.py").read_text(), "old publisher")
            self.assertFalse(legal_stage.exists())
            self.assertFalse(cases_stage.exists())
            self.assertIn(["/bin/systemctl", "start", "elegso-case-publisher.timer"], operations)
            self.assertIn(["/bin/systemctl", "start", "elegso-legal-publisher.timer"], operations)
            self.assertFalse(any(Path(row[0]).name in {"ln", "mv"} for row in operations))

    def test_private_case_staging_reuses_original_without_changing_live_pointer(self):
        from tests.test_case_carousel_feed import Response, case, illustrate, publisher, source_tree

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            source = source_tree(base)
            output = base / "generated"
            record = case()
            original = illustrate(record)
            with patch.object(publisher.urllib.request, "urlopen", side_effect=lambda req, timeout: Response(req.full_url, original)):
                _, previous = publisher.write_release(source, output, [record], publisher.DEFAULT_API_BASE)
            # Runtime retention must not reach the real namespace while the
            # private output's current link is seeded outside its releases.
            retained = []
            for number in range(5):
                folder = output / "releases" / f"previous-{number}"
                folder.mkdir()
                retained.append(folder)
            stage = output / ".deploy-stage-test"
            stage.mkdir()
            (stage / "current").symlink_to(previous)
            with patch.object(publisher.urllib.request, "urlopen", side_effect=AssertionError("Staging must reuse the exact cached ERP original")) as download:
                changed, candidate = publisher.write_release(source, stage, [record], publisher.DEFAULT_API_BASE)
                download.assert_not_called()
            self.assertTrue(changed)
            self.assertEqual((output / "current").resolve(), previous)
            self.assertEqual((stage / "current").resolve(), candidate)
            self.assertEqual(candidate.parent, stage / "releases")
            self.assertTrue((candidate / "cases/carousel.json").is_file())
            filename = publisher.illustration_filename(record)
            self.assertEqual((candidate / "cases/example-1" / filename).read_bytes(), original)
            self.assertTrue(all(folder.is_dir() for folder in retained))

    def test_same_digest_noop_external_seed_is_accepted_only_for_complete_previous(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            previous = base / "generated/releases/same-digest"
            stage = base / "generated/.deploy-stage-repeat"
            other = base / "generated/releases/unrelated"
            for candidate in [previous, other]:
                (candidate / "cases").mkdir(parents=True)
                (candidate / "cases/index.html").write_text("complete catalogue", encoding="utf-8")
                (candidate / "cases/carousel.json").write_text('{"version":1,"items":[]}', encoding="utf-8")
                (candidate / "manifest.json").write_text('{"content_digest":"same-digest","case_count":0,"slugs":[]}', encoding="utf-8")
            stage.mkdir()
            # An unchanged publisher returns success without replacing this
            # external seed link or creating any private release directory.
            (stage / "current").symlink_to(previous)
            (base / "generated/current").symlink_to(previous)

            def validate(candidate):
                script = PREFIX + "\n" + "\n".join([
                    f"cases_stage='{stage}'", f"cases_previous='{previous}'",
                    f"validate_case_candidate '{candidate}'", "",
                ])
                return subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True).returncode

            self.assertEqual(validate((stage / "current").resolve()), 0)
            self.assertEqual((base / "generated/current").resolve(), previous)
            self.assertEqual((stage / "current").resolve(), previous)
            self.assertFalse((stage / "releases").exists())
            self.assertNotEqual(validate(other), 0, "Unrelated external release must not be accepted")
            (previous / "cases/carousel.json").unlink()
            self.assertNotEqual(validate(previous), 0, "Previous catalogue without feed must not be accepted")
            (previous / "cases/carousel.json").write_text('{"version":1,"items":[]}', encoding="utf-8")
            (previous / "manifest.json").unlink()
            self.assertNotEqual(validate(previous), 0, "Previous catalogue without manifest must not be accepted")

            promotion = SOURCE[SOURCE.index('    if [ -n "$cases_candidate" ]; then'):SOURCE.index('    # Assets become available first;')]
            self.assertIn('if [ "$cases_candidate" = "$cases_previous" ]; then', promotion)
            self.assertIn('cases_ready=$cases_previous', promotion)
            self.assertLess(promotion.index('if [ "$cases_candidate" = "$cases_ready" ]; then'), promotion.index('sudo /bin/mv -T "$cases_candidate" "$cases_ready"'))


if __name__ == "__main__":
    unittest.main()
