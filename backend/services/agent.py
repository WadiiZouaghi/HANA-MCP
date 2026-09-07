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


class ModelUnavailable(RuntimeError):
    """Raised when the configured LLM endpoint cannot be reached."""


SYSTEM_PROMPT = """You are a SAP HANA database monitoring assistant. Your job is to help operators understand system health by selecting and calling the right monitoring tool.

## YOUR WORKFLOW

For every user question:
1. **Understand** what they're asking about (health? memory? backups? queries?)
2. **Select one tool** (see decision tree below)
3. **Call that tool** with appropriate parameters
4. **Synthesize** the results into clear, human-readable English
5. **Never invent data** — if a tool returns nothing, say so
6. **Keep it brief** — under 300 words per response

## DECISION TREE: Picking the Right Tool

START HERE → What is the user asking about?

├─ **"Is HANA healthy? Overall status? Issues?"**
│  └─ → USE: hana_health_check (gives you pass/fail + alert summary)
│
├─ **"Memory / RAM / memory pressure / swap / memory usage?"**
│  └─ → USE: hana_memory (detailed memory breakdown by type)
│
├─ **"CPU / processor / load / performance?"**
│  └─ → USE: hana_cpu (CPU utilization and top consumers)
│
├─ **"Disk / storage / space / full?"**
│  └─ → USE: hana_disk (disk usage by type: log, trace, backup, etc.)
│
├─ **"Connections / sessions / who's connected?"**
│  └─ → USE: hana_connections (active connection count + details)
│
├─ **"Backups / backup history / when last backed up?"**
│  └─ → USE: hana_backup_status (backup progress and history)
│
├─ **"Logs / trace files / error logs / recent activity?"**
│  └─ → USE: hana_trace_files (recent log/trace files with timestamps)
│
├─ **"Slow queries / expensive statements / query performance?"**
│  └─ → USE: hana_expensive_statements (long-running SQL ordered by duration)
│
├─ **"Locks / blocked / deadlocks / waiting transactions?"**
│  └─ → USE: hana_blocked_transactions (locked resources + blockers)
│
├─ **"Service status / which services are running?"**
│  └─ → USE: hana_services (nameserver, indexserver, compactionserver status)
│
├─ **"Replication / HA / standby status?"**
│  └─ → USE: hana_replication (replication lag + status)
│
├─ **"Trends / historical data / over time / last hour/day?"**
│  └─ → USE: hana_metric_history (time-series data for comparison)
│
├─ **"Anomalies / unusual / weird patterns / alerts?"**
│  └─ → USE: hana_detect_anomalies (statistical outlier detection)
│
├─ **"Compare two time periods / before vs after / then vs now?"**
│  └─ → USE: hana_compare_periods (side-by-side metric comparison)
│
└─ **"Specific data question? (users, tables, views, custom SQL)?"**
   └─ → USE: hana_execute_query
       ├─ User names → SELECT USER_NAME, USER_ID FROM SYS.USERS
       ├─ Table list → SELECT * FROM SYS.TABLES WHERE SCHEMA_NAME = 'SYS'
       ├─ View list → SELECT * FROM SYS.VIEWS WHERE SCHEMA_NAME = 'SYS'
       ├─ Connections → SELECT * FROM SYS.M_CONNECTIONS (add LIMIT 20)
       ├─ Blocked TXN → SELECT * FROM SYS.M_BLOCKED_TRANSACTIONS
       └─ Always add: LIMIT 5, LIMIT 20, or TOP 200 for large result sets

## EXAMPLES: Question → Tool Selection

**Q: "Is the system healthy?"**
→ A: Call hana_health_check. If it says "OK", you're done. If not, dig deeper with hana_memory or hana_cpu.

**Q: "We're running out of disk. What's filling up?"**
→ A: Call hana_disk (shows breakdown). Check which component is largest (trace? backup? log?).

**Q: "A user says queries are slow."**
→ A: Call hana_expensive_statements to find the slow query. Then optionally call hana_blocked_transactions to see if it's locked.

**Q: "Show me the backup status."**
→ A: Call hana_backup_status. Show last backup time, size, and status.

**Q: "List all database users."**
→ A: Call hana_execute_query with: SELECT USER_NAME, USER_ID FROM SYS.USERS ORDER BY USER_NAME

**Q: "Memory usage looks high. Is it normal?"**
→ A: Call hana_memory first. Then call hana_metric_history to see if it's trending up or stable.

## FILE UPLOAD HANDLING

When the operator uploads a file (CSV, TXT, log):
1. The file content is provided in the CONTEXT section of the message
2. You CANNOT use file paths in SQL - HANA cannot read files from disk
3. Instead, query the database directly using system views
4. For password files: Use SELECT USER_NAME FROM SYS.USERS (not file-based queries)
5. For log files: Use SYS.M_TRACEFILES or SYS.M_LOG_SEGMENTS
6. Explain what you found in the file and cross-reference with database data

Example:
- WRONG: SELECT * FROM "/path/to/file.csv"
- RIGHT: SELECT USER_NAME FROM SYS.USERS

✓ **DO:**
  - Call tools yourself. Never ask the user to run a tool.
  - Always use the right tool the first time.
  - Synthesize results into natural, conversational English.
  - Include numbers (MB, GB, count, %) in your response.
  - Vary your response style based on the question complexity.
  - Keep simple questions simple — don't over-analyze.

✗ **DON'T:**
  - Invent data. If a tool returns nothing, say so.
  - Use non-SELECT SQL. Only SELECT and WITH clauses are allowed.
  - Use rigid templates for every response.
  - Sound robotic or automated.
  - Include "Recommendation" sections for simple status checks.

## TOOL REFERENCE

hana_health_check        → Overall system status (pass/fail, alerts, summary)
hana_memory              → Memory usage by type (instance, column, tracking, etc.)
hana_cpu                 → CPU utilization and top consumers
hana_disk                → Disk usage by component (log, trace, data, backup)
hana_connections         → Active connections, session count
hana_backup_status       → Backup history, progress, last backup time
hana_trace_files         → Recent log/trace files, sorted by timestamp
hana_expensive_statements→ Slow SQL, sorted by duration
hana_blocked_transactions→ Locked resources, blocker analysis
hana_services            → Status of all HANA services
hana_replication         → Replication lag and status
hana_metric_history      → Historical trends (time-series)
hana_detect_anomalies    → Statistical outliers and unusual patterns
hana_compare_periods     → Before/after comparison of metrics
hana_execute_query       → Custom SQL (SELECT/WITH only, LIMIT large results)


## METRIC ANALYSIS GUIDANCE

When analyzing trends (CPU, memory, connections):
- State the TREND naturally: "Memory is stable at 27.4%" or "CPU is climbing ~2% per hour"
- Include specific numbers
- Compare to baseline when relevant
- Don't describe JSON structure


## RESPONSE STYLE

**Be natural and conversational.** Don't use rigid templates. Adapt your tone to the question:

- **Greetings** ("hello", "hi"): Just say hello back naturally. Don't run tools.
- **Simple questions** ("is anything down?", "services status"): Give a short, direct answer. "All 6 services are running fine."
- **Data requests** ("show users", "list tables"): Present the data in a natural way, like you'd tell a colleague.
- **Complex analysis** ("is memory growing?", "compare last hour"): Then you can use more structure with trends and numbers.

**DO:**
- Be conversational and human
- Vary your response style based on the question
- Keep it brief for simple questions
- Use bullet points only when they help readability
- Answer the actual question asked

**DON'T:**
- Use [Status]/[Details]/[Recommendation] headers for every response
- Sound like a robot or form letter
- Give lengthy analysis for simple yes-no questions
- Include "No action required" at the end of every response

**Good responses:**
- "Hello! How can I help with your HANA system?"
- "All services are up — nameserver, indexserver, and 4 others running normally."
- "You've got 525 active connections right now. Memory is at 29.7%, so plenty of headroom."

**Bad responses:**
- "[Status] HEALTHY. [Summary] All services online. [Recommendation] No action required."

The goal: sound like a helpful colleague, not a monitoring dashboard.

## IF YOU DON'T UNDERSTAND:

DO NOT GUESS OR MAKE UP A TOOL CALL.

INSTEAD, RESPOND:
"I didn't understand. Did you mean to ask about:
- Database health?
- Memory/CPU/disk usage?
- Active connections or locks?
- Slow queries?
- Backup status?

Please rephrase your question."

NEVER call a tool if you're uncertain.
NEVER make up SQL.

## FOLLOW-UP QUESTIONS (very important)

When the user has ALREADY received a tool result in the same conversation
(see the assistant messages with `tool_calls` and the matching `tool` role
results above), DO NOT call a new tool for:

- "why", "explain", "what does that mean"
- "tell me more", "details", "elaborate"
- "how do I fix", "what should I do", "recommend"
- "no explanation", "wrong", "try again", "summarize"

INSTEAD, look at the prior tool output already in the conversation and
write a clear, plain-English explanation. Reference specific numbers
from the prior result. If the user complained the previous answer was
bad ("no explanation", "wrong"), REWRITE the explanation in better
words — do NOT call a new tool.

Example — after `hana_health_check` returned:
  "DISK: 100.3% used (max volume), BACKUPS: NO BACKUP RECORD FOUND"

If the user asks "why is it critical?":
- DO NOT call `hana_execute_query` to list views
- DO write: "It's critical because the disk volume is 100.3% full
  (one of your volumes has no free space) and there are no backup
  records, so there's no recovery path if the volume is lost."

If the user says "no explanation" or "try again":
- Rewrite the previous answer in clearer language. Do not call tools.

## PARAMETER DISCIPLINE

Most monitoring tools (`hana_memory`, `hana_cpu`, `hana_disk`,
`hana_connections`, `hana_services`, `hana_replication`,
`hana_backup_status`, `hana_expensive_statements`,
`hana_blocked_transactions`, `hana_trace_files`, `hana_health_check`)
take NO arguments. Call them as `{}` (empty object).

If you pass an unknown parameter, the tool will return an error
telling you the parameter name and that you should call it with no
arguments. Read the error and retry with `{}` on the next turn.

`hana_execute_query` is the only tool that takes a `sql` parameter.
Use it for ad-hoc SELECTs only — never for things covered by a
dedicated monitoring tool.
NEVER respond to non-database questions.
"""

