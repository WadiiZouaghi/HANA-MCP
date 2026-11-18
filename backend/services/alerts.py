from backend import _pathsetup  # noqa: F401 (ensures project root is on sys.path)
from engine import query_rows

from . import alert_state


def get_alerts():
    """Return actionable dashboard alerts with severity and acknowledgement state."""
    locks = get_locks_alerts()
    expensive = get_expensive_queries()
    acknowledgements = alert_state.acknowledged_alerts()
    alerts = []

    lock_count = locks.get("count", 0) if isinstance(locks, dict) else 0
    if lock_count:
        ack = acknowledgements.get("blocked-transactions", {})
        alerts.append(
            {
                "id": "blocked-transactions",
                "title": "Blocked transactions detected",
                "description": f"{lock_count} transaction(s) are currently blocked.",
                "severity": "critical" if lock_count >= 5 else "warning",
                "acknowledged_at": ack.get("acknowledged_at"),
                "ack_note": ack.get("note", ""),
            }
        )

    expensive_rows = expensive if isinstance(expensive, list) else []
    if expensive_rows:
        ack = acknowledgements.get("expensive-queries", {})
        alerts.append(
            {
                "id": "expensive-queries",
                "title": "Expensive SQL statements detected",
                "description": f"{len(expensive_rows)} recent expensive statement(s) require review.",
                "severity": "warning",
                "acknowledged_at": ack.get("acknowledged_at"),
                "ack_note": ack.get("note", ""),
            }
        )

    return sorted(
        alerts,
        key=lambda item: (
            item.get("acknowledged_at") is not None,
            item.get("severity") != "critical",
            item.get("title", ""),
        ),
    )


def acknowledge_alert(alert_id, note: str = ""):
    """Acknowledge a current alert so the operator's action is retained."""
    active = {alert["id"] for alert in get_alerts()}
    if alert_id not in active:
        # Allow acknowledging known alert types even if transiently absent.
        known = {"blocked-transactions", "expensive-queries"}
        if alert_id not in known:
            raise ValueError("Alert not found or no longer active")
    result = alert_state.acknowledge_alert(alert_id, note)
    return {"id": alert_id, "acknowledged_at": result["acknowledged_at"], "note": result.get("note", "")}


def get_acknowledgements():
    return alert_state.get_acknowledgements()


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
