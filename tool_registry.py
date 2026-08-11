"""
Tool registry — the single source of truth for every MCP tool.

Tools are grouped into logical categories:

    Monitoring      — live HANA resource/health queries (from config.yaml)
    Metadata        — schema/object discovery and description
    SQL             — validated read-only query execution
    SAP Knowledge   — SAP diagnostic SQL library search and execution

Each tool entry carries documentation (description, purpose, input, output,
example) that improves Claude's ability to select and call the right tool.
"""

from monitoring import (
    execute_monitoring_tool,
    load_monitoring_config,
    monitoring_tool_metadata,
)

from metadata import (
    discover_views,
    discover_objects,
    search_views,
    search_objects,
    search_columns,
    describe_view,
    discover_monitoring_views,
    inspect_monitoring_view,
    describe_table,
    describe_object,
)

from sap.sap_tools import (
    hana_search_sap_library,
    hana_search_sap_by_note,
    hana_search_sap_by_component,
    hana_search_sap_by_table,
    hana_list_sap_library,
    hana_execute_sap_statement,
    hana_explain_sap_statement,
)

from engine import execute_query


# =====================================================
# TOOL BUILDER — MONITORING (dynamic from config.yaml)
# =====================================================

def create_monitoring_function(tool_name):
    """Build a no-argument callable that executes a configured monitoring tool."""

    def monitoring_function():
        return execute_monitoring_tool(tool_name)

    monitoring_function.__name__ = f"hana_{tool_name}"
    return monitoring_function


TOOLS = {}


def _register(
    name: str,
    function,
    category: str,
    description: str,
    purpose: str = "",
    inputs: list | None = None,
    output: str = "",
    example: str = "",
) -> None:
    """Register a tool with full documentation metadata."""
    TOOLS[name] = {
        "category": category,
        "description": description,
        "purpose": purpose,
        "inputs": inputs or [],
        "output": output,
        "example": example,
        "function": function,
    }


# ── MONITORING TOOLS (fully configurable from config.yaml) ──────────────
monitoring_tools = load_monitoring_config()

for name, definition in monitoring_tools.items():
    metadata = monitoring_tool_metadata(name)
    _register(
        name=f"hana_{name}",
        function=create_monitoring_function(name),
        category="Monitoring",
        description=metadata["description"],
        purpose=f"Live SAP HANA {name.replace('_', ' ')} monitoring.",
        inputs=[],
        output="Rows from the configured monitoring query with row_count and execution_ms.",
        example=f"Call hana_{name} to inspect current {name.replace('_', ' ')}.",
    )


# ── METADATA / DISCOVERY TOOLS ───────────────────────────────────────────

_register(
    "hana_discover_views",
    discover_views,
    category="Metadata",
    description="Discover available HANA views (cached 5 min).",
    purpose="List database views, optionally limited.",
    inputs=[{"name": "limit", "type": "int", "default": 100, "description": "Maximum views to return (1-500)."}],
    output="Rows with SCHEMA_NAME, VIEW_NAME.",
    example="hana_discover_views(limit=50)",
)

_register(
    "hana_discover_objects",
    discover_objects,
    category="Metadata",
    description="Discover HANA tables and views (cached 5 min).",
    purpose="List tables and views across schemas.",
    inputs=[{"name": "limit", "type": "int", "default": 100, "description": "Maximum objects to return (1-500)."}],
    output="Rows with SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE.",
    example="hana_discover_objects(limit=200)",
)

_register(
    "hana_search_views",
    search_views,
    category="Metadata",
    description="Search HANA views by keyword.",
    purpose="Find views whose name contains a keyword.",
    inputs=[{"name": "keyword", "type": "str", "description": "Search term (case-insensitive)."}],
    output="Matching rows with SCHEMA_NAME, VIEW_NAME.",
    example="hana_search_views(keyword='memory')",
)

_register(
    "hana_search_objects",
    search_objects,
    category="Metadata",
    description="Search HANA tables and views by keyword.",
    purpose="Find tables/views whose name contains a keyword.",
    inputs=[{"name": "keyword", "type": "str", "description": "Search term (case-insensitive)."}],
    output="Matching rows with SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE.",
    example="hana_search_objects(keyword='M_EXPENSIVE')",
)

