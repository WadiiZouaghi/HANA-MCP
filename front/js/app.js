/* ===== SAP HANA Monitor - dark redesign ===== */
var $ = function (id) { return document.getElementById(id); };
/* Robust api helper: always resolves to {error} on failure instead of
   rejecting, so callers can render a clean error chip/message. */
var api = function (path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () {
      return { error: "Non-JSON response (" + r.status + ")", network: true };
    });
  }).catch(function (e) {
    return { error: (e && e.message) || "Network error", network: true };
  });
};

var ESC_MAP = { "&": "&", "<": "<", ">": ">", '"': '"', "'": "'" };
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, function (c) {
    return "&#" + c.charCodeAt(0) + ";";
  });
}
/* bound escape for attribute/full-text safety */
function escAttr(v) { return esc(v); }

/* Render markdown to sanitized HTML using the loaded `marked` lib (fallback: plain text) */
function renderMarkdown(src) {
  if (typeof marked === "undefined" || !marked || typeof marked.parse !== "function") {
    return '<div style="white-space:pre-wrap">' + esc(src) + "</div>";
  }
  try {
    return marked.parse(src || "");
  } catch (e) {
    return '<div style="white-space:pre-wrap">' + esc(src) + "</div>";
  }
}

/* ---------- navigation ---------- */
var VIEWS = ["dashboard", "tools", "sql", "metadata", "chat"];
var LAST_VIEW_KEY = "hana_last_view";
function show(view) {
  VIEWS.forEach(function (v) {
    var el = $("view-" + v);
    if (el) el.classList.toggle("active", v === view);
  });
  document.querySelectorAll(".nav-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.view === view);
  });
  try { localStorage.setItem(LAST_VIEW_KEY, view); } catch (e) {}
  closeSidebar();
  if (view !== "tools") closeToolPanel();
  if (view !== "metadata") $("meta-drawer").classList.remove("open");
  if (view === "dashboard") loadDashboard();
  if (view === "tools") loadTools();
  if (view === "metadata") loadMetadata();
}
document.querySelectorAll(".nav-item").forEach(function (el) {
  el.addEventListener("click", function (e) {
    e.preventDefault();
    show(el.dataset.view);
  });
});

/* ---------- sidebar (mobile drawer) ---------- */
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebar-backdrop").classList.add("show");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-backdrop").classList.remove("show");
}
$("sidebar-toggle").addEventListener("click", function () {
  if ($("sidebar").classList.contains("open")) closeSidebar();
  else openSidebar();
});
$("sidebar-backdrop").addEventListener("click", closeSidebar);

/* ---------- top status bar ---------- */
function updateTopbar(sys) {
  sys = sys || {};
  var online = sys.status === "ONLINE";
  $("topbar-db").textContent = sys.database || "SAP HANA";
  $("topbar-host").textContent = sys.host ? sys.host + (sys.version ? " · " + sys.version : "") : "—";
  var statusEl = $("topbar-status");
  statusEl.className = "topbar__status" + (online ? "" : " offline");
  $("topbar-status-label").textContent = online ? "Connected" : (sys.status || "Offline");
}
function tickClock() {
  var now = new Date();
  $("topbar-clock").textContent = now.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}
setInterval(tickClock, 1000);
tickClock();

/* ---------- connection status ---------- */
function setStatus(online) {
  $("conn-dot").className = "status-dot " + (online ? "online" : "error");
  $("conn-label").textContent = online ? "Connected" : "Offline";
}

