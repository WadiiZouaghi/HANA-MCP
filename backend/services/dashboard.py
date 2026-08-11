from services.database import get_database_status

from services.metrics import (
    get_memory_metrics,
    get_connections_metrics,
    get_cpu_metrics,
    get_disk_metrics
)

from services.health import (
    get_services_status,
    get_replication_status,
    get_backup_status
)

from services.alerts import (
    get_locks_alerts,
    get_expensive_queries
)

from services.dashboard_metrics import build_dashboard_metrics
from services.history import record_snapshot


def safe_call(function):

    try:
        return function()

    except Exception as error:

        return {
            "error": str(error)
        }



def get_dashboard():

    raw_memory = safe_call(get_memory_metrics)
    raw_connections = safe_call(get_connections_metrics)
    raw_cpu = safe_call(get_cpu_metrics)

    dashboard = {

        "system": safe_call(
            get_database_status
        ),


        "metrics": {
            **build_dashboard_metrics(raw_memory, raw_cpu, raw_connections),
            "disk": safe_call(get_disk_metrics)
        },


        "health": {

            "services": safe_call(
                get_services_status
            ),

            "replication": safe_call(
                get_replication_status
            ),

            "backup": safe_call(
                get_backup_status
            )

        },


        "alerts": {

            "locks": safe_call(
                get_locks_alerts
            ),

            "expensive_queries": safe_call(
                get_expensive_queries
            )

        }

    }

    # Persist history best-effort; never let a storage failure break the dashboard.
    try:
        record_snapshot(dashboard["metrics"])
    except Exception as error:  # noqa: BLE001
        dashboard["history_error"] = str(error)
    return dashboard
