import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from backend import _pathsetup  # noqa: F401 (ensures project root is on sys.path)
from engine import query_rows

ALERT_DATABASE_PATH = Path(__file__).parent.parent / "data" / "alert_state.sqlite3"
SQLITE_BUSY_TIMEOUT_MS = 30 * 1000


def _alert_connection():
    ALERT_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(ALERT_DATABASE_PATH, timeout=SQLITE_BUSY_TIMEOUT_MS)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    # Single shared table used by both alerts.py (reads) and alert_state.py (writes).
    connection.execute("""CREATE TABLE IF NOT EXISTS alert_acknowledgements (
        alert_key TEXT PRIMARY KEY, acknowledged_at TEXT NOT NULL, note TEXT NOT NULL)""")
    return connection


def _acknowledged_alerts():
    with closing(_alert_connection()) as connection:
        return {
            row["alert_key"]: row["acknowledged_at"]
            for row in connection.execute("SELECT * FROM alert_acknowledgements")
        }


def get_alerts():
    """Return actionable dashboard alerts with severity and acknowledgement state."""
    locks = get_locks_alerts()
    expensive = get_expensive_queries()
    acknowledgements = _acknowledged_alerts()
    alerts = []

    lock_count = locks.get("count", 0) if isinstance(locks, dict) else 0
    if lock_count:
        alerts.append(
            {
                "id": "blocked-transactions",
                "title": "Blocked transactions detected",
                "description": f"{lock_count} transaction(s) are currently blocked.",
                "severity": "critical" if lock_count >= 5 else "warning",
                "acknowledged_at": acknowledgements.get("blocked-transactions"),
            }
        )

    expensive_rows = expensive if isinstance(expensive, list) else []
    if expensive_rows:
        alerts.append(
            {
                "id": "expensive-queries",
                "title": "Expensive SQL statements detected",
                "description": f"{len(expensive_rows)} recent expensive statement(s) require review.",
                "severity": "warning",
                "acknowledged_at": acknowledgements.get("expensive-queries"),
            }
        )

    return sorted(
        alerts,
        key=lambda item: (
            item["acknowledged_at"] is not None,
            item["severity"] != "critical",
        ),
    )


def acknowledge_alert(alert_id):
    """Acknowledge a current alert so the operator's action is retained."""
    valid_ids = {alert["id"] for alert in get_alerts()}
    if alert_id not in valid_ids:
        raise ValueError("Alert not found or no longer active")
    timestamp = datetime.now(UTC).isoformat(timespec="seconds")
    with _alert_connection() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO alert_acknowledgements (alert_key, acknowledged_at, note) VALUES (?, ?, ?)",
            (alert_id, timestamp, ""),
        )
    return {"id": alert_id, "acknowledged_at": timestamp}


def get_locks_alerts():

    query = """
    SELECT *
    FROM SYS.M_BLOCKED_TRANSACTIONS
    """

    try:
        locks = query_rows(query)
        return {"count": len(locks), "data": locks}

    except Exception as error:
        return {"error": str(error)}


def get_expensive_queries():

    query = """
    SELECT
        TOP 20
        *
    FROM SYS.M_EXPENSIVE_STATEMENTS
    ORDER BY START_TIME DESC
    """

    try:
        return query_rows(query)

    except Exception as error:
        return {"error": str(error)}
