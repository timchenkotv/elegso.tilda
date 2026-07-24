#!/usr/bin/env python3
import datetime as dt
import decimal
import json
import re
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

import psycopg2
from psycopg2 import sql


DB_DSN = "dbname=elegso_calc user=elegso_api host=/var/run/postgresql"
MAX_BODY = 2 * 1024 * 1024
SESSION_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
REPORT_MIN_YEAR = 1900
REPORT_MAX_YEAR = 2200
REPORT_DOCUMENT_TITLE_MAX_LENGTH = 160
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
CBR_MIN_DATE = dt.date(2013, 9, 17)
CBR_MAX_RANGE_DAYS = 5000
CBR_SOURCE_PATH = "https://www.cbr.ru/hd_base/KeyRate/"
CBR_SOAP_ENDPOINT = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx"
CBR_SOAP_ACTION = "http://web.cbr.ru/KeyRateXML"
CBR_CACHE_TTL_SECONDS = 6 * 60 * 60
CBR_CACHE_MAX_ENTRIES = 128
CBR_COMMENT_PREFIX = "ЦБ РФ ·"
CBR_CACHE = {}
CBR_CACHE_LOCK = threading.Lock()

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

REPORT_ALL_BALANCE_WITH_CUTOFF_SQL = """
WITH params AS (
    SELECT
        %s::text AS session_id,
        %s::date AS report_date,
        LEAST(%s::date, %s::date) AS cutoff_date
),
events AS (
    SELECT
        a.session_id,
        a.dt,
        a.accrued,
        a.paid,
        a.remains
    FROM all_acc_pay a
    CROSS JOIN params p
    WHERE a.session_id = p.session_id
      AND a.dt <= p.report_date
),
balance_intervals AS (
    SELECT
        a.session_id,
        a.dt,
        a.accrued,
        a.paid,
        a.remains,
        SUM(COALESCE(a.remains, 0::numeric)) OVER (
            PARTITION BY a.session_id
            ORDER BY a.dt
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS balance,
        LEAST(
            COALESCE(
                LEAD(a.dt) OVER (
                    PARTITION BY a.session_id
                    ORDER BY a.dt
                ) - 1,
                p.report_date
            ),
            p.report_date
        ) AS dt_end,
        fn_get_comment(a.session_id, a.dt) AS comment,
        fn_get_indicator_value(a.session_id, 'penalty', a.dt) AS penalty_value,
        fn_get_indicator_unit(a.session_id, 'penalty', a.dt) AS penalty_unit,
        fn_get_indicator_value(a.session_id, 'cb_rate', a.dt) AS cb_rate_value,
        fn_get_indicator_unit(a.session_id, 'cb_rate', a.dt) AS cb_rate_unit,
        fn_get_indicator_value(a.session_id, 'avg_loan_rate', a.dt) AS avg_loan_rate_value,
        fn_get_indicator_unit(a.session_id, 'avg_loan_rate', a.dt) AS avg_loan_rate_unit,
        fn_get_indicator_value(a.session_id, 'yield_rate', a.dt) AS yield_rate_value,
        fn_get_indicator_unit(a.session_id, 'yield_rate', a.dt) AS yield_rate_unit
    FROM events a
    CROSS JOIN params p
),
calculation_intervals AS (
    SELECT
        b.session_id,
        b.dt,
        b.accrued,
        b.paid,
        b.remains,
        b.balance,
        b.dt_end,
        b.comment,
        b.penalty_value,
        b.penalty_unit,
        b.cb_rate_value,
        b.cb_rate_unit,
        b.avg_loan_rate_value,
        b.avg_loan_rate_unit,
        b.yield_rate_value,
        b.yield_rate_unit,
        (
            SELECT COUNT(*)
            FROM generate_series(
                b.dt::timestamp with time zone,
                LEAST(b.dt_end, p.cutoff_date)::timestamp with time zone,
                '1 day'::interval
            ) AS g(day)
            WHERE EXTRACT(isodow FROM g.day) < 6
        ) AS dt_work_days,
        GREATEST(0, LEAST(b.dt_end, p.cutoff_date) - b.dt + 1) AS dt_total_days
    FROM balance_intervals b
    CROSS JOIN params p
)
SELECT
    c.session_id,
    c.dt,
    c.accrued,
    c.paid,
    c.remains,
    c.balance,
    c.dt_end,
    c.comment,
    c.penalty_value,
    c.penalty_unit,
    c.cb_rate_value,
    c.cb_rate_unit,
    c.avg_loan_rate_value,
    c.avg_loan_rate_unit,
    c.yield_rate_value,
    c.yield_rate_unit,
    c.dt_work_days,
    c.dt_total_days,
    fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.penalty_unit,
        c.penalty_value,
        c.balance
    ) AS penalty_amount,
    fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.cb_rate_unit,
        c.cb_rate_value,
        c.balance
    ) AS cb_rate_amount,
    fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.avg_loan_rate_unit,
        c.avg_loan_rate_value,
        c.balance
    ) AS avg_loan_rate_amount,
    fn_calc_amount_of_delay(
        c.dt_work_days,
        c.dt_total_days::bigint,
        c.yield_rate_unit,
        c.yield_rate_value,
        c.balance
    ) AS yield_rate_amount,
    c.dt_total_days AS penalty_quantity,
    c.dt_total_days AS cb_rate_quantity,
    c.dt_total_days AS avg_loan_rate_quantity,
    c.dt_total_days AS yield_rate_quantity,
    COALESCE((
        SELECT d.title_short
        FROM indicator_units d
        WHERE d.code = c.penalty_unit
    ), '') AS penalty_unit_title_short,
    COALESCE((
        SELECT d.title_short
        FROM indicator_units d
        WHERE d.code = c.cb_rate_unit
    ), '') AS cb_rate_unit_title_short,
    COALESCE((
        SELECT d.title_short
        FROM indicator_units d
        WHERE d.code = c.avg_loan_rate_unit
    ), '') AS avg_loan_rate_unit_title_short,
    COALESCE((
        SELECT d.title_short
        FROM indicator_units d
        WHERE d.code = c.yield_rate_unit
    ), '') AS yield_rate_unit_title_short
FROM calculation_intervals c
ORDER BY c.dt ASC
"""


