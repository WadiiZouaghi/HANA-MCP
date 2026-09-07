"""Time-series trend analysis over dashboard metric snapshots.

Reads the same local SQLite store that ``backend/services/history.py``
populates (CPU / memory / connection snapshots), and exposes it as pure
read-only analysis functions. No HANA connection and no model are required,
so these work fully on the free tier.

This module is top-level (not under ``backend/services``) on purpose: the MCP
server imports tool implementations from top-level modules, and ``backend`` is
not on ``sys.path`` there. ``backend/services/history.py`` re-exports the
read/write helpers so the Flask app is unaffected.
"""

from __future__ import annotations

import sqlite3
import statistics
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

DATABASE_PATH = Path(__file__).parent / "backend" / "data" / "metrics_history.sqlite3"
MAX_HISTORY_MINUTES = 24 * 60
SQLITE_BUSY_TIMEOUT_MS = 30 * 1000

METRICS = ("cpu_usage", "memory_usage", "connections")


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
    captured_at = datetime.now(UTC).isoformat(timespec="seconds")
    with closing(_connection()) as connection:
        connection.execute(
            "INSERT INTO metric_snapshots VALUES (?, ?, ?, ?)",
            (
                captured_at,
                float(metrics.get("cpu", {}).get("usage_percent", 0)),
                float(metrics.get("memory", {}).get("usage_percent", 0)),
                int(metrics.get("connections", {}).get("active", 0)),
            ),
        )
        connection.commit()
        cutoff = (datetime.now(UTC) - timedelta(minutes=MAX_HISTORY_MINUTES)).isoformat(
            timespec="seconds"
        )
        connection.execute(
            "DELETE FROM metric_snapshots WHERE captured_at < ?", (cutoff,)
        )
        connection.commit()


def get_metric_history(minutes: int = 60, limit: int | None = None) -> dict[str, Any]:
    if limit is not None:
        minutes = limit
    minutes = max(1, min(int(minutes), MAX_HISTORY_MINUTES))
    cutoff = (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat(
        timespec="seconds"
    )
    with closing(_connection()) as connection:
        rows = connection.execute(
            """SELECT captured_at, cpu_usage, memory_usage, connections
               FROM metric_snapshots WHERE captured_at >= ? ORDER BY captured_at""",
            (cutoff,),
        ).fetchall()
    return {"window_minutes": minutes, "points": [dict(row) for row in rows]}


def _points_between(
    start_minutes_ago: int, end_minutes_ago: int
) -> list[dict[str, Any]]:
    """Rows captured between two offsets (start > end, both minutes ago)."""
    now = datetime.now(UTC)
    start = (now - timedelta(minutes=start_minutes_ago)).isoformat(timespec="seconds")
    end = (now - timedelta(minutes=end_minutes_ago)).isoformat(timespec="seconds")
    with closing(_connection()) as connection:
        rows = connection.execute(
            """SELECT captured_at, cpu_usage, memory_usage, connections
               FROM metric_snapshots
               WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at""",
            (start, end),
        ).fetchall()
    return [dict(row) for row in rows]


def _aggregate(values: list[float]) -> dict[str, Any]:
    present = [v for v in values if v is not None]
    if not present:
        return {"count": 0, "avg": None, "min": None, "max": None, "std": None}
    return {
        "count": len(present),
        "avg": round(statistics.fmean(present), 4),
        "min": round(min(present), 4),
        "max": round(max(present), 4),
        "std": round(statistics.pstdev(present), 4) if len(present) > 1 else 0.0,
    }


def compare_periods(
    recent_minutes: int = 60, prior_minutes: int = 60, limit: int | None = None
) -> dict[str, Any]:
    """Compare a recent window against an immediately preceding window.

    Returns per-metric recent/prior averages and the percentage delta.
    """
    if limit is not None:
        recent_minutes = limit
    recent_minutes = max(1, min(int(recent_minutes), MAX_HISTORY_MINUTES))
    prior_minutes = max(1, min(int(prior_minutes), MAX_HISTORY_MINUTES))

    recent = _points_between(recent_minutes, 0)
    prior = _points_between(recent_minutes + prior_minutes, recent_minutes)

    metrics: dict[str, Any] = {}
    for metric in METRICS:
        recent_vals = [p[metric] for p in recent]
        prior_vals = [p[metric] for p in prior]
        recent_avg = statistics.fmean(recent_vals) if recent_vals else None
        prior_avg = statistics.fmean(prior_vals) if prior_vals else None
        if recent_avg is not None and prior_avg not in (None, 0):
            delta_pct = round((recent_avg - prior_avg) / prior_avg * 100, 2)
        else:
            delta_pct = None
        metrics[metric] = {
            "recent_avg": round(recent_avg, 4) if recent_avg is not None else None,
            "prior_avg": round(prior_avg, 4) if prior_avg is not None else None,
            "delta_pct": delta_pct,
        }

    return {
        "recent_minutes": recent_minutes,
        "prior_minutes": prior_minutes,
        "recent_samples": len(recent),
        "prior_samples": len(prior),
        "metrics": metrics,
    }


def detect_anomalies(
    minutes: int = 180, std_devs: float = 2.0, limit: int | None = None
) -> dict[str, Any]:
    """Flag snapshot points that deviate from the window mean beyond ``std_devs``.

    Works on CPU, memory and connections. Returns a per-metric summary plus a
    list of anomalous points (timestamp, metric, value, mean, deviation).
    """
    if limit is not None:
        minutes = limit
    minutes = max(1, min(int(minutes), MAX_HISTORY_MINUTES))
    std_devs = float(std_devs)
    points = get_metric_history(minutes)["points"]

    summaries: dict[str, Any] = {}
    anomalies: list[dict[str, Any]] = []
    for metric in METRICS:
        values = [p[metric] for p in points if p.get(metric) is not None]
        stats = _aggregate(values)
        summaries[metric] = stats
        if not values or (stats["std"] in (None, 0)):
            continue
        mean = stats["avg"]
        threshold = std_devs * stats["std"]
        for p in points:
            value = p.get(metric)
            if value is None:
                continue
            deviation = value - mean
            if abs(deviation) > threshold:
                anomalies.append(
                    {
                        "captured_at": p["captured_at"],
                        "metric": metric,
                        "value": value,
                        "mean": mean,
                        "deviation": round(deviation, 4),
                    }
                )

    anomalies.sort(key=lambda a: a["captured_at"])
    return {
        "window_minutes": minutes,
        "threshold_std_devs": std_devs,
        "metric_summary": summaries,
        "anomaly_count": len(anomalies),
        "anomalies": anomalies,
    }
