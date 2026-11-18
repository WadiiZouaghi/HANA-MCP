/* ===== Reusable UI components: states, badges, key/value lists, tables, charts ===== */

/* ---------- loading / empty / error states ---------- */
function stateHTML(kind, message, detail) {
  var icons = { loading: "", empty: icon("inbox"), error: icon("alert-triangle"), unavailable: icon("info") };
  return '<div class="state state--' + kind + '">' +
    (kind === "loading" ? '<span class="spinner"></span>' : icons[kind] || "") +
    "<div>" + esc(message) + "</div>" +
    (detail ? '<div class="state__detail">' + esc(detail) + "</div>" : "") +
    "</div>";
}
function setState(el, kind, message, detail) {
  if (el) el.innerHTML = stateHTML(kind, message, detail);
}

/* ---------- badges ---------- */
function badge(kind, label, withDot) {
  return '<span class="badge badge--' + kind + '">' +
    (withDot === false ? "" : '<span class="badge__dot"></span>') + esc(label) + "</span>";
}

/* ---------- key / value list ----------
   rows: [[key, value, {mono, html}]]; null/undefined values render as "Unavailable"
   so missing data is never confused with a real zero. */
function kvHTML(rows) {
  return rows.map(function (row) {
    var opts = row[2] || {};
    var value = row[1];
    var missing = value === null || value === undefined || value === "";
    var body = missing ? '<span class="muted">Unavailable</span>' : (opts.html ? value : esc(value));
    return '<div class="kv__row"><span class="kv__key">' + esc(row[0]) + '</span>' +
      '<span class="kv__val' + (opts.mono && !missing ? " mono" : "") + '">' + body + "</span></div>";
  }).join("");
}

/* ---------- data table with optional search + sorting ----------
   opts: {
     columns: [{key, label, render(row) -> html, value(row) -> sortable, align, mono, width}],
     rows: [...], search: bool, searchPlaceholder, empty: "message",
     pageSize, expand(row) -> html (click a row to expand), initialSort: {key, dir}
   } */
function createTable(container, opts) {
  var state = {
    rows: opts.rows || [],
    query: "",
    sortKey: opts.initialSort ? opts.initialSort.key : null,
    sortDir: opts.initialSort ? opts.initialSort.dir : 1,
    shown: opts.pageSize || 100,
    expanded: {}
  };
  var columns = opts.columns;

  function cellValue(col, row) {
    if (col.value) return col.value(row);
    return row[col.key];
  }
  function cellText(col, row) {
    var v = cellValue(col, row);
    return v === null || v === undefined ? "" : String(v);
  }
  function filtered() {
    var rows = state.rows;
    if (state.query) {
      var q = state.query.toLowerCase();
      rows = rows.filter(function (row) {
        return columns.some(function (col) { return cellText(col, row).toLowerCase().indexOf(q) >= 0; });
      });
    }
    if (state.sortKey) {
      var col = columns.filter(function (c) { return c.key === state.sortKey; })[0];
      if (col) {
        rows = rows.slice().sort(function (a, b) {
          var x = cellValue(col, a), y = cellValue(col, b);
          var nx = Number(x), ny = Number(y);
          var bothNumeric = x !== "" && y !== "" && x != null && y != null && isFinite(nx) && isFinite(ny);
          if (bothNumeric) return (nx - ny) * state.sortDir;
          return String(x == null ? "" : x).localeCompare(String(y == null ? "" : y)) * state.sortDir;
        });
      }
    }
    return rows;
  }

  function render() {
    var rows = filtered();
    var html = "";
    if (opts.search) {
      html += '<div class="table-tools"><div class="input-icon">' + icon("search") +
        '<input class="input input--sm" data-role="search" placeholder="' + escAttr(opts.searchPlaceholder || "Filter…") +
        '" value="' + escAttr(state.query) + '" spellcheck="false" /></div>' +
        '<span class="table-count">' + rows.length + (rows.length === state.rows.length ? "" : " of " + state.rows.length) +
        (state.rows.length === 1 ? " row" : " rows") + "</span></div>";
    }
    if (!state.rows.length) {
      html += stateHTML("empty", opts.empty || "No data available.");
      container.innerHTML = html;
      bind();
      return;
    }
    html += '<div class="table-wrap"><table class="data-table"><thead><tr>';
    columns.forEach(function (col) {
      var sorted = state.sortKey === col.key;
      html += '<th data-key="' + escAttr(col.key) + '" class="' + (col.sortable === false ? "" : "is-sortable") +
        (col.align === "right" ? " ta-right" : "") + '"' + (col.width ? ' style="width:' + col.width + '"' : "") + ">" +
        esc(col.label) + (sorted ? '<span class="sort-ind">' + (state.sortDir > 0 ? "▲" : "▼") + "</span>" : "") + "</th>";
    });
    html += "</tr></thead><tbody>";
    if (!rows.length) {
      html += '<tr><td class="table-empty" colspan="' + columns.length + '">No rows match the filter.</td></tr>';
    }
    rows.slice(0, state.shown).forEach(function (row, index) {
      var id = opts.rowId ? opts.rowId(row) : index;
      var open = !!state.expanded[id];
      html += '<tr data-row="' + escAttr(id) + '"' + (opts.expand ? ' class="is-expandable' + (open ? " is-open" : "") + '"' : "") + ">";
      columns.forEach(function (col) {
        var content = col.render ? col.render(row) : esc(cellText(col, row));
        if (content === "" || content === null || content === undefined) content = '<span class="muted">—</span>';
        html += '<td class="' + (col.mono ? "mono" : "") + (col.align === "right" ? " ta-right" : "") + '">' + content + "</td>";
      });
      html += "</tr>";
      if (opts.expand && open) {
        html += '<tr class="row-detail"><td colspan="' + columns.length + '">' + opts.expand(row) + "</td></tr>";
      }
    });
    html += "</tbody></table></div>";
    if (rows.length > state.shown) {
      html += '<div class="table-more"><button class="btn btn--secondary btn--sm" data-role="more" type="button">Show more (' +
        (rows.length - state.shown) + " remaining)</button></div>";
    }
    container.innerHTML = html;
    bind();
  }

  function bind() {
    var search = container.querySelector('[data-role="search"]');
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        var pos = search.selectionStart;
        render();
        var again = container.querySelector('[data-role="search"]');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      });
    }
    container.querySelectorAll("th.is-sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (state.sortKey === key) state.sortDir = -state.sortDir;
        else { state.sortKey = key; state.sortDir = 1; }
        render();
      });
    });
    var more = container.querySelector('[data-role="more"]');
    if (more) more.addEventListener("click", function () { state.shown += opts.pageSize || 100; render(); });
    if (opts.expand) {
      container.querySelectorAll("tr.is-expandable").forEach(function (tr) {
        tr.addEventListener("click", function (e) {
          if (e.target.closest("button, a, input")) return;
          var id = tr.getAttribute("data-row");
          state.expanded[id] = !state.expanded[id];
          render();
        });
      });
    }
    if (opts.onRender) opts.onRender(container);
  }

  render();
  return {
    setRows: function (rows) { state.rows = rows || []; render(); },
    setQuery: function (q) { state.query = q || ""; render(); }
  };
}

