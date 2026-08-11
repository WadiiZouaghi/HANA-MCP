import _pathsetup  # noqa: F401  (ensures project root is on sys.path)

from engine import query_rows



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


            "status":
                "ONLINE",


            "database":

                database_info[0]["DATABASE_NAME"]
                if database_info
                else "UNKNOWN",



            "version":

                database_info[0]["VERSION"]
                if database_info
                else "UNKNOWN",



            "user":

                current_user[0]["CURRENT_USER"]
                if current_user
                else "UNKNOWN",



            "host":

                host_info[0]["HOST"]
                if host_info
                else "UNKNOWN",



            "active_services":

                services[0]["ACTIVE_SERVICES"]
                if services
                else 0


        }



    except Exception as error:


        return {

            "status":
                "ERROR",

            "error":
                str(error)

        }