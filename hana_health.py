"""Composite SAP HANA health diagnostic."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from monitoring import execute_monitoring_tool

CHECKS = (
    "system_status",
    "services",
    "memory",
    "cpu",
    "disk",
    "connections",
    "blocked_transactions",
    "backup_status",
    "replication",
)
_SEVERITY_ORDER = {"HEALTHY": 0, "WARNING": 1, "CRITICAL": 2}


def hana_health_check() -> dict[str, Any]:
    """Run the standard HANA operational checks and summarize their health."""
    results: dict[str, dict[str, Any]] = {}
    failures: dict[str, str] = {}
    for check in CHECKS:
        try:
            results[check] = execute_monitoring_tool(check, max_rows=100)
        except Exception as error:
            failures[check] = str(error)

    sections = _build_sections(results, failures)
    health, findings = _overall_health(sections)
    return {
        "health": health,
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "summary": _format_report(health, sections, findings),
        "findings": findings,
        "checks": sections,
    }


def _build_sections(
    results: dict[str, dict[str, Any]], failures: dict[str, str]
) -> dict[str, dict[str, Any]]:
    builders: dict[str, Callable[[list[dict[str, Any]]], dict[str, Any]]] = {
        "system_status": _system_section,
        "services": _services_section,
        "memory": _memory_section,
        "cpu": _cpu_section,
        "disk": _disk_section,
        "connections": _connections_section,
        "blocked_transactions": _locks_section,
        "backup_status": _backup_section,
        "replication": _replication_section,
    }
    return {
        check: (
            {"state": "UNAVAILABLE", "error": failures[check]}
            if check in failures
            else builders[check](results[check].get("rows", []))
        )
        for check in CHECKS
    }


def _system_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    row = rows[0] if rows else {}
    return {
        "state": "OK" if row else "WARNING",
        "database": row.get("DATABASE_NAME", "UNKNOWN"),
        "status": "ONLINE" if row else "UNKNOWN",
        "version": row.get("VERSION"),
    }


def _services_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    online = sum(_is_online(row.get("ACTIVE_STATUS")) for row in rows)
    offline = len(rows) - online
    return {
        "state": "OK" if rows and not offline else "CRITICAL" if offline else "WARNING",
        "online": online,
        "total": len(rows),
        "offline": offline,
    }


def _memory_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = {
        str(row.get("NAME", "")).upper(): _number(row.get("VALUE")) for row in rows
    }
    total = values.get("SYSTEM_MEMORY_SIZE")
    used = values.get("TOTAL_MEMORY_SIZE_IN_USE")
    if (
        used is None
        and total is not None
        and values.get("SYSTEM_MEMORY_FREE_SIZE") is not None
    ):
        used = total - values["SYSTEM_MEMORY_FREE_SIZE"]
    percent = used / total * 100 if total and used is not None else None
    return {
        "state": _resource_state(percent),
        "used_percent": _round(percent),
        "used_bytes": used,
        "total_bytes": total,
    }


def _cpu_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Estimate instantaneous CPU usage from the cumulative counters in
    ``SYS.M_HOST_RESOURCE_UTILIZATION``.

    ``TOTAL_CPU_USER_TIME``, ``TOTAL_CPU_SYSTEM_TIME``, ``TOTAL_CPU_WIO_TIME``,
    and ``TOTAL_CPU_IDLE_TIME`` are monotonically increasing since process
    start. To get a meaningful percentage we sample twice with a short delay
    and compute ``(busy_delta / total_delta) * 100``.
    """
    sample = rows or _sample_cpu_counters()
    del rows
    if not sample:
        return {
            "state": "INFO",
            "used_percent": None,
            "hosts": 0,
            "note": "CPU counters are not available from SYS.M_HOST_RESOURCE_UTILIZATION.",
        }

    first = {row.get("HOST"): row for row in sample if row.get("HOST")}
    time.sleep(1.0)
    second_rows = _sample_cpu_counters()
    second = {row.get("HOST"): row for row in second_rows if row.get("HOST")}

    percentages: list[float] = []
    for host, before in first.items():
        after = second.get(host)
        if not after:
            continue
        busy_before = (
            (_number(before.get("TOTAL_CPU_USER_TIME")) or 0)
            + (_number(before.get("TOTAL_CPU_SYSTEM_TIME")) or 0)
            + (_number(before.get("TOTAL_CPU_WIO_TIME")) or 0)
        )
        busy_after = (
            (_number(after.get("TOTAL_CPU_USER_TIME")) or 0)
            + (_number(after.get("TOTAL_CPU_SYSTEM_TIME")) or 0)
            + (_number(after.get("TOTAL_CPU_WIO_TIME")) or 0)
        )
        idle_before = _number(before.get("TOTAL_CPU_IDLE_TIME")) or 0
        idle_after = _number(after.get("TOTAL_CPU_IDLE_TIME")) or 0
        busy_delta = busy_after - busy_before
        idle_delta = idle_after - idle_before
        total_delta = busy_delta + idle_delta
        if total_delta > 0:
            percentages.append(busy_delta / total_delta * 100)

    if not percentages:
        return {
            "state": "INFO",
            "used_percent": None,
            "hosts": len(first),
            "note": "CPU counters did not advance during the sampling interval.",
        }

    percent = sum(percentages) / len(percentages)
    return {
        "state": _resource_state(percent),
        "used_percent": _round(percent),
        "hosts": len(first),
        "note": None,
    }