/* ---------- helpers ---------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  var u = ["B", "KB", "MB", "GB", "TB"];
  var i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + u[i];
}
function pct(v) { return (Number(v) || 0).toFixed(0) + "%"; }

function gaugeColor(p) {
  p = Number(p) || 0;
  if (p >= 85) return "var(--red)";
  if (p >= 70) return "var(--amber)";
  return "var(--green)";
}
function kpiClass(p) {
  p = Number(p) || 0;
  if (p >= 85) return "bad";
  if (p >= 70) return "warn";
  return "good";
}
function renderSparkline(svgEl, values, color) {
  if (!svgEl) return;
  values = (values || []).filter(function (v) { return v != null && !isNaN(v); });
  if (values.length < 2) {
    svgEl.innerHTML = "";
    return;
  }
  var w = 72, h = 24, pad = 2;
  var min = Math.min.apply(null, values);
  var max = Math.max.apply(null, values);
  var range = max - min || 1;
  var pts = values.map(function (v, i) {
    var x = pad + (i / (values.length - 1)) * (w - pad * 2);
    var y = h - pad - ((v - min) / range) * (h - pad * 2);
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  svgEl.innerHTML =
    '<polyline fill="none" stroke="' + (color || "var(--primary)") + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="' + pts + '"/>';
}
function renderGauge(svgEl, pctVal, labelEl) {
  if (!svgEl) return;
  pctVal = Math.max(0, Math.min(100, Number(pctVal) || 0));
  var r = 46, cx = 60, cy = 60, sw = 8;
  var circ = 2 * Math.PI * r;
  var offset = circ * (1 - pctVal / 100);
  var col = gaugeColor(pctVal);
  svgEl.innerHTML =
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="' + sw + '"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '"' +
    ' stroke-dasharray="' + circ.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"' +
    ' stroke-linecap="round" transform="rotate(-90 ' + cx + ' ' + cy + ')" style="transition:stroke-dashoffset .6s ease,stroke .3s"/>' +
    '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="var(--foreground)" font-size="18" font-weight="700" font-family="var(--mono)">' + pctVal.toFixed(0) + '%</text>';
  if (labelEl) labelEl.textContent = pctVal.toFixed(1) + "% used";
}
function fmtDelta(current, prev) {
  if (prev == null || isNaN(prev)) return { text: "—", cls: "neutral" };
  var d = current - prev;
  if (Math.abs(d) < 0.1) return { text: "No change", cls: "neutral" };
  var sign = d > 0 ? "+" : "";
  return {
    text: sign + d.toFixed(1) + "% vs prior",
    cls: d > 0 ? "up" : "down"
  };
}
function setKpiDelta(elId, delta) {
  var el = $(elId);
  if (!el) return;
  el.textContent = delta.text;
  el.className = "kpi-card__delta " + delta.cls;
}
function calcDiskPct(diskRows) {
  if (!Array.isArray(diskRows) || !diskRows.length) return null;
  var used = 0, total = 0;
  diskRows.forEach(function (d) {
    used += Number(d.USED_SIZE || d.USED || 0);
    total += Number(d.TOTAL_SIZE || d.SIZE || d.ALLOCATED_SIZE || 0);
  });
  return total ? (used / total * 100) : null;
}
function svcStatusPill(status) {
  var s = String(status || "").toUpperCase();
  var cls = s === "YES" || s === "ACTIVE" || s === "STARTED" ? "online" : (s === "NO" || s === "STOPPED" ? "offline" : "warn");
  var label = s === "YES" ? "Active" : (s || "Unknown");
  return '<span class="status-pill ' + cls + '"><span class="pill-dot"></span>' + esc(label) + "</span>";
}
function renderTable(rows, bodyEl, theadEl) {
  if (!rows || !rows.length) {
    theadEl.innerHTML = "";
    bodyEl.innerHTML = '<tr><td style="text-align:center;font-family:inherit;color:var(--text3)">No data</td></tr>';
    return;
  }
  var cols = Object.keys(rows[0]);
  theadEl.innerHTML = "<tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
  bodyEl.innerHTML = rows.map(function (r) {
    return "<tr>" + cols.map(function (c) { return "<td>" + esc(r[c]) + "</td>"; }).join("") + "</tr>";
  }).join("");
  return rows;
}

/* ---------- DASHBOARD ---------- */
function updateDashBanner(dash, online) {
  var icon = $("dash-banner-icon");
  var title = $("dash-banner-title");
  var sub = $("dash-banner-sub");
  var mem = (dash.metrics && dash.metrics.memory) || {};
  var cpu = (dash.metrics && dash.metrics.cpu) || {};
  var alerts = dash.alerts || {};
  var locks = alerts.locks && alerts.locks.count;
  var crit = mem.usage_percent >= 85 || cpu.usage_percent >= 80;
  var warn = mem.usage_percent >= 70 || cpu.usage_percent >= 60 || locks;

  if (!online) {
    icon.className = "dash-banner__icon crit";
    icon.textContent = "✕";
    title.textContent = "System offline or unreachable";
    sub.textContent = "Cannot connect to SAP HANA — check network and credentials.";
    return;
  }
  if (crit) {
    icon.className = "dash-banner__icon crit";
    icon.textContent = "!";
    title.textContent = "Critical thresholds exceeded";
    sub.textContent = "Memory or CPU usage requires immediate attention.";
  } else if (warn) {
    icon.className = "dash-banner__icon warn";
    icon.textContent = "⚠";
    title.textContent = "Elevated resource usage detected";
    sub.textContent = "Some metrics are above normal thresholds — review alerts below.";
  } else {
    icon.className = "dash-banner__icon ok";
    icon.textContent = "✓";
    title.textContent = "All systems operational";
    var sys = dash.system || {};
    sub.textContent = (sys.database || "SAP HANA") + " on " + (sys.host || "instance") + " is healthy.";
  }
}
function renderServicesTable(svc) {
  var body = $("svc-body");
  if (!Array.isArray(svc) || !svc.length) {
    body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted)">No services data</td></tr>';
    return;
  }
  body.innerHTML = svc.map(function (s) {
    return "<tr><td class=\"svc-name\">" + esc(s.SERVICE_NAME || s.NAME || "—") + "</td>" +
      "<td>" + svcStatusPill(s.ACTIVE_STATUS || s.STATUS) + "</td>" +
      '<td class="mono">' + esc(s.PORT != null ? s.PORT : "—") + "</td></tr>";
  }).join("");
}
function loadDashboard() {
  var pill = $("dash-status");
  pill.className = "status-pill";
  $("dash-status-label").textContent = "Checking…";

  Promise.all([
    api("/api/dashboard"),
    api("/api/history?minutes=60")
  ]).then(function (results) {
    var dash = results[0];
    var history = results[1];
    if (dash.error) throw new Error(dash.error);

    var sys = dash.system || {};
    var online = sys.status === "ONLINE";
    updateTopbar(sys);
    setStatus(online);
    pill.classList.add(online ? "online" : "error");
    $("dash-status-label").textContent = online ? "Online" : (sys.status || "Offline");
    updateDashBanner(dash, online);

    var m = dash.metrics || {};
    var mem = m.memory || {};
    var cpu = m.cpu || {};
    var conn = m.connections || {};
    var diskRaw = m.disk;
    var diskRows = Array.isArray(diskRaw) ? diskRaw : (diskRaw && diskRaw.rows) || [];
    var diskPct = calcDiskPct(diskRows);

    var memPct = mem.usage_percent || 0;
    var cpuPct = cpu.usage_percent || 0;
    $("kpi-mem-val").textContent = pct(memPct);
    $("kpi-mem-val").className = "kpi-card__value " + kpiClass(memPct);
    $("kpi-cpu-val").textContent = pct(cpuPct);
    $("kpi-cpu-val").className = "kpi-card__value " + kpiClass(cpuPct);
    $("kpi-conn-val").textContent = conn.active != null ? conn.active : "—";
    $("kpi-conn-val").className = "kpi-card__value";
    if (diskPct != null) {
      $("kpi-disk-val").textContent = pct(diskPct);
      $("kpi-disk-val").className = "kpi-card__value " + kpiClass(diskPct);
    } else {
      $("kpi-disk-val").textContent = "—";
      $("kpi-disk-val").className = "kpi-card__value";
    }

    var points = (history && history.points) || [];
    if (points.length >= 2) {
      renderSparkline($("kpi-mem-spark"), points.map(function (p) { return p.memory_usage; }), gaugeColor(memPct));
      renderSparkline($("kpi-cpu-spark"), points.map(function (p) { return p.cpu_usage; }), gaugeColor(cpuPct));
      renderSparkline($("kpi-conn-spark"), points.map(function (p) { return p.connections; }), "var(--cyan)");
      renderSparkline($("kpi-disk-spark"), [], "var(--primary)");
      var prev = points[points.length - 2];
      var curr = points[points.length - 1];
      setKpiDelta("kpi-mem-delta", fmtDelta(curr.memory_usage, prev.memory_usage));
      setKpiDelta("kpi-cpu-delta", fmtDelta(curr.cpu_usage, prev.cpu_usage));
      var connDelta = curr.connections - prev.connections;
      $("kpi-conn-delta").textContent = connDelta === 0 ? "No change" : (connDelta > 0 ? "+" : "") + connDelta + " vs prior";
      $("kpi-conn-delta").className = "kpi-card__delta " + (connDelta > 0 ? "up" : connDelta < 0 ? "down" : "neutral");
    }
    if (diskPct != null) {
      $("kpi-disk-delta").textContent = "Current snapshot";
      $("kpi-disk-delta").className = "kpi-card__delta neutral";
    }

    renderGauge($("gauge-memory"), memPct, $("gauge-mem-label"));
    renderGauge($("gauge-cpu"), cpuPct, $("gauge-cpu-label"));
    renderServicesTable(dash.health && dash.health.services);
    renderAlerts(dash.alerts || {}, mem, cpu);
  }).catch(function (e) {
    $("dash-status-label").textContent = "Offline";
    pill.classList.add("error");
    setStatus(false);
    updateTopbar({});
    $("dash-banner-icon").className = "dash-banner__icon crit";
    $("dash-banner-icon").textContent = "✕";
    $("dash-banner-title").textContent = "Dashboard unavailable";
    $("dash-banner-sub").textContent = e.message || "Could not reach the monitoring API.";
    $("alerts-area").innerHTML = '<div class="alert-banner alert-banner--crit"><span class="ab-dot"></span>Dashboard unavailable: ' + esc(e.message) + "</div>";
  });
}

/* Alerts render as banner only when active; otherwise calm recessed strip */
function renderAlerts(alerts, mem, cpu) {
  var list = [];
  if (mem.usage_percent >= 85) list.push({ sev: "crit", text: "Memory usage " + pct(mem.usage_percent) + " — critical threshold exceeded." });
  else if (mem.usage_percent >= 70) list.push({ sev: "warn", text: "Memory usage " + pct(mem.usage_percent) + " — elevated." });
  if (cpu.usage_percent >= 80) list.push({ sev: "crit", text: "CPU usage " + pct(cpu.usage_percent) + " — critical threshold exceeded." });
  else if (cpu.usage_percent >= 60) list.push({ sev: "warn", text: "CPU usage " + pct(cpu.usage_percent) + " — elevated." });
  if (alerts.locks && alerts.locks.count) list.push({ sev: "warn", text: alerts.locks.count + " blocked transaction(s)." });
  if (Array.isArray(alerts.expensive_queries) && alerts.expensive_queries.length) list.push({ sev: "warn", text: alerts.expensive_queries.length + " expensive query(ies)." });

  var area = $("alerts-area");
  if (!list.length) {
    area.innerHTML = '<div class="alert-calm"><span class="alert-calm__dot"></span>No active alerts · all monitored thresholds within normal range.</div>';
    return;
  }
  area.innerHTML = list.map(function (a) {
    return '<div class="alert-banner alert-banner--' + a.sev + '"><span class="ab-dot"></span>' + esc(a.text) + "</div>";
  }).join("");
}

/* ---------- TOOL EXPLORER ---------- */
var TOOLS = [];
var toolCategory = "";
var toolSearch = "";
var selectedTool = null;
var CAT_ICONS = {
  "Monitoring": "📊",
  "Metadata": "🗄",
  "SQL": "⌨",
  "SAP Knowledge": "📚",
  "activity": "📊",
  "database": "🗄",
  "terminal": "⌨",
  "book": "📚",
  "tool": "🔧"
};
var UI_ICON_MAP = { activity: "📊", database: "🗄", terminal: "⌨", book: "📚", tool: "🔧" };
function toolIcon(t) {
  if (t.ui && t.ui.icon && UI_ICON_MAP[t.ui.icon]) return UI_ICON_MAP[t.ui.icon];
  return CAT_ICONS[t.category] || "🔧";
}