class CbrFetchError(RuntimeError):
    pass


def parse_iso_date(value, label):
    raw = str(value)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raise ValueError(f"Некорректная дата «{label}»")
    try:
        parsed = dt.date.fromisoformat(raw)
    except (TypeError, ValueError):
        raise ValueError(f"Некорректная дата «{label}»")
    if parsed.year < REPORT_MIN_YEAR or parsed.year > REPORT_MAX_YEAR:
        raise ValueError(
            f"Дата «{label}» должна быть в диапазоне "
            f"{REPORT_MIN_YEAR}–{REPORT_MAX_YEAR}"
        )
    return parsed


def validate_session_id(value):
    session_id = str(value or "")
    if not SESSION_RE.fullmatch(session_id):
        raise ValueError("Некорректный session_id")
    return session_id


def parse_report_document_title(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("report_document_title должен быть строкой или null")
    if CONTROL_CHARACTER_RE.search(value):
        raise ValueError(
            "Название документа не должно содержать переводы строк "
            "или управляющие символы"
        )
    title = value.strip()
    if not title:
        return None
    if len(title) > REPORT_DOCUMENT_TITLE_MAX_LENGTH:
        raise ValueError(
            "Название документа не должно быть длиннее "
            f"{REPORT_DOCUMENT_TITLE_MAX_LENGTH} символов"
        )
    return title


def validate_cbr_period(date_from, date_to):
    if date_from < CBR_MIN_DATE:
        raise ValueError("Ключевая ставка доступна с 17.09.2013")
    if date_to > dt.date.today():
        raise ValueError("Нельзя загрузить ключевую ставку за будущий период")
    if date_from > date_to:
        raise ValueError("Дата начала периода позже даты окончания")
    if (date_to - date_from).days > CBR_MAX_RANGE_DAYS:
        raise ValueError("Период загрузки слишком большой")


def xml_local_name(tag):
    return tag.rsplit("}", 1)[-1]


def parse_cbr_key_rate_xml(source):
    try:
        root = ET.fromstring(source)
    except ET.ParseError as exc:
        raise CbrFetchError("Банк России вернул некорректный XML") from exc

    fault = next(
        (element for element in root.iter() if xml_local_name(element.tag) == "faultstring"),
        None,
    )
    if fault is not None:
        raise CbrFetchError("Веб-сервис Банка России вернул ошибку")

    rates = {}
    row_count = 0
    invalid_rows = 0
    for row in root.iter():
        if xml_local_name(row.tag) != "KR":
            continue
        row_count += 1
        values = {
            xml_local_name(child.tag): (child.text or "").strip()
            for child in row
        }
        raw_date = values.get("DT", "")
        raw_value = values.get("Rate", "")
        try:
            # DT is published in Moscow time. Keep its calendar part so that
            # a UTC conversion can never shift the effective date.
            date_value = dt.date.fromisoformat(raw_date[:10])
            rate_value = decimal.Decimal(raw_value.replace(",", "."))
            if not rate_value.is_finite() or rate_value <= 0:
                raise decimal.InvalidOperation
        except (ValueError, decimal.InvalidOperation):
            invalid_rows += 1
            continue
        rates[date_value] = rate_value
    if row_count and invalid_rows:
        raise CbrFetchError("Банк России вернул неполные или некорректные данные")
    return [{"date": date_value, "value": rates[date_value]} for date_value in sorted(rates)]


def cbr_soap_body(date_from, date_to):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <KeyRateXML xmlns="http://web.cbr.ru/">
      <fromDate>{date_from.isoformat()}T00:00:00</fromDate>
      <ToDate>{date_to.isoformat()}T00:00:00</ToDate>
    </KeyRateXML>
  </soap:Body>
</soap:Envelope>""".encode("utf-8")


def fetch_cbr_daily_rates(date_from, date_to):
    cache_key = (date_from.isoformat(), date_to.isoformat())
    now = time.monotonic()
    with CBR_CACHE_LOCK:
        cached = CBR_CACHE.get(cache_key)
        if cached and now - cached["stored_at"] < CBR_CACHE_TTL_SECONDS:
            return cached["rates"], True

    body = cbr_soap_body(date_from, date_to)
    last_error = None
    for attempt in range(2):
        request = Request(
            CBR_SOAP_ENDPOINT,
            data=body,
            method="POST",
            headers={
                "Content-Type": "text/xml; charset=utf-8",
                "SOAPAction": f'"{CBR_SOAP_ACTION}"',
                "User-Agent": "ElegsoKeyRateImporter/1.0 (+https://elegso.ru/)",
                "Accept": "text/xml",
            },
        )
        try:
            with urlopen(request, timeout=25) as response:
                daily_rates = parse_cbr_key_rate_xml(response.read())
            if not daily_rates:
                raise CbrFetchError("Банк России вернул ответ без данных")
            with CBR_CACHE_LOCK:
                expired = [
                    key
                    for key, value in CBR_CACHE.items()
                    if time.monotonic() - value["stored_at"] >= CBR_CACHE_TTL_SECONDS
                ]
                for key in expired:
                    CBR_CACHE.pop(key, None)
                if len(CBR_CACHE) >= CBR_CACHE_MAX_ENTRIES:
                    oldest_key = min(
                        CBR_CACHE,
                        key=lambda key: CBR_CACHE[key]["stored_at"],
                    )
                    CBR_CACHE.pop(oldest_key, None)
                CBR_CACHE[cache_key] = {
                    "stored_at": time.monotonic(),
                    "rates": daily_rates,
                }
            return daily_rates, False
        except CbrFetchError:
            raise
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(0.35)

    raise CbrFetchError("Не удалось получить данные с сайта Банка России") from last_error


def compress_cbr_key_rates(daily_rates, date_from, date_to):
    baseline = [item for item in daily_rates if item["date"] <= date_from]
    if not baseline:
        raise CbrFetchError("Банк России не вернул ставку, действующую на начало периода")

    first = baseline[-1]
    points = [{
        "date": date_from,
        "value": first["value"],
        "source_date": first["date"],
        "period_start": True,
    }]
    current_value = first["value"]
    for item in daily_rates:
        if item["date"] <= date_from or item["date"] > date_to:
            continue
        if item["value"] == current_value:
            continue
        points.append({
            "date": item["date"],
            "value": item["value"],
            "source_date": item["date"],
            "period_start": False,
        })
        current_value = item["value"]
    return points


def fetch_cbr_key_rates(date_from, date_to):
    validate_cbr_period(date_from, date_to)
    query_from = max(CBR_MIN_DATE, date_from - dt.timedelta(days=31))
    daily_rates, cache_hit = fetch_cbr_daily_rates(query_from, date_to)
    points = compress_cbr_key_rates(daily_rates, date_from, date_to)
    selected_daily = [item for item in daily_rates if date_from <= item["date"] <= date_to]
    source_query = urlencode({
        "UniDbQuery.Posted": "True",
        "UniDbQuery.From": date_from.strftime("%d.%m.%Y"),
        "UniDbQuery.To": date_to.strftime("%d.%m.%Y"),
    })
    return {
        "date_from": date_from,
        "date_to": date_to,
        "source_url": f"{CBR_SOURCE_PATH}?{source_query}",
        "source_service": CBR_SOAP_ENDPOINT,
        "cache_hit": cache_hit,
        "daily_rows": len(selected_daily),
        "rates": points,
    }


def cbr_comment(point):
    source_date = point["source_date"].strftime("%d.%m.%Y")
    if point["period_start"] and point["source_date"] != point["date"]:
        return f"{CBR_COMMENT_PREFIX} ставка на начало периода (действует с {source_date})"
    return f"{CBR_COMMENT_PREFIX} официальная ключевая ставка"


def import_cbr_key_rates(session_id, date_from, date_to):
    dataset = fetch_cbr_key_rates(date_from, date_to)
    summary = {
        "official_daily_rows": dataset["daily_rows"],
        "change_points": len(dataset["rates"]),
        "inserted": 0,
        "updated": 0,
        "skipped": 0,
        "removed_placeholders": 0,
        "removed_same_date_duplicates": 0,
        "removed_obsolete_points": 0,
        "removed_redundant_points": 0,
    }

    with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
        # The HTTP server is threaded. Serialize imports for one calculator
        # session so that two simultaneous clicks cannot race and insert the
        # same effective-date point twice.
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))",
            (f"cbr-key-rate:{session_id}",),
        )
        cur.execute(
            """
            SELECT default_unit_code
              FROM indicator_kinds
             WHERE code = 'cb_rate'
            """,
        )
        unit_row = cur.fetchone()
        unit_code = unit_row[0] if unit_row and unit_row[0] else "percent_per_year"

        cur.execute(
            """
            DELETE FROM indicators
             WHERE session_id = %s
               AND kind = 'cb_rate'
               AND dt BETWEEN %s AND %s
               AND value = 0
               AND COALESCE(BTRIM(comment), '') = ''
            RETURNING id
            """,
            (session_id, date_from, date_to),
        )
        summary["removed_placeholders"] = len(cur.fetchall())

        cur.execute(
            """
            SELECT id, dt, value, unit_code, comment
              FROM indicators
             WHERE session_id = %s AND kind = 'cb_rate'
             ORDER BY dt ASC, id ASC
            """,
            (session_id,),
        )
        existing = [
            {
                "id": row[0],
                "date": row[1],
                "value": decimal.Decimal(row[2]),
                "unit_code": row[3],
                "comment": row[4],
            }
            for row in cur.fetchall()
        ]

        # The selected interval is authoritative: keep only official effective
        # dates there. Rows outside the user's chosen interval remain intact.
        desired_dates = {point["date"] for point in dataset["rates"]}
        obsolete_ids = [
            row["id"]
            for row in existing
            if date_from <= row["date"] <= date_to
            and row["date"] not in desired_dates
        ]
        if obsolete_ids:
            cur.execute("DELETE FROM indicators WHERE id = ANY(%s)", (obsolete_ids,))
            summary["removed_obsolete_points"] = len(obsolete_ids)
            existing = [row for row in existing if row["id"] not in obsolete_ids]

        for point in dataset["rates"]:
            point_date = point["date"]
            point_value = decimal.Decimal(point["value"])
            same_date = sorted(
                [row for row in existing if row["date"] == point_date],
                key=lambda row: (
                    str(row["comment"] or "").startswith(CBR_COMMENT_PREFIX),
                    row["id"],
                ),
            )
            source_comment = cbr_comment(point)

            if same_date:
                keep = same_date[0]
                duplicate_ids = [row["id"] for row in same_date[1:]]
                if duplicate_ids:
                    cur.execute("DELETE FROM indicators WHERE id = ANY(%s)", (duplicate_ids,))
                    summary["removed_same_date_duplicates"] += len(duplicate_ids)
                    existing = [row for row in existing if row["id"] not in duplicate_ids]

                next_comment = keep["comment"]
                if not next_comment or str(next_comment).startswith(CBR_COMMENT_PREFIX):
                    next_comment = source_comment
                changed = (
                    keep["value"] != point_value
                    or keep["unit_code"] != unit_code
                    or keep["comment"] != next_comment
                )
                if changed:
                    cur.execute(
                        """
                        UPDATE indicators
                           SET value = %s, unit_code = %s, comment = %s
                         WHERE id = %s AND session_id = %s AND kind = 'cb_rate'
                        """,
                        (point_value, unit_code, next_comment, keep["id"], session_id),
                    )
                    keep.update(value=point_value, unit_code=unit_code, comment=next_comment)
                    summary["updated"] += 1
                else:
                    summary["skipped"] += 1
                continue

            previous = [row for row in existing if row["date"] < point_date]
            previous_row = previous[-1] if previous else None
            if (
                previous_row
                and previous_row["value"] == point_value
                and previous_row["unit_code"] == unit_code
            ):
                summary["skipped"] += 1
                continue

            cur.execute(
                """
                INSERT INTO indicators (session_id, kind, dt, value, unit_code, comment)
                VALUES (%s, 'cb_rate', %s, %s, %s, %s)
                RETURNING id
                """,
                (session_id, point_date, point_value, unit_code, source_comment),
            )
            new_row = {
                "id": cur.fetchone()[0],
                "date": point_date,
                "value": point_value,
                "unit_code": unit_code,
                "comment": source_comment,
            }
            existing.append(new_row)
            existing.sort(key=lambda row: (row["date"], row["id"]))
            summary["inserted"] += 1

        # An overlapping import can start earlier than a previous import. In
        # that case the old synthetic "start of period" row may become
        # redundant. Remove only our generated row, never a user's manual row.
        previous_row = None
        for row in sorted(existing, key=lambda item: (item["date"], item["id"])):
            generated = str(row["comment"] or "").startswith(CBR_COMMENT_PREFIX)
            if (
                previous_row
                and generated
                and date_from <= row["date"] <= date_to
                and row["value"] == previous_row["value"]
                and row["unit_code"] == previous_row["unit_code"]
            ):
                cur.execute(
                    """
                    DELETE FROM indicators
                     WHERE id = %s AND session_id = %s AND kind = 'cb_rate'
                    """,
                    (row["id"], session_id),
                )
                summary["removed_redundant_points"] += 1
                continue
            previous_row = row

        conn.commit()

    return {
        **dataset,
        "summary": summary,
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

    def report_query(self, allowed):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        unknown = set(query) - set(allowed)
        if unknown:
            raise ValueError(f"Недопустимый параметр: {sorted(unknown)[0]}")
        for name, required in allowed.items():
            values = query.get(name)
            if values is not None and len(values) != 1:
                raise ValueError(f"Параметр {name} должен быть указан один раз")
            if required and (not values or values[0] == ""):
                raise ValueError(f"Не указан параметр {name}")
        return {name: query.get(name, [""])[0] for name in allowed}

    def get_report_settings(self):
        query = self.report_query({"session_id": True})
        session_id = validate_session_id(query["session_id"])
        with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT indicator_cutoff_date, report_document_title
                  FROM calculation_settings
                 WHERE session_id = %s
                """,
                (session_id,),
            )
            row = cur.fetchone()
        self.send_json(200, {
            "session_id": session_id,
            "indicator_cutoff_date": row[0] if row else None,
            "report_document_title": row[1] if row else None,
        })

    def get_all_balance_report(self):
        query = self.report_query({
            "session_id": True,
            "report_date": True,
            "indicator_cutoff_date": False,
        })
        session_id = validate_session_id(query["session_id"])
        report_date = parse_iso_date(query["report_date"], "дата отчёта")
        cutoff_raw = query["indicator_cutoff_date"]
        cutoff_date = (
            parse_iso_date(cutoff_raw, "рассчитывать показатели по")
            if cutoff_raw
            else None
        )
        if cutoff_date is not None and cutoff_date > report_date:
            raise ValueError(
                "Дата «рассчитывать показатели по» "
                "не может быть позже даты отчёта"
            )

        with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
            cur.execute("SET LOCAL statement_timeout = '15s'")
            if cutoff_date is None:
                # Preserve the original report semantics when the optional
                # cutoff is empty: this is the same view, filter and ordering
                # that the browser used before this endpoint was introduced.
                cur.execute(
                    """
                    SELECT *
                      FROM all_balance
                     WHERE session_id = %s
                       AND dt <= %s
                     ORDER BY dt ASC
                    """,
                    (session_id, report_date),
                )
            else:
                cur.execute(
                    REPORT_ALL_BALANCE_WITH_CUTOFF_SQL,
                    (session_id, report_date, cutoff_date, report_date),
                )
            rows = rows_as_dicts(cur)
        self.send_json(200, rows)

    def do_GET(self):
        request_path = urlparse(self.path).path
        if request_path == "/health":
            try:
                with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
                    cur.execute("SELECT 1")
                self.send_json(200, {"status": "ok"})
            except Exception:
                self.send_json(503, {"status": "error"})
            return
        if request_path == "/report/settings":
            try:
                self.get_report_settings()
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.log_error("Report settings GET failed: %s", exc)
                self.send_json(500, {"error": "Ошибка загрузки настроек отчёта"})
            return
        if request_path == "/report/all-balance":
            try:
                self.get_all_balance_report()
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.log_error("All-balance report GET failed: %s", exc)
                self.send_json(500, {"error": "Ошибка формирования отчёта"})
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
        if urlparse(self.path).path == "/cbr/key-rate/import":
            try:
                payload = self.read_body()
                if not isinstance(payload, dict):
                    raise ValueError("Некорректный запрос")
                session_id = str(payload.get("session_id", ""))
                if not SESSION_RE.fullmatch(session_id):
                    raise ValueError("Некорректный session_id")
                date_from = parse_iso_date(payload.get("from"), "с")
                date_to = parse_iso_date(payload.get("to"), "по")
                self.send_json(200, import_cbr_key_rates(session_id, date_from, date_to))
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json(400, {"error": str(exc)})
            except CbrFetchError as exc:
                self.send_json(502, {"error": str(exc)})
            except Exception as exc:
                self.log_error("CBR import failed: %s", exc)
                self.send_json(500, {"error": "Ошибка импорта ключевой ставки"})
            return
        self.mutate("insert")

    def do_PUT(self):
        if urlparse(self.path).path != "/report/settings":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            payload = self.read_body()
            if not isinstance(payload, dict):
                raise ValueError("Некорректный запрос")
            allowed_fields = {
                "session_id",
                "indicator_cutoff_date",
                "report_document_title",
            }
            settings_fields = {
                "indicator_cutoff_date",
                "report_document_title",
            }
            payload_fields = set(payload)
            if (
                "session_id" not in payload_fields
                or payload_fields - allowed_fields
                or not payload_fields.intersection(settings_fields)
            ):
                raise ValueError("Некорректные поля настроек")
            session_id = validate_session_id(payload["session_id"])
            cutoff_present = "indicator_cutoff_date" in payload
            title_present = "report_document_title" in payload

            cutoff_date = None
            if cutoff_present:
                cutoff_raw = payload["indicator_cutoff_date"]
                if cutoff_raw is None:
                    cutoff_date = None
                elif isinstance(cutoff_raw, str) and cutoff_raw:
                    cutoff_date = parse_iso_date(
                        cutoff_raw,
                        "рассчитывать показатели по",
                    )
                else:
                    raise ValueError(
                        "indicator_cutoff_date должен быть датой или null"
                    )

            report_document_title = (
                parse_report_document_title(payload["report_document_title"])
                if title_present
                else None
            )

            with psycopg2.connect(DB_DSN) as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO calculation_settings (
                        session_id,
                        indicator_cutoff_date,
                        report_document_title,
                        updated_at
                    )
                    VALUES (%s, %s, %s, now())
                    ON CONFLICT (session_id) DO UPDATE
                       SET indicator_cutoff_date = CASE
                               WHEN %s THEN EXCLUDED.indicator_cutoff_date
                               ELSE calculation_settings.indicator_cutoff_date
                           END,
                           report_document_title = CASE
                               WHEN %s THEN EXCLUDED.report_document_title
                               ELSE calculation_settings.report_document_title
                           END,
                           updated_at = now()
                    RETURNING
                        session_id,
                        indicator_cutoff_date,
                        report_document_title
                    """,
                    (
                        session_id,
                        cutoff_date,
                        report_document_title,
                        cutoff_present,
                        title_present,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
            self.send_json(200, {
                "session_id": row[0],
                "indicator_cutoff_date": row[1],
                "report_document_title": row[2],
            })
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.log_error("Report settings PUT failed: %s", exc)
            self.send_json(500, {"error": "Ошибка сохранения настроек отчёта"})

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
