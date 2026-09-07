"""
MCP server entry point for SAP HANA monitoring.

Registers every tool from ``tool_registry.TOOLS`` with FastMCP and runs the
stdio transport. Tool documentation (description + purpose + example) is
attached to the function docstring so the LLM sees rich guidance.
"""

import inspect
import logging

from fastmcp import FastMCP

from tool_registry import TOOLS

logging.basicConfig(level=logging.INFO)

logger = logging.getLogger("hana-mcp")


REASONING_FIRST_INSTRUCTIONS = """
REASONING-FIRST QUERY POLICY

You are connected to a live, read-only SAP HANA system. Prefer understanding
the user's intent and composing real SQL over reaching for generic catalog
tools.

1. PREFER hana_execute_query. To explore or inspect, write a targeted SELECT
   yourself, e.g. locate an object with
   `SELECT * FROM SYS.TABLES WHERE TABLE_NAME = '<X>'` or
   `SELECT * FROM SYS.VIEWS WHERE VIEW_NAME LIKE 'M_%'`, then
   `SELECT * FROM <schema>.<object>` for its rows/structure. Do not dump full
   object/table catalogs unless the user explicitly asks to list everything.

2. USE THE SQLStatements LIBRARY for known diagnostic scenarios. Search it with
   hana_search_sap_library / hana_search_sap_by_table and run the matching
   statement with hana_execute_sap_statement. This library (SAP Note 1969700)
   is the curated knowledge base — prefer it over improvising a diagnostic.

3. NEVER call a generic "discover/list/search everything" tool to answer a
   specific question. If the user says "show me table USERS", find USERS and
   SELECT from it — do not return the whole catalog.

4. When unsure of a schema/object name, resolve it with a small SYS.* query
   first, then run the real query. Reason step by step; the goal is correct,
   specific answers, not catalog dumps.
""".strip()


mcp = FastMCP(
    "SAP HANA AI Monitor",
    instructions=REASONING_FIRST_INSTRUCTIONS,
)


def register_tools():

    for name, tool in TOOLS.items():
        function = tool["function"]

        function.__name__ = name
        function.__doc__ = _build_docstring(name, tool)

        mcp.tool()(function)

        _validate_tool_schema(name, function)


def _build_docstring(name: str, tool: dict) -> str:
    """Compose a rich tool docstring from registry metadata."""
    lines = [tool.get("description", name)]

    purpose = tool.get("purpose")
    if purpose:
        lines.append(f"\nPurpose: {purpose}")

    inputs = tool.get("inputs")
    if inputs:
        lines.append("\nInputs:")
        for item in inputs:
            optional = " (optional)" if item.get("optional") else ""
            default = (
                f" (default: {item['default']})"
                if item.get("default") is not None
                else ""
            )
            lines.append(
                f"  - {item.get('name')}: {item.get('description', '')}{optional}{default}"
            )

    output = tool.get("output")
    if output:
        lines.append(f"\nOutput: {output}")

    example = tool.get("example")
    if example:
        lines.append(f"\nExample: {example}")

    return "\n".join(lines)


def _validate_tool_schema(name, function):
    """Warn if a tool parameter lacks a type annotation.

    FastMCP builds the JSON Schema that the LLM sees from the function
    signature + type annotations. Parameters without a type annotation
    produce an empty schema (e.g. ``"keyword": {}``) with no ``type``,
    which a model cannot satisfy and which causes it to hang in
    "Thinking". Log a clear warning so this is caught at startup.
    """

    signature = inspect.signature(function)

    for param in signature.parameters.values():
        if (
            param.default is inspect.Parameter.empty
            and param.annotation is inspect.Parameter.empty
        ):
            logger.warning(
                "Tool '%s' parameter '%s' has no type annotation "
                "and no default. FastMCP will emit an empty schema; "
                "the LLM may hang trying to call it.",
                name,
                param.name,
            )


register_tools()


if __name__ == "__main__":
    mcp.run()