function loadTools() {
  if (!TOOLS.length) {
    api("/api/tools").then(function (toolArray) {
      TOOLS = Array.isArray(toolArray) ? toolArray : [];
      buildToolTabs();
      renderTools();
    }).catch(function (e) {
      $("tool-list").innerHTML = '<div class="empty">Failed to load tools: ' + esc(e.message) + "</div>";
    });
  } else {
    buildToolTabs();
    renderTools();
  }
}
function buildToolTabs() {
  var seen = [];
  TOOLS.forEach(function (t) { if (seen.indexOf(t.category) < 0) seen.push(t.category); });
  var tabs = '<button class="tool-tab' + (!toolCategory ? " active" : "") + '" data-cat="">All</button>';
  tabs += seen.map(function (c) {
    return '<button class="tool-tab' + (toolCategory === c ? " active" : "") + '" data-cat="' + escAttr(c) + '">' + esc(c) + "</button>";
  }).join("");
  $("tool-tabs").innerHTML = tabs;
  $("tool-tabs").querySelectorAll(".tool-tab").forEach(function (b) {
    b.addEventListener("click", function () {
      $("tool-tabs").querySelectorAll(".tool-tab").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      toolCategory = b.dataset.cat;
      renderTools();
    });
  });
}
function renderTools() {
  var list = TOOLS.filter(function (t) {
    var okCat = !toolCategory || t.category === toolCategory;
    var q = toolSearch.toLowerCase();
    var okSearch = !q || (t.name + " " + (t.description || "") + " " + (t.purpose || "")).toLowerCase().indexOf(q) >= 0;
    return okCat && okSearch;
  });
  if (!list.length) {
    $("tool-list").innerHTML = '<div class="empty">No tools match.</div>';
    return;
  }
  $("tool-list").innerHTML = list.map(function (t) {
    var sel = selectedTool && selectedTool.name === t.name ? " selected" : "";
    return '<div class="tool-grid-card' + sel + '" data-name="' + escAttr(t.name) + '">' +
      '<div class="tool-grid-card__icon">' + toolIcon(t) + "</div>" +
      '<div class="tool-grid-card__name">' + esc(t.name) + "</div>" +
      '<div class="tool-grid-card__desc">' + esc(t.description || t.purpose || "") + "</div>" +
      '<div class="tool-grid-card__cat"><span class="chip chip--cat">' + esc(t.category) + "</span></div></div>";
  }).join("");
  $("tool-list").querySelectorAll(".tool-grid-card").forEach(function (card) {
    card.addEventListener("click", function () {
      var t = TOOLS.filter(function (x) { return x.name === card.dataset.name; })[0];
      if (t) openToolPanel(t);
    });
  });
}
function openToolPanel(t) {
  selectedTool = t;
  renderTools();
  $("tool-panel-title").textContent = t.name;
  $("tool-panel-desc").textContent = t.description || t.purpose || "";
  var inputsEl = $("tool-panel-inputs");
  inputsEl.innerHTML = "";
  (t.inputs || []).forEach(function (inp) {
    var f = document.createElement("div");
    f.className = "f";
    var label = document.createElement("label");
    label.textContent = inp.name + (inp.default != null ? " (default: " + inp.default + ")" : "") + (inp.optional ? " (optional)" : "");
    var input = document.createElement("input");
    input.placeholder = inp.name;
    input.dataset.param = inp.name;
    if (inp.default != null) input.value = inp.default;
    f.appendChild(label);
    f.appendChild(input);
    inputsEl.appendChild(f);
  });
  $("tool-panel-result").innerHTML = "";
  $("tool-panel").classList.add("open");
  $("tools-main").classList.add("panel-open");
}
function closeToolPanel() {
  $("tool-panel").classList.remove("open");
  $("tools-main").classList.remove("panel-open");
  selectedTool = null;
  renderTools();
}
function runToolPanel(t) {
  var params = {};
  $("tool-panel-inputs").querySelectorAll("input[data-param]").forEach(function (i) {
    if (i.value) params[i.dataset.param] = i.value;
  });
  var btn = $("tool-panel-run");
  var resultEl = $("tool-panel-result");
  btn.textContent = "Running…";
  btn.disabled = true;
  resultEl.innerHTML = '<div class="tool-result"><span style="color:var(--muted)">Running…</span></div>';
  api("/api/tool/" + t.name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  }).then(function (res) {
    if (res.error) {
      resultEl.innerHTML = '<div class="tool-result" style="color:var(--red)">Error: ' + esc(res.error) + "</div>";
    } else {
      resultEl.innerHTML = '<div class="tool-result"><span class="json">' + esc(JSON.stringify(res, null, 2)) + "</span></div>";
    }
  }).catch(function (e) {
    resultEl.innerHTML = '<div class="tool-result" style="color:var(--red)">Error: ' + esc(e.message) + "</div>";
  }).finally(function () {
    btn.textContent = "Run Tool";
    btn.disabled = false;
  });
}
$("tool-search").addEventListener("input", function () { toolSearch = this.value; renderTools(); });
$("tool-panel-close").addEventListener("click", closeToolPanel);
$("tool-panel-run").addEventListener("click", function () {
  if (selectedTool) runToolPanel(selectedTool);
});

/* ---------- SQL CONSOLE ---------- */
var SQL_HIST_KEY = "hana_sql_history";
function getSqlHistory() {
  try { return JSON.parse(localStorage.getItem(SQL_HIST_KEY) || "[]"); }
  catch (e) { return []; }
}
function pushSqlHistory(sql) {
  if (!sql) return;
  var h = getSqlHistory().filter(function (s) { return s !== sql; });
  h.unshift(sql);
  if (h.length > 10) h.length = 10;
  try { localStorage.setItem(SQL_HIST_KEY, JSON.stringify(h)); } catch (e) {}
  renderSqlHistory();
}
function renderSqlHistory() {
  var h = getSqlHistory();
  var el = $("sql-history-list");
  if (!h.length) { el.innerHTML = '<div class="sql-history-empty">No queries yet.</div>'; return; }
  el.innerHTML = h.map(function (s) {
    return '<div class="sql-history-item" data-sql="' + escAttr(s) + '">' + esc(s) + "</div>";
  }).join("");
  el.querySelectorAll(".sql-history-item").forEach(function (item) {
    item.addEventListener("click", function () {
      $("sql-editor").value = item.dataset.sql;
      $("sql-run").click();
    });
  });
}
renderSqlHistory();

document.querySelectorAll(".sql-snippet").forEach(function (btn) {
  btn.addEventListener("click", function () {
    $("sql-editor").value = btn.dataset.sql;
    $("sql-editor").focus();
  });
});

$("sql-run").addEventListener("click", function () {
  var sql = $("sql-editor").value.trim();
  if (!sql) return;
  $("sql-meta").textContent = "Running…";
  $("sql-error").hidden = true;
  $("sql-result-wrap").hidden = true;
  api("/api/tool/hana_execute_query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: sql })
  }).then(function (res) {
    if (res.error) {
      $("sql-error").textContent = "Error: " + res.error;
      $("sql-error").hidden = false;
      $("sql-meta").textContent = "";
      return;
    }
    var rows = res.rows || [];
    renderTable(rows, $("sql-table").querySelector("tbody"), $("sql-table").querySelector("thead"));
    $("sql-result-wrap").hidden = false;
    var meta = res.row_count + " row(s) in " + (res.execution_ms || 0).toFixed(1) + " ms";
    $("sql-meta").textContent = meta;
    $("sql-result-meta").textContent = meta;
    pushSqlHistory(sql);
  }).catch(function (e) {
    $("sql-error").textContent = "Error: " + e.message;
    $("sql-error").hidden = false;
    $("sql-meta").textContent = "";
  });
});