/* Build table columns straight from result rows (for raw tool output). */
function columnsFromRows(rows, limit) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).slice(0, limit || 12).map(function (key) {
    return {
      key: key,
      label: key,
      mono: true,
      render: function (row) {
        var v = row[key];
        if (v === null || v === undefined) return "";
        var text = String(v);
        return '<span title="' + escAttr(text) + '">' + esc(text.length > 120 ? text.slice(0, 117) + "…" : text) + "</span>";
      }
    };
  });
}

/* ---------- line / area chart (SVG, no dependencies) ----------
   points: [{t: Date, v: number}], opts: {color: css var name, unit, min, max, decimals}
   Draws nothing but an empty state when there are fewer than two points. */
var CHARTS = [];
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function lineChart(el, points, opts) {
  if (!el) return;
  var entry = null;
  for (var i = 0; i < CHARTS.length; i++) if (CHARTS[i].el === el) entry = CHARTS[i];
  if (!entry) { entry = { el: el }; CHARTS.push(entry); }
  entry.points = points;
  entry.opts = opts || {};
  drawChart(entry);
}
function drawChart(entry) {
  var el = entry.el, opts = entry.opts;
  var points = (entry.points || []).filter(function (p) { return p.t && p.v != null && isFinite(p.v); });
  if (points.length < 2) {
    el.innerHTML = stateHTML("empty",
      opts.emptyMessage || "Not enough history yet.",
      "Snapshots are recorded each time the overview refreshes while this app is open.");
    return;
  }
  var width = el.clientWidth;
  if (!width) return; /* hidden view: redrawn when shown */
  var height = opts.height || 220;
  var pad = { top: 12, right: 14, bottom: 26, left: 44 };
  var color = cssVar(opts.color || "--color-accent");
  var grid = cssVar("--color-border");
  var text = cssVar("--color-text-tertiary");
  var unit = opts.unit || "";
  var decimals = opts.decimals != null ? opts.decimals : 0;

  var values = points.map(function (p) { return p.v; });
  var lo = opts.min != null ? opts.min : Math.min.apply(null, values);
  var hi = opts.max != null ? opts.max : Math.max.apply(null, values);
  if (opts.min == null || opts.max == null) {
    var span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
    if (opts.min == null) lo = Math.max(0, lo - span * 0.15);
    if (opts.max == null) hi = hi + span * 0.15;
    if (!decimals) { lo = Math.floor(lo); hi = Math.ceil(hi); if (hi === lo) hi = lo + 1; }
  }
  /* Narrow ranges need more decimals, or neighbouring axis labels repeat. */
  var step = (hi - lo) / 4;
  var axisDecimals = decimals;
  while (axisDecimals < 3 && step < Math.pow(10, -axisDecimals) * 0.99) axisDecimals++;
  /* Leave room for the widest axis label. */
  var widest = Math.max(lo.toFixed(axisDecimals).length, hi.toFixed(axisDecimals).length) + unit.length;
  pad.left = Math.max(pad.left, 14 + widest * 7);
  var t0 = points[0].t.getTime(), t1 = points[points.length - 1].t.getTime();
  var tSpan = t1 - t0 || 1;
  var innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
  function x(t) { return pad.left + (t - t0) / tSpan * innerW; }
  function y(v) { return pad.top + (1 - (v - lo) / (hi - lo)) * innerH; }

  var id = "g" + Math.random().toString(36).slice(2, 9);
  var svg = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '" role="img">';
  svg += '<defs><linearGradient id="' + id + '" x1="0" x2="0" y1="0" y2="1">' +
    '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
    '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
  var ticks = 4;
  for (var i = 0; i <= ticks; i++) {
    var v = lo + (hi - lo) * i / ticks;
    var yy = y(v).toFixed(1);
    svg += '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + yy + '" y2="' + yy +
      '" stroke="' + grid + '" stroke-width="1" stroke-dasharray="' + (i === 0 ? "0" : "3 4") + '" opacity="0.7"/>';
    svg += '<text x="' + (pad.left - 8) + '" y="' + (Number(yy) + 4) + '" text-anchor="end" fill="' + text +
      '" font-size="11" font-family="JetBrains Mono, monospace">' + v.toFixed(axisDecimals) + esc(unit) + "</text>";
  }
  var xTicks = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
  var longSpan = tSpan > 20 * 3600 * 1000;
  for (var j = 0; j <= xTicks; j++) {
    var tt = t0 + tSpan * j / xTicks;
    var d = new Date(tt);
    var label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    if (longSpan && j === 0) label = d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + label;
    svg += '<text x="' + x(tt).toFixed(1) + '" y="' + (height - 8) + '" text-anchor="' +
      (j === 0 ? "start" : j === xTicks ? "end" : "middle") + '" fill="' + text +
      '" font-size="11" font-family="JetBrains Mono, monospace">' + esc(label) + "</text>";
  }
  var line = points.map(function (p, k) {
    return (k ? "L" : "M") + x(p.t.getTime()).toFixed(1) + " " + y(p.v).toFixed(1);
  }).join(" ");
  var base = (pad.top + innerH).toFixed(1);
  svg += '<path d="' + line + " L" + x(t1).toFixed(1) + " " + base + " L" + x(t0).toFixed(1) + " " + base +
    ' Z" fill="url(#' + id + ')"/>';
  svg += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  svg += '<line class="chart__cursor" y1="' + pad.top + '" y2="' + base + '" stroke="' + color + '" stroke-width="1" opacity="0"/>';
  svg += '<circle class="chart__dot" r="4" fill="' + color + '" stroke="' + cssVar("--color-bg-secondary") + '" stroke-width="2" opacity="0"/>';
  svg += "</svg>";
  el.innerHTML = svg + '<div class="chart__tip" hidden></div>';

  var svgEl = el.querySelector("svg");
  var tip = el.querySelector(".chart__tip");
  var cursor = el.querySelector(".chart__cursor");
  var dot = el.querySelector(".chart__dot");
  function hide() { tip.hidden = true; cursor.setAttribute("opacity", "0"); dot.setAttribute("opacity", "0"); }
  svgEl.addEventListener("mousemove", function (e) {
    var rect = svgEl.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var best = null, bestDist = Infinity;
    points.forEach(function (p) {
      var dist = Math.abs(x(p.t.getTime()) - mx);
      if (dist < bestDist) { bestDist = dist; best = p; }
    });
    if (!best) return hide();
    var px = x(best.t.getTime()), py = y(best.v);
    cursor.setAttribute("x1", px); cursor.setAttribute("x2", px); cursor.setAttribute("opacity", "0.5");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("opacity", "1");
    tip.innerHTML = '<span class="chart__tip-value">' + esc(best.v.toFixed(decimals || (unit === "%" ? 1 : 0)) + unit) +
      '</span><span class="chart__tip-time">' + esc(best.t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })) + "</span>";
    tip.hidden = false;
    var left = px + 12;
    if (left + tip.offsetWidth > width) left = px - tip.offsetWidth - 12;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = Math.max(0, py - 44) + "px";
  });
  svgEl.addEventListener("mouseleave", hide);
}
var chartResizeTimer = null;
function redrawCharts() {
  CHARTS.forEach(function (entry) {
    if (entry.points && entry.el.offsetParent !== null) drawChart(entry);
  });
}
window.addEventListener("resize", function () {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(redrawCharts, 120);
});

/* History points -> chart series */
function historySeries(points, field) {
  return (points || []).map(function (p) {
    return { t: parseTime(p.captured_at), v: p[field] == null ? null : Number(p[field]) };
  });
}
