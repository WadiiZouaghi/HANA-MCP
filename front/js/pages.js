/* ===== Pages: Performance, Resources, Alerts, Schema Explorer, MCP Tools,
   Execution History, Connections, Settings =====
   Every value shown here comes from a backend response. When a request fails
   the section shows an error or "unavailable" state; nothing is simulated. */

function rowsOrError(result) {
  if (!result || result.error) return { error: (result && result.error) || "No response from the backend." };
  if (Array.isArray(result)) return { rows: result };
  return { rows: Array.isArray(result.rows) ? result.rows : [] };
}

/* Render raw tool rows as a table, or the right state when there are none. */
function renderToolTable(el, result, opts) {
  opts = opts || {};
  var parsed = rowsOrError(result);
  if (parsed.error) { setState(el, "error", opts.errorLabel || "This information is unavailable.", parsed.error); return null; }
  if (!parsed.rows.length) { setState(el, "empty", opts.empty || "No rows returned."); return null; }
  return createTable(el, {
    columns: opts.columns || columnsFromRows(parsed.rows, opts.maxColumns),
    rows: parsed.rows,
    search: opts.search !== false,
    searchPlaceholder: opts.searchPlaceholder,
    pageSize: opts.pageSize || 25,
    empty: opts.empty
  });
}

/* =====================================================================
   PERFORMANCE
   ===================================================================== */
var PERF = { minutes: 60 };

function statCard(label, value, sub) {
  var missing = value === null || value === undefined;
  return '<div class="stat"><div class="stat__label">' + esc(label) + "</div>" +
    '<div class="stat__value' + (missing ? " is-unavailable" : "") + '">' + (missing ? "—" : esc(value)) + "</div>" +
    '<div class="stat__sub">' + esc(missing ? "Unavailable" : (sub || "")) + "</div></div>";
}
function seriesStats(points, field) {
  var values = (points || []).map(function (p) { return p[field]; }).filter(function (v) { return v != null && isFinite(v); });
  if (!values.length) return null;
  return {
    last: values[values.length - 1],
    avg: values.reduce(function (a, b) { return a + b; }, 0) / values.length,
    max: Math.max.apply(null, values),
    count: values.length
  };
}

function loadPerformance() {
  ["perf-chart-memory", "perf-chart-cpu", "perf-chart-connections"].forEach(function (id) {
    if (!$(id).innerHTML) setState($(id), "loading", "Loading history…");
  });
  var rangeLabel = PERF.minutes === 15 ? "15 minutes" : PERF.minutes === 60 ? "hour" : "24 hours";

  Promise.all([
    api("/api/history?minutes=" + PERF.minutes),
    api("/api/dashboard/metrics"),
    api("/api/alerts/locks"),
    api("/api/health/services")
  ]).then(function (r) {
    var history = r[0], metrics = r[1], locks = r[2], services = r[3];
    var points = (history && history.points) || [];
    var empty = "No snapshots recorded in the last " + rangeLabel + ".";
    if (history && history.error) {
      ["perf-chart-memory", "perf-chart-cpu", "perf-chart-connections"].forEach(function (id) {
        setState($(id), "error", "History is unavailable.", history.error);
      });
    } else {
      lineChart($("perf-chart-memory"), historySeries(points, "memory_usage"), { color: "--color-accent", unit: "%", decimals: 1, emptyMessage: empty });
      lineChart($("perf-chart-cpu"), historySeries(points, "cpu_usage"), { color: "--color-cyan", unit: "%", decimals: 1, emptyMessage: empty });
      lineChart($("perf-chart-connections"), historySeries(points, "connections"), { color: "--color-accent", emptyMessage: empty, height: 200 });
    }

    var memNow = metrics && !metrics.error && metrics.memory && metrics.memory.total_bytes ? metrics.memory.usage_percent : null;
    var cpuNow = metrics && !metrics.error && metrics.cpu && memNow !== null ? metrics.cpu.usage_percent : null;
    var connNow = metrics && !metrics.error && metrics.connections && memNow !== null ? metrics.connections.active : null;
    var memS = seriesStats(points, "memory_usage"), cpuS = seriesStats(points, "cpu_usage"), connS = seriesStats(points, "connections");
    var svcRows = Array.isArray(services) ? services : null;
    var svcUp = svcRows ? svcRows.filter(function (s) { return String(s.ACTIVE_STATUS).toUpperCase() === "YES"; }).length : null;
    var windowSub = function (s, unit, d) {
      return s ? "avg " + s.avg.toFixed(d) + unit + " · peak " + s.max.toFixed(d) + unit : "No history in this window";
    };

    $("perf-stats").innerHTML =
      statCard("Memory", memNow !== null ? Number(memNow).toFixed(1) + "%" : null, windowSub(memS, "%", 1)) +
      statCard("CPU", cpuNow !== null ? Number(cpuNow).toFixed(1) + "%" : null, windowSub(cpuS, "%", 1)) +
      statCard("Connections", connNow !== null ? fmtNumber(connNow) : null, windowSub(connS, "", 1)) +
      statCard("Service availability", svcUp !== null && svcRows.length ? svcUp + " / " + svcRows.length : null, "Services reporting active") +
      statCard("Blocked transactions", locks && !locks.error && locks.count != null ? fmtNumber(locks.count) : null, "Waiting on a lock right now");
    markUpdated();
  });

  setState($("perf-expensive"), "loading", "Loading statements…");
  runTool("hana_expensive_statements", {}, "performance").then(function (res) {
    renderToolTable($("perf-expensive"), res, {
      empty: "No expensive statements are recorded. HANA only fills this view when the expensive statements trace is enabled.",
      maxColumns: 9
    });
  });
  setState($("perf-active"), "loading", "Loading statements…");
  runTool("hana_active_statements", {}, "performance").then(function (res) {
    renderToolTable($("perf-active"), res, { empty: "No statements are executing right now.", maxColumns: 9 });
  });
}
$("perf-range").addEventListener("click", function (e) {
  var btn = e.target.closest("button[data-minutes]");
  if (!btn) return;
  PERF.minutes = Number(btn.getAttribute("data-minutes"));
  this.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b === btn); });
  loadPerformance();
});
PAGE_LOADERS.performance = loadPerformance;