/* ---------- METADATA ---------- */
var META_ALL = [];
var META_FILTERED = [];
var META_SCROLLED = 0;
var META_PAGE = 100;
function loadMetadata() {
  api("/api/tool/hana_discover_objects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 500 })
  }).then(function (res) {
    META_ALL = res.rows || res || [];
    applyMetaFilter();
  }).catch(function (e) {
    META_ALL = [];
    applyMetaFilter();
  });
}
function applyMetaFilter() {
  var q = $("meta-search").value.trim().toLowerCase();
  META_FILTERED = META_ALL.filter(function (r) {
    if (!q) return true;
    return (String(r.SCHEMA_NAME) + " " + String(r.OBJECT_NAME) + " " + String(r.OBJECT_TYPE)).toLowerCase().indexOf(q) >= 0;
  });
  META_SCROLLED = 0;
  renderMeta();
  renderMetaCount();
}
function renderMetaCount() {
  $("meta-count").textContent = META_FILTERED.length ? META_FILTERED.length + (META_FILTERED.length === META_ALL.length ? " shown" : " matched") : "0 results";
}
function typeBadge(t) {
  t = String(t || "").toUpperCase();
  if (t.indexOf("VIEW") >= 0) return '<span class="chip chip--view">VIEW</span>';
  if (t.indexOf("TABLE") >= 0) return '<span class="chip chip--table">TABLE</span>';
  if (t.indexOf("COLUMN") >= 0) return '<span class="chip chip--column">' + esc(t) + "</span>";
  return '<span class="chip chip--cat">' + esc(t) + "</span>";
}
function metaIcon(type) {
  var t = String(type || "").toUpperCase();
  if (t.indexOf("VIEW") >= 0) return '<span class="meta-icon meta-icon--view">V</span>';
  if (t.indexOf("TABLE") >= 0) return '<span class="meta-icon meta-icon--table">T</span>';
  return '<span class="meta-icon meta-icon--view">?</span>';
}
function renderMeta() {
  var start = META_SCROLLED;
  var end = Math.min(META_SCROLLED + META_PAGE, META_FILTERED.length);
  var body = $("meta-body");
  if (!META_FILTERED.length) {
    body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted)">No objects found.</td></tr>';
    return;
  }
  var rows = META_FILTERED.slice(start, end);
  body.innerHTML = rows.map(function (r) {
    return '<tr class="clickable" data-schema="' + escAttr(r.SCHEMA_NAME) + '" data-name="' + escAttr(r.OBJECT_NAME) + '" data-type="' + escAttr(r.OBJECT_TYPE) + '">' +
      "<td>" + metaIcon(r.OBJECT_TYPE) + esc(r.OBJECT_NAME) + "</td>" +
      "<td>" + typeBadge(r.OBJECT_TYPE) + "</td>" +
      '<td class="mono">' + esc(r.SCHEMA_NAME) + "</td></tr>";
  }).join("");
  body.querySelectorAll("tr.clickable").forEach(function (tr) {
    tr.addEventListener("click", function () {
      openMetaDrawer(tr.dataset.schema, tr.dataset.name, tr.dataset.type);
    });
  });
  if (end < META_FILTERED.length) {
    body.innerHTML += '<tr><td colspan="3" style="text-align:center;color:var(--muted);font-size:11px">Scroll to load more (' + (META_FILTERED.length - end) + " remaining)</td></tr>";
  }
}
function openMetaDrawer(schema, name, type) {
  $("meta-drawer-title").textContent = name;
  $("meta-drawer-sub").textContent = schema + " · " + type;
  $("meta-drawer-body").innerHTML = '<div class="meta-drawer__loading">Loading columns…</div>';
  $("meta-drawer").classList.add("open");
  var objType = String(type || "").toUpperCase().indexOf("VIEW") >= 0 ? "VIEW" : "TABLE";
  api("/api/tool/hana_describe_object", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: schema, object_name: name, object_type: objType })
  }).then(function (res) {
    if (res.error) {
      $("meta-drawer-body").innerHTML = '<div class="meta-drawer__loading" style="color:var(--red)">' + esc(res.error) + "</div>";
      return;
    }
    var rows = res.rows || [];
    if (!rows.length) {
      $("meta-drawer-body").innerHTML = '<div class="meta-drawer__loading">No columns found.</div>';
      return;
    }
    $("meta-drawer-body").innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead><tbody>' +
      rows.map(function (c) {
        return '<tr><td class="mono">' + esc(c.COLUMN_NAME || c.NAME || "—") + "</td><td>" + esc(c.DATA_TYPE_NAME || c.TYPE || "—") + "</td><td>" + esc(c.IS_NULLABLE != null ? c.IS_NULLABLE : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  });
}
$("meta-drawer-close").addEventListener("click", function () {
  $("meta-drawer").classList.remove("open");
});
$("meta-vscroll").addEventListener("scroll", function () {
  var el = this;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    if (META_SCROLLED < META_FILTERED.length - META_PAGE) {
      META_SCROLLED += META_PAGE;
      renderMeta();
    }
  }
});
$("meta-search").addEventListener("input", applyMetaFilter);
$("meta-load").addEventListener("click", loadMetadata);
$("meta-refresh").addEventListener("click", function () { $("meta-search").value = ""; loadMetadata(); });

/* ---------- AI CHAT (two-pane) ---------- */
var CHAT_KEY = "hana_chat_conversations";
var CHAT_SB_COLLAPSED = "hana_chat_sb_collapsed";
var currentConvId = null;
var activeConv = null; /* in-memory active conversation; guarantees continuity even if localStorage is unavailable */
var busy = false;
var pickedSql = null; /* SQL chosen by chooseSteps for a specific object/bulk query */

/* ---------- conversation persistence ---------- */
function loadConvs() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY) || "[]"); } catch (e) { return []; }
}
function saveConvs(convs) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(convs)); } catch (e) {}
}
function getConv(id) {
  /* Prefer the in-memory active conversation when it matches, so we never
     lose continuity if localStorage is unavailable or out of sync. */
  if (id && activeConv && activeConv.id === id) return activeConv;
  return loadConvs().filter(function (c) { return c.id === id; })[0] || null;
}
function upsertConv(conv) {
  try {
    var convs = loadConvs();
    var hit = convs.filter(function (c) { return c.id === conv.id; })[0];
    if (hit) {
      /* Move the most recently used conversation to the top of the list so
         a freshly created / just-actively-used chat surfaces first. */
      var hitIdx = convs.indexOf(hit);
      convs.splice(hitIdx, 1);
      Object.assign(hit, conv);
      convs.unshift(hit);
    } else {
      convs.unshift(conv);
    }
    saveConvs(convs);
  } catch (e) {}
  /* Always keep the in-memory copy fresh as the source of truth. */
  activeConv = conv;
}
function newConv() {
  var conv = { id: "c" + Date.now() + Math.floor(Math.random() * 1000), title: "New chat", created: Date.now(), messages: [] };
  upsertConv(conv);
  currentConvId = conv.id;
  activeConv = conv;
  renderSidebar();
  return conv;
}

/* ---------- sidebar ---------- */
function groupLabel(ts) {
  var now = new Date();
  var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var startYest = startToday - 86400000;
  var start7 = startToday - 7 * 86400000;
  if (ts >= startToday) return "Today";
  if (ts >= startYest) return "Yesterday";
  if (ts >= start7) return "Previous 7 days";
  return "Older";
}
function renderSidebar() {
  var convs = loadConvs();
  var q = ($("chat-sb-search").value || "").toLowerCase();
  if (q) {
    convs = convs.filter(function (c) { return c.title.toLowerCase().indexOf(q) >= 0; });
  }
var groups = { "Today": [], "Yesterday": [], "Previous 7 days": [], "Older": [] };
  convs.forEach(function (c) { groups[groupLabel(c.created)].push(c); });
  /* Keep each time group newest-first so a freshly created / just-used
     conversation always surfaces at the top of its group. */
  Object.keys(groups).forEach(function (g) {
    groups[g].sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
  });
  var el = $("chat-sb-groups");
  if (!convs.length) { el.innerHTML = '<div class="chat-sb-empty">No conversations yet.</div>'; return; }
  var html = "";
  Object.keys(groups).forEach(function (g) {
    if (!groups[g].length) return;
    html += '<div class="chat-sb-group-label">' + g + "</div>";
html += groups[g].map(function (c) {
      return '<div class="chat-sb-item' + (c.id === currentConvId ? " active" : "") + '" data-id="' + c.id + '">' +
        '<span class="ci-title">' + esc(c.title) + "</span>" +
        '<span class="ci-cnt">' + c.messages.length + "</span>" +
        '<button class="ci-del" data-del="' + c.id + '" title="Delete conversation">✕</button>' +
        "</div>";
    }).join("");
  });
  el.innerHTML = html;
  el.querySelectorAll(".chat-sb-item").forEach(function (it) {
    it.addEventListener("click", function (e) {
      if (e.target.closest(".ci-del")) return;
      openConv(it.dataset.id);
    });
  });
  el.querySelectorAll(".ci-del").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteConv(btn.dataset.del);
    });
  });
}
function deleteConv(id) {
  if (!id) return;
  var convs = loadConvs().filter(function (c) { return c.id !== id; });
  saveConvs(convs);
  if (activeConv && activeConv.id === id) activeConv = null;
if (currentConvId === id) {
    currentConvId = null;
    activeConv = null;
    showWelcome();
  }
  renderSidebar();
}
$("chat-clear-all").addEventListener("click", function () {
  saveConvs([]);
  activeConv = null;
  currentConvId = null;
  renderSidebar();
  showWelcome();
});
$("chat-sb-search").addEventListener("input", renderSidebar);
$("chat-new").addEventListener("click", function () { newChat(); });
/* conversations drawer toggle */
$("chat-toggle-conv").addEventListener("click", function () {
  var drawer = $("chat-drawer");
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderSidebar();
});
document.addEventListener("click", function (e) {
  var drawer = $("chat-drawer");
  if (!drawer.hidden && !e.target.closest("#chat-drawer") && !e.target.closest("#chat-toggle-conv")) {
    drawer.hidden = true;
  }
});

