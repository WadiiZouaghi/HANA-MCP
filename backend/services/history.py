"""Lightweight local time-series storage for dashboard metric snapshots.

The storage and read/write logic now lives in the top-level :mod:`trends`
module (importable by both the Flask app and the MCP server). This module
re-exports the helpers so existing imports (``from services.history import
get_metric_history`` / ``record_snapshot``) keep working unchanged.
"""

from trends import (
    DATABASE_PATH,
    MAX_HISTORY_MINUTES,
    SQLITE_BUSY_TIMEOUT_MS,
    compare_periods,
    detect_anomalies,
    get_metric_history,
    record_snapshot,
)

__all__ = [
    "DATABASE_PATH",
    "MAX_HISTORY_MINUTES",
    "SQLITE_BUSY_TIMEOUT_MS",
    "compare_periods",
    "detect_anomalies",
    "get_metric_history",
    "record_snapshot",
]
