"""
Tool registry — the single source of truth for every MCP tool.

ENHANCED: Better descriptions, clear "when to use", less vague purpose text.
The LLM now sees exactly when to pick each tool.
"""

from backend.services.metrics import get_hana_memory
from engine import execute_query
from hana_health import hana_health_check
from monitoring import (
    execute_monitoring_tool,
    load_monitoring_config,
    monitoring_tool_metadata,
)
from sap.sap_tools import (
    hana_execute_sap_statement,
    hana_explain_sap_statement,
    hana_list_sap_library,
    hana_search_sap_by_component,
    hana_search_sap_by_note,
    hana_search_sap_by_table,
    hana_search_sap_library,
)
from trends import (
    compare_periods,
    detect_anomalies,
    get_metric_history,
)

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


# ── HIGH-LEVEL DIAGNOSTICS ───────────────────────────────────────────────

_register(
    "hana_health_check",
    hana_health_check,
    category="Diagnostics",
    description="Complete SAP HANA operational health assessment (pass/fail, alerts, issues).",
    purpose=(
        "Use ONLY when the user asks 'is my database healthy?', 'how is the system?', 'health check', "
        "'system status', 'overall status', or similar health-summary questions. "
        "This tool gives you a PASS or FAIL verdict and lists any alerts. "
        "Do NOT use this for specific questions like memory, backups, users, tables, or locks — "
        "use the targeted tool instead."
    ),
    inputs=[],
    output="Overall health verdict (PASS/FAIL), alert list, and per-check structured results.",
    example="Call hana_health_check() for: 'is my database healthy?', 'what is the status?'",
)

# ── MONITORING TOOLS (fully configurable from config.yaml) ──────────────
monitoring_tools = load_monitoring_config()

for name in monitoring_tools:
    metadata = monitoring_tool_metadata(name)

    # Custom purpose text for each monitoring tool
    purpose_map = {
        "memory": (
            "Use for any memory question: 'is memory high?', 'memory usage', 'memory breakdown', "
            "'what is consuming memory?', 'memory pressure', 'out of memory'. "
            "Returns current memory usage, limits, and a pressure level (NORMAL/WARNING/CRITICAL)."
        ),
        "cpu": (
            "Use for CPU questions: 'what is the CPU?', 'CPU utilization', 'processor load', "
            "'is the server busy?'. Returns CPU usage and top CPU consumers."
        ),
        "disk": (
            "Use for disk/storage questions: 'is disk full?', 'disk usage', 'storage space', "
            "'what is using disk?'. Returns disk usage by type (log, trace, data, backup)."
        ),
        "connections": (
            "Use for connection questions: 'how many connections?', 'active sessions', "
            "'connection count'. Returns the active connection count (NOT user names or session details)."
        ),
        "services": (
            "Use for service questions: 'which services are running?', 'service status', "
            "'is the nameserver up?'. Returns all services and their status."
        ),
        "backup_status": (
            "Use for backup questions: 'when was the last backup?', 'backup status', "
            "'backup history'. Returns recent backup catalog and status."
        ),
        "expensive_statements": (
            "Use for performance questions: 'show slow queries', 'expensive statements', "
            "'why is the database slow?'. Returns long-running SQL statements."
        ),
        "blocked_transactions": (
            "Use for lock/deadlock questions: 'are there locks?', 'blocked transactions', "
            "'who is waiting?'. Returns locked resources and blocking analysis."
        ),
        "replication": (
            "Use for HA questions: 'replication status', 'is standby working?', 'HA status'. "
            "Returns system replication health and lag."
        ),
        "trace_files": (
            "Use for error/log questions: 'show logs', 'trace files', 'recent errors', "
            "'what errors occurred?'. Returns recent log and trace files."
        ),
        "active_statements": (
            "Use to see what SQL is running RIGHT NOW: 'what is running?', 'active queries', "
            "'current statements'. Returns currently executing SQL."
        ),
        "table_sizes": (
            "Use for storage questions: 'largest tables', 'table sizes', 'which tables use the most memory?'. "
            "Returns tables sorted by memory usage."
        ),
    }

    purpose = purpose_map.get(
        name, f"Live SAP HANA {name.replace('_', ' ')} monitoring."
    )

    _register(
        name=f"hana_{name}",
        function=create_monitoring_function(name),
        category="Monitoring",
        description=metadata["description"],
        purpose=purpose,
        inputs=[],
        output="Rows from the configured monitoring query with row_count and execution_ms.",
        example=f"Call hana_{name}() to inspect current {name.replace('_', ' ')}.",
    )


