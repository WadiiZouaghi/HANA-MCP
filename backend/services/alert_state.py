"""Persistent acknowledgement state for read-only monitoring alerts."""

import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

DATABASE_PATH = Path(__file__).parent.parent / "data" / "alert_state.sqlite3"
SQLITE_BUSY_TIMEOUT_MS = 30 * 1000


def _connection():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=SQLITE_BUSY_TIMEOUT_MS)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS alert_acknowledgements (
        alert_key TEXT PRIMARY KEY, acknowledged_at TEXT NOT NULL, note TEXT NOT NULL)"""
    )
    return connection


def acknowledged_alerts() -> dict:
    """Return acknowledged alerts keyed by alert id/key."""
    with closing(_connection()) as connection:
        return {
            row["alert_key"]: {
                "acknowledged_at": row["acknowledged_at"],
                "note": row["note"] or "",
            }
            for row in connection.execute(
                "SELECT alert_key, acknowledged_at, note FROM alert_acknowledgements"
            )
        }


def acknowledge_alert(alert_key: str, note: str = "") -> dict:
    """Persist an acknowledgement for an alert key."""
    if not alert_key or len(str(alert_key)) > 120:
        raise ValueError("A valid alert key is required")
    acknowledged_at = datetime.now(UTC).isoformat(timespec="seconds")
    normalized_note = (note or "")[:500]
    with closing(_connection()) as connection:
        connection.execute(
            "INSERT OR REPLACE INTO alert_acknowledgements VALUES (?, ?, ?)",
            (str(alert_key), acknowledged_at, normalized_note),
        )
        connection.commit()
    return {
        "alert_key": str(alert_key),
        "id": str(alert_key),
        "acknowledged_at": acknowledged_at,
        "note": normalized_note,
    }


def get_acknowledgements() -> list[dict]:
    with closing(_connection()) as connection:
        return [
            dict(row)
            for row in connection.execute(
                "SELECT alert_key, acknowledged_at, note FROM alert_acknowledgements ORDER BY acknowledged_at DESC"
            )
        ]


def clear_acknowledgement(alert_key: str) -> None:
    with closing(_connection()) as connection:
        connection.execute(
            "DELETE FROM alert_acknowledgements WHERE alert_key = ?",
            (str(alert_key),),
        )
        connection.commit()