_register(
    "hana_search_columns",
    search_columns,
    category="Metadata",
    description="Search HANA columns by keyword (cached 5 min).",
    purpose="Find which tables/views contain a column name.",
    inputs=[{"name": "keyword", "type": "str", "description": "Column name search term."}],
    output="Rows with SCHEMA_NAME, OBJECT_NAME, COLUMN_NAME, DATA_TYPE_NAME, OBJECT_TYPE.",
    example="hana_search_columns(keyword='MEMORY')",
)

_register(
    "hana_discover_monitoring_views",
    discover_monitoring_views,
    category="Metadata",
    description="Discover SAP HANA monitoring views (M_%).",
    purpose="List system monitoring views for exploration.",
    inputs=[{"name": "limit", "type": "int", "default": 100, "description": "Maximum views to return."}],
    output="Rows with SCHEMA_NAME, VIEW_NAME.",
    example="hana_discover_monitoring_views(limit=50)",
)

_register(
    "hana_inspect_monitoring_view",
    inspect_monitoring_view,
    category="Metadata",
    description="Inspect monitoring view columns.",
    purpose="Show the columns of a specific M_ view.",
    inputs=[{"name": "view_name", "type": "str", "description": "Monitoring view name (e.g. M_MEMORY)."}],
    output="Rows with COLUMN_NAME, DATA_TYPE_NAME, POSITION.",
    example="hana_inspect_monitoring_view(view_name='M_MEMORY')",
)

_register(
    "hana_describe_table",
    describe_table,
    category="Metadata",
    description="Describe table structure.",
    purpose="List the columns of a specific table.",
    inputs=[
        {"name": "table_name", "type": "str", "description": "Table name."},
        {"name": "schema", "type": "str", "description": "Optional schema name.", "optional": True},
    ],
    output="Rows with SCHEMA_NAME, TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME, POSITION.",
    example="hana_describe_table(table_name='M_DATABASE', schema='SYS')",
)

_register(
    "hana_describe_view",
    describe_view,
    category="Metadata",
    description="Describe view structure.",
    purpose="List the columns of a specific view.",
    inputs=[
        {"name": "view_name", "type": "str", "description": "View name."},
        {"name": "schema", "type": "str", "description": "Optional schema name.", "optional": True},
    ],
    output="Rows with SCHEMA_NAME, VIEW_NAME, COLUMN_NAME, DATA_TYPE_NAME, POSITION.",
    example="hana_describe_view(view_name='M_SERVICES', schema='SYS')",
)

_register(
    "hana_describe_object",
    describe_object,
    category="Metadata",
    description="Rich object description (columns, keys, indexes, comments).",
    purpose="Full metadata for a table or view.",
    inputs=[
        {"name": "schema", "type": "str", "description": "Schema name."},
        {"name": "object_name", "type": "str", "description": "Table or view name."},
        {"name": "object_type", "type": "str", "default": "TABLE", "description": "TABLE or VIEW."},
    ],
    output="Dict with object_type, schema, name, columns, primary_keys, indexes, comments.",
    example="hana_describe_object(schema='SYS', object_name='M_DATABASE', object_type='VIEW')",
)


# ── SAP KNOWLEDGE TOOLS ──────────────────────────────────────────────────

_register(
    "hana_search_sap_library",
    hana_search_sap_library,
    category="SAP Knowledge",
    description="Search the SAP Note 1969700 diagnostic SQL library.",
    purpose="Find SAP diagnostic statements by keyword.",
    inputs=[{"name": "keyword", "type": "str", "description": "Search term (name, description or tables)."}],
    output="List of matching library entries with name, description, tables, file.",
    example="hana_search_sap_library(keyword='memory')",
)