_register(
    "hana_memory",
    get_hana_memory,
    category="Monitoring",
    description="Semantic memory metrics with pressure evaluation (NORMAL/WARNING/CRITICAL).",
    purpose=(
        "Use for memory questions. Returns: memory_in_use_bytes, memory_in_use_percent, "
        "memory_pressure level, action_required flag. "
        "This is the primary memory tool — more semantic than raw M_MEMORY. "
        "Do NOT ask the user to add memory unless memory_pressure is WARNING or CRITICAL."
    ),
    inputs=[],
    output="Structured dict: system, hana, process, heap, shared, limits, compactors, pressure level.",
    example="Call hana_memory() for any memory question.",
)


# ── SAP KNOWLEDGE TOOLS ──────────────────────────────────────────────────

_register(
    "hana_search_sap_library",
    hana_search_sap_library,
    category="SAP Knowledge",
    description="Search the SAP Note 1969700 diagnostic SQL library by keyword.",
    purpose="Find pre-written diagnostic SQL statements by searching for keywords in the SAP Note 1969700 library.",
    inputs=[
        {
            "name": "keyword",
            "type": "str",
            "description": "Search term (name, description, or tables involved).",
        }
    ],
    output="List of matching library entries with name, description, tables, file.",
    example="hana_search_sap_library(keyword='memory')",
)

_register(
    "hana_search_sap_by_note",
    hana_search_sap_by_note,
    category="SAP Knowledge",
    description="Search SAP library entries by SAP Note number.",
    purpose="Find diagnostic statements referencing a specific SAP Note (e.g. 1969700).",
    inputs=[
        {
            "name": "note",
            "type": "str",
            "description": "SAP Note number (e.g. '1969700').",
        }
    ],
    output="List of matching library entries.",
    example="hana_search_sap_by_note(note='1969700')",
)

_register(
    "hana_search_sap_by_component",
    hana_search_sap_by_component,
    category="SAP Knowledge",
    description="Search SAP library by component/area (memory, disk, CPU, replication, etc).",
    purpose="Find diagnostic statements for a specific area of the system.",
    inputs=[
        {"name": "component", "type": "str", "description": "Component or area name."}
    ],
    output="List of matching library entries.",
    example="hana_search_sap_by_component(component='memory')",
)

_register(
    "hana_search_sap_by_table",
    hana_search_sap_by_table,
    category="SAP Knowledge",
    description="Search SAP library by HANA system table (M_MEMORY, M_CONNECTIONS, etc).",
    purpose="Find diagnostic statements that query a specific HANA system table.",
    inputs=[
        {"name": "table", "type": "str", "description": "Table name (e.g. M_MEMORY)."}
    ],
    output="List of matching library entries.",
    example="hana_search_sap_by_table(table='M_MEMORY')",
)

_register(
    "hana_list_sap_library",
    hana_list_sap_library,
    category="SAP Knowledge",
    description="List available SAP diagnostic SQL statements from the library.",
    purpose="Browse all available pre-written diagnostic SQL in the SAP Note 1969700 library.",
    inputs=[
        {
            "name": "limit",
            "type": "int",
            "default": 50,
            "description": "Maximum entries to return.",
        }
    ],
    output="List of library entries with name, description, source.",
    example="hana_list_sap_library(limit=20)",
)

_register(
    "hana_execute_sap_statement",
    hana_execute_sap_statement,
    category="SAP Knowledge",
    description="Execute a pre-written SAP diagnostic SQL statement from the library.",
    purpose="Run a safe, pre-tested diagnostic query from SAP Note 1969700.",
    inputs=[
        {"name": "name", "type": "str", "description": "SAP library statement name."}
    ],
    output="Query results with row_count and execution_ms.",
    example="hana_execute_sap_statement(name='HANA_Memory_Components_2.00.056+')",
)

