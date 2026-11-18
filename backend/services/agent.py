"""Agent loop for the Web UI AI Chat - ENHANCED VERSION.

Improvements:
- Restructured system prompt with decision trees instead of flat rules
- Few-shot examples showing question → tool mapping
- Better context framing for attachments and history
- Improved error recovery and self-correction
- Tool descriptions now include "when to use" guidance
- Multi-turn reasoning support with explicit next-step planning
"""

from __future__ import annotations

import json
import re
import time
import urllib.request

from backend import _pathsetup  # noqa: F401 (ensures project root on sys.path)
from engine import load_config
from tool_registry import TOOLS, tool_manifest

from .execution_log import record_execution


class ModelUnavailable(RuntimeError):
    """Raised when the configured LLM endpoint cannot be reached."""


SYSTEM_PROMPT = """You are a read-only SAP HANA monitoring assistant connected to a LIVE database through tools.

## GROUNDING RULES (most important)
- Every fact about this database (numbers, names, statuses, dates, users, tables) must come from a tool result in this conversation. If you do not have a tool result for it, call a tool. Never answer live-data questions from memory.
- Never invent, estimate or complete values. If a tool returned an error or zero rows, say exactly that and stop.
- Copy values exactly as the tool returned them. Do not convert units or do arithmetic.
- When a tool result has a "verdict", or a status such as Memory Pressure NORMAL or health HEALTHY, that IS the assessment. State it and explain it; never contradict it or re-judge the numbers yourself. NORMAL, OK and HEALTHY mean there is no problem.
- General HANA concept questions ("what is a savepoint?") may be answered without tools, but then state no figures about this system.

## PICK THE TOOL
- health / overall status -> hana_health_check
- memory -> hana_memory, CPU -> hana_cpu, disk -> hana_disk
- connection count -> hana_connections
- services -> hana_services (optional service_name, comma-separated for several)
- backups -> hana_backup_status, replication -> hana_replication
- slow SQL -> hana_expensive_statements, SQL running now -> hana_active_statements
- locks -> hana_blocked_transactions, trace/log files -> hana_trace_files
- largest tables -> hana_table_sizes
- trends -> hana_metric_history, hana_compare_periods, hana_detect_anomalies
- SAP Note 1969700 diagnostic SQL -> hana_search_sap_library, then hana_execute_sap_statement
- anything else (users, roles, tables, schemas, parameters) -> hana_execute_query
Tools without inputs are called with {}.

## WRITING SQL FOR hana_execute_query
- One SELECT or WITH statement. Always schema-qualify, with a DOT: SYS.USERS (never SYS_USERS, M_USER or USERS).
- Use only objects you are sure exist. Known-good views:
  - users: SYS.USERS (USER_NAME, USER_DEACTIVATED, LAST_SUCCESSFUL_CONNECT, CREATE_TIME)
  - roles: SYS.ROLES, SYS.GRANTED_ROLES (GRANTEE, ROLE_NAME)
  - privileges: SYS.GRANTED_PRIVILEGES (GRANTEE, PRIVILEGE, OBJECT_TYPE)
  - schemas: SYS.SCHEMAS, tables: SYS.TABLES, SYS.M_TABLES, views: SYS.VIEWS
  - columns: SYS.TABLE_COLUMNS, SYS.VIEW_COLUMNS
  - sessions: SYS.M_CONNECTIONS (CONNECTION_ID, USER_NAME, CONNECTION_STATUS, CLIENT_HOST)
  - database/version: SYS.M_DATABASE, license: SYS.M_LICENSE
  - parameters: SYS.M_INIFILE_CONTENTS (FILE_NAME, SECTION, KEY, VALUE)
  - backups: SYS.M_BACKUP_CATALOG, alerts: _SYS_STATISTICS.STATISTICS_CURRENT_ALERTS
- Not sure of a name? Look it up first, do not guess:
  SELECT SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS WHERE VIEW_NAME LIKE '%BACKUP%'
- Not sure of a column? SELECT COLUMN_NAME FROM SYS.VIEW_COLUMNS WHERE VIEW_NAME = 'USERS'
- If a query fails with "Unknown HANA object" or "invalid column name", use the suggestions in the error message, fix the SQL and retry once. Never repeat the same failing SQL.

## ANSWER FORMAT
- Write an explanation in plain language, not a table and not a list of every row:
  1. A direct answer to the question in one sentence (for example whether memory is high or not).
  2. The few figures from the tool result that support it, with the values in **bold**.
  3. The reason: which component, service or statement in the result drives the situation, and what that means. If the result does not show the cause, say so and name what should be checked next.
- Mention only the values that matter for the answer. No JSON, no raw dumps, no code blocks of data, no markdown tables.
- Do not tell the user to call a tool; you call it.
"""


MAX_ATTACHMENT_CHARS = 10000


def _file_context(att: dict) -> str:
    """Render an uploaded file's contents as a context block for the model."""
    name = att.get("name") or "file"
    content = att.get("content") or ""
    if len(content) > MAX_ATTACHMENT_CHARS:
        content = content[:MAX_ATTACHMENT_CHARS] + "\n\n[… file truncated …]"
    return (
        f'CONTEXT: The operator uploaded a file: "{name}"\n\n'
        "Use this to understand errors, query plans, logs, or diagnostic output:\n\n"
        f"--- BEGIN: {name} ---\n{content}\n--- END: {name} ---\n\n"
        "Reference this file when the user asks about it. If the file contains error messages, "
        "logs, or stack traces, explain what they mean."
    )


def load_llm_config() -> dict:
    """Return the ``llm`` section of config.yaml (empty dict if absent)."""
    return load_config().get("llm", {}) or {}


def agent_enabled() -> bool:
    """True only when the operator explicitly enabled the LLM agent."""
    try:
        return bool(load_llm_config().get("enabled", False))
    except Exception:
        return False


