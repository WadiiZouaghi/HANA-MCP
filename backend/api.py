import _pathsetup  # noqa: F401  (ensures project root is on sys.path)

from flask import (
    Blueprint,
    jsonify,
    request,
)

from tool_registry import TOOLS, tool_categories
from ui_config import tool_ui_meta

from services.database import get_database_status
from services.metrics import (
    get_memory_metrics,
    get_connections_metrics,
    get_cpu_metrics,
    get_disk_metrics,
)
from services.health import (
    get_services_status,
    get_replication_status,
    get_backup_status,
)
from services.alerts import (
    get_locks_alerts,
    get_expensive_queries,
    get_alerts,
)
from services.dashboard import get_dashboard
from services.dashboard_metrics import build_dashboard_metrics
from services.history import get_metric_history


api = Blueprint("api", __name__)


# =====================================
# Tool manifest (for Tool Explorer)
# =====================================

@api.route("/tools")
def tools():
    result = []
    for name, tool in TOOLS.items():
        category = tool.get("category")
        result.append({
            "name": name,
            "category": category,
            "description": tool.get("description"),
            "purpose": tool.get("purpose"),
            "inputs": tool.get("inputs"),
            "output": tool.get("output"),
            "example": tool.get("example"),
            "ui": tool_ui_meta(name, category),
        })
    return jsonify(result)


@api.route("/tools/categories")
def tool_categories_route():
    return jsonify(tool_categories())


# =====================================
# Execute tool dynamically
# =====================================

@api.route("/tool/<name>", methods=["POST"])
def execute_tool(name):
    if name not in TOOLS:
        return jsonify({"error": "Tool not found"}), 404

    tool = TOOLS[name]
    parameters = request.json or {}

    try:
        result = tool["function"](**parameters)
        return jsonify(result)

    except Exception as error:
        return jsonify({"error": str(error)}), 500


# =====================================
# AI CHAT SUGGESTIONS
# =====================================

@api.route("/chat/suggestions")
def chat_suggestions():
    """Suggested prompts for the AI Chat page and their tool sequences."""
    return jsonify([
        {
            "label": "How healthy is my database?",
            "desc": "Status, memory, CPU, connections",
            "steps": ["hana_system_status", "hana_memory", "hana_cpu", "hana_connections"],
            "icon": "♥",
        },
        {
            "label": "Any blocked transactions?",
            "desc": "Lock waits and live connections",
            "steps": ["hana_blocked_transactions", "hana_connections"],
            "icon": "🔒",
        },
        {
            "label": "Show expensive queries",
            "desc": "Top recent slow statements",
            "steps": ["hana_expensive_statements"],
            "icon": "⚡",
        },
        {
            "label": "Check replication status",
            "desc": "System replication health",
            "steps": ["hana_replication"],
            "icon": "⇄",
        },
        {
            "label": "Memory & service pressure",
            "desc": "Memory usage + active services",
            "steps": ["hana_memory", "hana_services"],
            "icon": "◢",
        },
        {
            "label": "Find a view by name",
            "desc": "Search schema views",
            "steps": ["hana_search_views"],
            "icon": "▤",
        },
    ])


# =====================================
# SYSTEM STATUS
# =====================================

@api.route("/system/status")
def system_status():
    return jsonify(get_database_status())


# =====================================
# METRICS
# =====================================

@api.route("/metrics/memory")
def memory_metrics():
    return jsonify(get_memory_metrics())


@api.route("/metrics/connections")
def connections_metrics():
    return jsonify(get_connections_metrics())


@api.route("/metrics/cpu")
def cpu_metrics():
    return jsonify(get_cpu_metrics())


@api.route("/metrics/disk")
def disk_metrics():
    return jsonify(get_disk_metrics())


# =====================================
# HEALTH
# =====================================

@api.route("/health/services")
def services_health():
    return jsonify(get_services_status())


@api.route("/health/replication")
def replication_health():
    return jsonify(get_replication_status())


@api.route("/health/backups")
def backup_health():
    return jsonify(get_backup_status())


# =====================================
# ALERTS
# =====================================

@api.route("/alerts/locks")
def locks_alerts():
    return jsonify(get_locks_alerts())


@api.route("/alerts/expensive")
def expensive_queries():
    return jsonify(get_expensive_queries())


@api.route("/alerts")
def alerts():
    return jsonify(get_alerts())


# =====================================
# DASHBOARD
# =====================================

@api.route("/dashboard")
def dashboard():
    return jsonify(get_dashboard())


@api.route("/dashboard/metrics")
def dashboard_metrics():
    return jsonify(
        build_dashboard_metrics(
            get_memory_metrics(),
            get_cpu_metrics(),
            get_connections_metrics(),
        )
    )


@api.route("/history")
def metric_history():
    try:
        minutes = int(request.args.get("minutes", 60))
    except ValueError:
        return jsonify({"error": "minutes must be an integer"}), 400
    return jsonify(get_metric_history(minutes))


# =====================================
# GLOBAL ERROR HANDLER
# =====================================

@api.errorhandler(Exception)
def handle_error(error):
    return jsonify({"error": str(error)}), 500
