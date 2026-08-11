"""
Logging configuration for the HANA MCP server.

Writes to:
    logs/mcp.log      — General MCP server activity
    logs/sql.log      — Every executed SQL query with timing
    logs/errors.log   — Errors and exceptions
"""

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


LOGS_DIR = Path(__file__).parent / "logs"


def _ensure_logs_dir() -> Path:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    return LOGS_DIR


def _handler(name: str, level: int = logging.INFO, max_bytes: int = 10 * 1024 * 1024, backup_count: int = 5) -> RotatingFileHandler:
    _ensure_logs_dir()
    path = LOGS_DIR / name
    handler = RotatingFileHandler(str(path), maxBytes=max_bytes, backupCount=backup_count)
    handler.setLevel(level)
    return handler


def _setup_logger(name: str, handler: RotatingFileHandler, level: int = logging.INFO, formatter: logging.Formatter | None = None) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.propagate = False
    if formatter is None:
        formatter = logging.Formatter(
            "%(asctime)s  %(levelname)-8s  %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


# ── MCP Logger ──────────────────────────────────────────────────────────
mcp_logger = _setup_logger(
    "hana-mcp",
    _handler("mcp.log"),
    level=logging.INFO,
)

# ── SQL Logger (detailed, one-line-per-query) ───────────────────────────
sql_logger = _setup_logger(
    "hana-sql",
    _handler("sql.log"),
    level=logging.INFO,
    formatter=logging.Formatter(
        "%(asctime)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ),
)

# ── Error Logger (warnings and errors only) ─────────────────────────────
error_logger = _setup_logger(
    "hana-errors",
    _handler("errors.log", level=logging.WARNING),
    level=logging.WARNING,
    formatter=logging.Formatter(
        "%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ),
)


def log_sql(tool: str, sql: str, execution_ms: float, row_count: int, success: bool) -> None:
    """Log a single SQL query execution."""
    status = "OK" if success else "FAIL"
    sql_logger.info(
        "[%-4s]  %-30s  %8.1f ms  %6d rows  %s",
        status,
        tool,
        execution_ms,
        row_count,
        sql.replace("\n", " ").strip()[:200],
    )


def log_error(tool: str, message: str) -> None:
    """Log an error with context."""
    error_logger.warning("[%s] %s", tool, message)