/* ---------- pane state ---------- */
function showWelcome() {
  $("chat-welcome").style.display = "flex";
  $("chat-thread").hidden = true;
}
function showThread() {
  $("chat-welcome").style.display = "none";
  $("chat-thread").hidden = false;
}
function newChat() {
  /* Don't create a conversation yet — just reset to the welcome screen. The
     conversation will be created on the first submitted message via
     startThread → newConv. This avoids polluting the sidebar with empty
     "New chat" entries every time the button is clicked. */
  currentConvId = null;
  activeConv = null;
  showWelcome();
  var main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  var thread = $("chat-thread");
  if (thread) thread.scrollTop = 0;
  var wel = $("chat-welcome");
  if (wel) wel.scrollTop = 0;
}

/* ---------- render a conversation ---------- */
function renderThread(conv) {
  var inner = $("chat-thread-inner");
  inner.innerHTML = "";
  conv.messages.forEach(function (m) {
    if (m.role === "user") appendUserMsg(m.text, false);
    else appendAssistantMsg(m, false);
  });
  showThread();
  var thread = $("chat-thread");
  thread.scrollTop = thread.scrollHeight;
}

function appendUserMsg(text, persist) {
  var inner = $("chat-thread-inner");
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg--user";
  div.innerHTML = '<div class="chat-msg-avatar">U</div>' +
    '<div class="chat-msg-body"><div class="chat-msg-bubble">' + esc(text) + "</div></div>";
  inner.appendChild(div);
  var thread = $("chat-thread");
  thread.scrollTop = thread.scrollHeight;
  if (persist) {
    var conv = getConv(currentConvId);
    if (conv) {
      conv.title = conv.messages.length ? conv.title : (text.slice(0, 40) + (text.length > 40 ? "…" : ""));
      conv.messages.push({ role: "user", text: text });
      upsertConv(conv);
      renderSidebar();
    }
  }
  return div;
}

function appendAssistantMsg(m, persist) {
  var inner = $("chat-thread-inner");
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg--ai";
  div.innerHTML = '<div class="chat-msg-avatar">✦</div>' +
    '<div class="chat-msg-body">' +
    '<div class="assistant-summary">' + renderMarkdown(m.summary || "") + "</div>" +
    '<div class="chat-msg-actions">' +
    '<button class="chat-msg-action" data-act="copy">⧉ Copy</button>' +
    '<button class="chat-msg-action" data-act="rerun">↻ Re-run tools</button>' +
    '<button class="chat-msg-action" data-act="regenerate">⟲ Retry</button>' +
    "</div></div>";
  inner.appendChild(div);
  div.querySelector('[data-act="copy"]').addEventListener("click", function () {
    var txt = m.summary || "";
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function(){});
  });
  div.querySelector('[data-act="rerun"]').addEventListener("click", function () {
    if (busy) return;
    busy = true;
    runSteps(m.steps || [], div, {})
      .then(function () { busy = false; })
      .catch(function () { busy = false; });
  });
  div.querySelector('[data-act="regenerate"]').addEventListener("click", function () {
    if (busy) return;
    var prev = convLastUser();
    if (prev) userAsk(prev, null);
  });
  if (persist) {
    var conv = getConv(currentConvId);
    if (conv) { conv.messages.push(m); upsertConv(conv); renderSidebar(); }
  }
  var thread = $("chat-thread");
  thread.scrollTop = thread.scrollHeight;
  return div;
}
function convLastUser() {
  var conv = getConv(currentConvId);
  if (!conv) return "";
  for (var i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === "user") return conv.messages[i].text;
  }
  return "";
}

/* ---------- start a thread ---------- */
function startThread(text, steps) {
  if (busy) return;
  busy = true;
  $("chat-send").disabled = true;
  /* Reuse the in-memory active conversation so a follow-up question stays in
     the same thread. Only start a brand-new conversation when there is no
     active one (e.g. first message on a fresh load). */
  var conv = activeConv || getConv(currentConvId) || newConv();
  currentConvId = conv.id;
  activeConv = conv;
  showThread();
  appendUserMsg(text, true);
  var aiDiv = appendAssistantMsg({ steps: steps, summary: '<span style="color:var(--text3)">Working…</span>' }, false);
  runSteps(steps, aiDiv, {})
    .then(function (summary) {
      var m = { role: "assistant", steps: steps, summary: summary };
      var conv2 = getConv(currentConvId);
      if (conv2) { conv2.messages.push(m); upsertConv(conv2); renderSidebar(); }
      busy = false;
      $("chat-send").disabled = false;
    })
    .catch(function () { busy = false; $("chat-send").disabled = false; });
}

function userAsk(text, nullArg) { startThread(text, chooseSteps(text)); }

