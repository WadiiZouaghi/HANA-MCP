from pathlib import Path
import json

from .sap_parser import SAPSQLParser

SQL_PATH = (
    Path(__file__).parent.parent /
    "SQLStatements"
)

def build_index():
    index = {}
    for file in SQL_PATH.glob(
        "*.txt"
    ):
        parser = SAPSQLParser(
            file
        )

        index[file.name] = {

            "file":
                str(file),
            **parser.metadata(),
            "sql":
                parser.sql()

        }


    return index



INDEX_FILE = Path(__file__).parent / "sap_index.json"


if __name__ == "__main__":
    index = build_index()
    with open(
        INDEX_FILE,
        "w"
    ) as file:
        json.dump(
            index,
            file,
            indent=4
        )
    print(
        f"Indexed {len(index)} SAP files"
    )
