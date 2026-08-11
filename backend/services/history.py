"""Lightweight local time-series storage for dashboard metric snapshots."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DATABASE_PATH = Path(__file__).parent.parent / "data" / "metrics_history.sqlite3"
MAX_HISTORY_MINUTES = 24 * 60
# Allow concurrent readers/writers from multiple requests/threads without
# tripping the default 5s busy handler under bursty dashboard refreshes.
SQLITE_BUSY_TIMEOUT_MS = 30 * 1000


def _connection() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=SQLITE_BUSY_TIMEOUT_MS)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("""CREATE TABLE IF NOT EXISTS metric_snapshots (
        captured_at TEXT NOT NULL, cpu_usage REAL NOT NULL,
        memory_usage REAL NOT NULL, connections INTEGER NOT NULL)""")
    return connection


def record_snapshot(metrics: dict[str, Any]) -> None:
    """Persist a compact dashboard metric snapshot and prune old entries."""
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with closing(_connection()) as connection:
        connection.execute("INSERT INTO metric_snapshots VALUES (?, ?, ?, ?)", (
            captured_at, float(metrics.get("cpu", {}).get("usage_percent", 0)),
            float(metrics.get("memory", {}).get("usage_percent", 0)),
            int(metrics.get("connections", {}).get("active", 0)),
        ))
        connection.commit()
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=MAX_HISTORY_MINUTES)).isoformat(timespec="seconds")
        connection.execute("DELETE FROM metric_snapshots WHERE captured_at < ?", (cutoff,))
        connection.commit()


def get_metric_history(minutes: int = 60) -> dict[str, Any]:
    """Return chronological chart points for the requested recent time window."""
    minutes = max(1, min(int(minutes), MAX_HISTORY_MINUTES))
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    with closing(_connection()) as connection:
        rows = connection.execute("""SELECT captured_at, cpu_usage, memory_usage, connections
            FROM metric_snapshots WHERE captured_at >= ? ORDER BY captured_at""", (cutoff,)).fetchall()
    return {"window_minutes": minutes, "points": [dict(row) for row in rows]}