/* =====================================================================
   RESOURCES
   ===================================================================== */
function loadResources() {
  setState($("res-services"), "loading", "Loading services…");
  runTool("hana_services", {}, "resources").then(function (res) {
    renderToolTable($("res-services"), res, {
      searchPlaceholder: "Filter services…",
      empty: "No services were reported.",
      columns: [
        { key: "SERVICE_NAME", label: "Service", mono: true },
        { key: "HOST", label: "Host", mono: true },
        { key: "PORT", label: "Port", mono: true, align: "right" },
        { key: "SQL_PORT", label: "SQL port", mono: true, align: "right" },
        { key: "COORDINATOR_TYPE", label: "Coordinator" },
        { key: "ACTIVE_STATUS", label: "Status", render: function (row) { return svcStatusPill(row.ACTIVE_STATUS); } }
      ]
    });
    markUpdated();
  });

  setState($("res-memory"), "loading", "Loading memory…");
  runTool("hana_memory", {}, "resources").then(function (res) {
    var parsed = rowsOrError(res);
    if (parsed.error) return setState($("res-memory"), "error", "Memory information is unavailable.", parsed.error);
    if (!parsed.rows.length) return setState($("res-memory"), "empty", "No memory metrics were returned.");
    $("res-memory").innerHTML = '<div class="kv">' + kvHTML(parsed.rows.map(function (row) {
      var label = String(row.metric), value = row.value;
      if (label === "Memory Pressure") {
        var tone = { NORMAL: "success", WARNING: "warning", CRITICAL: "critical" }[String(value)] || "neutral";
        return [label, badge(tone, value), { html: true }];
      }
      return [label, value, { mono: true }];
    })) + "</div>";
  });

  setState($("res-disk"), "loading", "Loading disk usage…");
  runTool("hana_disk", {}, "resources").then(function (res) {
    renderToolTable($("res-disk"), res, {
      search: false,
      empty: "No disk usage rows were returned.",
      columns: [
        { key: "USAGE_TYPE", label: "Usage type", mono: true },
        { key: "HOST", label: "Host", mono: true },
        { key: "USED_SIZE", label: "Used", mono: true, align: "right", render: function (row) {
          /* HANA reports -1 when a usage type has no data yet. */
          return Number(row.USED_SIZE) < 0 ? '<span class="muted">Not reported</span>' : esc(fmtBytes(row.USED_SIZE));
        } }
      ]
    });
  });

  setState($("res-host"), "loading", "Loading host information…");
  runTool("hana_execute_query", { sql: "SELECT * FROM SYS.M_HOST_INFORMATION" }, "resources").then(function (res) {
    renderToolTable($("res-host"), res, {
      searchPlaceholder: "Filter host properties…",
      empty: "No host information was returned.",
      pageSize: 12,
      columns: [
        { key: "HOST", label: "Host", mono: true },
        { key: "KEY", label: "Property", mono: true },
        { key: "VALUE", label: "Value", mono: true }
      ]
    });
  });

  setState($("res-tables"), "loading", "Loading table sizes…");
  runTool("hana_table_sizes", {}, "resources").then(function (res) {
    var parsed = rowsOrError(res);
    var columns = columnsFromRows(parsed.rows || [], 6).map(function (col) {
      if (/SIZE/.test(col.key)) {
        col.align = "right";
        col.render = function (row) { return esc(fmtBytes(row[col.key])); };
      }
      return col;
    });
    renderToolTable($("res-tables"), res, { columns: columns, pageSize: 12, empty: "No table size information was returned." });
  });
}
PAGE_LOADERS.resources = loadResources;

/* =====================================================================
   ALERTS
   ===================================================================== */
var ALERTS = { items: [], severity: "all", minutes: 0, table: null, errors: [] };
var ALERT_TONE = { critical: "critical", warning: "warning", info: "info" };

/* SAP HANA alert ratings: 1 information, 2 low, 3 medium, 4 high, 5 statistics server error. */
function ratingToSeverity(rating) {
  var n = Number(rating);
  if (n >= 4 && n !== 5) return "critical";
  if (n === 1) return "info";
  return "warning";
}