def _json_type(type_name: str | None) -> str:
    return {
        "str": "string",
        "string": "string",
        "int": "integer",
        "integer": "integer",
        "float": "number",
        "number": "number",
        "bool": "boolean",
        "boolean": "boolean",
        "list": "array",
        "array": "array",
        "dict": "object",
        "object": "object",
    }.get((type_name or "str").lower(), "string")


def _build_tools(only: list[str] | None = None) -> list[dict]:
    """Translate the MCP tool manifest into OpenAI tool-call schemas with better descriptions."""
    tools = []
    tool_guidance = {
        "hana_health_check": "Overall system health check (pass/fail, alerts).",
        "hana_memory": "Memory usage breakdown (RAM, heap, shared memory, pressure level).",
        "hana_cpu": "CPU utilization and top consumers.",
        "hana_disk": "Disk usage by component (log, trace, data, backup volumes).",
        "hana_connections": "Active connection count and session details.",
        "hana_backup_status": "Backup history, progress, last backup time.",
        "hana_trace_files": "Recent log/trace files and their timestamps.",
        "hana_expensive_statements": "Slow-running SQL statements sorted by duration.",
        "hana_blocked_transactions": "Blocked/locked transactions with blocker analysis.",
        "hana_services": "Service status (nameserver, indexserver, etc.). Optional service_name parameter to filter by specific service.",
        "hana_replication": "System replication status and lag.",
        "hana_metric_history": "Historical metric trends over time.",
        "hana_detect_anomalies": "Statistical outlier detection in metrics.",
        "hana_compare_periods": "Compare metrics between two time windows.",
        "hana_execute_query": "Custom SQL (SELECT/WITH only). For data not covered by other tools.",
    }

    for tool in tool_manifest():
        properties = {}
        required = []
        for item in tool.get("inputs") or []:
            name = item.get("name")
            if not name:
                continue
            prop = {
                "type": _json_type(item.get("type", "str")),
                "description": item.get("description", ""),
            }
            if item.get("default") is not None:
                prop["default"] = item["default"]
            properties[name] = prop
            if not item.get("optional") and item.get("default") is None:
                required.append(name)

        desc = tool.get("description", "")
        if tool["name"] in tool_guidance:
            desc = tool_guidance[tool["name"]]

        if only and tool["name"] not in only:
            continue

        tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": desc,
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    },
                },
            }
        )
    return tools


_QUERY_TOOL_MAP = [
    ("health", "hana_health_check"),
    ("status", "hana_health_check"),
    ("memory", "hana_memory"),
    ("ram", "hana_memory"),
    ("cpu", "hana_cpu"),
    ("processor", "hana_cpu"),
    ("disk", "hana_disk"),
    ("storage", "hana_disk"),
    ("volume", "hana_disk"),
    ("connection", "hana_connections"),
    ("backup", "hana_backup_status"),
    ("log", "hana_trace_files"),
    ("trace", "hana_trace_files"),
    ("slow", "hana_expensive_statements"),
    ("expensive", "hana_expensive_statements"),
    ("lock", "hana_blocked_transactions"),
    ("blocked", "hana_blocked_transactions"),
    ("deadlock", "hana_blocked_transactions"),
    ("service", "hana_services"),
    ("webdispatcher", "hana_services"),
    ("daemon", "hana_services"),
    ("indexserver", "hana_services"),
    ("nameserver", "hana_services"),
    ("preprocessor", "hana_services"),
    ("compileserver", "hana_services"),
    ("replication", "hana_replication"),
    ("standby", "hana_replication"),
    ("ha", "hana_replication"),
    ("running statement", "hana_active_statements"),
    ("active statement", "hana_active_statements"),
    ("running quer", "hana_active_statements"),
    ("largest table", "hana_table_sizes"),
    ("biggest table", "hana_table_sizes"),
    ("table size", "hana_table_sizes"),
    ("history", "hana_metric_history"),
    ("trend", "hana_metric_history"),
    ("anomal", "hana_detect_anomalies"),
    ("unusual", "hana_detect_anomalies"),
    ("compare", "hana_compare_periods"),
    ("sap note", "hana_search_sap_library"),
    ("library", "hana_search_sap_library"),
    ("diagnostic", "hana_search_sap_library"),
    ("user", "hana_execute_query"),
    ("role", "hana_execute_query"),
    ("table", "hana_execute_query"),
    ("view", "hana_execute_query"),
    ("schema", "hana_execute_query"),
    ("privilege", "hana_execute_query"),
    ("session", "hana_execute_query"),
    ("parameter", "hana_execute_query"),
    ("select", "hana_execute_query"),
    ("query", "hana_execute_query"),
]


def _classify_tools(user_text: str) -> list[str]:
    """Return the most relevant tool names for ``user_text`` (first round only)."""
    matched = _matched_tools(user_text)[:3]
    if "hana_execute_query" not in matched:
        matched.append("hana_execute_query")
    return matched


# Keywords that must match as a whole word (optionally plural); the rest
# match as a word prefix ("connection" matches "connections").
_EXACT_KEYWORDS = {"ha", "ram", "log", "cpu"}


# Wording that signals a question about the live system rather than a concept.
_DATA_QUESTION_RE = re.compile(
    r"\b(show|list|display|how many|how much|which|who|current|currently|"
    r"right now|latest|last|count|top|check|is there|are there|give me|get)\b"
)


# Limits on what is replayed to the model. Small local models have small
# context windows; overflowing them is a major cause of invented answers.
MODEL_MAX_ROWS = 25


MODEL_MAX_CHARS = 6000


HISTORY_MAX_ENTRIES = 6


HISTORY_MAX_ROWS = 5


HISTORY_MAX_CHARS = 1200


_NUDGE_MESSAGE = (
    "You answered without calling a tool. This question is about the live "
    "database, so you MUST call a tool now and answer only from its result. "
    "Do not answer from memory."
)


