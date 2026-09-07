"""Convert SAP HANA monitoring rows into small dashboard-ready payloads."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import Any


def _rows(value: Any) -> list[Mapping[str, Any]]:
    """Return query results as rows, accepting a single mapping for easy testing."""
    if isinstance(value, Mapping):
        return [value]
    if isinstance(value, list):
        return [row for row in value if isinstance(row, Mapping)]
    return []


def _number(value: Any) -> float:
    """Safely coerce HANA numeric values (including Decimal values) to floats."""
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError):
        return 0.0


def _round_percent(value: float) -> float:
    return round(max(0.0, min(value, 100.0)), 1)


def transform_memory_metrics(raw_metrics: Any) -> dict[str, Any]:
    """Calculate used/free memory and a percentage from ``SYS.M_MEMORY`` rows."""
    values = {
        str(row.get("NAME", "")).upper(): _number(row.get("VALUE"))
        for row in _rows(raw_metrics)
    }
    total = values.get("SYSTEM_MEMORY_SIZE", 0.0)
    free = values.get("SYSTEM_MEMORY_FREE_SIZE", 0.0)
    used = values.get("TOTAL_MEMORY_SIZE_IN_USE", max(total - free, 0.0))

    if total and used > total:
        used = max(total - free, 0.0)

    usage_percent = (used / total * 100) if total else 0.0
    free = max(total - used, 0.0)
    return {
        "usage_percent": _round_percent(usage_percent),
        "used_bytes": int(used),
        "free_bytes": int(free),
        "total_bytes": int(total),
        "chart": {"labels": ["Used", "Free"], "values": [int(used), int(free)]},
    }


def transform_cpu_metrics(raw_metrics: Any) -> dict[str, Any]:
    """Calculate CPU busy time as a percentage of HANA's reported CPU time."""
    rows = _rows(raw_metrics)
    user_time = sum(_number(row.get("TOTAL_CPU_USER_TIME")) for row in rows)
    system_time = sum(_number(row.get("TOTAL_CPU_SYSTEM_TIME")) for row in rows)
    idle_time = sum(_number(row.get("TOTAL_CPU_IDLE_TIME")) for row in rows)
    total_time = user_time + system_time + idle_time
    usage_percent = (
        ((user_time + system_time) / total_time * 100) if total_time else 0.0
    )
    return {
        "usage_percent": _round_percent(usage_percent),
        "chart": {
            "labels": ["Busy", "Idle"],
            "values": [
                _round_percent(usage_percent),
                _round_percent(100 - usage_percent),
            ],
        },
    }


def transform_connections_metrics(raw_metrics: Any) -> dict[str, int]:
    """Extract a single active-session count from the connections query."""
    rows = _rows(raw_metrics)
    active = _number(rows[0].get("CONNECTIONS")) if rows else 0.0
    return {"active": int(active)}


def build_dashboard_metrics(memory: Any, cpu: Any, connections: Any) -> dict[str, Any]:
    """Build the compact metrics section returned by ``/api/dashboard``."""
    return {
        "memory": transform_memory_metrics(memory),
        "cpu": transform_cpu_metrics(cpu),
        "connections": transform_connections_metrics(connections),
    }
