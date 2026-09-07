"""SAP HANA query engine.

Safe, read-only SQL execution with:

- Validation (statement allow-list, blocked keywords, single-statement rule)
- Object existence checks before touching HANA
- Automatic schema qualification for system statistics views
- Automatic row limiting (``SELECT *`` -> ``SELECT TOP N *``)
- Execution timing and row count
- Statement timeout (server-side, best-effort)
- Query logging (``logs/sql.log``, ``logs/errors.log``)
"""

import re
import time
from pathlib import Path

import yaml
from hdbcli import dbapi

from logging_config import log_error, log_sql

CONFIG_PATH = Path(__file__).parent / "config.yaml"

_CONFIG = None


# =====================================================
# CONFIGURATION
# =====================================================


def load_config():
    global _CONFIG

    if _CONFIG is None:
        with open(CONFIG_PATH) as file:
            _CONFIG = yaml.safe_load(file)

    return _CONFIG


def load_security():
    return load_config().get("security", {})


def get_connection():
    hana = load_config()["hana"]

    try:
        return dbapi.connect(
            address=hana["address"],
            port=hana["port"],
            user=hana["user"],
            password=hana["password"],
        )

    except Exception as error:
        raise RuntimeError(f"HANA connection failed: {error}") from error


def get_max_rows() -> int:
    """Maximum rows a query is allowed to return (from security config)."""
    try:
        return int(load_security().get("max_rows", 1000))
    except (TypeError, ValueError):
        return 1000


def get_timeout_seconds() -> int | None:
    """Statement timeout in seconds (from security config)."""
    return load_security().get("timeout_seconds")


# =====================================================
# SQL VALIDATION
# =====================================================


def validate_sql(sql):
    if not sql or not sql.strip():
        raise ValueError("SQL query is empty")

    query = sql.strip()
    upper = query.upper()

    statement = upper.split()[0]

    security = load_security()

    allowed_statements = security.get("allowed_statements", ["SELECT", "WITH"])

    if statement not in allowed_statements:
        raise ValueError(f"Statement {statement} is not allowed")

    if ";" in query[:-1]:
        raise ValueError("Multiple SQL statements are forbidden")

    if security.get("readonly", True):
        blocked = security.get("blocked_keywords", [])

        for keyword in blocked:
            if re.search(rf"\b{keyword}\b", upper):
                raise ValueError(f"Read-only restriction: {keyword}")


def apply_row_limit(sql: str, max_rows: int | None) -> str:
    """Rewrite ``SELECT *`` into ``SELECT TOP N *`` when no explicit limit exists.

    Prevents a bare ``SELECT * FROM M_EXPENSIVE_STATEMENTS`` from returning
    millions of rows. Existing ``TOP`` / ``LIMIT`` clauses are respected.
    """
    if not max_rows or max_rows <= 0:
        return sql

    upper = sql.strip().upper()

    if re.search(r"\bTOP\s+\d+", upper) or re.search(r"\bLIMIT\s+\d+", upper):
        return sql

    if re.match(r"^\s*SELECT\s+\*\s", sql, re.IGNORECASE) or re.match(
        r"^\s*SELECT\s+\*$", sql, re.IGNORECASE
    ):
        return re.sub(
            r"^\s*SELECT\s+",
            f"SELECT TOP {int(max_rows)} ",
            sql,
            count=1,
            flags=re.IGNORECASE,
        )

    return sql


def _apply_statement_timeout(cursor, timeout_seconds) -> None:
    """Best-effort server-enforced statement timeout via HANA session variable."""
    if not timeout_seconds or timeout_seconds <= 0:
        return
    try:
        cursor.execute(
            f"SET SESSION APPLICATION_TIMEOUT = {int(timeout_seconds * 1_000_000)}"
        )
    except Exception:
        # Some HANA versions/users do not allow this; ignore silently.
        pass


# =====================================================
# OBJECT EXTRACTION / VALIDATION
# =====================================================


def extract_objects(sql):
    return re.findall(r'\b(?:FROM|JOIN)\s+([A-Z0-9_\."]+)', sql.upper())


def normalize_object(value):
    return value.replace('"', "").strip().upper()


def resolve_object_schema(cursor, name):
    """Resolve an unqualified object name to a unique schema.

    Returns the schema name when ``name`` exists as a table or view in exactly
    one schema, otherwise ``None`` (ambiguous or missing). This lets us qualify
    references to system statistics tables (e.g. ``_SYS_STATISTICS``) that the
    connected user's default schema cannot resolve.
    """
    cursor.execute(
        """
        SELECT SCHEMA_NAME
        FROM (
            SELECT SCHEMA_NAME, TABLE_NAME AS OBJECT_NAME FROM SYS.TABLES
            UNION ALL
            SELECT SCHEMA_NAME, VIEW_NAME AS OBJECT_NAME FROM SYS.VIEWS
            UNION ALL
            SELECT SCHEMA_NAME, OBJECT_NAME FROM SYS.OBJECTS
            WHERE OBJECT_TYPE IN ('SYNONYM')
        )
        WHERE OBJECT_NAME = ?
        """,
        (name,),
    )
    schemas = {row[0] for row in cursor.fetchall()}
    if len(schemas) == 1:
        return schemas.pop()
    return None


