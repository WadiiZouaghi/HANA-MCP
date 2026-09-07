import json

from flask import (
    Blueprint,
    Response,
    jsonify,
    request,
)
from services.agent import ModelUnavailable, agent_enabled, run_agent, run_agent_events
from services.alerts import (
    get_alerts,
    get_expensive_queries,
    get_locks_alerts,
)
from services.dashboard import get_dashboard
from services.dashboard_metrics import build_dashboard_metrics
from services.database import get_database_status
from services.health import (
    get_backup_status,
    get_replication_status,
    get_services_status,
)
from services.history import get_metric_history
from services.metrics import (
    get_connections_metrics,
    get_cpu_metrics,
    get_disk_metrics,
    get_memory_metrics,
)

from tool_registry import TOOLS

api = Blueprint("api", __name__)


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


@api.route("/chat/config")
def chat_config():
    """Report whether the LLM agent loop is enabled for the Web UI."""
    return jsonify({"enabled": agent_enabled()})


@api.route("/chat/agent", methods=["POST"])
def chat_agent():
    """Run the tool-calling agent loop for a single user prompt.

    Body: {"text": "...", "history": [ {role, text|summary}, ... ],
            "attachment": {"name": "...", "content": "..."}}
    ``attachment`` (a .csv/.txt file uploaded by the UI) is fed to the model
    as context so it can interpret errors, long-running statements, or plan
    outputs. On model-unavailable the response carries ``fallback: true`` so
    the UI can transparently use the keyword router instead of erroring.
    """
    body = request.json or {}
    text = (body.get("text") or "").strip()
    attachment = body.get("attachment") or None
    if not text and not attachment:
        return jsonify({"error": "text or attachment is required"}), 400
    history = body.get("history") or None
    try:
        result = run_agent(text, history=history, attachment=attachment)
        return jsonify(result)
    except ModelUnavailable as error:
        return jsonify({"error": str(error), "fallback": True})
    except Exception as error:
        return jsonify({"error": str(error)}), 500


@api.route("/chat/agent/stream", methods=["POST"])
def chat_agent_stream():
    """Stream agent events for progressive UI updates.

    Yields newline-delimited JSON objects with ``type`` values:
    ``thinking``, ``tool_start``, ``tool_complete``, ``token``, ``done``.
    """
    body = request.json or {}
    text = (body.get("text") or "").strip()
    attachment = body.get("attachment") or None
    if not text and not attachment:
        return jsonify({"error": "text or attachment is required"}), 400
    history = body.get("history") or None

    def generate():
        try:
            for event in run_agent_events(text, history=history, attachment=attachment):
                payload = (json.dumps(event) + "\n").encode("utf-8")
                if len(payload) < 1024:
                    payload = payload + b" " * (1024 - len(payload)) + b"\n"
                yield payload
        except ModelUnavailable as error:
            payload = (json.dumps({"error": str(error), "fallback": True}) + "\n").encode("utf-8")
            if len(payload) < 1024:
                payload = payload + b" " * (1024 - len(payload)) + b"\n"
            yield payload
        except Exception as error:
            payload = (json.dumps({"error": str(error)}) + "\n").encode("utf-8")
            if len(payload) < 1024:
                payload = payload + b" " * (1024 - len(payload)) + b"\n"
            yield payload

    response = Response(generate(), mimetype="application/x-ndjson")
    response.headers["X-Accel-Buffering"] = "no"
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Connection"] = "keep-alive"
    return response


@api.route("/chat/suggestions")
def chat_suggestions():
    """Suggested prompts for the AI Chat page and their tool sequences."""
    return jsonify(
        [
            {
                "label": "How healthy is my database?",
                "desc": "Complete operational health assessment",
                "steps": ["hana_health_check"],
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
                "steps": ["hana_execute_query"],
                "icon": "▤",
            },
            {
                "label": "Show metric history",
                "desc": "CPU / memory / connections trend",
                "steps": ["hana_metric_history"],
                "icon": "📈",
            },
        ]
    )


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