/* ---------- run tool steps and build a smooth summary ---------- */
function runSteps(steps, aiDiv, opts) {
  return new Promise(function (resolve) {
    var body = aiDiv.querySelector(".chat-msg-body");
    var toolset = document.createElement("div");
    toolset.className = "chat-toolset";
    var summary = aiDiv.querySelector(".assistant-summary");
    body.insertBefore(toolset, summary);
    summary.innerHTML = '<div class="chat-streaming-cursor">Analyzing your system<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    var results = [];
    var idx = 0;

    function addChip(name) {
      var wrap = document.createElement("div");
      wrap.className = "toolchip-wrap";
      wrap.innerHTML = '<div class="toolchip busy">' +
        '<span class="tc-status run"></span>' +
        '<span class="tc-name">' + esc(name) + '</span>' +
        '<span class="tc-time">running…</span></div>' +
        '<div class="toolchip-detail"></div>';
      wrap.querySelector(".toolchip").addEventListener("click", function () {
        wrap.classList.toggle("open");
      });
      toolset.appendChild(wrap);
      return wrap;
    }
    function finishChip(chipWrap, name, res, ms) {
      var chip = chipWrap.querySelector(".toolchip");
      var detail = chipWrap.querySelector(".toolchip-detail");
      var status = chipWrap.querySelector(".tc-status");
      var timeEl = chipWrap.querySelector(".tc-time");
      chip.classList.remove("busy");
      if (res.error) {
        status.className = "tc-status err";
        timeEl.textContent = ms + " ms";
        detail.textContent = res.error;
      } else {
        status.className = "tc-status ok";
        timeEl.textContent = ms + " ms";
        detail.textContent = JSON.stringify(res, null, 2);
      }
    }

    function next() {
      if (idx >= steps.length) {
        var single = results.length === 1;
        var nm = single ? results[0].name : "";
        var s = (single && nm !== "__greet__" && nm !== "__unknown__") ? buildFocusedSummary(results) : buildSummary(results);
        summary.innerHTML = renderMarkdown(s);
        resolve(s);
        return;
      }
      if (steps[idx] === "__greet__" || steps[idx] === "__unknown__") {
        var marker = steps[idx];
        idx++;
        results.push({ name: marker, rows: [], rc: 0, res: {} });
        next();
        return;
      }
      var name = steps[idx];
      idx++;
      var chipWrap = addChip(name);
      var t0 = Date.now();
      var params = toolParams(name);
      api("/api/tool/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) })
        .then(function (res) {
          var ms = Date.now() - t0;
          finishChip(chipWrap, name, res, ms);
          if (res.error) {
            results.push({ name: name, error: res.error });
          } else {
            var rows = res.rows || [];
            var rc = res.row_count != null ? res.row_count : (rows.length || 0);
            results.push({ name: name, rows: rows, rc: rc, res: res });
          }
          next();
        })
        .catch(function (e) {
          finishChip(chipWrap, name, { error: e.message }, Date.now() - t0);
          results.push({ name: name, error: e.message });
          next();
        });
    }
    next();
  });
}

/* Group M_* monitoring views into friendly categories (mirrors HANA domains) */
var VIEW_GROUPS = [
  { re: /M_CS_|M_CATALOG|M_TABLE|M_INDEX|M_OBJECT/i, label: "Catalog, tables & column store", subs: [] },
  { re: /M_DATA_VOLUME|M_VOLUME|M_DISK|M_FILE|M_BACKUP/i, label: "Storage, data volumes & backups", subs: [] },
  { re: /M_SERVICE|M_CONNECTION|M_SESSION|M_HOST|M_DATABASE/i, label: "Services, system & connections", subs: [] },
  { re: /M_MEMORY|M_CACHE|M_CONTEXT|M_CPU|M_RESOURCE|M_LOAD|M_SQL|M_EXPENSIVE|M_WORKLOAD/i, label: "Memory, CPU & workload", subs: [] },
  { re: /M_LOCK|M_BLOCKED|M_TRANSACTION|M_ACTIVE|M_STATEMENT/i, label: "Locks, transactions & statements", subs: [] },
  { re: /M_REPLICATION|M_FAILOVER|M_RECOVERY|M_REMOTE/i, label: "Replication & recovery", subs: [] }
];
function groupViews(rows) {
  var out = [];
  VIEW_GROUPS.forEach(function (g) {
    var names = rows.filter(function (r) { return g.re.test(r.VIEW_NAME || ""); }).map(function (r) { return r.VIEW_NAME; });
    if (names.length) out.push({ label: g.label, names: names });
  });
  return out;
}

/* Format a memory/byte figure into a readable string */
function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "-";
  var n = Number(v);
  if (isNaN(n)) return String(v);
  if (Math.abs(n) >= 1024) {
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return x.toFixed(1) + u[i];
  }
  return String(n);
}

/* Render a small markdown table from rows */
function rowsToMarkdown(rows, max) {
  rows = (rows || []).slice(0, max || 12);
  if (!rows.length) return "_No rows returned._";
  var cols = Object.keys(rows[0]);
  var head = "| " + cols.join(" | ") + " |";
  var sep = "| " + cols.map(function () { return "---"; }).join(" | ") + " |";
  var body = rows.map(function (r) {
    return "| " + cols.map(function (c) { return String(r[c] === null || r[c] === undefined ? "" : r[c]).replace(/\|/g, "\\|"); }).join(" | ") + " |";
  }).join("\n");
  return head + "\n" + sep + "\n" + body;
}

/* ---- helpers to pull a value from a result by name ---- */
function findResult(results, name) {
  for (var i = 0; i < results.length; i++) {
    if (results[i].name === name && !results[i].error) return results[i];
  }
  return null;
}
function rowsOf(results, name) {
  var r = findResult(results, name);
  return (r && r.rows) || [];
}
function firstRow(results, name) {
  var rows = rowsOf(results, name);
  return rows[0] || {};
}
function num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}
function fmtBytes2(b) {
  b = num(b);
  if (b <= 0) return "0 B";
  var u = ["B", "KB", "MB", "GB", "TB"];
  var i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(1) + " " + u[i];
}

/* Produce a smooth, conversational health narrative from the tool results */
/* Focused narrative for a single monitoring tool (memory / cpu / connections). */
function buildFocusedSummary(results) {
  if (!results.length) return "No results were returned.";
  var r = results[0];
  if (r.error) return "**" + r.name + "** returned an error: " + esc(r.error);
  var rows = r.rows || [];
  if (!rows.length) return "That check returned no rows right now.";

  if (r.name === "hana_memory") {
    var byName = {};
    rows.forEach(function (x) {
      var k = String(x.NAME || "").toLowerCase();
      var v = num(x.VALUE);
      byName[k] = v;
    });
    var pickV = function (keys) {
      for (var i = 0; i < keys.length; i++) {
        for (var key in byName) {
          if (key.indexOf(keys[i]) >= 0) return byName[key];
        }
      }
      return null;
    };
    var used = pickV(["used", "allocated"]);
    var limit = pickV(["allocation limit", "limit", "max", "total", "peak"]);
    var out = [];
    out.push(used != null ? "Current memory usage is **" + fmtBytes2(used) + "**." : "Current memory usage is not directly available in the returned rows.");
    if (limit != null) out.push("Allocation limit is **" + fmtBytes2(limit) + "**.");
    var pct = (used != null && limit != null) ? Math.round(used / limit * 100) : null;
    if (pct != null) out.push(pct >= 85 ? "That is **" + pct + "%** of the limit — **elevated, watch this.**" : pct >= 70 ? "That is **" + pct + "%** of the limit — trending toward the warning threshold." : "That is **" + pct + "%** of the limit — comfortably within normal range.");
    return out.join("\n\n");
  }

  if (r.name === "hana_cpu") {
    var c = rows[0];
    var userT = num(c.TOTAL_CPU_USER_TIME) + num(c.TOTAL_CPU_SYSTEM_TIME);
    var totT = userT + num(c.TOTAL_CPU_IDLE_TIME);
    var util = totT ? Math.round(userT / totT * 100) + "%" : "n/a";
    return "Approx CPU utilization is **" + util + "** on **" + (c.HOST || "the instance") + "**.";
  }

  if (r.name === "hana_connections") {
    var conn = rows[0];
    var connVal = conn.CONNECTIONS != null ? conn.CONNECTIONS : rows.length;
    return "There are currently **" + connVal + "** active connection(s).";
  }

  return rowsToMarkdown(rows, 15);
}

