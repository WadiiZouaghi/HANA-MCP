# SAP HANA MCP Monitor

A **secure, read-only MCP server** for SAP HANA monitoring that exposes monitoring, metadata, and diagnostic capabilities to Claude Desktop, with a lightweight web interface for testing and demonstrations.

> **The MCP server is the product.** The web UI is only a client.

---

## Overview

This project connects to an SAP HANA instance through a low-privilege, read-only account and exposes a set of MCP tools to Claude. Each tool is:

- **Read-only** — only `SELECT` / `WITH` are permitted; DDL/DML is blocked.
- **Self-limiting** — `SELECT *` is automatically rewritten with a `TOP N` limit.
- **Logged** — every query is recorded with a timestamp, tool, execution time, and success/failure.
- **Documented** — each tool carries a description, purpose, inputs, output, and example to help Claude select and call it correctly.

---

## Architecture

```
hana-mcp
├── backend/               # Lightweight Flask web client (for testing/demo)
│   ├── api.py             # REST endpoints around the tool registry
│   ├── app.py             # Flask app entry point
│   ├── ui_config.py       # UI helper (tool palette)
│   └── services/          # Dashboard metric aggregation services
├── front/                 # Single static frontend (4 pages)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── sap/                   # SAP Note 1969700 diagnostic SQL library
│   ├── sap_search.py      # search by note / component / keyword / table
│   ├── sap_executor.py    # execute / explain library statements
│   ├── sap_tools.py       # MCP tool wrappers
│   └── sap_index.json     # pre-built library index
├── SQLStatements/         # Raw SAP diagnostic SQL sources
├── config.yaml            # HANA connection + security + monitoring config
├── engine.py              # read-only SQL engine (validation, limits, timing, logging)
├── monitoring.py          # dynamic monitoring tools from config.yaml
├── metadata.py            # schema discovery + description (TTL-cached)
├── tool_registry.py       # single source of truth for every MCP tool
├── mcp_server.py          # FastMCP server bootstrap
├── logging_config.py      # logging setup (mcp.log, sql.log, errors.log)
├── logs/                  # runtime log files
└── requirements.txt
```

---

## Requirements

- Python 3.10+
- SAP HANA instance and a **read-only** database user (recommended: a dedicated monitoring account)
- Install `hdbcli` (HANA Python driver), plus [fastmcp](https://github.com/jlowin/fastmcp) for the MCP server and Flask for the web client.

```bash
pip install -r requirements.txt
```

---

## Configuration (`config.yaml`)

```yaml
hana:
  address: localhost
  port: 39041
  user: MCP_MONITOR
  password: XXXX

security:
  readonly: true
  allowed_statements: [SELECT, WITH]
  blocked_keywords: [INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, MERGE, CALL, GRANT, REVOKE]
  max_rows: 500            # hard cap on rows returned by any query
  timeout_seconds: 30      # per-query execution timeout
  allowed_schemas: []      # optional schema allow-list

monitoring:
  memory:
    description: "Current HANA memory usage"
    category: Resources
    icon: memory
    severity: info
    query: |
      SELECT * FROM SYS.M_MEMORY
  # ... every monitoring tool is defined here
```

Every entry under `monitoring:` automatically becomes a `hana_<name>` MCP tool — **no code changes required** to add a new monitoring query.

---

## Running the MCP Server (Claude Desktop)

```bash
python mcp_server.py
```

Configure Claude Desktop to launch this as an MCP server. Claude will then see the full tool list and can automatically combine tools (e.g. for "how healthy is my database?" it may call `hana_system_status`, `hana_memory`, `hana_cpu`, `hana_connections`, and `hana_expensive_statements`).

---

## Running the Web Client

```bash
python backend/app.py
# open http://localhost:5000
```

The web UI has only **four** pages:

1. **Dashboard** — database, memory, CPU, connections, services, and alerts.
2. **Tool Explorer** — browse every registered MCP tool, supply inputs, run it, and see the JSON output.
3. **SQL Console** — run validated read-only SQL and see the result grid.
4. **Metadata Explorer** — search and browse views, tables, and columns.

---

## Tool Categories

| Category       | Tools |
|----------------|-------|
| **Monitoring** | `hana_system_status`, `hana_services`, `hana_memory`, `hana_cpu`, `hana_disk`, `hana_connections`, `hana_replication`, `hana_backup_status`, `hana_expensive_statements`, `hana_active_statements`, `hana_blocked_transactions`, `hana_table_sizes`, `hana_trace_files` |
| **Metadata**   | `hana_discover_views`, `hana_discover_objects`, `hana_search_views`, `hana_search_objects`, `hana_search_columns`, `hana_describe_table`, `hana_describe_view`, `hana_describe_object`, `hana_inspect_monitoring_view`, `hana_discover_monitoring_views` |
| **SQL**        | `hana_execute_query` (the single read-only SQL tool) |
| **SAP Knowledge** | `hana_search_sap_library`, `hana_search_sap_by_note`, `hana_search_sap_by_component`, `hana_search_sap_by_table`, `hana_list_sap_library`, `hana_execute_sap_statement`, `hana_explain_sap_statement` |

---

## Security Model

- **Read-only enforcement** — statement allow-list + keyword block-list.
- **Row limiting** — automatic `SELECT *` → `SELECT TOP N *` rewrite and a hard `max_rows` cap.
- **Object validation** — every `FROM`/`JOIN` object is checked against `SYS.TABLES`/`SYS.VIEWS` before execution.
- **Schema qualification** — unqualified system/statistics references are resolved to the correct schema (avoids HANA error 259).
- **Execution timeout** — per-query timeout from config.
- **Audit logging** — all queries logged to `logs/sql.log` with timestamp, tool, execution time, and success/failure.

---

## Query Result Format

`hana_execute_query` returns structured metadata that Claude loves:

```json
{
  "rows": [ { "DATABASE_NAME": "HXE", "VERSION": "..." } ],
  "row_count": 1,
  "execution_ms": 4.2
}
```

---

## Logging

Runtime logs are written to `logs/`:

- `mcp.log` — MCP server lifecycle + tool invocation events
- `sql.log` — every executed query (timestamp, tool, execution time, success/failure)
- `errors.log` — exceptions and failures

---

## Metadata Caching

Metadata changes rarely. `discover_views`, `discover_objects`, `search_columns`, and `describe_*` are cached for **5 minutes**, giving a large latency/load improvement on frequently repeated lookups.

---

## License

Internal monitoring tooling.

