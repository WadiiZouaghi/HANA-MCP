from pathlib import Path
import re


class SAPSQLParser:


    def __init__(self, file):

        self.file = Path(file)

        self.content = (
            self.file
            .read_text(
                errors="ignore"
            )
        )


    def extract_section(self, name):

        pattern = (
            rf"\[{name}\](.*?)(?=\n\[|$)"
        )

        match = re.search(
            pattern,
            self.content,
            re.S
        )

        if match:
            return match.group(1).strip()

        return None



    def metadata(self):

        return {

            "name":
                self.extract_section(
                    "NAME"
                ),

            "description":
                self.extract_section(
                    "DESCRIPTION"
                ),

            "source":
                self.extract_section(
                    "SOURCE"
                ),

            "tables":
                self.extract_section(
                    "INVOLVED TABLES"
                ),

            "parameters":
                self.extract_section(
                    "INPUT PARAMETERS"
                )
        }



    def sql(self):

        sql = re.sub(
            r"/\*.*?\*/",
            "",
            self.content,
            flags=re.S
        )


        return sql.strip()