function buildSummary(results) {
  var ok = results.filter(function (r) { return !r.error; });
  var errors = results.filter(function (r) { return r.error; });
  var lines = [];

  /* Greeting — respond conversationally without any DB query. */
  if (results.some(function (r) { return r.name === "__greet__"; })) {
    return "Hi there! 👋 I'm your **SAP HANA monitoring assistant**.\n\n" +
      "I can check live database health, memory, CPU, connections, services, disk, backups, blocked transactions, and more — all read-only.\n\n" +
      "Try asking things like:\n" +
      "- **\"how healthy is my database?\"**\n" +
      "- **\"how much memory is in use?\"**\n" +
      "- **\"any blocked transactions?\"**\n" +
      "- **\"show expensive queries\"**\n" +
      "- **\"list my users\"**\n\n" +
"What would you like me to check?";
  }

  /* Off-topic / unclear — point the user back to what I can do. */
  if (results.some(function (r) { return r.name === "__unknown__"; })) {
    return "I'm a **read-only SAP HANA monitoring assistant**, so I can't help with that.\n\n" +
      "I **can** tell you about live database health, memory, CPU, connections, services, disk/storage, backups, blocked transactions, recent errors, expensive queries, and schema objects — all read-only.\n\n" +
      "Try a prompt like **\"how healthy is my database?\"** or **\"show disk usage\"**.";
  }

  /* ---- HEALTH-STYLE NARRATIVE ---- */
  var health = false;
  for (var h = 0; h < results.length; h++) {
    if (results[h].name === "hana_services" || results[h].name === "hana_disk" || results[h].name === "hana_backup_status") health = true;
  }

  if (health) {
    var svcRows = rowsOf(results, "hana_services");
    var host = (firstRow(results, "hana_services").HOST) || (firstRow(results, "hana_system_status").HOST) || "the instance";
    var svcNames = [];
    svcRows.forEach(function (s) {
      svcNames.push(s.SERVICE_NAME || s.NAME || "?");
    });
    var svcText = svcRows.length
      ? "all **" + svcRows.length + "** services are healthy — " + svcNames.join(", ") + " on **" + host + "**."
      : "no service rows were returned.";
    lines.push("Overall, the instance is running fine operationally.");

    lines.push("**Services** — " + svcText);

    /* memory: NAME/VALUE pairs */
    var memRows = rowsOf(results, "hana_memory");
    if (memRows.length) {
      var byName = {};
      memRows.forEach(function (x) {
        var k = String(x.NAME || "").toLowerCase();
        var v = num(x.VALUE);
        byName[k] = v;
      });
      var pickV = function (keys) {
        for (var i = 0; i < keys.length; i++) {
          for (var key in byName) {
            if (key.indexOf(keys[i]) >= 0) return byName[key];
          }
        }
        return null;
      };
      var used = pickV(["used", "allocated"]);
      var limit = pickV(["allocation limit", "limit", "max", "total", "peak"]);
      used = (used === null) ? null : fmtBytes2(used);
      limit = (limit === null) ? null : fmtBytes2(limit);
      lines.push("**Memory** — " + ((used ? "current usage is **" + used + "**" : "current usage not available") + (limit ? ", against an allocation limit of **" + limit + "**." : ".")));
    }

    /* cpu */
    var c = firstRow(results, "hana_cpu");
    if (c && (c.TOTAL_CPU_USER_TIME != null || c.TOTAL_CPU_ACTIVE_TIME != null)) {
      var userT = num(c.TOTAL_CPU_USER_TIME) + num(c.TOTAL_CPU_SYSTEM_TIME);
      var totT = userT + num(c.TOTAL_CPU_IDLE_TIME);
      var util = totT ? Math.round(userT / totT * 100) + "%" : "n/a";
      lines.push("**CPU** — approx utilization **" + util + "** on **" + (c.HOST || host) + "**.");
    }

    /* connections */
    var conn = firstRow(results, "hana_connections");
    var connVal = conn.CONNECTIONS != null ? conn.CONNECTIONS : (rowsOf(results, "hana_connections").length || 0);
    if (connVal) {
      lines.push("**Connections** — **" + connVal + "** active connection(s).");
    }

    /* disk / volumes */
    var diskRows = rowsOf(results, "hana_disk");
    if (diskRows.length) {
      var parts = [];
      diskRows.slice(0, 6).forEach(function (d) {
        var name = d.USAGE_TYPE || d.VOLUME_ID || d.FILE_NAME || d.TYPE || "vol";
        var usedB = num(d.USED_SIZE) || num(d.USED);
        var totalB = num(d.TOTAL_SIZE) || num(d.SIZE) || num(d.ALLOCATED_SIZE);
        var p = totalB ? Math.round(usedB / totalB * 100) + "%" : "";
        parts.push(name + " **" + fmtBytes2(usedB) + (totalB ? " / " + fmtBytes2(totalB) : "") + "**" + (p ? " (" + p + ")" : ""));
      });
      lines.push("**Disk / volumes** — " + parts.join("; ") + ".");
    }

    /* backups */
    var backupRows = rowsOf(results, "hana_backup_status");
    lines.push(backupRows.length
      ? "**Backups** — " + backupRows.length + " backup record(s) present."
      : "**Backups — this is the flag.** `hana_backup_status` returned zero rows, meaning no backups have been recorded. If the container or volume is lost, there is no recovery path.");

    /* locks */
    var lockRows = rowsOf(results, "hana_blocked_transactions");
    lines.push(lockRows.length
      ? "**Locks** — **" + lockRows.length + "** blocked transaction(s) detected."
      : "**Locks** — clean, no blocked transactions right now.");

    if (errors.length) {
      lines.push("A few secondary checks couldn't complete: " + errors.map(function (e) { return "**" + e.name + "** (" + esc(e.error) + ")"; }).join(", ") + ".");
    }
    return lines.join("\n\n");
  }

  /* ---- GENERAL NARRATIVE (non-health) ---- */
  ok.forEach(function (r) {
    var rows = r.rows || [];
    if (r.name === "hana_discover_monitoring_views") {
      if (!rows.length) { lines.push("No monitoring (M_*) views were found in this instance."); return; }
      var groups = groupViews(rows);
      lines.push("Discovery worked. Here are the HANA monitoring (**M_**) views on your instance — showing the first **" + rows.length + "**:\n");
      groups.forEach(function (g) {
        lines.push("**" + g.label + "**\n\n" + g.names.slice(0, 14).join(", ") + (g.names.length > 14 ? " …" : "") + "\n");
      });
      if (rows.length >= 100) lines.push("There are likely more than the first " + rows.length + " shown — I can paginate or drill into any specific view.\n");
      lines.push("Want me to inspect the columns of any of these, or query one directly?");
      return;
    }
    if (r.name === "hana_search_views") {
      lines.push(rows.length
        ? "Found **" + rows.length + "** matching view(s):\n\n" + rows.slice(0, 15).map(function (x) {
            return "- **" + (x.VIEW_NAME || x.OBJECT_NAME || "?") + "**" + (x.SCHEMA_NAME ? " (" + x.SCHEMA_NAME + ")" : "");
          }).join("\n") + (rows.length > 15 ? "\n\n…and " + (rows.length - 15) + " more." : "") + "\n"
        : "No views matched that search.");
      return;
    }
    if (r.name === "hana_expensive_statements") {
      if (!rows.length) { lines.push("No expensive statements recorded recently.\n"); return; }
      lines.push("Top **" + rows.length + "** expensive statement(s):\n\n" + rows.slice(0, 8).map(function (x) {
        return "- **" + (x.DB_USER || "?") + "** · " + (Number(x.DURATION_MICROSEC) / 1000 || 0) + " ms · " + (x.START_TIME || "?") + "\n```\n" + (x.STATEMENT_STRING || "").slice(0, 180) + "\n```";
      }).join("\n") + (rows.length > 8 ? "\n\n…and " + (rows.length - 8) + " more." : "") + "\n");
      return;
    }
    if (r.name === "hana_trace_files") {
      lines.push("Recent trace files (**" + rows.length + "**):\n\n" + rowsToMarkdown(rows, 8));
      return;
    }
    if (r.name === "hana_execute_query") {
      lines.push(rowsToMarkdown(rows, 15));
      return;
    }
    if (rows.length) {
      lines.push("**" + esc(r.name) + "** (" + r.rc + " row(s)):\n\n" + rowsToMarkdown(rows, 12));
    } else {
      lines.push("**" + esc(r.name) + "**: no rows returned.");
    }
  });

  errors.forEach(function (r) {
    lines.push("**" + esc(r.name) + "** returned an error: " + esc(r.error));
  });

  if (!lines.length) lines.push("No results were returned.");
  return lines.join("\n\n");
}

/* ---------- sensible params for chat tool calls ---------- */
function toolParams(name) {
  var map = {
    "hana_search_views": { keyword: "memory" },
    "hana_search_objects": { keyword: "M_" },
    "hana_search_columns": { keyword: "NAME" },
    "hana_describe_table": { table_name: "M_DATABASE", schema: "SYS" },
    "hana_describe_view": { view_name: "M_SERVICES", schema: "SYS" },
    "hana_describe_object": { schema: "SYS", object_name: "M_DATABASE", object_type: "VIEW" },
    "hana_inspect_monitoring_view": { view_name: "M_MEMORY" },
    "hana_execute_sap_statement": { name: "HANA_Memory_Components_2.00.056+" },
    "hana_explain_sap_statement": { name: "HANA_Memory_Components_2.00.056+" },
    "hana_search_sap_library": { keyword: "memory" },
    "hana_search_sap_by_note": { note: "1969700" },
    "hana_search_sap_by_component": { component: "memory" },
"hana_search_sap_by_table": { table: "M_MEMORY" },
    "hana_search_sap_by_table_users": { table: "M_USERS" }
  };
  if (name === "hana_execute_query") {
    return pickedSql
      ? { sql: pickedSql }
      : { sql: "SELECT USER_NAME, USER_ID FROM SYS.USERS ORDER BY USER_NAME" };
  }
  return map[name] || {};
}

