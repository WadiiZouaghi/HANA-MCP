from backend import _pathsetup  # noqa: F401 (ensures project root is on sys.path)
from engine import get_connection, load_config, query_rows, validate_config


def get_database_status():

    try:
        database_info = query_rows(
            """
            SELECT

                DATABASE_NAME,
                VERSION

            FROM SYS.M_DATABASE

            """
        )

        current_user = query_rows(
            """
            SELECT CURRENT_USER
            FROM DUMMY
            """
        )

        host_info = query_rows(
            """
            SELECT

                HOST

            FROM SYS.M_HOST_INFORMATION

            LIMIT 1

            """
        )

        services = query_rows(
            """
            SELECT

                COUNT(*) AS ACTIVE_SERVICES

            FROM SYS.M_SERVICES

            WHERE ACTIVE_STATUS = 'YES'

            """
        )

        return {
            "status": "ONLINE",
            "database": database_info[0]["DATABASE_NAME"]
            if database_info
            else "UNKNOWN",
            "version": database_info[0]["VERSION"] if database_info else "UNKNOWN",
            "user": current_user[0]["CURRENT_USER"] if current_user else "UNKNOWN",
            "host": host_info[0]["HOST"] if host_info else "UNKNOWN",
            "active_services": services[0]["ACTIVE_SERVICES"] if services else 0,
        }

    except Exception as error:
        return {"status": "ERROR", "error": _safe_error_message(error)}


def ping_database() -> dict:
    """Lightweight connectivity/config probe without leaking sensitive details."""
    try:
        validate_config()
        cfg = load_config().get("hana", {})
        target = {
            "address": cfg.get("address"),
            "port": cfg.get("port"),
            "user": cfg.get("user"),
        }
    except Exception as error:
        return {
            "ok": False,
            "status": "CONFIG_ERROR",
            "category": "config",
            "message": _safe_error_message(error),
            "target": None,
        }

    connection = None
    cursor = None
    try:
        connection = get_connection()
        cursor = connection.cursor()
        cursor.execute("SELECT 1 FROM DUMMY")
        cursor.fetchone()
        return {
            "ok": True,
            "status": "ONLINE",
            "category": "connected",
            "message": "Successfully connected to SAP HANA.",
            "target": target,
        }
    except Exception as error:
        category, message = _classify_connection_error(error)
        return {
            "ok": False,
            "status": "OFFLINE",
            "category": category,
            "message": message,
            "target": target,
        }
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        if connection:
            try:
                connection.close()
            except Exception:
                pass


def _safe_error_message(error: Exception) -> str:
    text = str(error)
    # Avoid leaking credentials/connection strings in API responses.
    for marker in ("password", "Password", "PWD", "pwd", "userkey"):
        if marker in text:
            return "Connection/configuration error (details redacted)."
    return text[:300]


def _classify_connection_error(error: Exception) -> tuple[str, str]:
    text = str(error).lower()
    if any(k in text for k in ("authentication", "invalid credentials", "logon", "password", "user")):
        return "auth", "Authentication failed. Check HANA username/password."
    if any(k in text for k in ("refused", "timeout", "timed out", "unreachable", "network", "host", "socket", "getaddrinfo", "name or service not known")):
        return "network", "Cannot reach HANA host/port. Check network, address, and port."
    if "configuration" in text or "config" in text or "missing" in text:
        return "config", _safe_error_message(error)
    return "unknown", _safe_error_message(error)