_register(
    "hana_explain_sap_statement",
    hana_explain_sap_statement,
    category="SAP Knowledge",
    description="Run EXPLAIN PLAN on an SAP library statement (best-effort).",
    purpose="Understand the execution plan of a diagnostic query.",
    inputs=[
        {"name": "name", "type": "str", "description": "SAP library statement name."}
    ],
    output="EXPLAIN PLAN output or error message.",
    example="hana_explain_sap_statement(name='HANA_Memory_Components_2.00.056+')",
)


# ── RAW SQL (read-only) ──────────────────────────────────────────────────

_register(
    "hana_execute_query",
    execute_query,
    category="SQL",
    description="Execute validated read-only SQL (SELECT/WITH) — the primary way to explore the database.",
    purpose=(
        "Use when you need to compose a custom query to explore the database. "
        "This is the tool for: listing users, finding specific tables/views, running custom SELECT, "
        "or answering data-specific questions the other tools don't cover. "
        "Prefer this over generic discovery tools. Always add LIMIT or TOP to large queries."
    ),
    inputs=[
        {"name": "sql", "type": "str", "description": "SELECT or WITH statement."},
        {
            "name": "parameters",
            "type": "list",
            "description": "Optional bound parameters.",
            "optional": True,
        },
    ],
    output="Dict with rows, row_count, execution_ms.",
    example="hana_execute_query(sql='SELECT * FROM SYS.USERS WHERE USER_NAME = \\'SYSTEM\\'')",
)


# ── TREND / TIME-SERIES TOOLS ────────────────────────────────────────────

_register(
    "hana_metric_history",
    get_metric_history,
    category="Trends",
    description="Read historical snapshots of CPU, memory, and connection metrics.",
    purpose="Show how key metrics trended over time. Use for: 'is memory growing?', 'CPU trend', 'was it high earlier?'.",
    inputs=[
        {
            "name": "minutes",
            "type": "int",
            "default": 60,
            "description": "Window length in minutes (1-1440).",
        }
    ],
    output="Chronological points with timestamp, cpu_usage, memory_usage, connections.",
    example="hana_metric_history(minutes=120)",
)

_register(
    "hana_compare_periods",
    compare_periods,
    category="Trends",
    description="Compare metric averages: recent window vs prior window.",
    purpose="Quantify trends. Use for: 'is memory going up?', 'was CPU higher before?', 'compare today vs yesterday'.",
    inputs=[
        {
            "name": "recent_minutes",
            "type": "int",
            "default": 60,
            "description": "Length of the recent window in minutes.",
        },
        {
            "name": "prior_minutes",
            "type": "int",
            "default": 60,
            "description": "Length of the preceding window in minutes.",
        },
    ],
    output="Per-metric recent/prior averages and percentage delta.",
    example="hana_compare_periods(recent_minutes=60, prior_minutes=60)",
)

_register(
    "hana_detect_anomalies",
    detect_anomalies,
    category="Trends",
    description="Detect abnormal spikes or drops in metric history (statistical outliers).",
    purpose="Flag unusual metric values. Use for: 'anything weird in the metrics?', 'unusual spikes?', 'detect anomalies'.",
    inputs=[
        {
            "name": "minutes",
            "type": "int",
            "default": 180,
            "description": "History window in minutes to analyse.",
        },
        {
            "name": "std_devs",
            "type": "float",
            "default": 2.0,
            "description": "Standard-deviation threshold for an anomaly.",
        },
    ],
    output="Per-metric summary (mean/std/min/max) and a list of anomalous points.",
    example="hana_detect_anomalies(minutes=180, std_devs=2.0)",
)


# =====================================================
# HELPER ACCESSORS
# =====================================================


def get_tools_by_category(category: str) -> dict:
    """Return tools that belong to ``category`` (e.g. 'Monitoring')."""
    return {
        name: tool for name, tool in TOOLS.items() if tool.get("category") == category
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
    """Return an LLM-friendly manifest of all tools (no functions)."""
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
