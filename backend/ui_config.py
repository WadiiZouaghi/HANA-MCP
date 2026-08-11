"""UI presentation overrides for the Tool Explorer.

The source of truth for tool metadata is ``tool_registry.TOOLS``. This module
only supplies lightweight display hints (title, icon) that the web UI uses in
addition to the registry metadata.
"""


# Icons per category used by the Tool Explorer page.
CATEGORY_ICONS = {
    "Monitoring": "activity",
    "Metadata": "database",
    "SQL": "terminal",
    "SAP Knowledge": "book",
}

# Optional per-tool titles for nicer labels in the UI.
TOOL_TITLES = {
    "hana_execute_query": "SQL Console",
    "hana_describe_object": "Describe Object",
    "hana_search_sap_library": "Search SAP Library",
}


def tool_ui_meta(name: str, category: str) -> dict:
    """Return UI display metadata for a tool."""
    return {
        "title": TOOL_TITLES.get(name, name.replace("hana_", "").replace("_", " ").title()),
        "icon": CATEGORY_ICONS.get(category, "tool"),
    }