function renderAlertsTable() {
  var el = $("alerts-table");
  var cutoff = ALERTS.minutes ? Date.now() - ALERTS.minutes * 60000 : 0;
  var rows = ALERTS.items.filter(function (a) {
    if (ALERTS.severity !== "all" && a.severity !== ALERTS.severity) return false;
    if (cutoff) {
      var t = parseTime(a.timestamp);
      /* Live monitor alerts have no timestamp: they describe the present. */
      if (t && t.getTime() < cutoff) return false;
    }
    return true;
  });
  var note = ALERTS.errors.length
    ? '<div class="banner banner--warning banner--flush"><span class="banner__icon">' + icon("info") + "</span><span>" +
      esc(ALERTS.errors.join(" ")) + "</span></div>"
    : "";
  if (!rows.length) {
    el.innerHTML = note + stateHTML("empty",
      ALERTS.items.length ? "No alerts match the selected filters." : "No active alerts.",
      ALERTS.items.length ? "" : "Nothing is currently reported by this monitor or the SAP HANA statistics service.");
    return;
  }
  el.innerHTML = note + '<div data-role="table"></div>';
  createTable(el.querySelector('[data-role="table"]'), {
    rows: rows,
    pageSize: 50,
    initialSort: { key: "rank", dir: 1 },
    rowId: function (a) { return a.uid; },
    columns: [
      { key: "rank", label: "Severity", width: "110px", value: function (a) { return a.rank; },
        render: function (a) { return badge(ALERT_TONE[a.severity], a.severity.charAt(0).toUpperCase() + a.severity.slice(1)); } },
      { key: "timestamp", label: "Time", mono: true, width: "150px",
        render: function (a) { return a.timestamp ? esc(fmtTime(a.timestamp)) : '<span class="muted">Current</span>'; } },
      { key: "source", label: "Source", width: "170px" },
      { key: "title", label: "Event", render: function (a) {
        return '<div class="cell-title">' + esc(a.title) + "</div>" + (a.description ? '<div class="cell-sub">' + esc(a.description) + "</div>" : "");
      } },
      { key: "status", label: "Status", width: "150px", render: function (a) {
        if (a.acknowledged_at) return badge("neutral", "Acknowledged") ;
        return badge("info", "Active") + (a.ackable ? ' <button class="btn btn--secondary btn--sm" data-ack="' + escAttr(a.id) + '" type="button">Acknowledge</button>' : "");
      } }
    ],
    onRender: function (container) {
      container.querySelectorAll("[data-ack]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          btn.disabled = true;
          api("/api/alerts/" + encodeURIComponent(btn.getAttribute("data-ack")) + "/ack", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
          }).then(function () { loadAlerts(); });
        });
      });
    }
  });
}

/* background=true: a periodic refresh from the overview, not a user action. */
function loadAlerts(background) {
  background = background === true;
  if (!ALERTS.items.length && !background) setState($("alerts-table"), "loading", "Loading alerts…");
  Promise.all([
    api("/api/alerts"),
    runTool("hana_execute_query", { sql: "SELECT * FROM _SYS_STATISTICS.STATISTICS_CURRENT_ALERTS" }, "alerts", background)
  ]).then(function (r) {
    var monitor = r[0], stats = r[1];
    var items = [], errors = [];
    var rankOf = { critical: 0, warning: 1, info: 2 };

    if (Array.isArray(monitor)) {
      monitor.forEach(function (a) {
        var sev = a.severity === "critical" ? "critical" : a.severity === "info" ? "info" : "warning";
        items.push({
          uid: "m-" + a.id, id: a.id, severity: sev, rank: rankOf[sev], timestamp: null,
          source: "HANA Monitor", title: a.title, description: a.description,
          acknowledged_at: a.acknowledged_at, ackable: true
        });
      });
    } else {
      errors.push("Monitor alerts are unavailable" + (monitor && monitor.error ? ": " + monitor.error : "."));
    }

    if (stats && Array.isArray(stats.rows)) {
      stats.rows.forEach(function (row, index) {
        var sev = ratingToSeverity(row.ALERT_RATING);
        items.push({
          uid: "s-" + index, id: row.ALERT_ID, severity: sev, rank: rankOf[sev],
          timestamp: row.ALERT_TIMESTAMP || null,
          source: "Statistics service" + (row.ALERT_HOST ? " · " + row.ALERT_HOST : ""),
          title: row.ALERT_NAME || ("Alert " + row.ALERT_ID),
          description: row.ALERT_DETAILS || row.ALERT_DESCRIPTION || "",
          acknowledged_at: null, ackable: false
        });
      });
    } else {
      errors.push("SAP HANA statistics alerts are unavailable" + (stats && stats.error ? ": " + stats.error : "."));
    }

    ALERTS.items = items;
    ALERTS.errors = errors;
    renderAlertsTable();
    var count = $("nav-alert-count");
    var active = items.filter(function (a) { return !a.acknowledged_at && a.severity !== "info"; }).length;
    count.hidden = !active;
    count.textContent = active;
    if (typeof renderOverviewAlerts === "function") renderOverviewAlerts();
    if (!background) markUpdated();
  });
}
$("alert-sev").addEventListener("click", function (e) {
  var btn = e.target.closest("button[data-sev]");
  if (!btn) return;
  ALERTS.severity = btn.getAttribute("data-sev");
  this.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b === btn); });
  renderAlertsTable();
});
$("alert-range").addEventListener("change", function () {
  ALERTS.minutes = Number(this.value);
  renderAlertsTable();
});
PAGE_LOADERS.alerts = function () { loadAlerts(false); };

/* =====================================================================
   SCHEMA EXPLORER
   ===================================================================== */
var SCHEMA = { schemas: null, schema: null, objects: [], object: null };

