"""Search the SAP diagnostic SQL library (SAP Note 1969700)."""

import json
from pathlib import Path

INDEX_FILE = Path(__file__).parent / "sap_index.json"


def _load_index() -> dict:
    with open(INDEX_FILE) as file:
        return json.load(file)


def _searchable(item: dict) -> str:
    """Build a lower-cased searchable blob for an index entry."""
    return " ".join(
        [
            str(item.get("name", "")),
            str(item.get("description", "")),
            str(item.get("tables", "")),
            str(item.get("source", "")),
            str(item.get("parameters", "")),
        ]
    ).lower()


def _to_result(item: dict) -> dict:
    """Return a compact result without the full SQL."""
    return {
        "name": item.get("name"),
        "description": item.get("description"),
        "source": item.get("source"),
        "tables": item.get("tables"),
        "file": item.get("file"),
    }


def search_sap(keyword: str) -> list:
    """Search the library by keyword (name, description, tables, source)."""
    keyword = (keyword or "").strip().lower()
    if not keyword:
        raise ValueError("Keyword cannot be empty")

    index = _load_index()
    results = []
    for item in index.values():
        if keyword in _searchable(item):
            results.append(_to_result(item))
    return results


def search_sap_by_note(note: str) -> list:
    """Search the library by SAP Note number (e.g. '1969700')."""
    note = (note or "").strip().lower()
    if not note:
        raise ValueError("SAP Note cannot be empty")

    index = _load_index()
    results = []
    for item in index.values():
        source = str(item.get("source", "")).lower()
        if note in source:
            results.append(_to_result(item))
    return results


def search_sap_by_component(component: str) -> list:
    """Search the library by component / table family (e.g. 'memory', 'disk')."""
    return search_sap(component)


def search_sap_by_table(table: str) -> list:
    """Search the library by involved table name (e.g. 'M_MEMORY')."""
    table = (table or "").strip().upper()
    if not table:
        raise ValueError("Table name cannot be empty")

    index = _load_index()
    results = []
    for item in index.values():
        tables = str(item.get("tables", "")).upper()
        if table in tables:
            results.append(_to_result(item))
    return results


def list_sap_library(limit: int = 50) -> list:
    """List library entries (compact)."""
    limit = max(1, min(int(limit), 500))
    index = _load_index()
    return [_to_result(item) for item in list(index.values())[:limit]]
