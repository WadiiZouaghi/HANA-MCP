# AGENTS.md

## Project Overview

HANA-MCP is an AI-powered SAP HANA database monitoring tool. It provides:

- **MCP Server** (`mcp_server.py`): Exposes 50+ HANA monitoring tools to any MCP-compatible LLM client (e.g. Ollama running `llama3.1:8b`) via the Model Context Protocol
- **Web UI** (`backend/app.py` + `front/`): A Flask-served single-page application with dashboard, SQL console, and AI assistant pages
- **HANA Engine** (`engine.py`): Safe, read-only SQL execution with validation, object existence checks, and row limiting

## Project Structure

```
HANA-MCP/
├── config.yaml              # HANA connection + security config + monitoring tool defs
├── engine.py                # Read-only SQL engine (validation, execution, logging)
├── monitoring.py            # Dynamic monitoring tools from config.yaml
├── tool_registry.py         # MCP tool registry (50+ tools across 5 categories)
├── metadata.py              # HANA metadata discovery (tables, views, columns)
├── mcp_server.py            # FastMCP server entrypoint
├── hana_health.py           # Composite health check orchestration
├── logging_config.py        # Rotating file logger
├── requirements.txt         # Python dependencies
├── venv/                    # Virtual environment (Python 3.13)
├── backend/
│   ├── app.py               # Flask app entrypoint
│   ├── api.py               # REST API blueprint
│   ├── _pathsetup.py        # sys.path bootstrap
│   ├── services/
│   │   ├── database.py      # get_database_status
│   │   ├── metrics.py       # get_memory/cpu/connections/disk_metrics
│   │   ├── dashboard.py     # get_dashboard (composite)
│   │   ├── dashboard_metrics.py  # Pure metric transform functions
│   │   ├── health.py        # Services/replication/backup health
├── front/
│   ├── index.html           # Single HTML entry point
│   ├── css/
│   │   └── style.css        # Main stylesheet (~1055 lines, Catppuccin Mocha dark-first)
│   └── js/
│       ├── app.js           # Core helpers, navigation, theme toggle (~240 lines)
│       ├── dashboard.js     # Dashboard rendering + health check (~370 lines)
│       ├── sql-console.js   # SQL console, history, CSV export (~100 lines)
│       └── chat.js          # AI assistant chat, tool calling (~975 lines)
└── SQLStatements/           # SAP Note 1969700 diagnostic SQL library
    └── HANA_*.txt
```

## Tooling

### Python Environment
- **Interpreter**: `venv/bin/python` (Python 3.13.5, WSL2/Debian)
- **Dependencies**: `pip install -r requirements.txt`
- **Activate venv**: `source venv/bin/activate` (Linux/WSL) or `.\venv\Scripts\Activate.ps1` (Windows PowerShell)

### Type Checking
- No type checker currently configured (project uses runtime Python without static type enforcement)

### Linting
- **Command**: `ruff check .`
- **Format**: `ruff format .`
- **Config**: Uses ruff defaults; `BLE001` (blind exception) and `S110` (try-except-pass) suppressed in `pyproject.toml` as they are intentional graceful-degradation patterns
- **Line length**: Default 88 characters

### JavaScript
- No JS build step (vanilla ES5-compatible JavaScript loaded via `<script>` tags)
- No JS linter or test framework configured
- Scripts load in dependency order via HTML `<script>` tags

## Code Conventions

### Python
- 4-space indentation
- Type hints used in `dashboard_metrics.py`, `engine.py`; older modules omit them
- Docstrings present on public functions
- `_pathsetup.py` imported first in service files to ensure project root is on `sys.path`
- `safe_call()` wrapper used in `dashboard.py` for graceful service-failure handling

### JavaScript
- ES5-compatible (no `let`/`const`, no arrow functions in core code)
- Functions are global (no module system)
- `$()` DOM selector helper
- `api()` fetch helper with error handling
- Init IIFE at end of `chat.js` for page-level setup

### CSS
- Catppuccin Mocha dark-first theme with CSS custom properties
- Variables defined in `:root` with `--*-rgb` variants for `rgba()` usage
- Light mode via `@media (prefers-color-scheme: light)` + `.theme-light` class
- Glassmorphism via `--glass-bg` / `--glass-border` variables

## Commands

| Task                | Command                          |
|---------------------|----------------------------------|
| Install deps        | `pip install -r requirements.txt`|
| Run backend server  | `python backend/app.py`          |
| Run MCP server      | `python mcp_server.py`           |
| Run frontend only   | Open `front/index.html` directly |
| Lint Python         | `ruff check .`                   |
| Format Python       | `ruff format .`                  |
