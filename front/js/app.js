/* ===== HANA Monitor — core helpers, navigation, theme, top bar ===== */
var $ = function (id) { return document.getElementById(id); };

/* Robust api helper: always resolves to {error} on failure instead of
   rejecting, so callers can render a clean error state. */
var api = function (path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () {
      return { error: "Non-JSON response (" + r.status + ")", network: true };
    });
  }).catch(function (e) {
    return { error: (e && e.message) || "Network error", network: true };
  });
};

/* Run an MCP tool through the REST API. `source` labels the call in the
   execution history (overview, resources, tools, console ...). */
function runTool(name, params, source, background) {
  var headers = { "Content-Type": "application/json", "X-Source": source || "dashboard" };
  /* Automatic polls are not user activity, so they stay out of the history. */
  if (background) headers["X-Background"] = "1";
  return api("/api/tool/" + encodeURIComponent(name), {
    method: "POST",
    headers: headers,
    body: JSON.stringify(params || {})
  });
}

function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, function (c) {
    return "&#" + c.charCodeAt(0) + ";";
  });
}
/* bound escape for attribute/full-text safety */
function escAttr(v) { return esc(v); }

/* Render markdown to HTML using the loaded `marked` lib (fallback: plain text) */
function renderMarkdown(src) {
  if (typeof marked === "undefined" || !marked || typeof marked.parse !== "function") {
    return '<div style="white-space:pre-wrap">' + esc(src) + "</div>";
  }
  try {
    var html = marked.parse(src || "");
    return html.replace(/<table(\s[^>]*)?>([\s\S]*?)<\/table>/gi, function (_, attributes, body) {
      return '<div class="markdown-table-wrap"><table' + (attributes || "") + '>' + body + '</table></div>';
    });
  } catch (e) {
    return '<div style="white-space:pre-wrap">' + esc(src) + "</div>";
  }
}

/* ---------- navigation ---------- */
var VIEW_META = {
  dashboard:   { title: "Overview",          section: "Workspace" },
  performance: { title: "Performance",       section: "Workspace" },
  resources:   { title: "Resources",         section: "Workspace" },
  alerts:      { title: "Alerts",            section: "Workspace" },
  schema:      { title: "Schema Explorer",   section: "Workspace" },
  chat:        { title: "AI Assistant",      section: "AI & MCP" },
  tools:       { title: "MCP Tools",         section: "AI & MCP" },
  sql:         { title: "Query Console",     section: "AI & MCP" },
  history:     { title: "Execution History", section: "AI & MCP" },
  connections: { title: "Connections",       section: "System" },
  settings:    { title: "Settings",          section: "System" }
};
var VIEWS = Object.keys(VIEW_META);
var LAST_VIEW_KEY = "hana_last_view";
var currentView = "dashboard";
/* Each page script registers a loader: PAGE_LOADERS[view] = function (force) {} */
var PAGE_LOADERS = {};