_register(
    "hana_search_sap_by_note",
    hana_search_sap_by_note,
    category="SAP Knowledge",
    description="Search SAP library entries by SAP Note number.",
    purpose="Find diagnostic statements referencing a specific SAP Note.",
    inputs=[{"name": "note", "type": "str", "description": "SAP Note number (e.g. '1969700')."}],
    output="List of matching library entries.",
    example="hana_search_sap_by_note(note='1969700')",
)

_register(
    "hana_search_sap_by_component",
    hana_search_sap_by_component,
    category="SAP Knowledge",
    description="Search SAP library by component/area.",
    purpose="Find diagnostic statements for a specific area (e.g. memory, disk, replication).",
    inputs=[{"name": "component", "type": "str", "description": "Component or area name."}],
    output="List of matching library entries.",
    example="hana_search_sap_by_component(component='memory')",
)

_register(
    "hana_search_sap_by_table",
    hana_search_sap_by_table,
    category="SAP Knowledge",
    description="Search SAP library by involved HANA table.",
    purpose="Find diagnostic statements that query a specific table.",
    inputs=[{"name": "table", "type": "str", "description": "Table name (e.g. M_MEMORY)."}],
    output="List of matching library entries.",
    example="hana_search_sap_by_table(table='M_MEMORY')",
)

_register(
    "hana_list_sap_library",
    hana_list_sap_library,
    category="SAP Knowledge",
    description="List available SAP library entries.",
    purpose="Browse the SAP diagnostic SQL library.",
    inputs=[{"name": "limit", "type": "int", "default": 50, "description": "Maximum entries to return."}],
    output="List of library entries with name, description, source.",
    example="hana_list_sap_library(limit=20)",
)

_register(
    "hana_execute_sap_statement",
    hana_execute_sap_statement,
    category="SAP Knowledge",
    description="Execute an SAP diagnostic SQL statement from the library.",
    purpose="Run a SAP Note 1969700 diagnostic query safely.",
    inputs=[{"name": "name", "type": "str", "description": "SAP library statement name."}],
    output="Query results with row_count and execution_ms.",
    example="hana_execute_sap_statement(name='HANA_Memory_Components_2.00.056+')",
)

_register(
    "hana_explain_sap_statement",
    hana_explain_sap_statement,
    category="SAP Knowledge",
    description="Run EXPLAIN PLAN on an SAP library statement (best-effort).",
    purpose="Understand the execution plan of a diagnostic query.",
    inputs=[{"name": "name", "type": "str", "description": "SAP library statement name."}],
    output="EXPLAIN PLAN output or error message.",
    example="hana_explain_sap_statement(name='HANA_Memory_Components_2.00.056+')",
)


# ── RAW SQL (read-only) ──────────────────────────────────────────────────

_register(
    "hana_execute_query",
    execute_query,
    category="SQL",
    description="Execute validated read-only SQL (SELECT/WITH).",
    purpose="Run a safe read-only query with automatic row limiting.",
    inputs=[
        {"name": "sql", "type": "str", "description": "SELECT or WITH statement."},
        {"name": "parameters", "type": "list", "description": "Optional bound parameters.", "optional": True},
    ],
    output="Dict with rows, row_count, execution_ms.",
    example="hana_execute_query(sql='SELECT * FROM SYS.M_DATABASE')",
)


# =====================================================
# HELPER ACCESSORS
# =====================================================

def get_tools_by_category(category: str) -> dict:
    """Return tools that belong to ``category`` (e.g. 'Monitoring')."""
    return {
        name: tool
        for name, tool in TOOLS.items()
        if tool.get("category") == category
    }


def tool_categories() -> list[str]:
    """Return ordered unique categories."""
    seen: list[str] = []
    for tool in TOOLS.values():
        category = tool.get("category", "Other")
        if category not in seen:
            seen.append(category)
    return seen


def tool_manifest() -> list[dict]:
    """Return a Claude-friendly manifest of all tools (no functions)."""
    return [
        {
            "name": name,
            "category": tool.get("category"),
            "description": tool.get("description"),
            "purpose": tool.get("purpose"),
            "inputs": tool.get("inputs"),
            "output": tool.get("output"),
            "example": tool.get("example"),
        }
        for name, tool in TOOLS.items()
    ]