function runSql(sql, parameters, source) {
  var body = { sql: sql };
  if (parameters && parameters.length) body.parameters = parameters;
  return runTool("hana_execute_query", body, source || "schema");
}
function renderSchemaList() {
  var el = $("schema-list");
  var q = $("schema-search").value.toLowerCase();
  var rows = (SCHEMA.schemas || []).filter(function (s) { return !q || s.SCHEMA_NAME.toLowerCase().indexOf(q) >= 0; });
  if (!rows.length) return setState(el, "empty", SCHEMA.schemas && SCHEMA.schemas.length ? "No schema matches the filter." : "No schemas are visible to this user.");
  el.innerHTML = rows.map(function (s) {
    return '<button type="button" class="explorer__item' + (s.SCHEMA_NAME === SCHEMA.schema ? " active" : "") +
      '" data-schema="' + escAttr(s.SCHEMA_NAME) + '">' + icon("database") +
      '<span class="explorer__name mono">' + esc(s.SCHEMA_NAME) + "</span></button>";
  }).join("");
}
function renderObjectList() {
  var el = $("object-list");
  var q = $("object-search").value.toLowerCase();
  var rows = SCHEMA.objects.filter(function (o) { return !q || o.name.toLowerCase().indexOf(q) >= 0; });
  if (!rows.length) return setState(el, "empty", SCHEMA.objects.length ? "No object matches the filter." : "This schema has no tables or views.");
  el.innerHTML = rows.slice(0, 500).map(function (o) {
    return '<button type="button" class="explorer__item' + (SCHEMA.object && SCHEMA.object.name === o.name && SCHEMA.object.type === o.type ? " active" : "") +
      '" data-object="' + escAttr(o.name) + '" data-type="' + o.type + '">' + icon(o.type === "VIEW" ? "eye" : "table") +
      '<span class="explorer__name mono">' + esc(o.name) + '</span><span class="explorer__tag">' + o.type + "</span></button>";
  }).join("") + (rows.length > 500 ? '<div class="explorer__more">Showing 500 of ' + rows.length + ". Use the filter to narrow down.</div>" : "");
}
function loadSchemas(force) {
  if (SCHEMA.schemas && !force) return;
  setState($("schema-list"), "loading", "Loading schemas…");
  runSql("SELECT SCHEMA_NAME, SCHEMA_OWNER FROM SYS.SCHEMAS ORDER BY SCHEMA_NAME").then(function (res) {
    var parsed = rowsOrError(res);
    if (parsed.error) return setState($("schema-list"), "error", "Schemas are unavailable.", parsed.error);
    SCHEMA.schemas = parsed.rows;
    renderSchemaList();
    markUpdated();
    /* Deep link: #schema/<SCHEMA>/<OBJECT> */
    var args = currentView === "schema" ? hashArgs() : [];
    if (args[0] && !SCHEMA.schema) selectSchema(args[0], args[1]);
  });
}
function selectSchema(name, thenObject) {
  SCHEMA.schema = name;
  SCHEMA.object = null;
  SCHEMA.objects = [];
  renderSchemaList();
  $("object-title").textContent = name;
  $("object-search").value = "";
  setState($("object-list"), "loading", "Loading objects…");
  setState($("column-list"), "empty", "Select a table or view to see its columns.");
  $("column-title").textContent = "Columns";
  $("schema-preview").hidden = true;
  Promise.all([
    runSql("SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME", [name]),
    runSql("SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME", [name])
  ]).then(function (r) {
    if (SCHEMA.schema !== name) return;
    var tables = rowsOrError(r[0]), views = rowsOrError(r[1]);
    if (tables.error && views.error) return setState($("object-list"), "error", "Objects are unavailable.", tables.error);
    SCHEMA.objects = (tables.rows || []).map(function (t) { return { name: t.TABLE_NAME, type: "TABLE" }; })
      .concat((views.rows || []).map(function (v) { return { name: v.VIEW_NAME, type: "VIEW" }; }));
    renderObjectList();
    if (thenObject) {
      var match = SCHEMA.objects.filter(function (o) { return o.name === thenObject; })[0];
      if (match) selectObject(match.name, match.type);
    }
  });
}
function selectObject(name, type) {
  SCHEMA.object = { name: name, type: type };
  renderObjectList();
  var schema = SCHEMA.schema;
  $("column-title").textContent = schema + "." + name;
  $("schema-preview").hidden = false;
  setState($("column-list"), "loading", "Loading columns…");
  var sql = type === "VIEW"
    ? "SELECT POSITION, COLUMN_NAME, DATA_TYPE_NAME, LENGTH, IS_NULLABLE FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ? ORDER BY POSITION"
    : "SELECT POSITION, COLUMN_NAME, DATA_TYPE_NAME, LENGTH, IS_NULLABLE FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY POSITION";
  runSql(sql, [schema, name]).then(function (res) {
    if (!SCHEMA.object || SCHEMA.object.name !== name) return;
    renderToolTable($("column-list"), res, {
      searchPlaceholder: "Filter columns…",
      empty: "No columns were returned for this object.",
      pageSize: 200,
      columns: [
        { key: "POSITION", label: "#", mono: true, width: "56px", align: "right" },
        { key: "COLUMN_NAME", label: "Column", mono: true },
        { key: "DATA_TYPE_NAME", label: "Type", mono: true },
        { key: "LENGTH", label: "Length", mono: true, align: "right" },
        { key: "IS_NULLABLE", label: "Nullable", render: function (row) {
          return String(row.IS_NULLABLE).toUpperCase() === "TRUE" ? badge("neutral", "Nullable", false) : badge("info", "Not null", false);
        } }
      ]
    });
  });
}
$("schema-list").addEventListener("click", function (e) {
  var item = e.target.closest("[data-schema]");
  if (item) selectSchema(item.getAttribute("data-schema"));
});
$("object-list").addEventListener("click", function (e) {
  var item = e.target.closest("[data-object]");
  if (item) selectObject(item.getAttribute("data-object"), item.getAttribute("data-type"));
});
$("schema-search").addEventListener("input", renderSchemaList);
$("object-search").addEventListener("input", renderObjectList);
$("schema-preview").addEventListener("click", function () {
  if (!SCHEMA.object) return;
  var editor = $("sql-editor");
  editor.value = 'SELECT TOP 50 * FROM "' + SCHEMA.schema + '"."' + SCHEMA.object.name + '";';
  if (typeof updateEditor === "function") updateEditor();
  show("sql");
  editor.focus();
});
PAGE_LOADERS.schema = loadSchemas;

/* =====================================================================
   MCP TOOLS
   ===================================================================== */
var TOOLS_PAGE = { tools: null, category: "All", selected: null, runs: {} };

