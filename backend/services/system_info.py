"""Runtime information for the Connections and Settings pages.

Everything here is read from the live configuration or probed at request time.
Secrets (the HANA password and the LLM API key) are never included.
"""

from __future__ import annotations

import json
import platform
import time
import urllib.request
from importlib import metadata
from typing import Any
from urllib.parse import urlsplit

from backend import _pathsetup  # noqa: F401 (ensures project root is on sys.path)
from engine import load_config
from tool_registry import TOOLS

from .database import get_database_status

_LLM_PROBE_TTL_SECONDS = 20
_llm_probe_cache: tuple[float, dict[str, Any]] | None = None


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except Exception:
        return None


def _http_get(url: str, api_key: str | None, timeout: float = 2.5) -> bytes:
    headers = {"Authorization": "Bearer " + api_key} if api_key else {}
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(200_000)


def probe_llm() -> dict[str, Any]:
    """Check whether the configured LLM endpoint answers and serves the model."""
    global _llm_probe_cache
    now = time.monotonic()
    if _llm_probe_cache and now - _llm_probe_cache[0] < _LLM_PROBE_TTL_SECONDS:
        return _llm_probe_cache[1]

    cfg = load_config().get("llm", {}) or {}
    base_url = str(cfg.get("base_url") or "").rstrip("/")
    model = cfg.get("model")
    result: dict[str, Any] = {
        "enabled": bool(cfg.get("enabled", False)),
        "provider": cfg.get("provider"),
        "detected_server": None,
        "model": model,
        "base_url": base_url or None,
        "reachable": None,
        "model_available": None,
        "error": None,
    }

    if not base_url:
        result["error"] = "No LLM endpoint is configured."
    else:
        api_key = cfg.get("api_key")
        try:
            body = json.loads(_http_get(base_url + "/models", api_key))
            names = [
                str(item.get("id"))
                for item in body.get("data", [])
                if isinstance(item, dict)
            ]
            result["reachable"] = True
            result["model_available"] = model in names if model else None
        except Exception as error:
            result["reachable"] = False
            result["error"] = str(error)[:200]

        if result["reachable"]:
            # Ollama answers "Ollama is running" on its root URL.
            try:
                parts = urlsplit(base_url)
                root = f"{parts.scheme}://{parts.netloc}/"
                if b"Ollama" in _http_get(root, None, timeout=1.5):
                    result["detected_server"] = "Ollama"
            except Exception:
                pass

    _llm_probe_cache = (now, result)
    return result


def get_system_info() -> dict[str, Any]:
    """Return connection, security, LLM and MCP runtime information."""
    config = load_config()
    hana = config.get("hana", {}) or {}
    security = config.get("security", {}) or {}

    categories: dict[str, int] = {}
    for tool in TOOLS.values():
        category = tool.get("category") or "Other"
        categories[category] = categories.get(category, 0) + 1

    return {
        "database": get_database_status(),
        "connection": {
            "address": hana.get("address"),
            "port": hana.get("port"),
            "user": hana.get("user"),
        },
        "security": {
            "readonly": bool(security.get("readonly", True)),
            "allowed_statements": security.get("allowed_statements", []),
            "max_rows": security.get("max_rows"),
            "timeout_seconds": security.get("timeout_seconds"),
        },
        "llm": probe_llm(),
        "mcp": {
            "server_name": "SAP HANA AI Monitor",
            "transport": "stdio",
            "tool_count": len(TOOLS),
            "categories": categories,
            "fastmcp_version": _package_version("fastmcp"),
        },
        "runtime": {
            "python": platform.python_version(),
            "flask": _package_version("flask"),
            "hdbcli": _package_version("hdbcli"),
        },
    }
