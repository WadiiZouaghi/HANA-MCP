"""MCP tool wrappers for the SAP diagnostic SQL library."""

from .sap_executor import (
    execute_sap_statement,
    explain_sap_statement,
)
from .sap_search import (
    list_sap_library,
    search_sap,
    search_sap_by_component,
    search_sap_by_note,
    search_sap_by_table,
)


def hana_search_sap_library(keyword: str) -> list:
    """Search the SAP Note 1969700 diagnostic SQL library by keyword."""
    return search_sap(keyword)


def hana_search_sap_by_note(note: str) -> list:
    """Find SAP library entries referencing a specific SAP Note number."""
    return search_sap_by_note(note)


def hana_search_sap_by_component(component: str) -> list:
    """Find SAP library entries matching a component/area (e.g. memory, disk)."""
    return search_sap_by_component(component)


def hana_search_sap_by_table(table: str) -> list:
    """Find SAP library entries that involve a specific HANA table."""
    return search_sap_by_table(table)


def hana_list_sap_library(limit: int = 50) -> list:
    """List available SAP library entries (compact)."""
    return list_sap_library(limit)


def hana_execute_sap_statement(name: str, parameters: dict | None = None) -> dict:
    """Execute an SAP diagnostic SQL statement from the library."""
    return execute_sap_statement(name)


def hana_explain_sap_statement(name: str) -> dict:
    """Run EXPLAIN PLAN on a library statement (best-effort)."""
    return explain_sap_statement(name)
