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
var VIEWS = ["dashboard", "sql", "chat"];
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
  if (view === "dashboard") loadDashboard();
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
var brandLink = $("brand-link");
if (brandLink) {
  brandLink.addEventListener("click", function (e) {
    e.preventDefault();
    show("dashboard");
  });
}

/* ---------- top status bar ---------- */
function updateTopbar(sys) {
  /* reserved for future connection banner use */
}
function tickClock() {
  var el = $("topbar-clock");
  if (!el) return;
  var now = new Date();
  el.textContent = now.toLocaleString(undefined, {
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
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#374151" stroke-width="' + sw + '"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '"' +
    ' stroke-dasharray="' + circ.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"' +
    ' stroke-linecap="round" transform="rotate(-90 ' + cx + ' ' + cy + ')" style="transition:stroke-dashoffset .6s ease,stroke .3s"/>' +
    '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#f3f4f6" font-size="18" font-weight="700" font-family="var(--font-mono)">' + pctVal.toFixed(0) + '%</text>';
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
    return "<tr>" + cols.map(function (c) { return "<td>" + esc(r[c]) + "</td>"; }).join("");
  }).join("");
  return rows;
}

/* ---------- dashboard sidebar ---------- */
/* Sidebar removed - quick actions not needed */