_UNVERIFIED_NOTICE = (
    "> ⚠️ **Not verified against the live database** — no query was run for "
    "this answer, so treat any specifics below as unconfirmed.\n\n"
)


def _keyword_matches(keyword: str, text: str) -> bool:
    if keyword in _EXACT_KEYWORDS:
        return re.search(rf"\b{keyword}s?\b", text) is not None
    return re.search(rf"\b{re.escape(keyword)}", text) is not None


def _matched_tools(user_text: str) -> list[str]:
    """Return tools whose keywords appear in ``user_text`` (may be empty)."""
    text = user_text.lower()
    matched = []
    for keyword, tool in _QUERY_TOOL_MAP:
        if tool in TOOLS and tool not in matched and _keyword_matches(keyword, text):
            matched.append(tool)
    return matched


def _required_inputs(name: str) -> list[str]:
    tool = TOOLS.get(name) or {}
    return [
        item["name"]
        for item in tool.get("inputs") or []
        if item.get("name")
        and not item.get("optional")
        and item.get("default") is None
    ]


def _fallback_tool(matched: list[str]) -> str | None:
    """First keyword-matched tool that can run without any arguments."""
    for name in matched:
        if name != "hana_execute_query" and not _required_inputs(name):
            return name
    return None


def _verdict(name: str, raw) -> str | None:
    """Authoritative one-line assessment for tools that compute one.

    Small models tend to re-judge the numbers themselves and get it wrong
    (e.g. calling memory "high" at 29% usage), so the verdict the tool already
    computed is passed along as a fact to state, not something to derive.
    """
    if not isinstance(raw, dict):
        return None
    if name == "hana_memory":
        values = {
            str(row.get("metric")): row.get("value")
            for row in raw.get("rows") or []
            if isinstance(row, dict)
        }
        pressure = values.get("Memory Pressure")
        if not pressure:
            return None
        state = {
            "NORMAL": "Memory is NOT high",
            "WARNING": "Memory is elevated (WARNING)",
            "CRITICAL": "Memory is critically high",
        }.get(str(pressure), f"Memory pressure is {pressure}")
        return (
            f"{state}: pressure is {pressure}, HANA uses "
            f"{values.get('HANA Used %')} of system memory and "
            f"{values.get('Limit Used %')} of its allocation limit. "
            "'Heap Used %' is only the share of already-allocated heap that is "
            "in use; it is normally high and is NOT a sign of a memory problem."
        )
    if name == "hana_health_check" and raw.get("health"):
        findings = raw.get("findings") or []
        detail = "; ".join(str(f) for f in findings) if findings else "no findings"
        return f"Overall health is {raw['health']} ({detail})."
    return None


def _model_payload(
    raw, max_rows: int = MODEL_MAX_ROWS, max_chars: int = MODEL_MAX_CHARS
) -> str:
    """Serialize a tool result for the model, bounded in rows and characters."""
    if isinstance(raw, dict) and raw.get("error"):
        return json.dumps(
            {
                "error": raw["error"],
                "instruction": (
                    "The call failed and returned NO data. Fix it using the "
                    "suggestions in the error and retry once with a different "
                    "call. If you cannot, report this exact error. Do not "
                    "invent a result."
                ),
            }
        )
    data = raw
    if isinstance(raw, dict):
        data = {k: v for k, v in raw.items() if k not in ("structured", "raw_rows")}
        rows = data.get("rows")
        if isinstance(rows, list):
            total = len(rows)
            keep = min(total, max_rows)
            while True:
                data["rows"] = rows[:keep]
                if keep < total:
                    data["note"] = (
                        f"Only the first {keep} of {total} rows are shown. Do not "
                        "describe rows you cannot see; the UI shows the full table."
                    )
                text = json.dumps(_json_safe(data), default=str)
                if len(text) <= max_chars or keep <= 1:
                    break
                keep = max(1, keep // 2)
            return text[:max_chars]
    elif isinstance(raw, list) and len(raw) > max_rows:
        data = raw[:max_rows]
    text = json.dumps(_json_safe(data), default=str)
    if len(text) > max_chars:
        text = text[:max_chars] + " …[truncated]"
    return text


_FILE_PATH_RE = re.compile(
    r"""\b(?:FROM|JOIN)\s+['"]?(?:/|\.{1,2}/|[A-Za-z]:\\)""", re.IGNORECASE
)
_FILE_EXTENSION_RE = re.compile(r"\.(?:csv|txt|log|json)\b", re.IGNORECASE)


def _step_has_data(step: dict) -> bool:
    return not step.get("error") and bool(step.get("rows") or step.get("payload"))


def _drop_superseded_errors(steps: list[dict]) -> list[dict]:
    """Hide failed calls that a later successful call of the same tool fixed."""
    kept = []
    for index, step in enumerate(steps):
        if step.get("error") and any(
            later.get("name") == step.get("name") and not later.get("error")
            for later in steps[index + 1 :]
        ):
            continue
        kept.append(step)
    return kept


def _markdown_cell(value) -> str:
    text = "" if value is None else str(value)
    text = text.replace("|", "\\|").replace("\n", " ")
    return text if len(text) <= 80 else text[:77] + "..."


def _markdown_table(rows: list, max_rows: int = 15, max_cols: int = 8) -> str:
    dict_rows = [row for row in rows if isinstance(row, dict)]
    if not dict_rows:
        return "\n".join(f"- {_markdown_cell(row)}" for row in rows[:max_rows])
    columns = list(dict_rows[0].keys())[:max_cols]
    lines = [
        "| " + " | ".join(str(c) for c in columns) + " |",
        "| " + " | ".join("---" for _ in columns) + " |",
    ]
    for row in dict_rows[:max_rows]:
        lines.append(
            "| " + " | ".join(_markdown_cell(row.get(c)) for c in columns) + " |"
        )
    if len(dict_rows) > max_rows:
        lines.append(f"\n_Showing {max_rows} of {len(dict_rows)} rows._")
    return "\n".join(lines)


def _payload_bullets(payload: dict) -> str:
    """Render a structured (non-tabular) tool result as markdown bullets."""
    summary = payload.get("summary")
    if isinstance(summary, str) and summary.strip():
        return "\n".join(
            f"- {line.strip()}" for line in summary.splitlines() if line.strip()
        )
    lines = []
    for key, value in payload.items():
        label = str(key).replace("_", " ")
        if isinstance(value, dict):
            inner = ", ".join(
                f"{k}: {v}"
                for k, v in value.items()
                if not isinstance(v, (dict, list))
            )
            lines.append(f"- **{label}**: {inner}" if inner else f"- **{label}**")
        elif isinstance(value, list):
            lines.append(f"- **{label}**: {len(value)} item(s)")
        else:
            lines.append(f"- **{label}**: {value}")
    return "\n".join(lines)


_NUMBER_RE = re.compile(r"(?<![\w.])\d+(?:\.\d+)?")


def _numbers(text: str) -> list[str]:
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text or "")
    return _NUMBER_RE.findall(text)


