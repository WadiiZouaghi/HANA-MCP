"""Central sys.path setup for the backend package.

Adds the project root to ``sys.path`` so backend modules can import
top-level modules such as :mod:`engine` and :mod:`tool_registry`
regardless of the working directory the server is launched from.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