function toolStatusBadge(tool) {
  var last = tool.last_execution;
  if (!last) return badge("neutral", "Not run yet");
  return badge(last.status === "success" ? "success" : "critical",
    (last.status === "success" ? "Succeeded " : "Failed ") + fmtAgo(last.timestamp));
}
function renderToolCategories() {
  var counts = { All: TOOLS_PAGE.tools.length };
  TOOLS_PAGE.tools.forEach(function (t) { counts[t.category] = (counts[t.category] || 0) + 1; });
  $("tool-cats").innerHTML = Object.keys(counts).map(function (cat) {
    return '<button type="button" class="chip' + (cat === TOOLS_PAGE.category ? " active" : "") + '" data-cat="' + escAttr(cat) + '">' +
      esc(cat) + ' <span class="chip__count">' + counts[cat] + "</span></button>";
  }).join("");
}
function renderToolList() {
  var el = $("tool-list");
  var q = $("tool-search").value.toLowerCase();
  var rows = TOOLS_PAGE.tools.filter(function (t) {
    if (TOOLS_PAGE.category !== "All" && t.category !== TOOLS_PAGE.category) return false;
    return !q || (t.name + " " + t.description + " " + t.category).toLowerCase().indexOf(q) >= 0;
  });
  if (!rows.length) return setState(el, "empty", "No tool matches the search.");
  el.innerHTML = rows.map(function (t) {
    return '<button type="button" class="tool-item' + (t.name === TOOLS_PAGE.selected ? " active" : "") + '" data-tool="' + escAttr(t.name) + '">' +
      '<div class="tool-item__top"><span class="tool-item__name mono">' + esc(t.name) + "</span>" + badge("neutral", t.category, false) + "</div>" +
      '<div class="tool-item__desc">' + esc(t.description) + "</div>" +
      '<div class="tool-item__meta"><span class="tool-item__ro">' + icon("lock") + "Read-only</span>" +
      "<span>" + (t.inputs.length ? t.inputs.length + " parameter" + (t.inputs.length === 1 ? "" : "s") : "No parameters") + "</span>" +
      toolStatusBadge(t) + "</div></button>";
  }).join("");
}
function toolByName(name) {
  return (TOOLS_PAGE.tools || []).filter(function (t) { return t.name === name; })[0];
}
function inputIsRequired(input) {
  return !input.optional && (input.default === undefined || input.default === null);
}
function renderToolDetail() {
  var el = $("tool-detail");
  var tool = toolByName(TOOLS_PAGE.selected);
  if (!tool) return setState(el, "empty", "Select a tool to see its parameters and run it.");
  var fields = tool.inputs.map(function (input) {
    var type = String(input.type || "str").toLowerCase();
    var id = "tool-arg-" + input.name;
    var required = inputIsRequired(input);
    var def = input.default === undefined || input.default === null ? "" : input.default;
    var control;
    if (input.name === "sql") {
      control = '<textarea class="input input--area mono" id="' + id + '" rows="4" spellcheck="false" placeholder="SELECT …"></textarea>';
    } else if (type === "int" || type === "integer" || type === "float" || type === "number") {
      control = '<input class="input mono" id="' + id + '" type="number" step="' + (type.charAt(0) === "f" || type === "number" ? "any" : "1") + '" value="' + escAttr(def) + '" />';
    } else if (type === "bool" || type === "boolean") {
      control = '<select class="select" id="' + id + '"><option value="false">false</option><option value="true"' + (def === true ? " selected" : "") + ">true</option></select>";
    } else if (type === "list" || type === "array") {
      control = '<input class="input mono" id="' + id + '" placeholder=\'JSON array, e.g. ["VALUE"]\' spellcheck="false" />';
    } else {
      control = '<input class="input mono" id="' + id + '" value="' + escAttr(def) + '" spellcheck="false" />';
    }
    return '<div class="field"><label class="field__label" for="' + id + '"><span class="mono">' + esc(input.name) + "</span>" +
      '<span class="field__type">' + esc(type) + (required ? " · required" : " · optional") + "</span></label>" + control +
      (input.description ? '<div class="field__help">' + esc(input.description) + "</div>" : "") + "</div>";
  }).join("");

  el.innerHTML =
    '<div class="tool-detail__head"><div><div class="tool-detail__name mono">' + esc(tool.name) + "</div>" +
    '<div class="tool-detail__badges">' + badge("neutral", tool.category, false) +
    '<span class="badge badge--success">' + icon("lock") + "Read-only</span>" + toolStatusBadge(tool) + "</div></div></div>" +
    '<p class="tool-detail__desc">' + esc(tool.description) + "</p>" +
    (tool.purpose ? '<div class="tool-detail__section"><div class="section-label">When the model uses it</div><p class="tool-detail__text">' + esc(tool.purpose) + "</p></div>" : "") +
    (tool.output ? '<div class="tool-detail__section"><div class="section-label">Returns</div><p class="tool-detail__text">' + esc(tool.output) + "</p></div>" : "") +
    '<div class="tool-detail__section"><div class="section-label">Parameters</div>' +
    (fields || '<p class="tool-detail__text muted">This tool takes no parameters.</p>') + "</div>" +
    '<div class="tool-detail__run"><button class="btn btn--primary" id="tool-run" type="button">' + icon("play") + "Execute</button>" +
    '<span class="tool-detail__runmeta" id="tool-run-meta"></span></div>' +
    '<div class="tool-detail__result" id="tool-result"></div>';
  $("tool-run").addEventListener("click", function () { executeSelectedTool(); });
  var previous = TOOLS_PAGE.runs[tool.name];
  if (previous) renderToolResult(previous);
}
function collectToolArgs(tool) {
  var args = {};
  for (var i = 0; i < tool.inputs.length; i++) {
    var input = tool.inputs[i];
    var el = $("tool-arg-" + input.name);
    var raw = el ? el.value : "";
    var type = String(input.type || "str").toLowerCase();
    if (raw === "" || raw === null) {
      if (inputIsRequired(input)) return { error: 'Parameter "' + input.name + '" is required.' };
      continue;
    }
    if (type === "int" || type === "integer") {
      if (!/^-?\d+$/.test(raw.trim())) return { error: 'Parameter "' + input.name + '" must be a whole number.' };
      args[input.name] = parseInt(raw, 10);
    } else if (type === "float" || type === "number") {
      if (!isFinite(Number(raw))) return { error: 'Parameter "' + input.name + '" must be a number.' };
      args[input.name] = Number(raw);
    } else if (type === "bool" || type === "boolean") {
      args[input.name] = raw === "true";
    } else if (type === "list" || type === "array") {
      try {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        args[input.name] = parsed;
      } catch (e) {
        return { error: 'Parameter "' + input.name + '" must be a JSON array.' };
      }
    } else {
      args[input.name] = raw;
    }
  }
  return { args: args };
}
function renderToolResult(run) {
  var meta = $("tool-run-meta"), el = $("tool-result");
  if (!meta || !el) return;
  if (run.pending) {
    meta.innerHTML = '<span class="spinner spinner--sm"></span> Running…';
    el.innerHTML = "";
    return;
  }
  var res = run.result;
  var failed = !res || res.error;
  meta.innerHTML = badge(failed ? "critical" : "success", failed ? "Failed" : "Completed") +
    ' <span class="mono">' + esc(fmtDuration(run.ms)) + "</span>" +
    (!failed && res.row_count != null ? ' · <span class="mono">' + esc(res.row_count) + " rows</span>" : "");
  if (failed) {
    el.innerHTML = '<pre class="code-block code-block--error">' + esc((res && res.error) || "No response from the backend.") + "</pre>";
    return;
  }
  var rows = Array.isArray(res) ? res : res.rows;
  if (Array.isArray(rows) && rows.length) {
    el.innerHTML = '<div data-role="rows"></div>';
    createTable(el.querySelector('[data-role="rows"]'), { columns: columnsFromRows(rows, 14), rows: rows, search: true, pageSize: 25 });
  } else if (Array.isArray(rows)) {
    el.innerHTML = stateHTML("empty", "The tool ran successfully and returned no rows.");
  } else {
    /* Structured (non-tabular) result, e.g. the health check or trends. */
    el.innerHTML = '<pre class="code-block">' + esc(JSON.stringify(res, null, 2)) + "</pre>";
  }
  if (res.sql) el.insertAdjacentHTML("afterbegin", '<div class="section-label">Executed SQL</div><pre class="code-block">' + esc(res.sql) + "</pre>");
}
function executeSelectedTool() {
  var tool = toolByName(TOOLS_PAGE.selected);
  if (!tool) return;
  var collected = collectToolArgs(tool);
  if (collected.error) {
    $("tool-run-meta").innerHTML = badge("warning", collected.error);
    return;
  }
  var button = $("tool-run");
  button.disabled = true;
  var name = tool.name;
  TOOLS_PAGE.runs[name] = { pending: true };
  renderToolResult(TOOLS_PAGE.runs[name]);
  var started = performance.now();
  runTool(name, collected.args, "tools").then(function (res) {
    TOOLS_PAGE.runs[name] = { result: res, ms: performance.now() - started };
    /* Refresh the "last execution" badges from the server's own record. */
    api("/api/tools").then(function (payload) {
      if (payload && payload.tools) { TOOLS_PAGE.tools = payload.tools; renderToolList(); }
      if (TOOLS_PAGE.selected === name) {
        var b = $("tool-run");
        if (b) b.disabled = false;
        renderToolResult(TOOLS_PAGE.runs[name]);
      }
    });
  });
}
function loadTools(force) {
  if (TOOLS_PAGE.tools && !force) return;
  setState($("tool-list"), "loading", "Loading tools…");
  api("/api/tools").then(function (payload) {
    if (!payload || payload.error || !payload.tools) {
      return setState($("tool-list"), "error", "The tool registry is unavailable.", payload && payload.error);
    }
    TOOLS_PAGE.tools = payload.tools;
    /* Deep link: #tools/<tool_name> */
    var args = currentView === "tools" ? hashArgs() : [];
    if (args[0] && !TOOLS_PAGE.selected && toolByName(args[0])) TOOLS_PAGE.selected = args[0];
    renderToolCategories();
    renderToolList();
    renderToolDetail();
    markUpdated();
  });
}
$("tool-cats").addEventListener("click", function (e) {
  var chip = e.target.closest("[data-cat]");
  if (!chip) return;
  TOOLS_PAGE.category = chip.getAttribute("data-cat");
  renderToolCategories();
  renderToolList();
});
$("tool-list").addEventListener("click", function (e) {
  var item = e.target.closest("[data-tool]");
  if (!item) return;
  TOOLS_PAGE.selected = item.getAttribute("data-tool");
  renderToolList();
  renderToolDetail();
  if (isNarrow()) $("tool-detail").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("tool-search").addEventListener("input", renderToolList);
PAGE_LOADERS.tools = loadTools;

/* =====================================================================
   EXECUTION HISTORY
   ===================================================================== */
var HISTORY = { items: [] };

function renderHistoryTable() {
  var el = $("hist-table");
  var q = $("hist-search").value.toLowerCase();
  var status = $("hist-status").value, source = $("hist-source").value, minutes = Number($("hist-range").value);
  var cutoff = minutes ? Date.now() - minutes * 60000 : 0;
  var rows = HISTORY.items.filter(function (item) {
    if (status !== "all" && item.status !== status) return false;
    if (source !== "all" && item.source !== source) return false;
    if (cutoff) { var t = parseTime(item.timestamp); if (t && t.getTime() < cutoff) return false; }
    if (q && (item.tool + " " + JSON.stringify(item.arguments || {}) + " " + (item.error || "")).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  if (!HISTORY.items.length) {
    return setState(el, "empty", "No tool executions recorded yet.",
      "History is kept in memory and starts when the backend starts. Run a tool or ask the assistant something.");
  }
  if (!rows.length) return setState(el, "empty", "No executions match the selected filters.");
  createTable(el, {
    rows: rows,
    pageSize: 50,
    rowId: function (item) { return item.id; },
    columns: [
      { key: "status", label: "Status", width: "110px", render: function (item) {
        return badge(item.status === "success" ? "success" : "critical", item.status === "success" ? "Success" : "Failed");
      } },
      { key: "tool", label: "Tool", mono: true },
      { key: "source", label: "Source", width: "130px", render: function (item) { return badge("neutral", item.source, false); } },
      { key: "timestamp", label: "Time", mono: true, width: "150px", render: function (item) {
        return '<span title="' + escAttr(item.timestamp) + '">' + esc(fmtTime(item.timestamp)) + "</span>";
      } },
      { key: "duration_ms", label: "Duration", mono: true, align: "right", width: "110px", render: function (item) { return esc(fmtDuration(item.duration_ms)); } },
      { key: "row_count", label: "Rows", mono: true, align: "right", width: "80px" }
    ],
    expand: function (item) {
      var args = item.arguments && Object.keys(item.arguments).length ? JSON.stringify(item.arguments, null, 2) : "(no arguments)";
      return '<div class="detail-grid"><div><div class="section-label">Arguments</div><pre class="code-block">' + esc(args) + "</pre></div>" +
        "<div>" + (item.error
          ? '<div class="section-label">Error</div><pre class="code-block code-block--error">' + esc(item.error) + "</pre>"
          : '<div class="section-label">Result</div><p class="tool-detail__text">Completed in ' + esc(fmtDuration(item.duration_ms)) +
            (item.row_count != null ? " and returned " + esc(item.row_count) + " row(s)." : ".") +
            " Result data is not stored in the history.</p>") + "</div></div>";
    }
  });
}
function loadHistory() {
  if (!HISTORY.items.length) setState($("hist-table"), "loading", "Loading executions…");
  api("/api/executions").then(function (payload) {
    if (!payload || payload.error) return setState($("hist-table"), "error", "Execution history is unavailable.", payload && payload.error);
    HISTORY.items = payload.executions || [];
    var select = $("hist-source"), current = select.value, seen = {};
    HISTORY.items.forEach(function (item) { seen[item.source] = true; });
    select.innerHTML = '<option value="all">All sources</option>' + Object.keys(seen).sort().map(function (s) {
      return '<option value="' + escAttr(s) + '">' + esc(s) + "</option>";
    }).join("");
    select.value = seen[current] ? current : "all";
    renderHistoryTable();
    markUpdated();
  });
}
["hist-search"].forEach(function (id) { $(id).addEventListener("input", renderHistoryTable); });
["hist-status", "hist-source", "hist-range"].forEach(function (id) { $(id).addEventListener("change", renderHistoryTable); });
PAGE_LOADERS.history = loadHistory;

/* =====================================================================
   SYSTEM INFO (shared by Connections, Settings and the assistant header)
   ===================================================================== */
var SYSTEM_INFO = { data: null, at: 0, pending: null };
function getSystemInfo(force) {
  if (!force && SYSTEM_INFO.data && Date.now() - SYSTEM_INFO.at < 20000) return Promise.resolve(SYSTEM_INFO.data);
  if (SYSTEM_INFO.pending) return SYSTEM_INFO.pending;
  SYSTEM_INFO.pending = api("/api/system/info").then(function (info) {
    SYSTEM_INFO.pending = null;
    if (info && !info.error) { SYSTEM_INFO.data = info; SYSTEM_INFO.at = Date.now(); }
    return info;
  });
  return SYSTEM_INFO.pending;
}
function llmBadge(llm) {
  if (!llm) return badge("neutral", "Unknown");
  if (!llm.enabled) return badge("neutral", "Disabled");
  if (llm.reachable === false) return badge("critical", "Unreachable");
  if (llm.reachable && llm.model_available === false) return badge("warning", "Model not found");
  if (llm.reachable) return badge("success", "Reachable");
  return badge("neutral", "Unknown");
}
function llmProviderLabel(llm) {
  if (!llm) return null;
  if (llm.detected_server) return llm.detected_server;
  return llm.provider ? llm.provider + " (compatible endpoint)" : null;
}

/* ---------- CONNECTIONS ---------- */
function loadConnections(force) {
  if (!$("conn-info").innerHTML) setState($("conn-info"), "loading", "Loading connection…");
  getSystemInfo(force).then(function (info) {
    if (!info || info.error) return setState($("conn-info"), "error", "Connection information is unavailable.", info && info.error);
    var db = info.database || {}, conn = info.connection || {};
    var online = db.status === "ONLINE";
    $("conn-info").innerHTML = kvHTML([
      ["Status", badge(online ? "success" : "critical", online ? "Connected" : "Disconnected"), { html: true }],
      ["Database", db.database, { mono: true }],
      ["Version", db.version, { mono: true }],
      ["Host", db.host || conn.address, { mono: true }],
      ["Configured address", conn.address, { mono: true }],
      ["Port", conn.port, { mono: true }],
      ["Database user", db.user || conn.user, { mono: true }],
      ["Active services", db.active_services, { mono: true }],
      ["Last successful check", online ? new Date().toLocaleString([], { hour12: false }) : null, { mono: true }],
      ["Password", '<span class="muted">Hidden</span>', { html: true }]
    ]) + (db.error ? '<div class="banner banner--critical banner--flush"><span class="banner__icon">' + icon("x-circle") + "</span><span>" + esc(db.error) + "</span></div>" : "");
    markUpdated();
  });

  setState($("conn-sessions"), "loading", "Loading sessions…");
  runSql("SELECT TOP 200 CONNECTION_ID, USER_NAME, CONNECTION_STATUS, CONNECTION_TYPE, CLIENT_HOST, CLIENT_IP, START_TIME, IDLE_TIME FROM SYS.M_CONNECTIONS WHERE CONNECTION_ID > 0 ORDER BY START_TIME DESC", null, "connections").then(function (res) {
    renderToolTable($("conn-sessions"), res, {
      searchPlaceholder: "Filter sessions…",
      empty: "No open sessions were returned.",
      columns: [
        { key: "CONNECTION_ID", label: "ID", mono: true, align: "right", width: "90px" },
        { key: "USER_NAME", label: "User", mono: true },
        { key: "CONNECTION_STATUS", label: "Status", render: function (row) {
          var s = String(row.CONNECTION_STATUS || "");
          return badge(s === "RUNNING" ? "success" : s === "IDLE" ? "neutral" : "info", s || "Unknown");
        } },
        { key: "CONNECTION_TYPE", label: "Type" },
        { key: "CLIENT_HOST", label: "Client host", mono: true },
        { key: "CLIENT_IP", label: "Client IP", mono: true },
        { key: "START_TIME", label: "Started", mono: true, render: function (row) { return esc(fmtTime(row.START_TIME)); } },
        { key: "IDLE_TIME", label: "Idle", mono: true, align: "right", render: function (row) { return row.IDLE_TIME == null ? "" : esc(fmtDuration(row.IDLE_TIME)); } }
      ]
    });
  });
}
$("conn-test").addEventListener("click", function () {
  var button = this, out = $("conn-test-result");
  button.disabled = true;
  out.innerHTML = '<span class="spinner spinner--sm"></span>';
  var started = performance.now();
  api("/api/system/ping").then(function (res) {
    button.disabled = false;
    var ok = res && res.ok;
    out.innerHTML = badge(ok ? "success" : "critical", ok ? "Connected in " + fmtDuration(performance.now() - started) : ((res && (res.message || res.error)) || "Connection failed"));
    refreshConnection();
  });
});
PAGE_LOADERS.connections = loadConnections;

/* ---------- SETTINGS ---------- */
function loadSettings(force) {
  ["set-llm", "set-mcp", "set-security"].forEach(function (id) { if (!$(id).innerHTML) setState($(id), "loading", "Loading…"); });
  getSystemInfo(force).then(function (info) {
    if (!info || info.error) {
      ["set-llm", "set-mcp", "set-security"].forEach(function (id) { setState($(id), "error", "Unavailable.", info && info.error); });
      return;
    }
    var llm = info.llm || {}, mcp = info.mcp || {}, sec = info.security || {}, rt = info.runtime || {};
    $("set-llm-badge").innerHTML = llmBadge(llm);
    $("set-llm").innerHTML = kvHTML([
      ["Provider", llmProviderLabel(llm)],
      ["Model", llm.model, { mono: true }],
      ["Endpoint", llm.base_url, { mono: true }],
      ["Assistant", llm.enabled ? badge("success", "Enabled") : badge("neutral", "Disabled in config.yaml"), { html: true }],
      ["Model installed", llm.model_available === null || llm.model_available === undefined ? null : (llm.model_available ? badge("success", "Yes") : badge("warning", "Not listed by the endpoint")), { html: true }],
      ["API key", '<span class="muted">Hidden</span>', { html: true }]
    ]) + (llm.error ? '<div class="banner banner--warning banner--flush"><span class="banner__icon">' + icon("info") + "</span><span>" + esc(llm.error) + "</span></div>" : "");
    $("set-mcp").innerHTML = kvHTML([
      ["Server name", mcp.server_name],
      ["Transport", mcp.transport, { mono: true }],
      ["Process", '<span class="muted">Started on demand by the MCP client</span>', { html: true }],
      ["Tools exposed", mcp.tool_count, { mono: true }],
      ["Categories", Object.keys(mcp.categories || {}).map(function (c) { return badge("neutral", c + " " + mcp.categories[c], false); }).join(" "), { html: true }],
      ["FastMCP version", mcp.fastmcp_version, { mono: true }]
    ]);
    $("set-security").innerHTML = kvHTML([
      ["Read-only mode", sec.readonly ? badge("success", "On") : badge("warning", "Off"), { html: true }],
      ["Allowed statements", (sec.allowed_statements || []).join(", "), { mono: true }],
      ["Row limit for SELECT *", sec.max_rows, { mono: true }],
      ["Statement timeout", sec.timeout_seconds != null ? sec.timeout_seconds + " s" : null, { mono: true }]
    ]);
    $("set-runtime").textContent = "Python " + (rt.python || "?") + " · Flask " + (rt.flask || "?") + " · hdbcli " + (rt.hdbcli || "?");
    markUpdated();
  });
}
PAGE_LOADERS.settings = loadSettings;

/* ---------- AI ASSISTANT header (real LLM + database state) ---------- */
function loadAssistantStatus(force) {
  getSystemInfo(force).then(function (info) {
    var el = $("chat-llm-badge"), sub = $("chat-header-sub");
    if (!info || info.error) {
      el.className = "badge badge--neutral";
      el.innerHTML = '<span class="badge__dot"></span>LLM status unknown';
      return;
    }
    var llm = info.llm || {};
    var tone = !llm.enabled ? "neutral" : llm.reachable === false ? "critical" : llm.model_available === false ? "warning" : llm.reachable ? "success" : "neutral";
    var text = !llm.enabled ? "LLM disabled" : llm.reachable === false ? "LLM unreachable" : llm.model_available === false ? "Model not found" : llm.reachable ? "LLM ready" : "LLM status unknown";
    el.className = "badge badge--" + tone;
    el.innerHTML = '<span class="badge__dot"></span>' + esc(text);
    el.title = llm.error || (llm.base_url || "");
    var provider = llm.detected_server || llm.provider || "LLM";
    sub.textContent = "Powered by " + provider + (llm.model ? " · " + llm.model : "") + " · MCP Server (" + ((info.mcp && info.mcp.tool_count) || "?") + " tools)";
  });
}
PAGE_LOADERS.chat = loadAssistantStatus;
