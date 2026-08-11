"""Persistent acknowledgement state for read-only monitoring alerts."""

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


DATABASE_PATH = Path(__file__).parent.parent / "data" / "alert_state.sqlite3"
SQLITE_BUSY_TIMEOUT_MS = 30 * 1000


def _connection():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=SQLITE_BUSY_TIMEOUT_MS)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("""CREATE TABLE IF NOT EXISTS alert_acknowledgements (
        alert_key TEXT PRIMARY KEY, acknowledged_at TEXT NOT NULL, note TEXT NOT NULL)""")
    return connection


def acknowledge_alert(alert_key: str, note: str = "") -> dict:
    if not alert_key or len(alert_key) > 120:
        raise ValueError("A valid alert key is required")
    acknowledged_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with closing(_connection()) as connection:
        connection.execute("INSERT OR REPLACE INTO alert_acknowledgements VALUES (?, ?, ?)", (alert_key, acknowledged_at, note[:500]))
        connection.commit()
    return {"alert_key": alert_key, "acknowledged_at": acknowledged_at, "note": note[:500]}


def get_acknowledgements() -> list[dict]:
    with closing(_connection()) as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM alert_acknowledgements ORDER BY acknowledged_at DESC")]
