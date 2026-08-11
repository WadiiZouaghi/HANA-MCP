**Global shell (every page)**

- Left **sidebar** (`--sidebar`, slightly lighter than the page) with the app title, a nav list (Dashboard, Tool Explorer, SQL Console, Metadata Explorer, AI Assistant), and a connection badge at the bottom. The active item gets a filled `--sidebar-accent` pill. Below the `lg` breakpoint (1024px) the sidebar collapses into a slide-in drawer, which is why at your 992px preview it's off-canvas.
- **Top status bar**: DB host/name on the left, a live "Connected" status dot, and the current timestamp on the right.
- Everything sits on `--background` with content cards on `--card`, hairline `--border` separators, and a blue `--primary` accent.


**1. Dashboard** — the health overview. A status banner, a row of 4 KPI stat cards (Memory, CPU, Connections, Disk) each with a value, delta, and a mini sparkline. Below: a Services table (name, status pill, port) and two radial resource gauges (memory + CPU) that fill proportionally and shift color from green → amber → red as usage climbs.

**2. Tool Explorer** — your MCP registry. Category tabs (overview, memory, connections, SQL, metadata) filter a grid of tool cards. Clicking a card opens a right-hand detail panel showing description, input fields, and a **Run** button that renders a mock JSON result.

**3. SQL Console** — a monospace query editor with snippet chips, a read-only security note, and an **Execute** button. Results render in a grid below with row count and execution time.

**4. Metadata Explorer** — a searchable, filterable table of DB objects (name, type, schema) with colored icons for tables vs views. Clicking a row opens a describe drawer listing columns and types.

**5. AI Assistant** — a chat page with suggested prompt chips. Messages stream from the AI SDK; each tool call the model makes renders as an inline chip (tool name + result). Shows a spinner while analyzing and a destructive error banner if the Gateway is unavailable.