MAX_ATTACHMENT_CHARS = 50000


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


def _build_tools() -> list[dict]:
    """Translate the MCP tool manifest into OpenAI tool-call schemas with better descriptions."""
    tools = []
    tool_guidance = {
        "hana_health_check": "Use this first to get overall system status. Returns pass/fail and alert summary.",
        "hana_memory": "Shows memory usage breakdown. Call this if user asks about RAM, memory pressure, or 'out of memory'.",
        "hana_cpu": "CPU utilization and top consumers. Use for performance complaints.",
        "hana_disk": "Disk usage by component. Use if user mentions 'disk full' or 'storage'.",
        "hana_connections": "Active connections and session count. Use for connection questions.",
        "hana_backup_status": "Backup history and status. Use for backup-related questions.",
        "hana_trace_files": "Recent log/trace files. Use when looking for error logs or recent activity.",
        "hana_expensive_statements": "Slow queries. Use when user reports slow queries or performance issues.",
        "hana_blocked_transactions": "Locked resources and blockers. Use for lock/deadlock questions.",
        "hana_services": "Service status. Use to check which services are running.",
        "hana_replication": "Replication status and lag. Use for HA/replication questions.",
        "hana_metric_history": "Historical trends. Use to see if metrics are trending up/down over time.",
        "hana_detect_anomalies": "Find statistical outliers. Use to detect unusual patterns.",
        "hana_compare_periods": "Compare metrics between time periods. Use for before/after analysis.",
        "hana_execute_query": "Custom SQL queries (SELECT/WITH only). Use for specific data not covered by other tools.",
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


def _build_messages(
    user_text: str, history: list[dict] | None, attachment: dict | None = None
) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Add conversation history
    if history:
        for entry in history:
            if not isinstance(entry, dict):
                continue
            role = entry.get("role")

            if role == "user":
                content = entry.get("text") or entry.get("content") or ""
                att = entry.get("attachment") if isinstance(entry, dict) else None
                if att and att.get("content"):
                    messages.append({"role": "user", "content": _file_context(att)})
                if content:
                    messages.append({"role": "user", "content": content})

            elif role == "assistant":
                # For assistant messages with steps, reconstruct the tool-calling exchange
                steps_value = entry.get("steps")
                if isinstance(steps_value, list) and steps_value:
                    # Simulate: assistant made tool_calls
                    tool_calls = []
                    for step in steps_value:
                        if not isinstance(step, dict):
                            continue
                        tool_calls.append(
                            {
                                "id": f"call_{step.get('name', 'tool')}",
                                "type": "function",
                                "function": {
                                    "name": step.get("name", ""),
                                    "arguments": json.dumps(
                                        step.get("arguments", {}) or {}
                                    ),
                                },
                            }
                        )

                    # Add assistant message with tool_calls
                    messages.append(
                        {
                            "role": "assistant",
                            "content": entry.get("summary") or "",
                            "tool_calls": tool_calls,
                        }
                    )

                    # Add tool results for each step
                    for step in steps_value:
                        if not isinstance(step, dict):
                            continue
                        if not step.get("error"):
                            messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": f"call_{step.get('name', 'tool')}",
                                    "name": step.get("name", ""),
                                    "content": json.dumps(
                                        _json_safe(step.get("rows", [])), default=str
                                    ),
                                }
                            )
                else:
                    # No steps, just add the response
                    content = entry.get("summary") or entry.get("content") or ""
                    if content:
                        messages.append({"role": "assistant", "content": content})

    # Add current attachment
    if attachment and attachment.get("content"):
        messages.append({"role": "user", "content": _file_context(attachment)})

    # Add current question
    messages.append(
        {
            "role": "user",
            "content": f"QUESTION: {user_text}\n\nSelect the best tool from the decision tree and call it.",
        }
    )

    return messages


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
                    # Find the parameters object - look for "parameters": { ... }
                    params_match = re.search(
                        r'"parameters"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})',
                        json_str,
                        re.DOTALL,
                    )
                    if name_match:
                        name = name_match.group(1)
                        args = {}
                        if params_match:
                            try:
                                args = json.loads(params_match.group(1))
                            except json.JSONDecodeError:
                                pass
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
    """Light-touch cleanup: remove obvious fabrication markers."""
    if not text:
        return text
    lower = text.lower()
    if any(
        phrase in lower
        for phrase in [
            "for demonstration purposes",
            "simulate the output",
            "simulated output",
            "illustration based",
            "hardcoded assumption",
        ]
    ):
        return "I don't have that information. Please try rephrasing your question or check the SQL Console for direct queries."
    return text