def _ungrounded_numbers(answer: str, sources: list[str]) -> list[str]:
    """Return numbers in ``answer`` that cannot be traced to ``sources``.

    A number is grounded when it appears in the tool output, is a rounding of
    a value there, or is a bytes value there expressed in KB/MB/GB/TB. Small
    integers (list numbering, simple counts) are not checked.
    """
    source_tokens = set()
    for source in sources:
        source_tokens.update(_numbers(source))
    source_values = [float(token) for token in source_tokens]

    ungrounded = []
    for token in _numbers(answer):
        value = float(token)
        if "." not in token and value <= 10:
            continue
        if token in source_tokens:
            continue
        decimals = len(token.split(".")[1]) if "." in token else 0
        tolerance = 0.5 * 10**-decimals + 1e-9
        grounded = False
        for source_value in source_values:
            if abs(source_value - value) <= tolerance:
                grounded = True
                break
            if source_value >= 1024 and any(
                abs(source_value / 1024**power - value) <= tolerance
                for power in (1, 2, 3, 4)
            ):
                grounded = True
                break
        if not grounded:
            ungrounded.append(token)
    return ungrounded


def _final_summary(
    model_text: str, steps: list[dict], sources: list[str]
) -> tuple[str, str]:
    """Choose the final answer; return ``(summary, source)``.

    ``source`` is ``"model"`` for a grounded explanation written by the model
    and ``"data"`` when the summary was rendered straight from tool results.
    """
    text = _sanitize_response(_clean_response((model_text or "").strip()))
    if not steps:
        return text or "_The assistant did not return an answer._", "model"
    # With no data (all calls failed or returned nothing) the model has nothing
    # to ground an answer on, so report the outcome deterministically.
    if not any(_step_has_data(step) for step in steps):
        return _synthesize_summary(steps), "data"
    if text and not _ungrounded_numbers(text, sources):
        return text, "model"
    return _synthesize_summary(steps), "data"


def _token_events(summary: str):
    batch = []
    for char in summary:
        batch.append(char)
        if len(batch) >= 3:
            yield {"type": "token", "text": "".join(batch)}
            batch = []
            time.sleep(0.01)
    if batch:
        yield {"type": "token", "text": "".join(batch)}


def _build_messages(
    user_text: str, history: list[dict] | None, attachment: dict | None = None
) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    for index, entry in enumerate((history or [])[-HISTORY_MAX_ENTRIES:]):
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")

        if role == "user":
            content = entry.get("text") or entry.get("content") or ""
            att = entry.get("attachment")
            if isinstance(att, dict) and att.get("content"):
                messages.append({"role": "user", "content": _file_context(att)})
            if content:
                messages.append({"role": "user", "content": content})

        elif role == "assistant":
            steps = [
                step
                for step in (entry.get("steps") or [])
                if isinstance(step, dict) and step.get("name")
            ]
            if not steps:
                content = entry.get("summary") or entry.get("content") or ""
                if content:
                    messages.append({"role": "assistant", "content": content})
                continue

            call_ids = [f"call_h{index}_{n}" for n in range(len(steps))]
            messages.append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": step["name"],
                                "arguments": json.dumps(step.get("arguments") or {}),
                            },
                        }
                        for call_id, step in zip(call_ids, steps)
                    ],
                }
            )
            # Replay compact results (including failures) so every tool call
            # has a matching response and old data cannot crowd out new data.
            for call_id, step in zip(call_ids, steps):
                if step.get("error"):
                    result = {"error": step["error"]}
                else:
                    result = {
                        "rows": step.get("rows") or [],
                        "row_count": step.get("row_count"),
                    }
                    if isinstance(step.get("payload"), dict):
                        result = step["payload"]
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": step["name"],
                        "content": _model_payload(
                            result, HISTORY_MAX_ROWS, HISTORY_MAX_CHARS
                        ),
                    }
                )

    if attachment and attachment.get("content"):
        messages.append({"role": "user", "content": _file_context(attachment)})

    user_content = f"QUESTION: {user_text}"
    service_names = _extract_service_names(user_text)
    if service_names:
        user_content += (
            f"\n\nNOTE: The user is asking about specific service(s): "
            f"'{service_names}'. Call hana_services with "
            f"service_name='{service_names}'."
        )
    messages.append({"role": "user", "content": user_content})

    return messages


