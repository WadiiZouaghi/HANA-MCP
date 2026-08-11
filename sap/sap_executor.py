"""Execute SAP diagnostic SQL statements from the library."""

import json
from pathlib import Path

from engine import execute_query


INDEX_FILE = Path(__file__).parent / "sap_index.json"


def load_statement(name: str) -> str:
    """Return the raw SQL for a library entry by name (fuzzy match)."""
    with open(INDEX_FILE) as file:
        index = json.load(file)

    for item in index.values():
        searchable = (
            str(item.get("name"))
            + str(item.get("description"))
        ).lower()

        if name.lower() in searchable:
            return item["sql"]

    raise ValueError(f"SAP statement not found: {name}")


def execute_sap_statement(name: str, parameters: dict | None = None) -> dict:
    """Execute a library statement through the safe read-only engine.

    Returns the standard ``{rows, row_count, execution_ms}`` payload.
    """
    sql = load_statement(name)

    return execute_query(
        sql,
        tool=f"hana_execute_sap_statement",
    )


def explain_sap_statement(name: str) -> dict:
    """Run EXPLAIN PLAN on a library statement (best-effort).

    Not all SAP Note 1969700 statements can be explained (many are
    statement-generators or rely on session bind variables), so failures
    return the underlying error message rather than raising.
    """
    sql = load_statement(name)

    try:
        return execute_query(
            f"EXPLAIN PLAN SET STATEMENT_NAME = 'MCP_EXPLAIN' FOR {sql}",
            tool="hana_explain_sap_statement",
        )
    except Exception as error:
        return {
            "error": str(error),
            "note": "This statement may not be explainable (generator or session-bound).",
        }