def _collect_step(name: str, raw, args: dict) -> tuple[dict, dict]:
    """Build a display step and the raw payload to return to the model."""
    if isinstance(raw, dict):
        rows = raw.get("rows") or []
        if not isinstance(rows, list):
            rows = []
        rc = raw.get("row_count", raw.get("rc", len(rows)))
        sql = raw.get("sql")
        ms = raw.get("execution_ms")
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
        sql = args.get("sql", "") or args.get("query", "") or ""
        sql_upper = sql.upper().strip()

        # Block file path references in SQL
        if "/" in sql or "\\" in sql:
            return "SQL cannot reference file paths. Instead, query HANA system views directly. For passwords, use: SELECT USER_NAME FROM SYS.USERS"

        # Ensure it's a read-only query
        if not sql_upper.startswith(("SELECT", "WITH", "DESCRIBE", "EXPLAIN")):
            return "Only SELECT, WITH, DESCRIBE, and EXPLAIN queries are allowed."

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
        if k in declared:
            filtered[k] = v
        else:
            dropped.append(k)
    return filtered, dropped


def _execute_tool(name: str, args: dict) -> tuple[dict, dict]:
    if name not in TOOLS:
        return _error_step(name, f"Unknown tool: {name}", args)
    args, dropped = _filter_args(name, args)
    if dropped:
        return _error_step(
            name,
            f"Tool {name} does not accept parameter(s): {', '.join(dropped)}. Call it with no arguments.",
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
    if not steps:
        return "_The assistant did not return a summary._"
    parts = []
    for step in steps:
        if step.get("error"):
            parts.append(f"**{step['name']}** failed: {step['error']}")
        else:
            count = step.get("rc", 0)
            parts.append(f"**{step['name']}** returned {count} row(s)")
    return "Results:\n" + " | ".join(parts)


def _reject_off_topic(text: str, history: list[dict] | None = None) -> str:
    """Reject off-topic questions. Return rejection message or None if valid.

    Follow-up questions after a tool call ("why", "explain", "show me more",
    etc.) are allowed when the prior turn was a HANA tool result.
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

    has_prior_tool_call = False
    if history:
        for entry in reversed(history):
            if entry.get("role") == "user":
                continue
            if entry.get("role") == "assistant":
                if entry.get("steps"):
                    has_prior_tool_call = True
                break

    if has_prior_tool_call:
        return None

    follow_up_signals = [
        "why",
        "how come",
        "what happened",
        "what does that mean",
        "what does this mean",
        "what do you mean",
        "explain",
        "tell me more",
        "more details",
        "details",
        "elaborate",
        "show me",
        "show me why",
        "show me more",
        "go on",
        "continue",
        "what about",
        "what next",
        "what should",
        "fix it",
        "fix this",
        "fix that",
        "fix the",
        "how do i fix",
        "how to fix",
        "how can i",
        "what can i do",
        "recommend",
        "advice",
        "no explanation",
        "no context",
        "no answer",
        "no detail",
        "wrong",
        "that's wrong",
        "thats wrong",
        "that's not",
        "thats not",
        "not what i",
        "not what you",
        "try again",
        "try once more",
        "again",
        "redo",
        "do it again",
        "what does",
        "what is that",
        "so what",
        "meaning",
        "interpret",
        "translate",
        "in english",
        "in plain",
        "speak english",
        "human",
        "simpler",
        "summarize",
        "summary",
        "tldr",
    ]
    if any(sig in text_lower for sig in follow_up_signals):
        return None

    if "who is" in text_lower or "what is" in text_lower:
        metric_keywords = [
            "memory",
            "cpu",
            "disk",
            "connection",
            "backup",
            "query",
            "lock",
        ]
        if not any(kw in text_lower for kw in metric_keywords):
            return "I can only help with SAP HANA database monitoring. Please ask about: database health, memory, CPU, disk, connections, backups, or locks."

    off_topic = [
        "weather",
        "recipe",
        "cooking",
        "music",
        "movie",
        "sports",
        "joke",
        "riddle",
        "game",
        "news",
        "bitcoin",
        "stock",
        "person",
        "how to",
        "tutorial",
    ]

    if any(phrase in text_lower for phrase in off_topic):
        return "I can only help with SAP HANA database monitoring. Please ask about: database health, memory, CPU, disk, connections, backups, or locks."

    hana_keywords = [
        "hana",
        "database",
        "memory",
        "ram",
        "cpu",
        "processor",
        "disk",
        "storage",
        "connection",
        "session",
        "backup",
        "lock",
        "query",
        "slow",
        "expensive",
        "transaction",
        "replication",
        "healthy",
        "status",
        "health",
        "sql",
        "service",
        "performance",
        "usage",
        "growing",
        "trending",
        "critical",
        "warning",
        "alert",
        "error",
        "issue",
        "problem",
        "fix",
    ]

    if not any(kw in text_lower for kw in hana_keywords):
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

    tools_schema = _build_tools()
    messages = _build_messages(user_text, history, attachment)
    steps: list[dict] = []
    max_rounds = int(cfg.get("max_tool_rounds", 6))
    model = cfg.get("model", "unknown")
    rounds = 0
    last_content = ""

    yield {"type": "thinking", "stage": "preparing"}

    while rounds < max_rounds:
        rounds += 1
        yield {"type": "thinking", "stage": "calling_model", "round": rounds}
        payload = {
            "model": model,
            "messages": messages,
            "tools": tools_schema,
            "tool_choice": "auto",
            "temperature": cfg.get("temperature", 0.3),
            "top_p": cfg.get("top_p", 0.9),
            "max_tokens": cfg.get("max_tokens", 1500),
        }
        data = _call_llm(cfg, payload)
        choice = data["choices"][0]["message"]
        messages.append(choice)
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
            summary = _sanitize_response(
                _clean_response(last_content.strip() or _synthesize_summary(steps))
            )
            batch = []
            for char in summary:
                batch.append(char)
                if len(batch) >= 3:
                    yield {"type": "token", "text": "".join(batch)}
                    batch = []
                    time.sleep(0.01)
            if batch:
                yield {"type": "token", "text": "".join(batch)}
            yield {
                "type": "done",
                "summary": summary,
                "steps": _json_safe(steps),
                "model": model,
                "rounds": rounds,
            }
            return

        for call in tool_calls:
            function = call.get("function", {})
            name = function.get("name")
            try:
                args = json.loads(function.get("arguments", "{}") or "{}")
            except Exception:
                args = {}
            if not isinstance(args, dict):
                args = {}
            yield {"type": "tool_start", "name": name, "arguments": args}
            display, raw = _execute_tool(name, args)
            steps.append(display)
            yield {"type": "tool_complete", "step": display}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "name": name,
                    "content": json.dumps(_json_safe(raw), default=str),
                }
            )

    summary = _sanitize_response(
        _clean_response(last_content.strip() or _synthesize_summary(steps))
    )
    batch = []
    for char in summary:
        batch.append(char)
        if len(batch) >= 3:
            yield {"type": "token", "text": "".join(batch)}
            batch = []
            time.sleep(0.01)
    if batch:
        yield {"type": "token", "text": "".join(batch)}
    yield {
        "type": "done",
        "summary": summary,
        "steps": _json_safe(steps),
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