def _extract_service_names(text: str) -> str | None:
    """Extract service names from user query if asking about specific service(s).

    Returns comma-separated service names if multiple found, single name if one found,
    or None if no specific service mentioned.
    """
    text_lower = text.lower()

    # Common HANA service names
    service_names = [
        "webdispatcher", "daemon", "indexserver", "nameserver",
        "preprocessor", "compileserver", "scriptserver", "xsengine",
        "dpserver", "etsserver", "docstore", "search", "queue"
    ]

    import re
    found_services = set()

    # Patterns that indicate asking about a specific service
    patterns = [
        r"service\s+(\w+)",           # "service webdispatcher"
        r"details\s+about\s+(\w+)",   # "details about webdispatcher"
        r"show\s+(\w+)\s+service",    # "show webdispatcher service"
        r"status\s+of\s+(\w+)",       # "status of webdispatcher"
        r"(\w+)\s+service\s+details", # "webdispatcher service details"
        r"about\s+(\w+)\s+service",   # "about webdispatcher service"
    ]

    for pattern in patterns:
        for match in re.finditer(pattern, text_lower):
            candidate = match.group(1)
            if candidate in service_names:
                found_services.add(candidate)

    # Also check for service names directly mentioned with "service" keyword
    for svc in service_names:
        if svc in text_lower and ("service" in text_lower or "detail" in text_lower or "status" in text_lower or "show" in text_lower):
            found_services.add(svc)

    if found_services:
        return ",".join(sorted(found_services))

    return None

def _call_llm(cfg: dict, payload: dict) -> dict:
    """POST to the OpenAI-compatible chat/completions endpoint."""
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    api_key = cfg.get("api_key")
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    timeout = int(cfg.get("request_timeout", 120))
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise ModelUnavailable(f"LLM request failed: {error}") from error


def _call_llm_streaming(cfg: dict, payload: dict):
    """Stream text chunks from the OpenAI-compatible chat/completions endpoint."""
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    api_key = cfg.get("api_key")
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    timeout = int(cfg.get("request_timeout", 120))
    payload = dict(payload)
    payload["stream"] = True
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            buffer = ""
            while True:
                chunk = response.read(1024)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        msg = json.loads(data)
                        delta = msg.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content")
                        if content:
                            yield content
                    except (json.JSONDecodeError, IndexError, KeyError):
                        continue
    except Exception as error:
        raise ModelUnavailable(f"LLM streaming request failed: {error}") from error


def _json_safe(value):
    """Make a value JSON-serializable."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return json.loads(json.dumps(value, default=str))


def _extract_tool_calls_from_text(text: str) -> list[dict]:
    """Parse JSON tool calls from LLM text response.

    Ollama models sometimes output tool calls as JSON text instead of using
    the proper tool_calls format. This function detects and extracts them.
    """
    if not text:
        return []

    tool_calls = []

    # Find all potential JSON objects that start with {"name": "hana_...
    pattern = r'\{\s*"name"\s*:\s*"hana_[a-z_]+"'

    for match in re.finditer(pattern, text):
        try:
            # Find the full JSON object by matching braces
            start = match.start()
            brace_count = 0
            end = start
            in_string = False
            escape_next = False
            for i in range(
                start, min(start + 2000, len(text))
            ):  # Limit search to 2000 chars
                char = text[i]
                if escape_next:
                    escape_next = False
                    continue
                if char == "\\" and in_string:
                    escape_next = True
                    continue
                if char == '"':
                    in_string = not in_string
                    continue
                if not in_string:
                    if char == "{":
                        brace_count += 1
                    elif char == "}":
                        brace_count -= 1
                        if brace_count == 0:
                            end = i + 1
                            break
            if brace_count != 0:
                continue  # Unmatched braces

            json_str = text[start:end]

            # Try to parse JSON directly
            try:
                parsed = json.loads(json_str)
            except json.JSONDecodeError:
                # Fix common LLM JSON errors:
                # 1. Missing comma between string and next key: "value" "key" -> "value", "key"
                fixed = re.sub(r"(?<=\")(\s+)(?=\"\s*:)", ",", json_str)
                try:
                    parsed = json.loads(fixed)
                except json.JSONDecodeError:
                    # 2. Extract name and parameters separately using regex
                    name_match = re.search(r'"name"\s*:\s*"(hana_[a-z_]+)"', json_str)
                    params_match = re.search(
                        r'"(?:parameters|arguments)"\s*:\s*(\{?(?:[^{}]|\{[^{}]*\})*\}?)',
                        json_str,
                        re.DOTALL,
                    )
                    if name_match:
                        name = name_match.group(1)
                        args = {}
                        if params_match:
                            raw_args = params_match.group(1)
                            try:
                                args = json.loads(raw_args)
                            except (json.JSONDecodeError, TypeError):
                                pass
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except (json.JSONDecodeError, TypeError):
                                    args = {}
                        tool_calls.append(
                            {
                                "id": f"call_{name}_{len(tool_calls)}",
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": json.dumps(args),
                                },
                            }
                        )
                        continue
                    continue

            name = parsed.get("name", "")
            args = parsed.get("parameters") or parsed.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, TypeError):
                    args = {}
            if name.startswith("hana_") and isinstance(args, dict):
                tool_calls.append(
                    {
                        "id": f"call_{name}_{len(tool_calls)}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                )
        except (json.JSONDecodeError, TypeError, IndexError, re.error):
            continue

    return tool_calls


def _fmt_bytes(value):
    """Format a byte value as human-readable (B/KB/MB/GB/TB)."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return str(value)
    if n <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    idx = 0
    while n >= 1024 and idx < len(units) - 1:
        n /= 1024.0
        idx += 1
    return f"{n:.1f} {units[idx]}"


_BYTE_COLUMNS = {
    "hana_memory": {"VALUE"},
    "hana_disk": {"USED_SIZE", "TOTAL_SIZE", "SIZE", "ALLOCATED_SIZE", "FREE_SIZE"},
    "hana_table_sizes": {"MEMORY_SIZE_IN_TOTAL", "MEMORY_SIZE"},
    "hana_trace_files": {"FILE_SIZE", "USED_SIZE"},
    "hana_backup_status": {"BACKUP_SIZE", "USED_BACKUP_SIZE"},
}


