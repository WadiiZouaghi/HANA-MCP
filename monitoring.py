"""
SAP HANA monitoring engine.

Loads monitoring tools fully dynamically from ``config.yaml`` and executes
them through the safe query engine. Each tool carries metadata (description,
category, icon, severity) that is surfaced to the LLM (via MCP) and the web UI.
"""

import re
from pathlib import Path

import yaml

from engine import execute_query, validate_config

CONFIG_PATH = Path(__file__).parent / "config.yaml"

_MONITORING_CONFIG = None


def load_monitoring_config():
    """Return the ``monitoring`` section of ``config.yaml``."""
    global _MONITORING_CONFIG

    if _MONITORING_CONFIG is None:
        with open(CONFIG_PATH) as file:
            config = yaml.safe_load(file) or {}
        validate_config(config)
        monitoring = config.get("monitoring", {})
        _MONITORING_CONFIG = monitoring if isinstance(monitoring, dict) else {}

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


def monitoring_tool_inputs(name: str) -> list[dict]:
    """Return the documented inputs (from ``config.yaml``) for a monitoring tool."""
    tool = load_monitoring_config().get(name, {})
    inputs = []
    for item in tool.get("inputs") or []:
        entry = {
            "name": item["name"],
            "type": item.get("type", "str"),
            "description": item.get("description", ""),
        }
        if "default" in item:
            entry["default"] = item["default"]
            entry["optional"] = True
        inputs.append(entry)
    return inputs


_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _apply_input_filters(query: str, inputs: list[dict], values: dict):
    """Wrap ``query`` so each supplied input filters its result column.

    An input filters the column named by its ``column`` key (default: the
    input name upper-cased). Values are comma-separated, matched
    case-insensitively, and always passed as bound parameters.
    """
    conditions = []
    parameters = []
    for item in inputs:
        value = values.get(item["name"], item.get("default"))
        if value is None or str(value).strip() == "":
            continue
        column = str(item.get("column") or item["name"]).upper()
        if not _IDENTIFIER_RE.match(column):
            raise ValueError(f"Invalid filter column for input {item['name']}")
        terms = [part.strip().lower() for part in str(value).split(",")]
        terms = [term for term in terms if term]
        if not terms:
            continue
        placeholders = ", ".join("?" for _ in terms)
        conditions.append(f'LOWER("{column}") IN ({placeholders})')
        parameters.extend(terms)

    if not conditions:
        return query, None

    inner = query.strip().rstrip(";")
    return (
        f"SELECT * FROM (\n{inner}\n) WHERE " + " AND ".join(conditions),
        parameters,
    )


def execute_monitoring_tool(
    name: str, max_rows: int | None = None, **inputs
) -> dict:
    """Execute a configured monitoring query by name.

    Keyword arguments matching the tool's configured ``inputs`` filter the
    result. Returns the standard ``{rows, row_count, execution_ms}`` payload.
    """
    tools = load_monitoring_config()

    if name not in tools:
        raise ValueError(f"Unknown monitoring tool: {name}")

    tool = tools[name]
    query = tool.get("query")

    if not query:
        raise ValueError(f"No query defined for monitoring tool: {name}")

    declared = tool.get("inputs") or []
    unknown = set(inputs) - {item["name"] for item in declared}
    if unknown:
        raise ValueError(
            f"Unknown input(s) for hana_{name}: {', '.join(sorted(unknown))}"
        )

    query, parameters = _apply_input_filters(query, declared, inputs)

    return execute_query(
        query,
        parameters,
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