# Regex to locate FROM/JOIN object references (optionally schema-qualified).
_OBJECT_REF_RE = re.compile(
    r'\b(?:FROM|JOIN)\s+((?:"[^"]+"\s*\.\s*"[^"]+"|'
    r"[A-Z0-9_]+\.[A-Z0-9_]+)|"
    r"[A-Z0-9_]+)",
    re.IGNORECASE,
)


def qualify_sql_objects(sql, cursor):
    """Rewrite unqualified FROM/JOIN references to include their unique schema.

    Prevents HANA error 259 ("Could not find table/view X in schema <default>")
    when a query references a system statistics table without the schema prefix.
    """

    def replace(match):
        ref = match.group(1)
        if "." in ref:
            # Already schema-qualified; leave untouched.
            return match.group(0)
        name = ref.replace('"', "").strip().upper()
        schema = resolve_object_schema(cursor, name)
        if schema:
            return f"{match.group(0)[: match.start(1) - match.start(0)]}{schema}.{name}"
        return match.group(0)

    return _OBJECT_REF_RE.sub(replace, sql)


def object_exists(cursor, schema, name):
    cursor.execute(
        """
        SELECT COUNT(*)
        FROM SYS.TABLES
        WHERE TABLE_NAME = ?
        AND (? IS NULL OR SCHEMA_NAME = ?)

        UNION ALL

        SELECT COUNT(*)
        FROM SYS.VIEWS
        WHERE VIEW_NAME = ?
        AND (? IS NULL OR SCHEMA_NAME = ?)
        """,
        (name, schema, schema, name, schema, schema),
    )

    return any(row[0] > 0 for row in cursor.fetchall())


def validate_objects(cursor, sql):
    objects = extract_objects(sql)

    for obj in objects:
        obj = normalize_object(obj)

        parts = obj.split(".")

        if len(parts) == 2:
            schema = parts[0]
            name = parts[1]
        else:
            schema = None
            name = parts[0]

        if not object_exists(cursor, schema, name):
            raise ValueError(f"Unknown HANA object: {obj}")


# =====================================================
# QUERY EXECUTION
# =====================================================


def execute_query(
    sql: str,
    parameters: tuple | list | None = None,
    max_rows: int | None = None,
    timeout_seconds: int | None = None,
    tool: str = "hana_execute_query",
) -> dict:
    """Execute a validated read-only query against HANA.

    Returns::

        {
            "rows": [ {column: value, ...}, ... ],
            "row_count": 25,
            "execution_ms": 12.34
        }
    """
    validate_sql(sql)

    if max_rows is None:
        max_rows = get_max_rows()

    sql = apply_row_limit(sql, max_rows)

    connection = None
    cursor = None
    start = time.perf_counter()
    success = False
    row_count = 0

    try:
        connection = get_connection()
        cursor = connection.cursor()

        # Enforce a server-side statement timeout when configured.
        _apply_statement_timeout(
            cursor,
            timeout_seconds if timeout_seconds is not None else get_timeout_seconds(),
        )

        # Validate that referenced objects exist before touching HANA.
        validate_objects(cursor, sql)

        # Qualify unqualified system/statistics references so HANA resolves
        # them to the correct schema (avoids error 259 in the default schema).
        sql = qualify_sql_objects(sql, cursor)

        if parameters:
            cursor.execute(sql, parameters)
        else:
            cursor.execute(sql)

        if cursor.description:
            columns = [column[0] for column in cursor.description]
            rows = cursor.fetchall()
            row_count = len(rows)
        else:
            columns = []
            rows = []

        success = True

        return {
            "rows": [dict(zip(columns, row)) for row in rows],
            "row_count": row_count,
            "execution_ms": round((time.perf_counter() - start) * 1000, 2),
        }

    except Exception as error:
        log_error(tool, str(error))
        raise RuntimeError(f"HANA query failed: {error}") from error

    finally:
        execution_ms = round((time.perf_counter() - start) * 1000, 2)
        log_sql(tool, sql, execution_ms, row_count, success)

        if cursor:
            cursor.close()

        if connection:
            connection.close()


def query_rows(
    sql: str,
    parameters: tuple | list | None = None,
    **kwargs,
) -> list:
    """Execute a query and return only the row list (legacy convenience)."""
    return execute_query(sql, parameters, **kwargs)["rows"]
