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

import difflib
import re
import time
from pathlib import Path

import yaml
from hdbcli import dbapi

from logging_config import log_error, log_sql

CONFIG_PATH = Path(__file__).parent / "config.yaml"

_CONFIG = None
_CONFIG_VALIDATED = False


# =====================================================
# CONFIGURATION
# =====================================================


def load_config():
    global _CONFIG

    if _CONFIG is None:
        with open(CONFIG_PATH) as file:
            _CONFIG = yaml.safe_load(file) or {}
        validate_config(_CONFIG)

    return _CONFIG


def load_security():
    return load_config().get("security", {})


def validate_config(config: dict | None = None) -> dict:
    """Validate required config fields and fail with clear errors."""
    global _CONFIG_VALIDATED
    if config is None:
        config = load_config()
    if _CONFIG_VALIDATED and config is _CONFIG:
        return config

    if not isinstance(config, dict):
        raise ValueError("config.yaml must contain a mapping/object at the root.")

    hana = config.get("hana")
    if not isinstance(hana, dict):
        raise ValueError("config.yaml: missing required 'hana' section.")
    for key in ("address", "port", "user", "password"):
        if key not in hana or hana.get(key) in (None, ""):
            raise ValueError(f"config.yaml: hana.{key} is required.")
    try:
        int(hana.get("port"))
    except Exception as error:
        raise ValueError("config.yaml: hana.port must be an integer.") from error

    security = config.get("security", {})
    if security is None:
        security = {}
    if not isinstance(security, dict):
        raise ValueError("config.yaml: 'security' must be a mapping when provided.")
    allowed_statements = security.get("allowed_statements", ["SELECT", "WITH"])
    if not isinstance(allowed_statements, list) or not all(
        isinstance(x, str) and x.strip() for x in allowed_statements
    ):
        raise ValueError("config.yaml: security.allowed_statements must be a non-empty list of strings.")
    blocked_keywords = security.get("blocked_keywords", [])
    if not isinstance(blocked_keywords, list):
        raise ValueError("config.yaml: security.blocked_keywords must be a list when provided.")

    monitoring = config.get("monitoring", {})
    if monitoring is None:
        monitoring = {}
    if not isinstance(monitoring, dict):
        raise ValueError("config.yaml: 'monitoring' must be a mapping/object.")
    for name, tool in monitoring.items():
        if not isinstance(tool, dict):
            raise ValueError(f"config.yaml: monitoring.{name} must be a mapping/object.")
        query = tool.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError(f"config.yaml: monitoring.{name}.query is required and must be a non-empty SQL string.")
        inputs = tool.get("inputs", [])
        if inputs is None:
            inputs = []
        if not isinstance(inputs, list):
            raise ValueError(f"config.yaml: monitoring.{name}.inputs must be a list when provided.")
        for idx, inp in enumerate(inputs):
            if not isinstance(inp, dict) or not inp.get("name"):
                raise ValueError(f"config.yaml: monitoring.{name}.inputs[{idx}] must include a 'name'.")

    if config is _CONFIG:
        _CONFIG_VALIDATED = True
    return config


