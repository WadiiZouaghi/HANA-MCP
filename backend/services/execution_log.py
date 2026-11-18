"""In-memory log of tool executions for the Web UI's Execution History page.

Every tool call made through the REST API or by the AI assistant is recorded
with its real duration and outcome. The log is a bounded ring buffer held in
process memory: it is intentionally not persisted and resets on restart.
"""

from __future__ import annotations

import threading
from collections import deque
from datetime import UTC, datetime
from typing import Any

MAX_ENTRIES = 500
_MAX_ARGUMENT_CHARS = 2000
_MAX_ERROR_CHARS = 1000

_entries: deque[dict[str, Any]] = deque(maxlen=MAX_ENTRIES)
_lock = threading.Lock()
_sequence = 0


def _compact_arguments(arguments: dict | None) -> dict:
    compact = {}
    for key, value in (arguments or {}).items():
        text = value if isinstance(value, str) else repr(value)
        if len(text) > _MAX_ARGUMENT_CHARS:
            text = text[:_MAX_ARGUMENT_CHARS] + "…"
        compact[str(key)] = text if isinstance(value, str) else value
        if not isinstance(value, (str, int, float, bool, type(None), list, dict)):
            compact[str(key)] = text
    return compact


def record_execution(
    tool: str,
    source: str,
    duration_ms: float,
    ok: bool,
    error: str | None = None,
    arguments: dict | None = None,
    row_count: int | None = None,
) -> dict[str, Any]:
    """Append one execution to the log and return the stored entry."""
    global _sequence
    with _lock:
        _sequence += 1
        entry = {
            "id": _sequence,
            "tool": tool,
            "source": source,
            "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
            "duration_ms": round(float(duration_ms), 2),
            "status": "success" if ok else "error",
            "error": (str(error)[:_MAX_ERROR_CHARS] if error else None),
            "arguments": _compact_arguments(arguments),
            "row_count": row_count,
        }
        _entries.append(entry)
    return entry


def list_executions(limit: int = MAX_ENTRIES) -> list[dict[str, Any]]:
    """Return recorded executions, newest first."""
    with _lock:
        entries = list(_entries)
    entries.reverse()
    return entries[: max(1, int(limit))]


def last_execution_by_tool() -> dict[str, dict[str, Any]]:
    """Return the most recent execution for each tool."""
    latest: dict[str, dict[str, Any]] = {}
    with _lock:
        for entry in _entries:
            latest[entry["tool"]] = entry
    return latest
