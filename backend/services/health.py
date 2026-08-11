import _pathsetup  # noqa: F401  (ensures project root is on sys.path)

from engine import query_rows


def get_services_status():

    query = """
    SELECT
        SERVICE_NAME,
        HOST,
        PORT,
        ACTIVE_STATUS
    FROM SYS.M_SERVICES
    """

    return query_rows(query)



def get_replication_status():

    query = """
    SELECT *
    FROM SYS.M_SERVICE_REPLICATION
    """

    try:
        return query_rows(query)

    except Exception as error:
        return {
            "error": str(error)
        }



def get_backup_status():

    query = """
    SELECT *
    FROM SYS.M_BACKUP_CATALOG
    ORDER BY SYS_START_TIME DESC
    """

    try:
        return query_rows(query)

    except Exception as error:
        return {
            "error": str(error)
        }
