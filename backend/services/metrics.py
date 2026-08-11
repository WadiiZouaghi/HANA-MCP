import _pathsetup  # noqa: F401  (ensures project root is on sys.path)

from engine import query_rows



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




def get_connections_metrics():


    query = """

    SELECT
        COUNT(*) AS CONNECTIONS

    FROM SYS.M_CONNECTIONS

    """


    return query_rows(query)


def get_cpu_metrics():

    query = """
    SELECT *
    FROM SYS.M_HOST_RESOURCE_UTILIZATION
    """

    return query_rows(query)

def get_disk_metrics():

    query = """
    SELECT *
    FROM SYS.M_DISK_USAGE
    """

    return query_rows(query)