def _sample_cpu_counters() -> list[dict[str, Any]]:
    """Return the cumulative CPU counters for every host, or [] on failure."""
    try:
        result = execute_monitoring_tool(
            "cpu",
            max_rows=100,
        )
    except Exception:
        return []
    return result.get("rows", []) if isinstance(result, dict) else []


def _disk_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute the max-used disk percentage from ``SYS.M_DISK_USAGE``.

    Columns are ``USAGE_TYPE``, ``USED_SIZE``, ``FILE_SIZE``. Rows whose
    ``USED_SIZE`` is negative are placeholders (e.g. ``CATALOG_BACKUP`` when
    no backup has been taken yet) and are skipped.
    """
    percentages = []
    for row in rows:
        used = _first_number(row, "USED_SIZE", "USED_BYTES", "TOTAL_USED_SIZE")
        total = _first_number(row, "FILE_SIZE", "TOTAL_SIZE", "TOTAL_BYTES", "SIZE")
        if used is None or total is None or total <= 0 or used < 0:
            continue
        percentages.append(used / total * 100)
    maximum = max(percentages) if percentages else None
    return {
        "state": _resource_state(maximum),
        "max_used_percent": _round(maximum),
        "volumes": len(percentages),
    }


def _connections_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "state": "OK",
        "count": _number(rows[0].get("CONNECTIONS")) if rows else None,
    }


def _locks_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "state": "OK" if not rows else "CRITICAL",
        "blocked_transactions": len(rows),
    }


def _backup_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"state": "UNKNOWN", "status": "NO BACKUP RECORD FOUND"}
    latest = rows[0]
    text = " ".join(
        str(value).upper()
        for key, value in latest.items()
        if "STATE" in key or "STATUS" in key
    )
    failed = any(word in text for word in ("FAIL", "ERROR", "CANCEL"))
    return {
        "state": "CRITICAL" if failed else "OK",
        "status": "FAILED" if failed else "OK",
        "latest": latest,
    }


def _replication_section(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"state": "INFO", "status": "NOT CONFIGURED"}
    text = " ".join(str(value).upper() for row in rows for value in row.values())
    bad = any(word in text for word in ("ERROR", "FAIL", "DISCONNECT", "UNKNOWN"))
    return {
        "state": "CRITICAL" if bad else "OK",
        "status": "ERROR" if bad else "OK",
        "entries": len(rows),
    }


def _overall_health(sections: dict[str, dict[str, Any]]) -> tuple[str, list[str]]:
    health, findings = "HEALTHY", []
    for name, section in sections.items():
        state = section["state"]
        if state == "UNAVAILABLE":
            health = (
                "CRITICAL"
                if name in {"system_status", "services"}
                else max(health, "WARNING", key=_SEVERITY_ORDER.get)
            )
            findings.append(f"{name}: unavailable")
        elif state in _SEVERITY_ORDER:
            health = max(health, state, key=_SEVERITY_ORDER.get)
            if state not in {"OK", "INFO"}:
                findings.append(f"{name}: {state.lower()}")
    return health, findings


def _format_report(
    health: str, sections: dict[str, dict[str, Any]], findings: list[str]
) -> str:
    system, services, memory, cpu, disk = (
        sections[name]
        for name in ("system_status", "services", "memory", "cpu", "disk")
    )
    lines = [
        f"SYSTEM: {system.get('status', system['state'])}",
        f"HEALTH: {health}",
        f"SERVICES: {services.get('online', 0)}/{services.get('total', 0)} ONLINE",
        f"MEMORY: {_display_percent(memory.get('used_percent'))} used",
        f"CPU: {_display_percent(cpu.get('used_percent'))}",
        f"DISK: {_display_percent(disk.get('max_used_percent'))} used (max volume)",
        f"CONNECTIONS: {sections['connections'].get('count', 'UNKNOWN')}",
        f"LOCKS: {sections['blocked_transactions'].get('blocked_transactions', 'UNKNOWN')} blocked",
        f"BACKUPS: {sections['backup_status'].get('status', sections['backup_status']['state'])}",
        f"REPLICATION: {sections['replication'].get('status', sections['replication']['state'])}",
    ]
    if findings:
        lines.extend(["", "Findings: " + "; ".join(findings)])
    return "\n".join(lines)


def _is_online(value: Any) -> bool:
    return str(value).strip().upper() in {"YES", "TRUE", "ACTIVE", "ONLINE", "RUNNING"}


def _resource_state(percent: float | None) -> str:
    return (
        "INFO"
        if percent is None
        else "CRITICAL"
        if percent >= 90
        else "WARNING"
        if percent >= 80
        else "OK"
    )


def _first_number(row: dict[str, Any], *keys: str) -> float | None:
    return next(
        (value for key in keys if (value := _number(row.get(key))) is not None), None
    )


def _number(value: Any) -> float | None:
    try:
        return None if value is None or isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return None


def _round(value: float | None) -> float | None:
    return round(value, 1) if value is not None else None


def _display_percent(value: float | None) -> str:
    return f"{value:.1f}%" if value is not None else "not available"
