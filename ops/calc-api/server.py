#!/usr/bin/env python3
import datetime as dt
import decimal
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import psycopg2
from psycopg2 import sql


DB_DSN = "dbname=elegso_calc user=elegso_api host=/var/run/postgresql"
MAX_BODY = 2 * 1024 * 1024
SESSION_RE = re.compile(r"^[0-9a-fA-F-]{36}$")

TABLES = {
    "accruals": {
        "read": ("id", "session_id", "dt", "amount", "comment", "created_at"),
        "write": ("session_id", "dt", "amount", "comment"),
        "filters": ("id", "session_id", "dt"),
    },
    "payments": {
        "read": ("id", "session_id", "dt", "amount", "comment", "created_at"),
        "write": ("session_id", "dt", "amount", "comment"),
        "filters": ("id", "session_id", "dt"),
    },
    "indicators": {
        "read": ("id", "session_id", "kind", "dt", "value", "unit_code", "comment", "created_at"),
        "write": ("session_id", "kind", "dt", "value", "unit_code", "comment"),
        "filters": ("id", "session_id", "kind", "dt"),
    },
    "indicator_kinds": {
        "read": ("code", "title", "title_short", "description", "default_unit_code"),
        "write": (),
        "filters": ("code",),
    },
    "indicator_units": {
        "read": ("code", "title", "title_short", "description"),
        "write": (),
        "filters": ("code",),
    },
    "all_balance": {
        "read": None,
        "write": (),
        "filters": ("session_id", "dt"),
    },
}


def json_default(value):
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def rows_as_dicts(cursor):
    names = [item.name for item in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "ElegsoCalcAPI/1.0"

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def table_name(self):
        match = re.fullmatch(r"/rest/v1/([a-z_]+)", urlparse(self.path).path)
        if not match or match.group(1) not in TABLES:
            return None
        return match.group(1)

    def query_parts(self, table):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        clauses, values = [], []
        for key, raw_values in query.items():
            if key in ("select", "order", "limit"):
                continue
            if key not in TABLES[table]["filters"] or len(raw_values) != 1:
                raise ValueError(f"Недопустимый фильтр: {key}")
            raw = raw_values[0]
            if "." not in raw:
                raise ValueError(f"Недопустимое условие: {key}")
            operator, value = raw.split(".", 1)
            sql_operator = {"eq": "=", "lte": "<=", "gte": ">="}.get(operator)
            if not sql_operator:
                raise ValueError(f"Недопустимый оператор: {operator}")
            if key == "session_id" and not SESSION_RE.fullmatch(value):
                raise ValueError("Некорректный session_id")
            clauses.append(sql.SQL("{} {} %s").format(sql.Identifier(key), sql.SQL(sql_operator)))
            values.append(value)
        where = sql.SQL(" WHERE ") + sql.SQL(" AND ").join(clauses) if clauses else sql.SQL("")

        order = sql.SQL("")
        if query.get("order"):
            raw_order = query["order"][0].split(",", 1)[0]
            parts = raw_order.split(".")
            column = parts[0]
            direction = parts[1] if len(parts) > 1 else "asc"
            readable = TABLES[table]["read"]
            if column not in (readable or ("dt",)) or direction not in ("asc", "desc"):
                raise ValueError("Некорректная сортировка")
            order = sql.SQL(" ORDER BY {} {}").format(sql.Identifier(column), sql.SQL(direction.upper()))
        limit = 0 if query.get("limit", [""])[0] == "0" else None
        return where, values, order, limit

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Некорректный Content-Length")
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Некорректный размер запроса")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            try:
                with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
                    cur.execute("SELECT 1")
                self.send_json(200, {"status": "ok"})
            except Exception:
                self.send_json(503, {"status": "error"})
            return
        table = self.table_name()
        if not table:
            self.send_json(404, {"error": "Not found"})
            return
        try:
            if table in ("accruals", "payments", "indicators", "all_balance") and "session_id=eq." not in urlparse(self.path).query:
                raise ValueError("Для чтения требуется session_id")
            where, values, order, limit = self.query_parts(table)
            with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
                count_query = sql.SQL("SELECT count(*) FROM {}{}").format(sql.Identifier(table), where)
                cur.execute(count_query, values)
                total = cur.fetchone()[0]
                columns = TABLES[table]["read"]
                select_columns = sql.SQL("*") if columns is None else sql.SQL(",").join(map(sql.Identifier, columns))
                query = sql.SQL("SELECT {} FROM {}{}{}").format(select_columns, sql.Identifier(table), where, order)
                if limit == 0:
                    rows = []
                else:
                    cur.execute(query, values)
                    rows = rows_as_dicts(cur)
            self.send_json(200, rows, {"Content-Range": f"0-{max(0, len(rows)-1)}/{total}"})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.log_error("GET failed: %s", exc)
            self.send_json(500, {"error": "Ошибка базы данных"})

    def do_POST(self):
        self.mutate("insert")

    def do_PATCH(self):
        self.mutate("update")

    def do_DELETE(self):
        self.mutate("delete")

    def mutate(self, action):
        table = self.table_name()
        if not table or not TABLES[table]["write"]:
            self.send_json(404, {"error": "Not found"})
            return
        try:
            with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
                if action == "insert":
                    payload = self.read_body()
                    items = payload if isinstance(payload, list) else [payload]
                    if not items or len(items) > 1000:
                        raise ValueError("Некорректное число строк")
                    result = []
                    for item in items:
                        if not isinstance(item, dict):
                            raise ValueError("Строка должна быть объектом")
                        unknown = set(item) - set(TABLES[table]["write"])
                        if unknown or "session_id" not in item or not SESSION_RE.fullmatch(str(item["session_id"])):
                            raise ValueError("Некорректные поля строки")
                        columns = list(item)
                        query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING {}").format(
                            sql.Identifier(table),
                            sql.SQL(",").join(map(sql.Identifier, columns)),
                            sql.SQL(",").join(sql.Placeholder() * len(columns)),
                            sql.SQL(",").join(map(sql.Identifier, TABLES[table]["read"])),
                        )
                        cur.execute(query, [item[column] for column in columns])
                        result.extend(rows_as_dicts(cur))
                    conn.commit()
                    self.send_json(201, result)
                    return

                where, values, _, _ = self.query_parts(table)
                if not values or "session_id=eq." not in urlparse(self.path).query:
                    raise ValueError("Для изменения требуется session_id")
                if action == "delete":
                    cur.execute(sql.SQL("DELETE FROM {}{}").format(sql.Identifier(table), where), values)
                    conn.commit()
                    self.send_json(204, [])
                    return

                payload = self.read_body()
                if not isinstance(payload, dict) or not payload:
                    raise ValueError("Пустое изменение")
                unknown = set(payload) - set(TABLES[table]["write"])
                if unknown or "session_id" in payload:
                    raise ValueError("Некорректные поля изменения")
                assignments = sql.SQL(",").join(
                    sql.SQL("{} = %s").format(sql.Identifier(column)) for column in payload
                )
                returning = sql.SQL(",").join(map(sql.Identifier, TABLES[table]["read"]))
                query = sql.SQL("UPDATE {} SET {}{} RETURNING {}").format(
                    sql.Identifier(table), assignments, where, returning
                )
                cur.execute(query, list(payload.values()) + values)
                rows = rows_as_dicts(cur)
                conn.commit()
                self.send_json(200, rows)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.log_error("%s failed: %s", action, exc)
            self.send_json(500, {"error": "Ошибка базы данных"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8783), ApiHandler).serve_forever()