def _format_tool_rows(name, rows):
    """Post-process tool result rows to format byte values and strip delimiters."""
    if not rows or not isinstance(rows, list):
        return rows
    formatted = []
    for row in rows:
        if not isinstance(row, dict):
            formatted.append(row)
            continue
        new_row = {}
        for key, value in row.items():
            if isinstance(value, str):
                value = value.replace("⧉", "").strip()
            new_row[key] = value
        formatted.append(new_row)
    if name in _BYTE_COLUMNS:
        byte_formatted = []
        for row in formatted:
            if not isinstance(row, dict):
                byte_formatted.append(row)
                continue
            new_row = dict(row)
            for col in _BYTE_COLUMNS[name]:
                if col in new_row and new_row[col] is not None:
                    try:
                        val = float(new_row[col])
                        if val >= 1024:
                            new_row[col] = _fmt_bytes(val)
                    except (TypeError, ValueError):
                        pass
            byte_formatted.append(new_row)
        return byte_formatted
    return formatted


def _clean_response(text: str) -> str:
    """Post-process agent response to remove raw tool-output artifacts."""
    if not text:
        return text
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if re.match(r"^\d+\s+rows?", stripped):
            continue
        if re.match(r"^\d+\s*ms\s+hana_[a-z_]+", stripped):
            continue
        if re.match(r"^hana_[a-z_]+\s*\d+\s*ms\s*$", stripped):
            continue
        if stripped.startswith(("🔒", "📋")):
            continue
        if re.match(r"^hana_[a-z_]+$", stripped):
            continue
        if stripped == "⧉":
            continue
        if "⧉" in stripped:
            continue
        if "\t" in stripped and re.search(r"[A-Z_][A-Z0-9_]*⧉", stripped):
            continue
        if re.match(
            r"^(SELECT|WITH|FROM|JOIN|WHERE|ORDER|GROUP|HAVING|LIMIT|TOP|SET)\b",
            stripped,
            re.IGNORECASE,
        ):
            continue
        cleaned.append(line)
    result = "\n".join(cleaned)
    result = re.sub(r"⧉", "", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    result = re.sub(
        r"\[?<environment_details>.*?<\/environment_details>\]?",
        "",
        result,
        flags=re.DOTALL,
    )
    result = re.sub(r"\[?Current time:.*?\]?", "", result, flags=re.DOTALL)
    result = re.sub(r"\[?Working directory:.*?\]?", "", result, flags=re.DOTALL)
    result = re.sub(r"\[?Open tabs:.*?\]?", "", result, flags=re.DOTALL)
    return result.strip()


def _sanitize_response(text: str) -> str:
    """Remove JSON code blocks from response."""
    if not text:
        return text

    import re

    # Remove all ```json ... ``` blocks
    text = re.sub(r'```json\s[\s\S]*?```', '', text)

    # Remove all ``` ... ``` blocks that contain "rows" or "columns"
    text = re.sub(r'```\s*\[\s*\{[\s\S]*?"(rows|columns)"[\s\S]*?\}[\s\S]*?```', '', text)

    # Remove standalone JSON objects with "row_count"
    text = re.sub(r'\{\s*"sql"[\s\S]*?"row_count"[\s\S]*?\n\}', '', text)

    # Clean up extra blank lines
    text = re.sub(r'\n\n\n+', '\n\n', text)

    return text.strip()


def _collect_step(name: str, raw, args: dict) -> tuple[dict, dict]:
    """Build a display step and the raw payload to return to the model."""
    payload = None
    if isinstance(raw, dict):
        rows = raw.get("rows") or []
        if not isinstance(rows, list):
            rows = []
        rc = raw.get("row_count", raw.get("rc", len(rows)))
        sql = raw.get("sql")
        ms = raw.get("execution_ms")
        if "rows" not in raw:
            # Structured (non-tabular) results: health check, trends.
            payload = _json_safe(raw)
    elif isinstance(raw, list):
        rows = raw
        rc = len(raw)
        sql = None
        ms = None
    else:
        rows = []
        rc = 0
        sql = None
        ms = None
    display = {
        "name": name,
        "rows": _json_safe(rows),
        "row_count": rc,
        "rc": rc,
        "sql": sql,
        "execution_ms": ms,
        "error": None,
        "arguments": args,
        "payload": payload,
    }
    return display, raw


def _error_step(name: str, message: str, args: dict) -> tuple[dict, dict]:
    display = {
        "name": name,
        "rows": [],
        "row_count": 0,
        "rc": 0,
        "sql": None,
        "execution_ms": None,
        "error": message,
        "arguments": args,
    }
    return display, {"error": message}


def _validate_query_args(name: str, args: dict) -> str | None:
    """Validate tool arguments before execution. Returns error message or None."""
    if name == "hana_execute_query":
        sql = args.get("sql") or ""
        without_literals = re.sub(r"'(?:[^']|'')*'", "''", sql)

        if _FILE_PATH_RE.search(sql) or _FILE_EXTENSION_RE.search(without_literals):
            return (
                "SQL cannot read files. Query HANA system views instead, "
                "for example SELECT USER_NAME FROM SYS.USERS."
            )

        if not sql.upper().strip().startswith(("SELECT", "WITH")):
            return "Only a single SELECT or WITH statement is allowed."

    return None


def _filter_args(name: str, args: dict) -> tuple[dict, list[str]]:
    """Drop arguments that the tool's schema does not declare.

    Returns (filtered_args, dropped_names). This protects against models
    (e.g. llama3.1:8b) that hallucinate parameter names not present in
    the tool definition.
    """
    tool = TOOLS.get(name)
    if not tool:
        return args, []
    declared = {p.get("name") for p in (tool.get("inputs") or [])}
    if not declared:
        return {}, list((args or {}).keys())
    filtered = {}
    dropped = []
    for k, v in (args or {}).items():
        if k not in declared:
            dropped.append(k)
            continue
        if k == "parameters" and isinstance(v, str):
            try:
                v = json.loads(v)
            except (json.JSONDecodeError, TypeError):
                pass
        if k == "parameters" and v == []:
            continue
        filtered[k] = v
    return filtered, dropped


def _execute_tool(name: str, args: dict) -> tuple[dict, dict]:
    """Run a tool for the assistant and record it in the execution history."""
    started = time.perf_counter()
    display, raw = _run_tool(name, args)
    try:
        record_execution(
            str(name),
            "assistant",
            (time.perf_counter() - started) * 1000,
            ok=not display.get("error"),
            error=display.get("error"),
            arguments=display.get("arguments"),
            row_count=display.get("row_count"),
        )
    except Exception:
        pass
    return display, raw


def _run_tool(name: str, args: dict) -> tuple[dict, dict]:
    if name not in TOOLS:
        known = ", ".join(sorted(TOOLS))
        return _error_step(
            name, f"Unknown tool: {name}. Available tools: {known}", args
        )
    if name == "hana_execute_query" and "sql" not in args and args.get("query"):
        args = {**args, "sql": args["query"]}
    # Undeclared arguments are dropped rather than failing the call: small
    # models often add stray parameters to tools that take none.
    args, _dropped = _filter_args(name, args)
    missing = [p for p in _required_inputs(name) if args.get(p) in (None, "")]
    if missing:
        declared = [p.get("name") for p in TOOLS[name].get("inputs") or []]
        return _error_step(
            name,
            f"Tool {name} requires parameter(s): {', '.join(missing)}. "
            f"Accepted parameters: {', '.join(declared)}.",
            args,
        )
    validation_error = _validate_query_args(name, args)
    if validation_error:
        return _error_step(name, validation_error, args)
    try:
        raw = TOOLS[name]["function"](**args)
    except Exception as error:
        return _error_step(name, str(error), args)
    if isinstance(raw, dict):
        rows = raw.get("rows") or []
        if isinstance(rows, list) and rows:
            rows = _format_tool_rows(name, rows)
            raw = dict(raw)
            raw["rows"] = rows
    elif isinstance(raw, list):
        raw = _format_tool_rows(name, raw)
    return _collect_step(name, raw, args)


def _synthesize_summary(steps: list[dict]) -> str:
    """Deterministically render tool results as markdown (no model involved)."""
    if not steps:
        return "No results available."

    parts = []
    for step in _drop_superseded_errors(steps):
        name = step.get("name", "unknown")
        label = name.replace("hana_", "").replace("_", " ").title()
        rows = step.get("rows") or []
        payload = step.get("payload")

        if step.get("error"):
            parts.append(f"⚠️ **{label}** failed: {step['error']}")
        elif rows:
            parts.append(f"**{label}** — {len(rows)} row(s)\n\n{_markdown_table(rows)}")
        elif isinstance(payload, dict) and payload:
            parts.append(f"**{label}**\n\n{_payload_bullets(payload)}")
        else:
            parts.append(
                f"**{label}:** the query ran successfully and returned no rows."
            )

    return "\n\n".join(parts)


def _reject_off_topic(text: str, history: list[dict] | None = None) -> str:
    """Reject obvious spam or clearly off-topic requests.

    Everything else is allowed; the model system prompt keeps answers
    focused on SAP HANA monitoring.
    """
    text_lower = text.lower().strip()

    if len(text_lower) < 3:
        return "Please ask a complete question about your database."

    spam_patterns = [
        r"^(asdf|qwerty|test|lol|haha|xxx|yyy|zzz|aaa|bbb)",
        r"^[^a-z]*$",
    ]

    for pattern in spam_patterns:
        if re.search(pattern, text_lower):
            return "I can only help with SAP HANA database monitoring. Please ask about: database health, memory, CPU, disk, connections, backups, or locks."

    deny_phrases = [
        "weather forecast",
        "tell me a joke",
        "cook a recipe",
        "play a game",
        "buy a stock",
    ]

    for phrase in deny_phrases:
        if phrase in text_lower:
            return "I can only help with SAP HANA database monitoring. Please ask about: database health, memory, CPU, disk, connections, backups, or locks."

    return None


def run_agent_events(
    user_text: str,
    history: list[dict] | None = None,
    attachment: dict | None = None,
    config: dict | None = None,
):
    """Run the agent loop and yield UI events for streaming."""
    cfg = config or load_llm_config()
    if not cfg.get("enabled"):
        raise ModelUnavailable("LLM agent is not enabled")

    rejection_reason = _reject_off_topic(user_text, history=history)
    if rejection_reason:
        yield {
            "type": "done",
            "summary": rejection_reason,
            "steps": [],
            "model": "rejected",
            "rounds": 0,
        }
        return

    all_tools = _build_tools()
    # Round 1: send only relevant tools to reduce prompt size.
    # Round 2+: send all tools in case the LLM needs to call a different one.
    matched = _matched_tools(user_text)
    relevant = _classify_tools(user_text)
    has_attachment = bool(attachment and attachment.get("content"))
    # A question about the live system must be answered from a tool result.
    needs_live_data = not has_attachment and (
        bool(matched) or bool(_DATA_QUESTION_RE.search(user_text.lower()))
    )
    messages = _build_messages(user_text, history, attachment)
    steps: list[dict] = []
    # Text the final answer may legitimately take numbers from.
    sources: list[str] = [user_text]
    if has_attachment:
        sources.append(str(attachment.get("content"))[:MAX_ATTACHMENT_CHARS])
    seen_calls: dict[str, str] = {}
    max_rounds = int(cfg.get("max_tool_rounds", 6))
    model = cfg.get("model", "unknown")
    rounds = 0
    last_content = ""
    nudged = False
    unverified = False

    def run_tool(name, args, call_id):
        display, raw = _execute_tool(name, args)
        steps.append(display)
        verdict = _verdict(name, raw)
        if verdict:
            # First key, so the model reads it before the raw figures.
            raw = {"verdict": verdict, **raw}
        content = _model_payload(raw)
        sources.append(content)
        messages.append(
            {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}
        )
        return display, content

    yield {"type": "thinking", "stage": "preparing"}

    while rounds < max_rounds:
        rounds += 1
        yield {"type": "thinking", "stage": "calling_model", "round": rounds}
        have_data = any(_step_has_data(step) for step in steps)
        # The full tool list is only needed when the first pick did not work;
        # resending it once data is in hand just slows a local model down.
        if rounds > 1 and not have_data:
            tools_for_round = all_tools
        else:
            tools_for_round = _build_tools(only=relevant)
        payload = {
            "model": model,
            "messages": messages,
            "tools": tools_for_round,
            "tool_choice": "auto",
            "temperature": cfg.get("temperature", 0.1),
            "top_p": cfg.get("top_p", 0.9),
            "max_tokens": cfg.get("max_tokens", 1500),
        }
        try:
            data = _call_llm(cfg, payload)
        except ModelUnavailable:
            if not have_data:
                raise
            # The data is already fetched; show it rather than failing because
            # the model was too slow to phrase it.
            last_content = ""
            break
        choice = data["choices"][0]["message"]
        tool_calls = choice.get("tool_calls")
        last_content = choice.get("content") or ""

        if not tool_calls and last_content:
            extracted = _extract_tool_calls_from_text(last_content)
            if extracted:
                tool_calls = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": tc["function"],
                    }
                    for tc in extracted
                ]
                choice["tool_calls"] = tool_calls
                last_content = ""

        if not tool_calls:
            if steps or not needs_live_data:
                break
            # The model tried to answer a live-data question from memory.
            if not nudged:
                nudged = True
                messages.append({"role": "assistant", "content": last_content})
                messages.append({"role": "user", "content": _NUDGE_MESSAGE})
                continue
            fallback = _fallback_tool(matched)
            if fallback:
                # Route deterministically so the answer is built from real data.
                yield {"type": "tool_start", "name": fallback, "arguments": {}}
                messages.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_fallback",
                                "type": "function",
                                "function": {"name": fallback, "arguments": "{}"},
                            }
                        ],
                    }
                )
                display, _content = run_tool(fallback, {}, "call_fallback")
                yield {"type": "tool_complete", "step": display}
                last_content = ""
            else:
                unverified = True
            break

        messages.append(choice)
        executed = 0
        for index, call in enumerate(tool_calls):
            function = call.get("function", {})
            name = function.get("name")
            try:
                args = json.loads(function.get("arguments", "{}") or "{}")
            except Exception:
                args = {}
            if not isinstance(args, dict):
                args = {}
            call_id = call.get("id") or f"call_{rounds}_{index}"
            call["id"] = call_id

            call_key = f"{name}:{json.dumps(args, sort_keys=True, default=str)}"
            if call_key in seen_calls:
                # Repeating an identical call cannot produce a new result.
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": name,
                        "content": json.dumps(
                            {
                                "note": "Identical call already made; result "
                                "repeated below. Do not call it again — "
                                "answer from it or change the call.",
                                "previous_result": seen_calls[call_key][:2000],
                            }
                        ),
                    }
                )
                continue

            yield {"type": "tool_start", "name": name, "arguments": args}
            display, content = run_tool(name, args, call_id)
            seen_calls[call_key] = content
            executed += 1
            yield {"type": "tool_complete", "step": display}

        if not executed:
            # Only repeats this round: the model is looping, stop here.
            last_content = ""
            break

    # If the explanation cites figures that are not in the tool results, give
    # the model one chance to rewrite it before falling back to the raw data.
    cleaned = _sanitize_response(_clean_response(last_content.strip()))
    if cleaned and any(_step_has_data(step) for step in steps):
        invented = _ungrounded_numbers(cleaned, sources)
        if invented:
            yield {"type": "thinking", "stage": "verifying_answer"}
            messages.append({"role": "assistant", "content": last_content})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Your answer contains figures that are not in the tool "
                        f"results: {', '.join(invented[:10])}. Rewrite the "
                        "explanation using only values that appear in the tool "
                        "results, copied exactly. Do not calculate or convert."
                    ),
                }
            )
            try:
                data = _call_llm(
                    cfg,
                    {
                        "model": model,
                        "messages": messages,
                        "temperature": cfg.get("temperature", 0.1),
                        "top_p": cfg.get("top_p", 0.9),
                        "max_tokens": cfg.get("max_tokens", 1500),
                    },
                )
                last_content = data["choices"][0]["message"].get("content") or ""
                rounds += 1
            except ModelUnavailable:
                last_content = ""

    summary, summary_source = _final_summary(last_content, steps, sources)
    if unverified and summary:
        summary = _UNVERIFIED_NOTICE + summary

    yield from _token_events(summary)
    yield {
        "type": "done",
        "summary": summary,
        # "model": a verified explanation written by the model — show as is.
        # "data": rendered straight from tool results (model text unusable).
        "summary_source": summary_source,
        "steps": _json_safe(_drop_superseded_errors(steps)),
        "model": model,
        "rounds": rounds,
    }


def run_agent(
    user_text: str,
    history: list[dict] | None = None,
    attachment: dict | None = None,
    config: dict | None = None,
) -> dict:
    """Run the tool-calling agent loop and return a UI-ready result.

    Returns::

        {
            "summary": "<markdown>",
            "steps": [ {name, rows, row_count, sql, execution_ms, error, arguments}, ... ],
            "model": "<model>",
            "rounds": <int>,
        }

    Raises ``ModelUnavailable`` if the endpoint is not configured or cannot
    be reached (the Web UI uses this to fall back to the keyword router).
    """
    events = list(run_agent_events(user_text, history, attachment, config))
    done = [e for e in events if e.get("type") == "done"]
    if done:
        return done[-1]
    return {
        "summary": "_The assistant did not return a summary._",
        "steps": [],
        "model": "unknown",
        "rounds": 0,
    }
