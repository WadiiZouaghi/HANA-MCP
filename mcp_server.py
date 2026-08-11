"""
MCP server entry point for SAP HANA monitoring.

Registers every tool from ``tool_registry.TOOLS`` with FastMCP and runs the
stdio transport. Tool documentation (description + purpose + example) is
attached to the function docstring so Claude sees rich guidance.
"""

import inspect
import logging

from fastmcp import FastMCP

from tool_registry import TOOLS


logging.basicConfig(
    level=logging.INFO
)

logger = logging.getLogger(
    "hana-mcp"
)


mcp = FastMCP(
    "SAP HANA AI Monitor"
)


def register_tools():

    for name, tool in TOOLS.items():

        function = tool["function"]

        description = tool.get("description", "")

        function.__name__ = name
        function.__doc__ = _build_docstring(name, tool)

        mcp.tool()(function)

        _validate_tool_schema(
            name,
            function
        )


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
            default = f" (default: {item['default']})" if item.get("default") is not None else ""
            lines.append(f"  - {item.get('name')}: {item.get('description', '')}{optional}{default}")

    output = tool.get("output")
    if output:
        lines.append(f"\nOutput: {output}")

    example = tool.get("example")
    if example:
        lines.append(f"\nExample: {example}")

    return "\n".join(lines)


def _validate_tool_schema(name, function):

    """Warn if a tool parameter lacks a type annotation.

    FastMCP builds the JSON Schema that Claude sees from the function
    signature + type annotations. Parameters without a type annotation
    produce an empty schema (e.g. ``"keyword": {}``) with no ``type``,
    which a model cannot satisfy and which causes it to hang in
    "Thinking". Log a clear warning so this is caught at startup.
    """

    signature = inspect.signature(
        function
    )

    for param in signature.parameters.values():

        if param.default is inspect.Parameter.empty and param.annotation is inspect.Parameter.empty:

            logger.warning(
                "Tool '%s' parameter '%s' has no type annotation "
                "and no default. FastMCP will emit an empty schema; "
                "Claude may hang trying to call it.",
                name,
                param.name
            )


register_tools()


if __name__ == "__main__":

    mcp.run()
