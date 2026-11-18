from typing import Any

from backend import _pathsetup  # noqa: F401 (ensures project root is on sys.path)
from engine import query_rows


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


def get_memory_metrics():
    query = """
    SELECT
        NAME,
        VALUE
    FROM SYS.M_MEMORY
    WHERE NAME IN (
        'SYSTEM_MEMORY_SIZE',
        'SYSTEM_MEMORY_FREE_SIZE',
        'TOTAL_MEMORY_SIZE_IN_USE'
    )
    """
    return query_rows(query)


def get_hana_memory() -> dict[str, Any]:
    """Return semantic memory metrics with derived pressure evaluation."""
    rows = query_rows("SELECT NAME, VALUE FROM SYS.M_MEMORY")
    values = {
        str(row.get("NAME", "")).upper(): _to_float(row.get("VALUE")) for row in rows
    }
    system_total = values.get("SYSTEM_MEMORY_SIZE")
    system_free = values.get("SYSTEM_MEMORY_FREE_SIZE")
    hana_used = values.get("TOTAL_MEMORY_SIZE_IN_USE")
    process_memory = values.get("PROCESS_MEMORY_SIZE")
    process_resident = values.get("PROCESS_RESIDENT_SIZE")
    heap_allocated = values.get("HEAP_MEMORY_ALLOCATED_SIZE")
    heap_used = values.get("HEAP_MEMORY_USED_SIZE")
    heap_free = values.get("HEAP_MEMORY_FREE_SIZE")
    global_limit = values.get("GLOBAL_ALLOCATION_LIMIT")
    effective_limit = values.get("EFFECTIVE_PROCESS_ALLOCATION_LIMIT")
    shared_allocated = values.get("SHARED_MEMORY_ALLOCATED_SIZE")
    shared_used = values.get("SHARED_MEMORY_USED_SIZE")
    shared_free = values.get("SHARED_MEMORY_FREE_SIZE")
    compactors_size = values.get("COMPACTORS_SIZE")
    compactors_freeable = values.get("COMPACTORS_FREEABLE_SIZE")
    process_allocation_limit = values.get("PROCESS_ALLOCATION_LIMIT")

    usage_percent = _pct(hana_used, system_total)
    limit_usage_percent = _pct(hana_used, effective_limit)
    heap_usage_percent = _pct(heap_used, heap_allocated)
    shared_usage_percent = _pct(shared_used, shared_allocated)

    if usage_percent is None:
        pressure = "UNKNOWN"
    elif usage_percent >= 90 or limit_usage_percent >= 90:
        pressure = "CRITICAL"
    elif usage_percent >= 70 or limit_usage_percent >= 70:
        pressure = "WARNING"
    else:
        pressure = "NORMAL"

    # Return in standard format with rows for frontend compatibility
    # Also include structured data for detailed access
    summary_rows = [
        {"metric": "System Total", "value": _fmt_bytes(system_total)},
        {"metric": "System Free", "value": _fmt_bytes(system_free)},
        {"metric": "HANA Used", "value": _fmt_bytes(hana_used)},
        {"metric": "HANA Used %", "value": f"{usage_percent:.1f}%"},
        {"metric": "Process Memory", "value": _fmt_bytes(process_memory)},
        {"metric": "Process Resident", "value": _fmt_bytes(process_resident)},
        {"metric": "Heap Allocated", "value": _fmt_bytes(heap_allocated)},
        {"metric": "Heap Used", "value": _fmt_bytes(heap_used)},
        {"metric": "Heap Used %", "value": f"{heap_usage_percent:.1f}%"},
        {"metric": "Shared Allocated", "value": _fmt_bytes(shared_allocated)},
        {"metric": "Shared Used", "value": _fmt_bytes(shared_used)},
        {"metric": "Shared Used %", "value": f"{shared_usage_percent:.1f}%"},
        {"metric": "Global Limit", "value": _fmt_bytes(global_limit)},
        {"metric": "Effective Limit", "value": _fmt_bytes(effective_limit)},
        {"metric": "Limit Used %", "value": f"{limit_usage_percent:.1f}%"},
        {"metric": "Memory Pressure", "value": pressure},
    ]

    return {
        "rows": summary_rows,
        "row_count": len(summary_rows),
        "execution_ms": 0,
        "structured": {
            "system": {"total_bytes": system_total, "free_bytes": system_free},
            "hana": {"memory_in_use_bytes": hana_used, "memory_in_use_percent": usage_percent},
            "process": {"memory_bytes": process_memory, "resident_bytes": process_resident},
            "heap": {"allocated_bytes": heap_allocated, "used_bytes": heap_used, "free_bytes": heap_free, "usage_percent": heap_usage_percent},
            "shared": {"allocated_bytes": shared_allocated, "used_bytes": shared_used, "free_bytes": shared_free, "usage_percent": shared_usage_percent},
            "limits": {"global_allocation_limit_bytes": global_limit, "effective_process_allocation_limit_bytes": effective_limit, "process_allocation_limit_bytes": process_allocation_limit, "limit_usage_percent": limit_usage_percent},
            "compactors": {"size_bytes": compactors_size, "freeable_bytes": compactors_freeable},
            "memory_pressure": pressure,
            "action_required": pressure in ("WARNING", "CRITICAL"),
            "raw_rows": rows,
        }
    }


def get_connections_metrics():
    query = """
    SELECT
        COUNT(*) AS CONNECTIONS
    FROM SYS.M_CONNECTIONS
    WHERE CONNECTION_ID > 0
      AND CONNECTION_STATUS IN ('RUNNING', 'IDLE', 'QUEUING')
    """
    return query_rows(query)


def get_cpu_metrics():
    query = """
    SELECT
        HOST,
        TOTAL_CPU_USER_TIME,
        TOTAL_CPU_SYSTEM_TIME,
        TOTAL_CPU_IDLE_TIME
    FROM SYS.M_HOST_RESOURCE_UTILIZATION
    """
    return query_rows(query)


def get_disk_metrics():
    query = """
    SELECT *
    FROM SYS.M_DISK_USAGE
    """
    return query_rows(query)


def _to_float(value: Any) -> float | None:
    try:
        return None if value is None or isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return None


def _pct(part: float | None, total: float | None) -> float | None:
    if part is None or not total:
        return None
    return round(part / total * 100, 1)