def get_connection():
    hana = load_config()["hana"]

    try:
        return dbapi.connect(
            address=hana["address"],
            port=int(hana["port"]),
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


_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")
_FUNCTION_FROM_RE = re.compile(
    r"\b(EXTRACT|TRIM|SUBSTRING)\s*\(([^()]*?)\bFROM\b", re.IGNORECASE
)
_CTE_NAME_RE = re.compile(r'(?:\bWITH|,)\s*"?([A-Z0-9_]+)"?\s+AS\s*\(')


def extract_objects(sql):
    """Return the table/view names referenced after FROM/JOIN.

    String literals, ``EXTRACT(x FROM y)``-style function syntax and CTE
    names are ignored so they are not mistaken for database objects.
    """
    text = _STRING_LITERAL_RE.sub("''", sql)
    text = _FUNCTION_FROM_RE.sub(r"\1(\2,", text).upper()
    cte_names = set(_CTE_NAME_RE.findall(text))
    return [
        name
        for name in re.findall(r'\b(?:FROM|JOIN)\s+([A-Z0-9_\."]+)', text)
        if normalize_object(name) not in cte_names
    ]


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


_CATALOG_SCHEMAS = ("SYS", "_SYS_STATISTICS")
_CATALOG_NAMES: dict[str, str] | None = None


def _catalog_names(cursor) -> dict[str, str]:
    """Return ``{object_name: schema}`` for the HANA system catalogs (cached)."""
    global _CATALOG_NAMES
    if _CATALOG_NAMES is None:
        cursor.execute(
            """
            SELECT SCHEMA_NAME, TABLE_NAME FROM SYS.TABLES
            WHERE SCHEMA_NAME IN ('SYS', '_SYS_STATISTICS')
            UNION
            SELECT SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS
            WHERE SCHEMA_NAME IN ('SYS', '_SYS_STATISTICS')
            """
        )
        names: dict[str, str] = {}
        for schema, name in cursor.fetchall():
            # Prefer SYS when a name exists in both catalogs.
            if name not in names or schema == "SYS":
                names[name] = schema
        _CATALOG_NAMES = names
    return _CATALOG_NAMES


def suggest_objects(cursor, name: str, limit: int = 5) -> list[str]:
    """Return real, schema-qualified system objects resembling ``name``."""
    try:
        catalog = _catalog_names(cursor)
    except Exception:
        return []
    bare = name.split(".")[-1]
    stem = re.sub(r"^(SYS_|M_)", "", bare)
    stem = stem[:-1] if stem.endswith("S") else stem

    ranked = difflib.get_close_matches(bare, catalog, n=limit, cutoff=0.7)
    if len(stem) >= 3:
        containing = [n for n in catalog if stem in n]
        # Shortest names first: USERS before USER_PARAMETERS.
        ranked = sorted(containing, key=lambda n: (len(n), n))[:limit] + ranked
    # Long guessed names (M_DATABASE_BACKUP_CONFIG): rank by shared words.
    words = {w for w in bare.split("_") if len(w) >= 4}
    if words:
        scored = [
            (len(words & set(n.split("_"))), n) for n in catalog
        ]
        by_words = sorted(
            ((score, n) for score, n in scored if score),
            key=lambda item: (-item[0], len(item[1]), item[1]),
        )
        ranked += [n for _, n in by_words[:limit]]
    seen: list[str] = []
    for candidate in ranked:
        qualified = f"{catalog[candidate]}.{candidate}"
        if qualified not in seen:
            seen.append(qualified)
    return seen[:limit]


def _unknown_object_error(cursor, obj: str) -> ValueError:
    suggestions = suggest_objects(cursor, obj)
    message = f"Unknown HANA object: {obj}."
    if suggestions:
        message += f" Did you mean: {', '.join(suggestions)}?"
    stem = re.sub(r"^(SYS_|M_)", "", obj.split(".")[-1])
    message += (
        " To find the right name run: SELECT SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS"
        f" WHERE VIEW_NAME LIKE '%{stem}%'"
    )
    return ValueError(message)


def validate_objects(cursor, sql):
    """Check that every referenced object exists; return the (possibly fixed) SQL.

    The one automatic fix is the common ``SYS_USERS`` typo for ``SYS.USERS``:
    when ``SYS_<X>`` does not exist but ``SYS.<X>`` does, the reference is
    rewritten. Anything else unknown raises with suggestions of real objects.
    """
    for obj in extract_objects(sql):
        obj = normalize_object(obj)

        parts = obj.split(".")

        if len(parts) == 2:
            schema = parts[0]
            name = parts[1]
        else:
            schema = None
            name = parts[0]

        if object_exists(cursor, schema, name):
            continue

        if schema is None and name.startswith("SYS_") and object_exists(
            cursor, "SYS", name[4:]
        ):
            pattern = re.compile(
                rf'(?<![\w."]){re.escape(name)}(?![\w"])', re.IGNORECASE
            )
            # Rewrite only outside string literals.
            pieces = re.split(r"('(?:[^']|'')*')", sql)
            sql = "".join(
                piece if piece.startswith("'") else pattern.sub(f"SYS.{name[4:]}", piece)
                for piece in pieces
            )
            continue

        raise _unknown_object_error(cursor, obj)

    return sql


def _column_hint(cursor, sql: str, error: Exception) -> str:
    """For an 'invalid column name' error, list the real columns (best effort)."""
    if "invalid column name" not in str(error).lower():
        return ""
    hints = []
    try:
        for obj in extract_objects(sql)[:2]:
            parts = normalize_object(obj).split(".")
            name = parts[-1]
            schema = parts[0] if len(parts) == 2 else None
            cursor.execute(
                """
                SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
                WHERE TABLE_NAME = ? AND (? IS NULL OR SCHEMA_NAME = ?)
                UNION
                SELECT COLUMN_NAME FROM SYS.VIEW_COLUMNS
                WHERE VIEW_NAME = ? AND (? IS NULL OR SCHEMA_NAME = ?)
                """,
                (name, schema, schema, name, schema, schema),
            )
            columns = sorted({row[0] for row in cursor.fetchall()})
            if columns:
                shown = ", ".join(columns[:60])
                more = f" (+{len(columns) - 60} more)" if len(columns) > 60 else ""
                hints.append(f"Columns of {normalize_object(obj)}: {shown}{more}.")
    except Exception:
        return ""
    return " " + " ".join(hints) if hints else ""


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
        sql = validate_objects(cursor, sql)

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
            "sql": sql,
            "row_count": row_count,
            "execution_ms": round((time.perf_counter() - start) * 1000, 2),
        }

    except Exception as error:
        log_error(tool, str(error))
        hint = _column_hint(cursor, sql, error) if cursor else ""
        raise RuntimeError(f"HANA query failed: {error}{hint}") from error

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