/* Deep links: #overview, #performance, #assistant, #console ... */
var HASH_BY_VIEW = { dashboard: "overview", chat: "assistant", sql: "console" };
/* Extra path segments select an item: #tools/hana_memory, #schema/SYS/USERS */
function hashArgs() {
  return String(location.hash || "").replace(/^#/, "").split("/").slice(1).map(function (part) {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  });
}
function viewFromHash() {
  var hash = String(location.hash || "").replace(/^#/, "").split("/")[0].toLowerCase();
  if (!hash) return null;
  for (var view in HASH_BY_VIEW) if (HASH_BY_VIEW[view] === hash) return view;
  return VIEW_META[hash] ? hash : null;
}
window.addEventListener("hashchange", function () {
  var view = viewFromHash();
  if (view && view !== currentView) show(view);
});

function show(view) {
  if (!VIEW_META[view]) view = "dashboard";
  currentView = view;
  VIEWS.forEach(function (v) {
    var el = $("view-" + v);
    if (el) el.classList.toggle("active", v === view);
  });
  document.querySelectorAll(".nav-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.view === view);
  });
  $("topbar-page").textContent = VIEW_META[view].title;
  $("topbar-crumb").textContent = VIEW_META[view].section;
  document.title = VIEW_META[view].title + " · HANA Monitor";
  document.body.classList.remove("sidebar-open");
  try { localStorage.setItem(LAST_VIEW_KEY, view); } catch (e) {}
  try {
    if (viewFromHash() !== view) history.replaceState(null, "", "#" + (HASH_BY_VIEW[view] || view));
  } catch (e) {}
  if (typeof PAGE_LOADERS[view] === "function") PAGE_LOADERS[view](false);
  if (typeof window.toggleConnectionPoll === "function") {
    window.toggleConnectionPoll(view === "chat");
  }
}
document.querySelectorAll(".nav-item").forEach(function (el) {
  el.addEventListener("click", function (e) {
    e.preventDefault();
    show(el.dataset.view);
  });
});
$("brand-link").addEventListener("click", function (e) {
  e.preventDefault();
  show("dashboard");
});
document.addEventListener("click", function (e) {
  var go = e.target.closest("[data-goto]");
  if (go) { e.preventDefault(); show(go.getAttribute("data-goto")); return; }
  var refresh = e.target.closest("[data-refresh]");
  if (refresh) { e.preventDefault(); refreshCurrentPage(); }
});

/* ---------- sidebar (collapsible on desktop, drawer on small screens) ---------- */
function isNarrow() { return window.matchMedia("(max-width: 900px)").matches; }
$("sidebar-toggle").addEventListener("click", function () {
  if (isNarrow()) {
    document.body.classList.toggle("sidebar-open");
    return;
  }
  var collapsed = document.documentElement.classList.toggle("sidebar-collapsed");
  try { localStorage.setItem("hana_sidebar_collapsed", collapsed ? "1" : "0"); } catch (e) {}
  window.dispatchEvent(new Event("resize"));
});
$("sidebar-scrim").addEventListener("click", function () {
  document.body.classList.remove("sidebar-open");
});

/* ---------- theme ---------- */
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}
function applyTheme(theme) {
  theme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("hana_theme", theme); } catch (e) {}
  syncThemeControls();
  /* Charts read colours from CSS variables, so redraw them. */
  window.dispatchEvent(new Event("resize"));
}
function syncThemeControls() {
  var theme = currentTheme();
  var toggle = $("theme-toggle");
  /* Show the theme you would switch TO. */
  toggle.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  toggle.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  document.querySelectorAll("[data-theme-value]").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-theme-value") === theme);
  });
}
$("theme-toggle").addEventListener("click", function () {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});
document.querySelectorAll("[data-theme-value]").forEach(function (b) {
  b.addEventListener("click", function () { applyTheme(b.getAttribute("data-theme-value")); });
});
syncThemeControls();

/* ---------- connection state (single source for every indicator) ---------- */
var CONNECTION = { state: "unknown", system: null };
var CONNECTION_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting",
  unknown: "Unknown"
};
var CONNECTION_DOT = { connected: "online", disconnected: "error", reconnecting: "reconnect", unknown: "" };
var CONNECTION_BADGE = { connected: "success", disconnected: "critical", reconnecting: "warning", unknown: "neutral" };

function setConnection(state, sys) {
  CONNECTION.state = state;
  if (sys) CONNECTION.system = sys;
  var label = CONNECTION_LABELS[state];
  var dot = "status-dot " + CONNECTION_DOT[state];
  var db = CONNECTION.system && CONNECTION.system.database;

  $("conn-dot").className = dot;
  $("conn-label").textContent = label;
  $("conn-db").textContent = db ? "SAP HANA · " + db : "SAP HANA";
  $("conn-badge").className = "conn-status is-" + state;

  $("sidebar-conn-dot").className = dot;
  $("sidebar-conn-state").textContent = label;
  $("sidebar-conn-db").textContent = db || "";

  var badge = $("ov-conn-badge");
  if (badge) {
    badge.className = "badge badge--" + CONNECTION_BADGE[state];
    badge.innerHTML = '<span class="badge__dot"></span>' + esc(label);
  }
  var chatDb = $("chat-db-badge");
  if (chatDb) {
    chatDb.className = "badge badge--" + CONNECTION_BADGE[state];
    chatDb.innerHTML = '<span class="badge__dot"></span>Database ' + esc(label.toLowerCase());
  }
}
/* Kept for the scripts that report status from their own requests. */
function setStatus(online, sys) {
  setConnection(online ? "connected" : "disconnected", sys);
}
function updateTopbar(sys) {
  if (sys && sys.database) setConnection(CONNECTION.state, sys);
}

