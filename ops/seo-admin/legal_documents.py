"""Isolated, transactional legal-document drafts and publication snapshots.

This module does not write website files, execute commands, authorize users or
publish HTTP content. The caller must authorize each operation; a separate worker
publishes a claimed immutable snapshot and only then calls ``complete_job``.
Imported JSON strings, including legacy HTML, are preserved exactly. Unsafe
legacy markup remains inspectable but cannot be queued for publication.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

TYPES = {"offer", "legal", "legacy", "practice", "settings"}
MAX_JSON_BYTES = 2_000_000
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z")
VERSION = re.compile(r"[a-z0-9][a-z0-9-]{0,119}\Z")
TAGS = {"p", "br", "strong", "em", "b", "i", "u", "s", "ul", "ol", "li",
        "blockquote", "span", "a", "sub", "sup", "table", "thead", "tbody",
        "tfoot", "tr", "th", "td", "h2", "h3", "h4", "code", "pre", "img"}
VOID = {"br", "img"}


class ValidationError(ValueError):
    pass


class ConflictError(ValueError):
    pass


class NotFoundError(KeyError):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def identifier(value, label="id"):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValidationError("invalid_" + label)
    return value


def canonical(value):
    """Canonicalize JSON encoding only; never normalize strings or HTML."""
    def check(item, depth=0):
        if depth > 30:
            raise ValidationError("json_too_deep")
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 200:
                    raise ValidationError("invalid_json_key")
                check(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                check(child, depth + 1)
        elif item is None or type(item) in (bool, int, str):
            pass
        elif type(item) is float and math.isfinite(item):
            pass
        else:
            raise ValidationError("not_json")
    check(value)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(raw.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValidationError("json_too_large")
    return raw


def digest(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def validate_url(value, image=False):
    if not isinstance(value, str) or not value or len(value) > 3000:
        raise ValidationError("invalid_url")
    if value != value.strip() or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValidationError("invalid_url")
    decoded = value
    for _ in range(3):
        decoded = unquote(decoded)
    if re.search(r"[\x00-\x20\x7f\\]", decoded) or decoded.startswith("//"):
        raise ValidationError("unsafe_url")
    try:
        parts = urlsplit(value)
        decoded_parts = urlsplit(decoded)
        if parts.scheme != decoded_parts.scheme:
            raise ValidationError("unsafe_url")
        if not parts.scheme:
            if not value.startswith(("/", "#")) or parts.netloc:
                raise ValidationError("relative_url_must_be_rooted")
            if any(part in (".", "..") for part in decoded_parts.path.split("/")):
                raise ValidationError("unsafe_url_path")
        elif parts.scheme in ("http", "https") and not image:
            if not parts.hostname or parts.username or parts.password:
                raise ValidationError("unsafe_url_authority")
            _ = parts.port
        elif parts.scheme == "mailto" and not image:
            if not re.fullmatch(r"[^@/?#<>]+@[^@/?#<>]+", parts.path) or parts.query or parts.fragment:
                raise ValidationError("invalid_email_url")
        elif parts.scheme == "tel" and not image:
            if not re.fullmatch(r"\+?[0-9().-]{3,30}", parts.path) or parts.query or parts.fragment:
                raise ValidationError("invalid_phone_url")
        else:
            raise ValidationError("unsafe_url_scheme")
    except ValueError as exc:
        if isinstance(exc, ValidationError):
            raise
        raise ValidationError("invalid_url") from exc
    return value


class SafeHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in TAGS:
            raise ValidationError("unsafe_html_tag:" + tag)
        names = [key for key, _ in attrs]
        if len(set(names)) != len(names):
            raise ValidationError("duplicate_html_attribute")
        allowed = {"title", "lang"}
        if tag == "a":
            allowed |= {"href", "target", "rel"}
        if tag in ("td", "th"):
            allowed |= {"colspan", "rowspan", "scope"}
        if tag == "img":
            allowed |= {"src", "alt", "width", "height", "loading"}
        values = dict(attrs)
        for key, value in attrs:
            if key not in allowed or value is None or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
                raise ValidationError("unsafe_html_attribute:" + key)
            if key in ("href", "src"):
                validate_url(value, image=key == "src")
            elif key in ("width", "height", "colspan", "rowspan"):
                if not value.isdigit() or not 1 <= int(value) <= 4000:
                    raise ValidationError("invalid_html_dimension")
            elif key == "target" and value not in ("_blank", "_self"):
                raise ValidationError("unsafe_html_target")
            elif key == "rel" and not set(value.split()) <= {"noopener", "noreferrer", "nofollow"}:
                raise ValidationError("unsafe_html_rel")
            elif key == "loading" and value not in ("lazy", "eager"):
                raise ValidationError("invalid_html_loading")
            elif key == "scope" and value not in ("row", "col", "rowgroup", "colgroup"):
                raise ValidationError("invalid_html_scope")
        if tag == "a" and values.get("target") == "_blank" and "noopener" not in values.get("rel", "").split():
            raise ValidationError("blank_link_requires_noopener")
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            raise ValidationError("unbalanced_html")

    def handle_comment(self, data):
        raise ValidationError("html_comments_not_allowed")

    def handle_decl(self, decl):
        raise ValidationError("html_declaration_not_allowed")

    def unknown_decl(self, data):
        raise ValidationError("html_declaration_not_allowed")

    def handle_pi(self, data):
        raise ValidationError("html_processing_instruction_not_allowed")


def validate_html(value):
    if not isinstance(value, str) or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise ValidationError("invalid_html")
    parser = SafeHTML()
    try:
        parser.feed(value)
        parser.close()
    except (AssertionError, ValueError) as exc:
        if isinstance(exc, ValidationError):
            raise
        raise ValidationError("invalid_html") from exc
    if parser.stack:
        raise ValidationError("unclosed_html")


def validate_content(kind, content):
    if kind not in TYPES or not isinstance(content, dict):
        raise ValidationError("invalid_content")
    canonical(content)
    if kind == "offer":
        if not isinstance(content.get("version"), str) or not VERSION.fullmatch(content["version"]):
            raise ValidationError("invalid_offer_version")
        fields = {"permanentUrl", "identifier", "identifierLabel", "permanentUrlLabel", "checksumLabel", "checksumNote"}
        publication = content.get("publication", {})
        if not isinstance(publication, dict) or set(publication) - fields:
            raise ValidationError("invalid_publication_metadata")
        # Legacy top-level presentation fields stay supported; nested metadata
        # takes precedence in builders, while both forms get the same guards.
        for key, value in list(publication.items()) + [(key, content[key]) for key in fields if key in content]:
            if not isinstance(value, str) or not value.strip() or len(value) > 1000:
                raise ValidationError("invalid_publication_metadata")
            if key == "permanentUrl":
                if not re.fullmatch(r"/(?:oferta|oferta-fiz)/versions/[a-z0-9][a-z0-9-]{0,119}/", value):
                    raise ValidationError("invalid_permanent_url")
            elif "<" in value or ">" in value:
                raise ValidationError("publication_labels_are_plain_text")
    if kind in ("offer", "legal"):
        if not isinstance(content.get("title"), str) or not content["title"].strip():
            raise ValidationError("missing_title")
        sections = content.get("sections")
        if not isinstance(sections, list) or not sections:
            raise ValidationError("missing_sections")
        section_ids, numbers = set(), set()
        for section in sections:
            if not isinstance(section, dict):
                raise ValidationError("invalid_section")
            sid = identifier(section.get("id"), "section_id")
            if sid in section_ids:
                raise ValidationError("duplicate_section_id")
            section_ids.add(sid)
            if not isinstance(section.get("title"), str) or not section["title"].strip():
                raise ValidationError("missing_section_title")
            clauses = section.get("clauses")
            if not isinstance(clauses, list) or not clauses:
                raise ValidationError("missing_clauses")
            for clause in clauses:
                if not isinstance(clause, dict) or not isinstance(clause.get("number"), str) or not clause["number"].strip():
                    raise ValidationError("invalid_clause")
                if clause["number"] in numbers:
                    raise ValidationError("duplicate_clause_number")
                numbers.add(clause["number"])
                validate_html(clause.get("html"))

    def walk(value, key=""):
        if isinstance(value, dict):
            for name, child in value.items():
                walk(child, name)
        elif isinstance(value, list):
            for child in value:
                walk(child, key)
        elif isinstance(value, str):
            if key.lower().endswith(("url", "href", "src")) or key in ("origin", "logo"):
                validate_url(value)
            if key.lower().endswith("html") or re.search(r"<\s*[A-Za-z!/?]", value):
                validate_html(value)
    walk(content)
    return content


def actor_json(actor):
    if not isinstance(actor, (str, dict)) or not actor:
        raise ValidationError("missing_actor")
    raw = canonical(actor)
    if len(raw) > 4000:
        raise ValidationError("actor_too_large")
    return raw


SCHEMA = """
CREATE TABLE IF NOT EXISTS legal_documents (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
 source_path TEXT, editable INTEGER NOT NULL CHECK(editable IN(0,1)),
 imported_json TEXT NOT NULL, baseline_sha256 TEXT NOT NULL,
 draft_json TEXT NOT NULL, revision INTEGER NOT NULL,
 published_version TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legal_imports (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legal_publications (
 document_id TEXT NOT NULL, version_id TEXT NOT NULL, content_json TEXT NOT NULL,
 sha256 TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
 declared_published_at TEXT, recorded_at TEXT NOT NULL, actor_json TEXT NOT NULL,
 PRIMARY KEY(document_id,version_id), FOREIGN KEY(document_id) REFERENCES legal_documents(id));
CREATE TABLE IF NOT EXISTS legal_jobs (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed')),
 actor_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 worker TEXT, error TEXT, publication_version TEXT,
 UNIQUE(document_id,revision), FOREIGN KEY(document_id) REFERENCES legal_documents(id));
CREATE TABLE IF NOT EXISTS legal_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT, action TEXT NOT NULL,
 revision INTEGER, actor_json TEXT NOT NULL, detail_json TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS legal_jobs_queue ON legal_jobs(status,created_at,id);
CREATE TRIGGER IF NOT EXISTS legal_publications_no_update BEFORE UPDATE ON legal_publications
 BEGIN SELECT RAISE(ABORT,'immutable_publication'); END;
CREATE TRIGGER IF NOT EXISTS legal_publications_no_delete BEFORE DELETE ON legal_publications
 BEGIN SELECT RAISE(ABORT,'immutable_publication'); END;
CREATE TRIGGER IF NOT EXISTS legal_audit_no_update BEFORE UPDATE ON legal_audit
 BEGIN SELECT RAISE(ABORT,'immutable_audit'); END;
CREATE TRIGGER IF NOT EXISTS legal_audit_no_delete BEFORE DELETE ON legal_audit
 BEGIN SELECT RAISE(ABORT,'immutable_audit'); END;
CREATE TRIGGER IF NOT EXISTS legal_imports_no_update BEFORE UPDATE ON legal_imports
 BEGIN SELECT RAISE(ABORT,'immutable_import'); END;
CREATE TRIGGER IF NOT EXISTS legal_imports_no_delete BEFORE DELETE ON legal_imports
 BEGIN SELECT RAISE(ABORT,'immutable_import'); END;
CREATE TRIGGER IF NOT EXISTS legal_baseline_no_update
 BEFORE UPDATE OF imported_json,baseline_sha256,id,type,source_path ON legal_documents
 BEGIN SELECT RAISE(ABORT,'immutable_baseline'); END;
CREATE TRIGGER IF NOT EXISTS legal_job_snapshot_no_update
 BEFORE UPDATE OF id,document_id,revision,snapshot_json,snapshot_sha256,actor_json,created_at ON legal_jobs
 BEGIN SELECT RAISE(ABORT,'immutable_job_snapshot'); END;
CREATE TRIGGER IF NOT EXISTS legal_job_no_delete BEFORE DELETE ON legal_jobs
 BEGIN SELECT RAISE(ABORT,'immutable_job'); END;
"""


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        except FileExistsError:
            pass
        os.chmod(self.path, 0o600)
        with self._connection() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA busy_timeout=10000")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if write:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _row(db, doc_id):
        identifier(doc_id)
        row = db.execute("SELECT * FROM legal_documents WHERE id=?", (doc_id,)).fetchone()
        if row is None:
            raise NotFoundError(doc_id)
        return row

    @staticmethod
    def _expected(row, revision):
        if type(revision) is not int or revision != row["revision"]:
            raise ConflictError("revision_conflict")
        if not row["editable"]:
            raise ValidationError("document_read_only")

    @staticmethod
    def _audit(db, doc_id, action, revision, actor, detail):
        db.execute("INSERT INTO legal_audit(document_id,action,revision,actor_json,detail_json,recorded_at) VALUES(?,?,?,?,?,?)",
                   (doc_id, action, revision, actor_json(actor), canonical(detail), timestamp()))

    @staticmethod
    def _publication(db, doc_id, version_id, raw, revision, kind, actor, declared_at=None):
        identifier(version_id, "version")
        prior = db.execute("SELECT sha256 FROM legal_publications WHERE document_id=? AND version_id=?", (doc_id, version_id)).fetchone()
        if prior:
            if prior["sha256"] != digest(raw):
                raise ConflictError("immutable_version_conflict")
            return
        if declared_at is None:
            content = json.loads(raw)
            declared_at = content.get("publishedAt") or content.get("revisionDate")
        if declared_at is not None and not isinstance(declared_at, str):
            raise ValidationError("invalid_declared_publication_date")
        db.execute("INSERT INTO legal_publications VALUES(?,?,?,?,?,?,?,?,?)",
                   (doc_id, version_id, raw, digest(raw), revision, kind, declared_at, timestamp(), actor_json(actor)))

    def import_bundle(self, bundle, idempotent=True):
        if not isinstance(bundle, dict) or bundle.get("schema_version") != 1 or not isinstance(bundle.get("documents"), list):
            raise ValidationError("invalid_bundle")
        bundle_id = identifier(bundle.get("bundle_id"), "bundle_id")
        bundle_hash = digest(canonical(bundle))
        prepared, ids = [], set()
        for item in bundle["documents"]:
            if not isinstance(item, dict):
                raise ValidationError("invalid_document")
            doc_id = identifier(item.get("id"))
            if doc_id in ids or item.get("type") not in TYPES or not isinstance(item.get("content"), dict):
                raise ValidationError("invalid_document")
            ids.add(doc_id)
            if not isinstance(item.get("title"), str) or not item["title"].strip():
                raise ValidationError("missing_title")
            if "editable" in item and type(item["editable"]) is not bool:
                raise ValidationError("invalid_editable")
            if item.get("url") is not None:
                validate_url(item["url"])
            source = item.get("source_path")
            if source is not None and (not isinstance(source, str) or source.startswith("/") or "\\" in source or ".." in source.split("/") or "\x00" in source):
                raise ValidationError("invalid_source_path")
            raw = canonical(item["content"])
            history = item.get("history", [])
            if not isinstance(history, list):
                raise ValidationError("invalid_history")
            for version in history:
                if not isinstance(version, dict) or not isinstance(version.get("content"), dict):
                    raise ValidationError("invalid_history")
                identifier(version.get("version_id"), "version")
                canonical(version["content"])
            prepared.append((item, raw))
        with self._connection(write=True) as db:
            prior = db.execute("SELECT sha256 FROM legal_imports WHERE id=?", (bundle_id,)).fetchone()
            if prior:
                if not idempotent or prior["sha256"] != bundle_hash:
                    raise ConflictError("bundle_conflict")
                return {"imported": 0, "existing": len(prepared), "bundle_id": bundle_id}
            count = 0
            for item, raw in prepared:
                existing = db.execute("SELECT * FROM legal_documents WHERE id=?", (item["id"],)).fetchone()
                if existing:
                    if (existing["baseline_sha256"] != digest(raw) or existing["type"] != item["type"]
                            or existing["source_path"] != item.get("source_path") or existing["url"] != item.get("url")
                            or bool(existing["editable"]) != item.get("editable", True)):
                        raise ConflictError("baseline_conflict:" + item["id"])
                else:
                    now = timestamp()
                    version = item.get("published_version", "baseline")
                    identifier(version, "version")
                    db.execute("INSERT INTO legal_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               (item["id"], item["type"], item["title"], item.get("url"), item.get("source_path"),
                                int(item.get("editable", True)), raw, digest(raw), raw, 1, version, now, now))
                    self._publication(db, item["id"], version, raw, 1, "imported", "import", item.get("published_at"))
                    self._audit(db, item["id"], "import", 1, "import", {"baseline_sha256": digest(raw), "bundle_id": bundle_id})
                    count += 1
                for version in item.get("history", []):
                    self._publication(db, item["id"], version["version_id"], canonical(version["content"]), 0, "imported", "import", version.get("published_at"))
            db.execute("INSERT INTO legal_imports VALUES(?,?,?)", (bundle_id, bundle_hash, timestamp()))
            return {"imported": count, "existing": len(prepared) - count, "bundle_id": bundle_id}

    @staticmethod
    def _document(row, full=False):
        result = {key: row[key] for key in ("id", "type", "title", "url", "source_path", "revision", "baseline_sha256", "published_version", "created_at", "updated_at")}
        result["editable"] = bool(row["editable"])
        result["draft_revision"] = result["revision"]
        result["draft_sha256"] = digest(row["draft_json"])
        if full:
            result["content"] = json.loads(row["draft_json"])
            result["draft_content"] = result["content"]
            result["imported_content"] = json.loads(row["imported_json"])
            try:
                validate_content(row["type"], result["content"])
                result["validation_errors"] = []
            except ValidationError as exc:
                result["validation_errors"] = [str(exc)]
        return result

    def list_documents(self):
        with self._connection() as db:
            return [self._document(row) for row in db.execute("SELECT * FROM legal_documents ORDER BY id")]

    def get_document(self, doc_id):
        with self._connection() as db:
            result = self._document(self._row(db, doc_id), full=True)
            result["history"] = [self._history(row, False) for row in db.execute("SELECT * FROM legal_publications WHERE document_id=? ORDER BY recorded_at DESC,version_id", (doc_id,))]
            current = db.execute("SELECT content_json,sha256 FROM legal_publications WHERE document_id=? AND version_id=?", (doc_id, result["published_version"])).fetchone()
            result["published_content"] = json.loads(current["content_json"]) if current else None
            result["published_sha256"] = current["sha256"] if current else None
            result["has_changes"] = result["draft_sha256"] != result["published_sha256"]
            return result

    def save_draft(self, doc_id, payload, expected_revision, actor):
        actor_json(actor)
        raw = canonical(payload)
        with self._connection(write=True) as db:
            row = self._row(db, doc_id)
            self._expected(row, expected_revision)
            validate_content(row["type"], payload)
            baseline = json.loads(row["imported_json"])
            for key in ("id", "url"):
                if key in baseline and payload.get(key) != baseline[key]:
                    raise ValidationError("immutable_document_" + key)
            if raw != row["draft_json"]:
                revision = row["revision"] + 1
                db.execute("UPDATE legal_documents SET draft_json=?,revision=?,title=?,updated_at=? WHERE id=?",
                           (raw, revision, payload.get("title", row["title"]), timestamp(), doc_id))
                self._audit(db, doc_id, "save_draft", revision, actor, {"sha256": digest(raw), "previous_sha256": digest(row["draft_json"])})
        return self.get_document(doc_id)

    @staticmethod
    def _job(row):
        result = dict(row)
        result["snapshot"] = json.loads(result.pop("snapshot_json"))
        result["actor"] = json.loads(result.pop("actor_json"))
        return result

    def request_publish(self, doc_id, expected_revision, actor):
        actor_json(actor)
        with self._connection(write=True) as db:
            row = self._row(db, doc_id)
            self._expected(row, expected_revision)
            content = json.loads(row["draft_json"])
            validate_content(row["type"], content)
            self._publish_guard(db, row, content)
            prior = db.execute("SELECT * FROM legal_jobs WHERE document_id=? AND revision=?", (doc_id, expected_revision)).fetchone()
            if prior:
                return self._job(prior)
            jid, now = str(uuid.uuid4()), timestamp()
            db.execute("INSERT INTO legal_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (jid, doc_id, expected_revision, row["draft_json"], digest(row["draft_json"]), "queued", actor_json(actor), now, now, None, None, None))
            self._audit(db, doc_id, "request_publish", expected_revision, actor, {"job_id": jid, "sha256": digest(row["draft_json"])})
            return self._job(db.execute("SELECT * FROM legal_jobs WHERE id=?", (jid,)).fetchone())

    @staticmethod
    def _permanent_url(row, content):
        return content.get("publication", {}).get("permanentUrl") or content.get("permanentUrl") or (row["url"] or "/oferta/").rstrip("/") + "/versions/" + content["version"] + "/"

    def _publish_guard(self, db, row, content):
        if row["type"] != "offer":
            return
        raw_hash = digest(canonical(content))
        current = db.execute("SELECT * FROM legal_publications WHERE document_id=? AND version_id=?", (row["id"], row["published_version"])).fetchone()
        if current and current["sha256"] == raw_hash:
            return
        new_url = self._permanent_url(row, content)
        prefix = (row["url"] or "/oferta/").rstrip("/") + "/versions/"
        if not new_url.startswith(prefix):
            raise ValidationError("permanent_url_wrong_document")
        for old in db.execute("SELECT * FROM legal_publications WHERE document_id=?", (row["id"],)):
            old_content = json.loads(old["content_json"])
            if content["version"] == old_content.get("version") or content["version"] == old["version_id"]:
                raise ValidationError("Измените идентификатор редакции: опубликованная версия неизменяема")
            if old_content.get("version") and self._permanent_url(row, old_content) == new_url:
                raise ValidationError("permanent_url_already_published")
        # A queued/running snapshot also reserves its identifier and URL, even
        # if it has not reached the public history yet.
        for pending in db.execute("SELECT * FROM legal_jobs WHERE document_id=? AND status IN('queued','running')", (row["id"],)):
            if pending["snapshot_sha256"] == raw_hash:
                continue
            other = json.loads(pending["snapshot_json"])
            if other.get("version") == content["version"] or self._permanent_url(row, other) == new_url:
                raise ConflictError("publication_identifier_reserved")

    def jobs(self, document_id=None, status=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000 or status not in (None, "queued", "running", "completed", "failed"):
            raise ValidationError("invalid_job_filter")
        where, values = [], []
        if document_id is not None:
            identifier(document_id)
            where.append("document_id=?")
            values.append(document_id)
        if status is not None:
            where.append("status=?")
            values.append(status)
        sql = "SELECT * FROM legal_jobs" + (" WHERE " + " AND ".join(where) if where else "")
        with self._connection() as db:
            return [self._job(row) for row in db.execute(sql + " ORDER BY created_at DESC,id LIMIT ?", (*values, limit))]

    def get_job(self, job_id):
        identifier(job_id, "job_id")
        with self._connection() as db:
            row = db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise NotFoundError(job_id)
            return self._job(row)

    getjob = get_job

    def claim_job(self, worker):
        identifier(worker, "worker")
        with self._connection(write=True) as db:
            # One running job per document prevents older publications from
            # racing a newer snapshot. Different documents can run concurrently.
            row = db.execute("SELECT j.* FROM legal_jobs j WHERE j.status='queued' AND NOT EXISTS(SELECT 1 FROM legal_jobs r WHERE r.document_id=j.document_id AND r.status='running') ORDER BY j.created_at,j.id LIMIT 1").fetchone()
            if row is None:
                return None
            db.execute("UPDATE legal_jobs SET status='running',worker=?,updated_at=? WHERE id=?", (worker, timestamp(), row["id"]))
            self._audit(db, row["document_id"], "claim_publish", row["revision"], worker, {"job_id": row["id"]})
            return self._job(db.execute("SELECT * FROM legal_jobs WHERE id=?", (row["id"],)).fetchone())

    def complete_job(self, job_id, worker, publication_version, published_at=None):
        identifier(worker, "worker")
        identifier(publication_version, "version")
        with self._connection(write=True) as db:
            row = db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise NotFoundError(job_id)
            if row["status"] == "completed" and row["worker"] == worker and row["publication_version"] == publication_version:
                return self._job(row)
            if row["status"] != "running" or row["worker"] != worker:
                raise ConflictError("job_not_owned")
            document = self._row(db, row["document_id"])
            snapshot = json.loads(row["snapshot_json"])
            current = db.execute("SELECT revision FROM legal_publications WHERE document_id=? AND version_id=?", (row["document_id"], document["published_version"])).fetchone()
            if current and current["revision"] > row["revision"]:
                raise ConflictError("newer_revision_already_published")
            if document["type"] == "offer" and publication_version != snapshot["version"]:
                raise ValidationError("publication_version_mismatch")
            self._publish_guard(db, document, snapshot)
            self._publication(db, row["document_id"], publication_version, row["snapshot_json"], row["revision"], "published", worker, published_at)
            db.execute("UPDATE legal_jobs SET status='completed',publication_version=?,updated_at=? WHERE id=?", (publication_version, timestamp(), job_id))
            db.execute("UPDATE legal_documents SET published_version=?,updated_at=? WHERE id=?", (publication_version, timestamp(), row["document_id"]))
            self._audit(db, row["document_id"], "published", row["revision"], worker, {"job_id": job_id, "version_id": publication_version, "sha256": row["snapshot_sha256"]})
            return self._job(db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone())

    def fail_job(self, job_id, worker, error):
        identifier(worker, "worker")
        if not isinstance(error, str) or not error or len(error) > 4000:
            raise ValidationError("invalid_error")
        with self._connection(write=True) as db:
            row = db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise NotFoundError(job_id)
            if row["status"] != "running" or row["worker"] != worker:
                raise ConflictError("job_not_owned")
            db.execute("UPDATE legal_jobs SET status='failed',error=?,updated_at=? WHERE id=?", (error, timestamp(), job_id))
            self._audit(db, row["document_id"], "publish_failed", row["revision"], worker, {"job_id": job_id, "error": error})
            return self._job(db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone())

    def retry_job(self, job_id, actor):
        """Explicit retry of the same snapshot; never silently reclaim workers."""
        actor_json(actor)
        with self._connection(write=True) as db:
            row = db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise NotFoundError(job_id)
            if row["status"] != "failed":
                raise ConflictError("job_not_failed")
            document = self._row(db, row["document_id"])
            if not document["editable"]:
                raise ValidationError("document_read_only")
            # An already published newer revision must not be replaced by a
            # retry of an older failed snapshot. Restore into a new draft instead.
            current = db.execute("SELECT revision FROM legal_publications WHERE document_id=? AND version_id=?", (row["document_id"], document["published_version"])).fetchone()
            if current and current["revision"] > row["revision"]:
                raise ConflictError("newer_revision_already_published")
            newer = db.execute("SELECT 1 FROM legal_jobs WHERE document_id=? AND revision>? AND status IN('queued','running')", (row["document_id"], row["revision"])).fetchone()
            if newer:
                raise ConflictError("newer_revision_in_queue")
            self._publish_guard(db, document, json.loads(row["snapshot_json"]))
            db.execute("UPDATE legal_jobs SET status='queued',worker=NULL,error=NULL,updated_at=? WHERE id=?", (timestamp(), job_id))
            self._audit(db, row["document_id"], "retry_publish", row["revision"], actor, {"job_id": job_id})
            return self._job(db.execute("SELECT * FROM legal_jobs WHERE id=?", (job_id,)).fetchone())

    @staticmethod
    def _history(row, full):
        result = dict(row)
        raw = result.pop("content_json")
        result["actor"] = json.loads(result.pop("actor_json"))
        if full:
            result["content"] = json.loads(raw)
        return result

    def get_history(self, doc_id, version_id=None):
        with self._connection() as db:
            self._row(db, doc_id)
            if version_id is not None:
                row = db.execute("SELECT * FROM legal_publications WHERE document_id=? AND version_id=?", (doc_id, version_id)).fetchone()
                if row is None:
                    raise NotFoundError(version_id)
                return self._history(row, True)
            return [self._history(row, False) for row in db.execute("SELECT * FROM legal_publications WHERE document_id=? ORDER BY recorded_at DESC,version_id", (doc_id,))]

    def create_from_history(self, doc_id, version_id, expected_revision, actor):
        actor_json(actor)
        with self._connection(write=True) as db:
            row = self._row(db, doc_id)
            self._expected(row, expected_revision)
            old = db.execute("SELECT * FROM legal_publications WHERE document_id=? AND version_id=?", (doc_id, version_id)).fetchone()
            if old is None:
                raise NotFoundError(version_id)
            # Restoration is a new draft, never an archive mutation. Legacy
            # unsafe markup can be restored for correction, not publication.
            revision = row["revision"] + 1
            content = json.loads(old["content_json"])
            db.execute("UPDATE legal_documents SET draft_json=?,revision=?,title=?,updated_at=? WHERE id=?",
                       (old["content_json"], revision, content.get("title", row["title"]), timestamp(), doc_id))
            self._audit(db, doc_id, "create_from_history", revision, actor, {"version_id": version_id, "sha256": old["sha256"]})
        return self.get_document(doc_id)

    def get_audit(self, doc_id=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValidationError("invalid_audit_limit")
        with self._connection() as db:
            rows = db.execute("SELECT * FROM legal_audit" + (" WHERE document_id=?" if doc_id else "") + " ORDER BY id DESC LIMIT ?", (doc_id, limit) if doc_id else (limit,))
            result = []
            for row in rows:
                item = dict(row)
                item["actor"] = json.loads(item.pop("actor_json"))
                item["detail"] = json.loads(item.pop("detail_json"))
                result.append(item)
            return result

    def export_published(self):
        """Coherent committed snapshots for a worker; never export drafts here."""
        with self._connection() as db:
            db.execute("BEGIN")
            result = []
            for row in db.execute("SELECT * FROM legal_documents ORDER BY id"):
                item = self._document(row)
                item["imported_content"] = json.loads(row["imported_json"])
                current = db.execute("SELECT * FROM legal_publications WHERE document_id=? AND version_id=?", (row["id"], row["published_version"])).fetchone()
                item["published_content"] = json.loads(current["content_json"]) if current else None
                item["published_sha256"] = current["sha256"] if current else None
                item["history"] = [self._history(old, True) for old in db.execute("SELECT * FROM legal_publications WHERE document_id=? ORDER BY recorded_at,version_id", (row["id"],))]
                result.append(item)
            db.commit()
            return {"schema_version": 1, "documents": result}
