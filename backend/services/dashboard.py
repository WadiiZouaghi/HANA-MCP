from services.alerts import get_alerts
from services.dashboard_metrics import build_dashboard_metrics
from services.database import get_database_status
from services.health import (
    get_backup_status,
    get_replication_status,
    get_services_status,
)
from services.history import record_snapshot
from services.metrics import (
    get_connections_metrics,
    get_cpu_metrics,
    get_disk_metrics,
    get_memory_metrics,
)


def safe_call(function):

    try:
        return function()

    except Exception as error:
        return {"error": str(error)}


def get_dashboard():

    raw_memory = safe_call(get_memory_metrics)
    raw_connections = safe_call(get_connections_metrics)
    raw_cpu = safe_call(get_cpu_metrics)

    dashboard = {
        "system": safe_call(get_database_status),
        "metrics": {
            **build_dashboard_metrics(raw_memory, raw_cpu, raw_connections),
            "disk": safe_call(get_disk_metrics),
        },
        "health": {
            "services": safe_call(get_services_status),
            "replication": safe_call(get_replication_status),
            "backup": safe_call(get_backup_status),
        },
        "alerts": safe_call(get_alerts),
    }

    # Persist history best-effort; never let a storage failure break the dashboard.
    try:
        record_snapshot(dashboard["metrics"])
    except Exception as error:
        dashboard["history_error"] = str(error)
    return dashboard
