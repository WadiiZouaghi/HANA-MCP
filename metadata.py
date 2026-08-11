"""
SAP HANA metadata discovery and inspection.

Provides cached discovery of schemas, tables, views and columns plus enriched
object descriptions (object type, primary keys, indexes, comments where the
connected user has access).

Metadata is cached for 5 minutes (TTL) because it changes rarely.
"""

import time
from functools import wraps
from typing import Any, Optional

from engine import execute_query, query_rows


# =====================================================
# SIMPLE TTL CACHE
# =====================================================

_CACHE: dict[str, tuple[float, Any]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes


def _cached(key: str, loader):
    """Return cached value for ``key`` or compute via ``loader``.

    Never raises: on a loader failure the cache is bypassed and the error
    propagates to the caller (transient HANA errors should not be cached).
    """
    now = time.monotonic()
    entry = _CACHE.get(key)

    if entry and (now - entry[0]) < _CACHE_TTL_SECONDS:
        return entry[1]

    value = loader()
    _CACHE[key] = (now, value)
    return value


def clear_cache() -> None:
    """Drop all cached metadata (used by tests / config reloads)."""
    _CACHE.clear()


# =====================================================
# NORMALIZATION
# =====================================================

def normalize_keyword(value: str) -> str:
    if not value or not value.strip():
        raise ValueError("Keyword cannot be empty")
    return value.upper()


def normalize_identifier(value: str) -> str:
    if not value or not value.strip():
        raise ValueError("Identifier cannot be empty")
    return value.upper()


# =====================================================
# SCHEMA DISCOVERY
# =====================================================

def discover_schemas() -> list:

    def loader():
        return query_rows(
            """
            SELECT SCHEMA_NAME
            FROM SYS.SCHEMAS
            ORDER BY SCHEMA_NAME
            """
        )

    return _cached("schemas", loader)


# =====================================================
# OBJECT DISCOVERY
# =====================================================

def discover_objects(limit: int = 100) -> list:
    limit = max(1, min(int(limit), 500))

    def loader():
        return query_rows(
            """
            SELECT
                SCHEMA_NAME,
                TABLE_NAME AS OBJECT_NAME,
                'TABLE' AS OBJECT_TYPE
            FROM SYS.TABLES

            UNION ALL

            SELECT
                SCHEMA_NAME,
                VIEW_NAME AS OBJECT_NAME,
                'VIEW' AS OBJECT_TYPE
            FROM SYS.VIEWS
            ORDER BY SCHEMA_NAME, OBJECT_NAME

            LIMIT ?
            """,
            (limit,),
        )

    return _cached(f"objects:{limit}", loader)


def search_objects(keyword: str) -> list:
    keyword = normalize_keyword(keyword)
    value = f"%{keyword}%"

    return query_rows(
        """
        SELECT
            SCHEMA_NAME,
            TABLE_NAME AS OBJECT_NAME,
            'TABLE' AS OBJECT_TYPE
        FROM SYS.TABLES
        WHERE UPPER(TABLE_NAME) LIKE ?

        UNION ALL

        SELECT
            SCHEMA_NAME,
            VIEW_NAME AS OBJECT_NAME,
            'VIEW' AS OBJECT_TYPE
        FROM SYS.VIEWS
        WHERE UPPER(VIEW_NAME) LIKE ?

        ORDER BY OBJECT_NAME
        """,
        (value, value),
    )


# =====================================================
# VIEW DISCOVERY
# =====================================================

def discover_views(limit: int = 100) -> list:
    limit = max(1, min(int(limit), 500))

    def loader():
        return query_rows(
            """
            SELECT SCHEMA_NAME, VIEW_NAME
            FROM SYS.VIEWS
            ORDER BY SCHEMA_NAME, VIEW_NAME
            LIMIT ?
            """,
            (limit,),
        )

    return _cached(f"views:{limit}", loader)


def discover_monitoring_views(limit: int = 100) -> list:
    limit = max(1, min(int(limit), 500))

    def loader():
        return query_rows(
            """
            SELECT SCHEMA_NAME, VIEW_NAME
            FROM SYS.VIEWS
            WHERE VIEW_NAME LIKE 'M_%'
            ORDER BY VIEW_NAME
            LIMIT ?
            """,
            (limit,),
        )

    return _cached(f"mviews:{limit}", loader)


def search_views(keyword: str) -> list:
    keyword = normalize_keyword(keyword)
    return query_rows(
        """
        SELECT SCHEMA_NAME, VIEW_NAME
        FROM SYS.VIEWS
        WHERE UPPER(VIEW_NAME) LIKE ?
        ORDER BY VIEW_NAME
        """,
        (f"%{keyword}%",),
    )


# =====================================================
# COLUMN SEARCH
# =====================================================

def search_columns(keyword: str) -> list:
    keyword = normalize_keyword(keyword)
    value = f"%{keyword}%"

    def loader():
        return query_rows(
            """
            SELECT
                SCHEMA_NAME,
                TABLE_NAME AS OBJECT_NAME,
                COLUMN_NAME,
                DATA_TYPE_NAME,
                'TABLE' AS OBJECT_TYPE
            FROM SYS.TABLE_COLUMNS
            WHERE UPPER(COLUMN_NAME) LIKE ?

            UNION ALL

            SELECT
                SCHEMA_NAME,
                VIEW_NAME AS OBJECT_NAME,
                COLUMN_NAME,
                DATA_TYPE_NAME,
                'VIEW' AS OBJECT_TYPE
            FROM SYS.VIEW_COLUMNS
            WHERE UPPER(COLUMN_NAME) LIKE ?

            ORDER BY OBJECT_NAME, COLUMN_NAME
            """,
            (value, value),
        )

    return _cached(f"columns:{keyword}", loader)


# =====================================================
# STRUCTURE INSPECTION (enriched)
# =====================================================

def _resolve_schema(cursor, name: str, schema: Optional[str]) -> str:
    """Return a concrete schema for ``name`` (falls back to provided schema)."""
    if schema:
        return normalize_identifier(schema)
    sql = """
        SELECT SCHEMA_NAME
        FROM (
            SELECT SCHEMA_NAME, TABLE_NAME AS OBJECT_NAME FROM SYS.TABLES
            UNION ALL
            SELECT SCHEMA_NAME, VIEW_NAME AS OBJECT_NAME FROM SYS.VIEWS
        )
        WHERE OBJECT_NAME = ?
    """
    cursor.execute(sql, (normalize_identifier(name),))
    schemas = {row[0] for row in cursor.fetchall()}
    if len(schemas) == 1:
        return schemas.pop()
    return normalize_identifier(name)


def describe_table(table_name: str, schema: Optional[str] = None) -> list:
    table_name = normalize_identifier(table_name)

    def loader():
        return query_rows(
            """
            SELECT
                SCHEMA_NAME,
                TABLE_NAME,
                COLUMN_NAME,
                DATA_TYPE_NAME,
                POSITION
            FROM SYS.TABLE_COLUMNS
            WHERE TABLE_NAME = ?
            {schema_clause}
            ORDER BY POSITION
            """.format(
                schema_clause="AND SCHEMA_NAME = ?" if schema else ""
            ),
            tuple(
                [table_name] + ([normalize_identifier(schema)] if schema else [])
            ),
        )

    return _cached(f"describe_table:{schema}:{table_name}", loader)


def describe_view(view_name: str, schema: Optional[str] = None) -> list:
    view_name = normalize_identifier(view_name)

    def loader():
        return query_rows(
            """
            SELECT
                SCHEMA_NAME,
                VIEW_NAME,
                COLUMN_NAME,
                DATA_TYPE_NAME,
                POSITION
            FROM SYS.VIEW_COLUMNS
            WHERE VIEW_NAME = ?
            {schema_clause}
            ORDER BY POSITION
            """.format(
                schema_clause="AND SCHEMA_NAME = ?" if schema else ""
            ),
            tuple(
                [view_name] + ([normalize_identifier(schema)] if schema else [])
            ),
        )

    return _cached(f"describe_view:{schema}:{view_name}", loader)


def inspect_monitoring_view(view_name: str) -> list:
    view_name = normalize_identifier(view_name)

    def loader():
        return query_rows(
            """
            SELECT COLUMN_NAME, DATA_TYPE_NAME, POSITION
            FROM SYS.VIEW_COLUMNS
            WHERE VIEW_NAME = ?
            ORDER BY POSITION
            """,
            (view_name,),
        )

    return _cached(f"inspect_mview:{view_name}", loader)


# =====================================================
# ENRICHED OBJECT DESCRIPTION
# =====================================================

def describe_object(
    schema: str,
    object_name: str,
    object_type: str = "TABLE",
) -> dict:
    """Return a rich object description including columns, keys and indexes.

    Payload::

        {
            "object_type": "TABLE",
            "schema": "SYS",
            "name": "M_DATABASE",
            "columns": [...],
            "primary_keys": [...],
            "indexes": [...],
            "comments": [...]
        }
    """
    schema = normalize_identifier(schema)
    object_name = normalize_identifier(object_name)
    object_type = normalize_identifier(object_type)

    if object_type not in ("TABLE", "VIEW"):
        raise ValueError("Object type must be TABLE or VIEW")

    if object_type == "TABLE":
        columns = describe_table(object_name, schema)
        keys = _table_primary_keys(schema, object_name)
        indexes = _table_indexes(schema, object_name)
    else:
        columns = describe_view(object_name, schema)
        keys = []
        indexes = []

    comments = _object_comments(schema, object_name)

    return {
        "object_type": object_type,
        "schema": schema,
        "name": object_name,
        "columns": columns,
        "primary_keys": keys,
        "indexes": indexes,
        "comments": comments,
    }


def _table_primary_keys(schema: str, table: str) -> list:
    try:
        return query_rows(
            """
            SELECT
                COLUMN_NAME,
                POSITION
            FROM SYS.CONSTRAINTS
            WHERE SCHEMA_NAME = ?
              AND TABLE_NAME = ?
              AND IS_PRIMARY_KEY = 'TRUE'
            ORDER BY POSITION
            """,
            (schema, table),
        )
    except Exception:
        return []


def _table_indexes(schema: str, table: str) -> list:
    try:
        return query_rows(
            """
            SELECT
                INDEX_NAME,
                INDEX_TYPE,
                COLUMN_NAME,
                POSITION
            FROM SYS.INDEX_COLUMNS
            WHERE SCHEMA_NAME = ?
              AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, POSITION
            """,
            (schema, table),
        )
    except Exception:
        return []


def _object_comments(schema: str, name: str) -> list:
    try:
        return query_rows(
            """
            SELECT
                SCHEMA_NAME,
                OBJECT_NAME,
                OBJECT_TYPE,
                COMMENTS
            FROM SYS.COMMENTS
            WHERE SCHEMA_NAME = ?
              AND OBJECT_NAME = ?
            """,
            (schema, name),
        )
    except Exception:
        return []


# =====================================================
# INFORMATION WRAPPER
# =====================================================

def get_view_information(view_name: str, schema: Optional[str] = None) -> dict:
    view_name = normalize_identifier(view_name)
    return {
        "view_name": view_name,
        "schema": schema,
        "columns": describe_view(view_name, schema),
    }


def get_object_type(schema: str, name: str) -> list:
    return query_rows(
        """
        SELECT 'TABLE' AS TYPE
        FROM SYS.TABLES
        WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?

        UNION ALL

        SELECT 'VIEW'
        FROM SYS.VIEWS
        WHERE SCHEMA_NAME = ? AND VIEW_NAME = ?
        """,
        (
            schema.upper(),
            name.upper(),
            schema.upper(),
            name.upper(),
        ),
    )
