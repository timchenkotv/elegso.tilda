#!/usr/bin/env python3
"""Private SQLite source -> validated, atomic, static legal-site projection.

Run as the restricted publisher, never from a request handler. All executable
paths and output routes are deployment-owned, not supplied by an editor.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from legal_documents import Store, canonical, digest

ORIGIN = "https://elegso.ru"
WORKER = "legal-publisher"
ROUTES = {"oferta", "oferta-fiz", "soglashenie", "consent", "cookies", "documents", "offer_for_lawyer_20231103"}
ASSETS = ["offers.css", "offers.js", "legal-pages.css", "site-privacy.css", "site-privacy.js", "site-fonts.css"]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def legacy_fields(source):
    """Editable text islands retain the original Tilda structure verbatim."""
    block = re.search(r'<div id="rec768446258"[\s\S]*?(?=<!--footer-->)', source)
    if not block:
        raise ValueError("Missing original contractor document block")
    text = block.group(0)
    matches = list(re.finditer(r'(<div\b[^>]*class="t993__btn-text-(?:title|descr)"[^>]*>)([\s\S]*?)(</div>)', text))
    if not matches:
        raise ValueError("Missing contractor text fields")
    sections = [{"id": "legacy-content", "title": "Информация для исполнителей", "clauses": []}]
    for index, match in enumerate(matches):
        sections[0]["clauses"].append({"number": f"1.{index + 1}", "html": match.group(2)})
    return sections


def seed_bundle(source):
    config = read_json(source / "config/offers.json")
    docs = []
    for offer in config["offers"]:
        versions = [read_json(path) for path in sorted((source / "content/offers" / offer["id"]).glob("*.json"))]
        current = next(value for value in versions if value["version"] == offer["currentVersion"])
        docs.append({"id": "offer-" + offer["id"], "type": "offer", "title": current["title"], "url": offer["url"],
                     "source_path": f"content/offers/{offer['id']}", "content": current,
                     "published_version": current["version"],
                     "history": [{"version_id": value["version"], "content": value, "published_at": value.get("publishedAt")} for value in versions if value["version"] != current["version"]]})
    for path in sorted((source / "content/legal").glob("*.json")):
        value = read_json(path)
        docs.append({"id": "legal-" + value["id"], "type": "legal", "title": value["title"], "url": value["url"],
                     "source_path": str(path.relative_to(source)), "content": value, "published_version": value["revisionDate"]})
    for doc_id, title, kind, filename in [
        ("offer-practice", "Судебная практика к оферте", "practice", "content/offers/practice.json"),
        ("offer-settings", "Оферты: названия и настройки публикации", "settings", "config/offers.json"),
        ("privacy-settings", "Cookie: настройки опубликованного согласия", "settings", "config/site-privacy.json"),
    ]:
        docs.append({"id": doc_id, "title": title, "type": kind, "source_path": filename, "content": read_json(source / filename), "published_version": "imported"})
    presentation = source / "config/legal-presentation.json"
    docs.append({"id": "document-presentation", "title": "Каталог документов и подписи кнопок", "type": "settings", "source_path": "config/legal-presentation.json", "content": read_json(presentation) if presentation.exists() else {}, "published_version": "imported"})
    legacy = (source / "www/offer_for_lawyer_20231103/index.html").read_text(encoding="utf-8")
    legacy_doc = {"id": "contractors", "url": "/offer_for_lawyer_20231103/", "title": "Информация для исполнителей", "description": "Присоединение исполнителей", "documentUrl": "https://disk.yandex.ru/i/_gHHis7xWl8o4w", "sections": legacy_fields(legacy)}
    docs.append({"id": "legacy-contractors", "title": legacy_doc["title"], "type": "legacy", "url": legacy_doc["url"], "source_path": "www/offer_for_lawyer_20231103/index.html", "content": legacy_doc, "published_version": "imported"})
    return {"schema_version": 1, "bundle_id": "elegso-legal-original-v1", "documents": docs}


def initialize(store, source):
    # Git is a migration seed, never a source overwriting administrative edits.
    if not store.list_documents():
        return store.import_bundle(seed_bundle(source))
    return {"status": "already_imported"}


def backup_database(database, directory):
    directory.mkdir(parents=True, exist_ok=True)
    name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite3"
    destination = directory / name
    with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(destination)) as target:
        source.backup(target)
    destination.chmod(0o600)
    return destination


def publication_content(document):
    return copy.deepcopy(document["published_content"])


def render_legacy(source, content):
    before = source.read_text(encoding="utf-8")
    slots = iter(clause["html"] for section in content["sections"] for clause in section["clauses"])
    pattern = r'(<div\b[^>]*class="t993__btn-text-(?:title|descr)"[^>]*>)([\s\S]*?)(</div>)'
    block = re.search(r'<div id="rec768446258"[\s\S]*?(?=<!--footer-->)', before)
    if not block:
        raise ValueError("Contractor source block is missing")
    try:
        replacement = re.sub(pattern, lambda m: m.group(1) + next(slots) + m.group(3), block.group(0))
    except StopIteration as exc:
        raise ValueError("Сохраните число исходных блоков старой страницы исполнителей") from exc
    if next(slots, None) is not None:
        raise ValueError("Для старой страницы исполнителей поддерживается редактирование существующих блоков")
    replacement = replacement.replace('href="https://disk.yandex.ru/i/_gHHis7xWl8o4w"', 'href="' + html.escape(content["documentUrl"], quote=True) + '"')
    result = before[:block.start()] + replacement + before[block.end():]
    if content["title"] != "Информация для исполнителей" or content["description"] != "Присоединение исполнителей":
        result = page_metadata(result, content["url"], content["title"], content["description"], index=True)
    return result


def page_metadata(body, url, title, description, *, index=False, collection=False):
    """Keep canonical, social and structured metadata on the same route."""
    body = re.sub(r"<title\b[^>]*>[\s\S]*?</title>", "<title>" + html.escape(title) + " — ЭЛЕГСО</title>", body, count=1)
    values = {"description": description, "robots": "index, follow" if index else "noindex, follow", "og:url": ORIGIN + url, "og:title": title, "og:description": description}
    for key, value in values.items():
        expression = r'<meta\b(?=[^>]*(?:name|property)=["\']' + re.escape(key) + r'["\'])[^>]*>'
        attribute = "property" if key.startswith("og:") else "name"
        body = re.sub(expression, f'<meta {attribute}="{key}" content="{html.escape(value, quote=True)}">', body, flags=re.I)
    body = re.sub(r'<link\b(?=[^>]*rel=["\']canonical["\'])[^>]*>', f'<link rel="canonical" href="{ORIGIN}{url}">', body, flags=re.I)
    def schema(match):
        value = json.loads(match.group(2))
        nodes = value.get("@graph", [value])
        for node in nodes:
            if node.get("@type") in ("WebPage", "CollectionPage"):
                node.update({"@type": "CollectionPage" if collection else "WebPage", "@id": ORIGIN + url + "#webpage", "url": ORIGIN + url, "name": title, "description": description})
            elif node.get("@type") == "BreadcrumbList" and node.get("itemListElement"):
                node["itemListElement"][-1].update({"item": ORIGIN + url, "name": title})
        return match.group(1) + json.dumps(value, ensure_ascii=False).replace("<", "\\u003c") + match.group(3)
    return re.sub(r'(<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>)([\s\S]*?)(</script>)', schema, body, flags=re.I)


def build_projection(source, stage, documents, job=None, previous=None, node="/usr/bin/node"):
    """Build a candidate without touching the live pointer or database."""
    by_id = {item["id"]: item for item in documents}
    contents = {key: publication_content(item) for key, item in by_id.items()}
    if job:
        contents[job["document_id"]] = copy.deepcopy(job["snapshot"])
    config = contents["offer-settings"]
    # Fixed public namespaces and identities are checked again by builders.
    for offer in config["offers"]:
        doc_id = "offer-" + offer["id"]
        current = contents[doc_id]
        offer["currentVersion"] = current["version"]
        original = by_id[doc_id].get("imported_content", by_id[doc_id]["published_content"])
        if current["title"] != original["title"]:
            offer["pageTitle"] = current["title"]
            offer["seoTitle"] = current["title"]
        if current["description"] != original["description"]:
            offer["pageDescription"] = current["description"]
        historical = {item["content"]["version"]: item["content"] for item in by_id[doc_id]["history"]}
        historical[current["version"]] = current
        for version, value in historical.items():
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,119}", version):
                raise ValueError("Invalid version path")
            write_json(stage / "content/offers" / offer["id"] / (version + ".json"), value)
    write_json(stage / "config/offers.json", config)
    write_json(stage / "content/offers/practice.json", contents["offer-practice"])
    write_json(stage / "config/legal-presentation.json", contents["document-presentation"])
    privacy = contents["privacy-settings"]
    if job and job["document_id"] in {"legal-consent", "legal-privacy", "legal-cookies", "privacy-settings"} and job["snapshot"] != by_id[job["document_id"]]["published_content"]:
        old = read_json(previous / "privacy-config.json") if previous and (previous / "privacy-config.json").exists() else privacy
        today = datetime.now(timezone.utc).date().isoformat()
        old_version = old["consentVersion"].split(".")
        serial = int(old_version[-1]) + 1 if old_version[0] == today else 1
        privacy["consentVersion"] = f"{today}.{serial}"
    elif previous and (previous / "privacy-config.json").exists():
        privacy["consentVersion"] = read_json(previous / "privacy-config.json")["consentVersion"]
    write_json(stage / "config/site-privacy.json", privacy)
    for item in documents:
        if item["type"] == "legal":
            value = contents[item["id"]]
            if value["url"] != item["url"] or value["url"].strip("/") not in ROUTES:
                raise ValueError("Системный адрес документа изменять нельзя")
            write_json(stage / "content/legal" / (value["id"] + ".json"), value)
    web = stage / "www"
    for filename in ["mission/index.html", *["assets/" + asset for asset in ASSETS]]:
        destination = web / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / "www" / filename, destination)
    sitemap = source / "www/sitemap.base.xml"
    if not sitemap.exists():
        sitemap = source / "www/sitemap.xml"
    shutil.copyfile(sitemap, web / "sitemap.xml")
    environment = {"PATH": "/usr/bin:/bin", "TZ": "Europe/Moscow", "HOME": str(stage)}
    for script, flags in [("build-offers.mjs", ["--seal"]), ("build-legal-pages.mjs", ["--write"])]:
        result = subprocess.run([node, str(source / "scripts" / script), "--root", str(stage), *flags], capture_output=True, text=True, timeout=60, env=environment)
        if result.returncode:
            raise ValueError("Ошибка сборки документа: " + result.stderr[-2500:])
    legacy_dir = web / "offer_for_lawyer_20231103"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    (legacy_dir / "index.html").write_text(render_legacy(source / "www/offer_for_lawyer_20231103/index.html", contents["legacy-contractors"]), encoding="utf-8")
    # Legal-page history uses immutable database snapshots, without inventing
    # editions older than the imported documents.
    for item in documents:
        if item["type"] != "legal":
            continue
        route = item["url"].strip("/")
        current_html = (web / route / "index.html").read_text(encoding="utf-8")
        link = f'<a class="eo-link" href="/{route}/history/">История редакций →</a>'
        current_html = current_html.replace('<nav class="eo-bottom el-related"', link + '<nav class="eo-bottom el-related"', 1)
        (web / route / "index.html").write_text(current_html, encoding="utf-8")
        versions = list(item["history"])
        if job and job["document_id"] == item["id"] and job["snapshot"] != item["published_content"]:
            versions.append({"version_id": job["id"], "content": job["snapshot"]})
        links = []
        for version in versions:
            value = version["content"]
            slug = str(version["version_id"])
            if not re.fullmatch(r"[a-zA-Z0-9_.:-]+", slug):
                raise ValueError("Invalid historical version")
            url = f"/{route}/versions/{slug}/"
            dest = web / url.lstrip("/")
            cached = previous / "www" / url.lstrip("/") / "index.html" if previous else None
            if cached and cached.is_file():
                dest.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(cached, dest / "index.html")
                links.append(f'<li><a href="{url}">Редакция от {html.escape(value["revisionDate"])} · {html.escape(slug)}</a></li>')
                continue
            archive = stage / "archive-work"
            if archive.exists():
                shutil.rmtree(archive)
            shutil.copytree(stage / "content/legal", archive / "content/legal")
            shutil.copytree(stage / "config", archive / "config")
            shutil.copytree(web / "assets", archive / "www/assets")
            shutil.copytree(web / "mission", archive / "www/mission")
            write_json(archive / "content/legal" / (value["id"] + ".json"), value)
            result = subprocess.run([node, str(source / "scripts/build-legal-pages.mjs"), "--root", str(archive), "--write"], capture_output=True, text=True, timeout=60, env=environment)
            if result.returncode:
                raise ValueError("Ошибка сборки истории: " + result.stderr[-1000:])
            archived = (archive / "www" / route / "index.html").read_text(encoding="utf-8")
            archived = page_metadata(archived, url, value["title"] + " — редакция от " + value["revisionDate"], value["description"])
            dest.mkdir(parents=True, exist_ok=True)
            (dest / "index.html").write_text(archived, encoding="utf-8")
            links.append(f'<li><a href="{url}">Редакция от {html.escape(value["revisionDate"])} · {html.escape(slug)}</a></li>')
        history = re.sub(r'<main\b[\s\S]*?</main>', '<main class="eo-main"><div class="eo-wrap"><h1>История редакций</h1><p>' + html.escape(contents[item["id"]]["title"]) + '</p><ul>' + ''.join(reversed(links)) + f'</ul><a href="/{route}/">Действующий документ →</a></div></main>', current_html, count=1)
        history = page_metadata(history, f"/{route}/history/", "История редакций — " + contents[item["id"]]["title"], "Опубликованные редакции документа и даты их действия.", collection=True)
        target = web / route / "history"
        target.mkdir(parents=True, exist_ok=True)
        (target / "index.html").write_text(history, encoding="utf-8")
    if (stage / "archive-work").exists():
        shutil.rmtree(stage / "archive-work")
    # Only the legal namespaces are exposed by nginx; seed/template copies are
    # removed so this release cannot replace the rest of the website.
    shutil.rmtree(web / "mission")
    shutil.rmtree(web / "assets")
    rows = re.findall(r"<url>[\s\S]*?</url>", (web / "sitemap.xml").read_text(encoding="utf-8"))
    managed = [row for row in rows if re.search(r'<loc>https://elegso\.ru/(?:oferta|oferta-fiz|soglashenie|cookies|consent|documents|offer_for_lawyer_20231103)/', row)]
    write_json(stage / "sitemap-legal.json", {"roots": sorted(ROUTES), "rows": managed})
    write_json(stage / "privacy-config.json", privacy)
    (stage / "privacy-config.js").write_text("window.__elegsoPublishedPrivacyConfig=" + json.dumps(privacy, ensure_ascii=False).replace("<", "\\u003c") + ";\n", encoding="utf-8")
    write_json(stage / "published.json", {"documents": contents, "job_id": job["id"] if job else None})
    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(), "job_id": job["id"] if job else None, "previous": str(previous) if previous else None, "source": str(source), "documents": {key: digest(canonical(value)) for key, value in contents.items()}}
    write_json(stage / "manifest.json", manifest)
    for page in web.rglob("index.html"):
        body = page.read_text(encoding="utf-8")
        if "<html" not in body or "</html>" not in body or "<title" not in body:
            raise ValueError("Incomplete generated page: " + str(page.relative_to(web)))
    return manifest


def complete_snapshot(store, job):
    item = store.get_document(job["document_id"])
    version = job["snapshot"]["version"] if item["type"] == "offer" else (item.get("published_version") if job["snapshot_sha256"] == item["published_sha256"] else job["id"])
    return store.complete_job(job["id"], WORKER, version or job["id"])


def run(source, database, output, node, initialize_only=False, force=False):
    source = source.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".publish.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        store = Store(database)
        imported = initialize(store, source)
        if initialize_only:
            return imported
        running = [job for job in store.jobs() if job["status"] == "running" and job.get("worker") == WORKER]
        # A deployment rebuild must not commit a queued editorial publication:
        # its own later rollback cannot undo that separate database commit.
        if force and running:
            raise RuntimeError("Recover the interrupted publication before rebuilding the site")
        job = None if force else (running[0] if running else store.claim_job(WORKER))
        if not job and (output / "current").exists() and not force:
            return {"status": "idle"}
        if job:
            backup_database(database, database.parent / "backups")
        previous = (output / "current").resolve() if (output / "current").exists() else None
        # Recover a crash after the pointer switch but before SQLite commit.
        # In particular, do not increment the consent version a second time.
        if job and previous and (previous / "manifest.json").exists():
            manifest = read_json(previous / "manifest.json")
            if manifest.get("job_id") == job["id"] and manifest.get("documents", {}).get(job["document_id"]) == job["snapshot_sha256"]:
                try:
                    published = read_json(previous / "published.json")
                    if digest(canonical(published["documents"][job["document_id"]])) != job["snapshot_sha256"]:
                        raise ValueError("Published snapshot checksum mismatch")
                    complete_snapshot(store, job)
                    return {"status": "reconciled", "release": str(previous), "job_id": job["id"]}
                except Exception as exc:
                    rollback = Path(manifest["previous"]) if manifest.get("previous") else None
                    if rollback and rollback.is_dir() and rollback.parent.resolve() == (output / "releases").resolve():
                        link = output / ".current.rollback"
                        link.unlink(missing_ok=True)
                        link.symlink_to(rollback)
                        os.replace(link, output / "current")
                    elif rollback is None:
                        (output / "current").unlink(missing_ok=True)
                    store.fail_job(job["id"], WORKER, str(exc)[:3000])
                    raise
        stage = Path(tempfile.mkdtemp(prefix=".build-", dir=output))
        switched = False
        try:
            manifest = build_projection(source, stage, store.export_published()["documents"], job, previous, node)
            name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            release = output / "releases" / name
            release.parent.mkdir(parents=True, exist_ok=True)
            for path in stage.rglob("*"):
                path.chmod(0o755 if path.is_dir() else 0o644)
            stage.chmod(0o755)
            os.replace(stage, release)
            temp_link = output / ".current.new"
            temp_link.unlink(missing_ok=True)
            temp_link.symlink_to(release)
            os.replace(temp_link, output / "current")
            switched = True
            if job:
                complete_snapshot(store, job)
            return {"status": "published", "release": str(release), "job_id": manifest["job_id"]}
        except Exception as exc:
            if switched:
                target = output / ".current.rollback"
                target.unlink(missing_ok=True)
                if previous:
                    target.symlink_to(previous)
                    os.replace(target, output / "current")
                else:
                    (output / "current").unlink(missing_ok=True)
            if job:
                store.fail_job(job["id"], WORKER, str(exc)[:3000])
            raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/srv/www/elegso.ru/current"))
    parser.add_argument("--database", type=Path, default=Path("/var/lib/elegso-seo-admin/legal/documents.sqlite3"))
    parser.add_argument("--output", type=Path, default=Path("/srv/www/elegso.ru/generated-legal"))
    parser.add_argument("--node", default="/usr/bin/node")
    parser.add_argument("--initialize-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.source, args.database, args.output, args.node, args.initialize_only, args.force), ensure_ascii=False))