function refreshConnection() {
  return api("/api/system/status").then(function (s) {
    if (s && s.status === "ONLINE") {
      setConnection("connected", s);
    } else if (s && s.network) {
      /* The backend itself did not answer: retrying, not a database verdict. */
      setConnection(CONNECTION.state === "unknown" ? "unknown" : "reconnecting");
    } else {
      setConnection("disconnected");
    }
    return s;
  });
}
setConnection("unknown");
refreshConnection();
setInterval(function () {
  if (document.visibilityState === "visible") refreshConnection();
}, 30000);

/* ---------- last refresh + manual refresh ---------- */
function markUpdated() {
  var now = new Date();
  $("topbar-updated").textContent = "Last updated: " + now.toLocaleTimeString([], { hour12: false });
  $("topbar-updated").title = "Last successful data refresh: " + now.toLocaleString();
}
function refreshCurrentPage() {
  var btn = $("refresh-btn");
  btn.classList.add("is-spinning");
  setTimeout(function () { btn.classList.remove("is-spinning"); }, 700);
  refreshConnection();
  if (typeof PAGE_LOADERS[currentView] === "function") PAGE_LOADERS[currentView](true);
}
$("refresh-btn").addEventListener("click", refreshCurrentPage);

/* ---------- formatting helpers ---------- */
function fmtBytes(n) {
  n = Number(n);
  if (!isFinite(n)) return "—";
  var u = ["B", "KB", "MB", "GB", "TB"];
  var i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}
function pct(v) { return (Number(v) || 0).toFixed(0) + "%"; }
function fmtNumber(v) {
  var n = Number(v);
  return isFinite(n) ? n.toLocaleString() : "—";
}
function fmtDuration(ms) {
  var n = Number(ms);
  if (!isFinite(n)) return "—";
  if (n < 1000) return n.toFixed(n < 10 ? 1 : 0) + " ms";
  return (n / 1000).toFixed(2) + " s";
}
/* Parse backend timestamps (ISO, or HANA "YYYY-MM-DD HH:MM:SS.ffffff"). */
function parseTime(value) {
  if (!value) return null;
  var text = String(value);
  var d = new Date(text.indexOf("T") < 0 ? text.replace(" ", "T") : text);
  if (isNaN(d.getTime())) d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}
function fmtTime(value) {
  var d = parseTime(value);
  if (!d) return value ? String(value) : "—";
  var today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour12: false })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtAgo(value) {
  var d = parseTime(value);
  if (!d) return "—";
  var s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function gaugeColor(p) {
  p = Number(p) || 0;
  if (p >= 85) return "var(--color-error)";
  if (p >= 70) return "var(--color-warning)";
  return "var(--color-success)";
}
function kpiClass(p) {
  p = Number(p) || 0;
  if (p >= 85) return "bad";
  if (p >= 70) return "warn";
  return "good";
}
function calcDiskPct(diskRows) {
  if (!Array.isArray(diskRows) || !diskRows.length) return null;
  var used = 0, total = 0;
  diskRows.forEach(function (d) {
    var rowUsed = Number(d.USED_SIZE != null ? d.USED_SIZE : (d.USED || 0));
    var rowTotal = Number(
      d.FILE_SIZE != null ? d.FILE_SIZE :
      (d.TOTAL_SIZE != null ? d.TOTAL_SIZE :
      (d.SIZE != null ? d.SIZE : (d.ALLOCATED_SIZE || 0)))
    );
    if (rowUsed < 0 || rowTotal <= 0) return;
    used += rowUsed;
    total += rowTotal;
  });
  return total ? (used / total * 100) : null;
}
function svcStatusPill(status) {
  var s = String(status || "").toUpperCase();
  var cls = s === "YES" || s === "ACTIVE" || s === "STARTED" ? "success" : (s === "NO" || s === "STOPPED" ? "critical" : "warning");
  var label = s === "YES" ? "Active" : (s === "NO" ? "Inactive" : (s || "Unknown"));
  return '<span class="badge badge--' + cls + '"><span class="badge__dot"></span>' + esc(label) + "</span>";
}
/* Generic table renderer (the Query Console overrides this with a sortable one). */
function renderTable(rows, bodyEl, theadEl) {
  if (!rows || !rows.length) {
    theadEl.innerHTML = "";
    bodyEl.innerHTML = '<tr><td class="table-empty">No data</td></tr>';
    return;
  }
  var cols = Object.keys(rows[0]);
  theadEl.innerHTML = "<tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
  bodyEl.innerHTML = rows.map(function (r) {
    return "<tr>" + cols.map(function (c) { return "<td>" + esc(r[c]) + "</td>"; }).join("") + "</tr>";
  }).join("");
  return rows;
}