/* Extract a bare object name (SCHEMA.OBJECT or OBJECT) from a prompt. */
function extractObjectName(text) {
  var m = text.match(/[A-Z_][A-Z0-9_]*(\.[A-Z_][A-Z0-9_]*)?/i);
  if (!m) return null;
  var name = m[0].toUpperCase();
  if (text.toLowerCase().indexOf(name.toLowerCase()) < 0) return null;
  return name;
}

/* Build a read-only SELECT for a specific schema object. */
function sqlForObject(name) {
  var upper = name.toUpperCase();
  var schema = null, obj = upper;
  if (upper.indexOf(".") > 0) {
    var parts = upper.split(".");
    schema = parts[0];
    obj = parts[1];
  }
  var from = schema ? schema + "." + obj : obj;
  return "SELECT TOP 50 * FROM " + from;
}

/* ---------- map free-text prompt to a step sequence ---------- */
function chooseSteps(text) {
  var t = text.toLowerCase().trim();
  /* Greetings / chit-chat: return a special marker so runSteps can answer
     conversationally without hammering the DB with the full health sequence. */
  if (t === "hi" || t === "hello" || t === "hey" || t === "yo" || t === "how are u" || t === "how are you" || t === "how r u" || t === "u" || t === "thanks" || t === "thank you") {
    return ["__greet__"];
  }
  /* Off-topic / chatting about non-HANA subjects → polite "I can't do that".
     This must run before the keyword branches so anything with an off-topic
     word ("mom", insults, hobbies, personal questions, etc.) is stopped even
     if it also happens to contain a valid keyword like "health", "disk" or
     "show". */
  var offTopic = /\b(weather|stock|joke|poem|soccer|football|movie|movie|film|song|music|cook|cooking|recipe|pizza|fashion|shopping|love|girlfriend|boyfriend|kiss|dance|party|your mom|your mother|mommy|mother|mom|idiot|stupid|dumb|suck|ugly|hate|hates|loser|nonsense|garbage|rubbish)\b/i;
  if (offTopic.test(text)) {
    return ["__unknown__"];
  }
  /* A bare uppercase object (SYS.M_TABLE, M_BACKUP_CATALOG, _SYS_STATISTICS,
     HOST_JOBEXECUTOR_WORKER_GROUPS_BASE, M_MEMORY, etc.) → run a read-only
     SELECT on that exact object instead of a generic tool. */
pickedSql = null;
  var spec = text.match(/([A-Z_][A-Z0-9_]*\.[A-Z_][A-Z0-9_]*|[A-Z_][A-Z0-9_]{3,})/);
  if (spec) {
    var word = spec[1].toUpperCase();
    /* Only treat it as a real HANA object when it clearly looks like one
       (dotted schema.object, contains an underscore, or a SYS/M_ prefix). This
       avoids misreading ordinary English words like "SHOW" or "WHAT". */
    var looksLikeObject =
      word.indexOf(".") > 0 ||
      word.indexOf("_") >= 0 ||
      word.indexOf("SYS") === 0 ||
      word.indexOf("M_") === 0;
    if (looksLikeObject && word.indexOf("FROM") < 0 && word.indexOf("SELECT") < 0 && word.indexOf("WHERE") < 0) {
      pickedSql = sqlForObject(word);
      return ["hana_execute_query"];
    }
  }
  if ((t.indexOf("view") >= 0 && (t.indexOf("show") >= 0 || t.indexOf("list") >= 0 || t.indexOf("name") >= 0 || t.indexOf("all") >= 0)) && t.indexOf("describe") < 0) {
    if (t.indexOf("find") >= 0 || t.indexOf("search") >= 0) return ["hana_search_views"];
    return ["hana_discover_monitoring_views"];
  }
  if (t.indexOf("blocked") >= 0 || t.indexOf("lock") >= 0) return ["hana_blocked_transactions", "hana_connections"];
  if (t.indexOf("disk") >= 0 || t.indexOf("storage") >= 0 || t.indexOf("volumes") >= 0 || t.indexOf("volume") >= 0) return ["hana_disk"];
  if (t.indexOf("memory") >= 0 || t.indexOf("ram") >= 0) return ["hana_memory"];
  if (t.indexOf("cpu") >= 0 || t.indexOf("core") >= 0) return ["hana_cpu"];
  if (t.indexOf("connect") >= 0) return ["hana_connections"];
  if (t.indexOf("expensive") >= 0 || t.indexOf("slow") >= 0) return ["hana_expensive_statements"];
  if (t.indexOf("replic") >= 0) return ["hana_replication"];
  if (t.indexOf("backup") >= 0) return ["hana_backup_status"];
  if (t.indexOf("user") >= 0) return ["hana_execute_query"];
  if (t.indexOf("table") >= 0 || t.indexOf("tables") >= 0) return ["hana_table_sizes"];
  if (t.indexOf("view") >= 0) return ["hana_search_views"];
  if (t.indexOf("error") >= 0 || t.indexOf("issue") >= 0 || t.indexOf("problem") >= 0) return ["hana_trace_files", "hana_expensive_statements"];
  if (t.indexOf("log") >= 0 || t.indexOf("trace") >= 0) return ["hana_trace_files"];
  if (t.indexOf("service") >= 0) return ["hana_services"];
  if (t.indexOf("health") >= 0 || t.indexOf("status") >= 0 || t.indexOf("healthy") >= 0) return ["hana_system_status", "hana_services", "hana_memory", "hana_cpu", "hana_connections", "hana_disk", "hana_backup_status", "hana_blocked_transactions"];
  if (t) return ["__unknown__"];
  return ["__greet__"];
}

/* ---------- open a conversation ---------- */
function openConv(id) {
  var conv = getConv(id);
  if (!conv) return;
  currentConvId = id;
  activeConv = conv;
  renderSidebar();
  if (conv.messages.length) renderThread(conv);
  else showWelcome();
}

/* ---------- form submit ---------- */
$("chat-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var text = $("chat-input").value.trim();
  if (!text || busy) return;
  $("chat-input").value = "";
  startThread(text, chooseSteps(text));
});
$("chat-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 140) + "px";
});
$("chat-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    var text = this.value.trim();
    if (text && !busy) {
      this.value = "";
      startThread(text, chooseSteps(text));
    }
  }
});

/* ---------- live connection indicator (polls /api/system/status) ---------- */
function pollConnection() {
  api("/api/system/status").then(function (s) {
    var online = s && s.status === "ONLINE";
    var dot = $("chat-ctx-dot");
    dot.className = "chat-head-dot " + (online ? "online" : "error");
    var db = s.database || "HXE";
    var user = s.user || "MCP_MONITOR";
    $("chat-ctx-meta").textContent = online ? (db + " · " + user + " · read-only") : "Reconnecting…";
    $("chat-error-banner").hidden = online;
    if (online) updateTopbar(s);
  }).catch(function () {
    $("chat-ctx-dot").className = "chat-head-dot reconnect";
    $("chat-ctx-meta").textContent = "Reconnecting…";
    $("chat-error-banner").hidden = false;
    $("chat-error-text").textContent = "Gateway unavailable — cannot reach SAP HANA. Monitoring tools may still work when connection is restored.";
  });
}
setInterval(pollConnection, 15000);

/* ---------- chat init ---------- */
(function chatInit() {
  var convs = loadConvs();
  if (convs.length) { currentConvId = convs[0].id; activeConv = convs[0]; renderSidebar(); }
  else { renderSidebar(); }
})();

/* ---------- suggested prompt cards (onboarding) ---------- */
$("chat-prompt-grid").addEventListener("click", function (e) {
  var card = e.target.closest(".chat-prompt-card");
  if (!card || busy) return;
  startThread(card.dataset.prompt, chooseSteps(card.dataset.prompt));
});

/* ---------- init ---------- */
(function initView() {
  var last = "dashboard";
  try { last = localStorage.getItem(LAST_VIEW_KEY) || "dashboard"; } catch (e) {}
  if (VIEWS.indexOf(last) < 0) last = "dashboard";
  show(last);
})();
renderSqlHistory();
pollConnection();
setInterval(loadDashboard, 30000);
