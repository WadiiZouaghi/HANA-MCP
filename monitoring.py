"""
SAP HANA monitoring engine.

Loads monitoring tools fully dynamically from ``config.yaml`` and executes
them through the safe query engine. Each tool carries metadata (description,
category, icon, severity) that is surfaced to the LLM (via MCP) and the web UI.
"""

from pathlib import Path

import yaml

from engine import execute_query

CONFIG_PATH = Path(__file__).parent / "config.yaml"

_MONITORING_CONFIG = None


def load_monitoring_config():
    """Return the ``monitoring`` section of ``config.yaml``."""
    global _MONITORING_CONFIG

    if _MONITORING_CONFIG is None:
        with open(CONFIG_PATH) as file:
            config = yaml.safe_load(file)
            _MONITORING_CONFIG = config.get("monitoring", {})

    return _MONITORING_CONFIG


def monitoring_tool_names():
    """Return the ordered list of configured monitoring tool names."""
    return list(load_monitoring_config().keys())


def monitoring_tool_metadata(name: str) -> dict:
    """Return display metadata for a monitoring tool."""
    tool = load_monitoring_config().get(name, {})
    return {
        "description": tool.get("description", f"Execute HANA {name} monitoring"),
        "category": tool.get("category", "Monitoring"),
        "icon": tool.get("icon", "monitor"),
        "severity": tool.get("severity", "info"),
    }


def execute_monitoring_tool(name: str, max_rows: int | None = None) -> dict:
    """Execute a configured monitoring query by name.

    Returns the standard ``{rows, row_count, execution_ms}`` payload.
    """
    tools = load_monitoring_config()

    if name not in tools:
        raise ValueError(f"Unknown monitoring tool: {name}")

    tool = tools[name]
    query = tool.get("query")

    if not query:
        raise ValueError(f"No query defined for monitoring tool: {name}")

    return execute_query(
        query,
        max_rows=max_rows,
        tool=f"hana_{name}",
    )


def monitoring_summary() -> dict:
    """Return all monitoring tool metadata grouped by category."""
    tools = load_monitoring_config()
    summary = {}
    for name, definition in tools.items():
        category = definition.get("category", "Monitoring")
        summary.setdefault(category, {})[f"hana_{name}"] = {
            "description": definition.get("description", ""),
            "icon": definition.get("icon", "monitor"),
            "severity": definition.get("severity", "info"),
        }
    return summary
