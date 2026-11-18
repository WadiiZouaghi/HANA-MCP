/* ---------- OVERVIEW ---------- */
function overviewActive() {
  var view = $("view-dashboard");
  return !!view && view.classList.contains("active");
}

function setKpi(id, value, sub, tone) {
  var val = $("kpi-" + id + "-val");
  var subEl = $("kpi-" + id + "-sub");
  var dot = $("kpi-" + id + "-dot");
  if (val) {
    val.textContent = value === null || value === undefined ? "—" : value;
    val.className = "kpi__value" + (value === null || value === undefined ? " is-unavailable" : "");
  }
  if (subEl) subEl.textContent = sub || "";
  if (dot) dot.className = "status-dot " + ({ success: "online", warning: "reconnect", critical: "error" }[tone] || "");
}

function renderServicesTable(svc) {
  var body = $("svc-body");
  if (!Array.isArray(svc)) {
    body.innerHTML = '<tr><td colspan="4" class="table-empty">Service information is unavailable' +
      (svc && svc.error ? ": " + esc(svc.error) : ".") + "</td></tr>";
    return;
  }
  if (!svc.length) {
    body.innerHTML = '<tr><td colspan="4" class="table-empty">No services were reported.</td></tr>';
    return;
  }
  body.innerHTML = svc.map(function (s) {
    return '<tr><td class="mono">' + esc(s.SERVICE_NAME || s.NAME || "—") + "</td>" +
      '<td class="mono">' + esc(s.HOST != null ? s.HOST : "—") + "</td>" +
      '<td class="mono">' + esc(s.PORT != null ? s.PORT : "—") + "</td>" +
      "<td>" + svcStatusPill(s.ACTIVE_STATUS || s.STATUS) + "</td></tr>";
  }).join("");
}

function renderActivity(el, payload) {
  if (!el) return;
  if (!payload || payload.error) {
    setState(el, "error", "Activity is unavailable.", payload && payload.error);
    return;
  }
  var items = payload.executions || [];
  if (!items.length) {
    setState(el, "empty", "No tool executions recorded yet.", "Activity appears here when the assistant, the console or a page runs an MCP tool.");
    return;
  }
  el.innerHTML = items.slice(0, 8).map(function (item) {
    var ok = item.status === "success";
    return '<div class="activity__item">' +
      '<span class="activity__icon activity__icon--' + (ok ? "success" : "critical") + '">' + icon(ok ? "check-circle" : "x-circle") + "</span>" +
      '<div class="activity__body"><div class="activity__title mono">' + esc(item.tool) + "</div>" +
      '<div class="activity__meta">' + esc(ok ? "Completed" : "Failed") + " · " + esc(item.source) + " · " + esc(fmtDuration(item.duration_ms)) + "</div></div>" +
      '<span class="activity__time mono" title="' + escAttr(item.timestamp) + '">' + esc(fmtAgo(item.timestamp)) + "</span></div>";
  }).join("");
}

/* Summarises the alerts loaded by the Alerts page (monitor + HANA statistics). */
function renderOverviewAlerts() {
  var area = $("alerts-area");
  if (!area || area.querySelector(".banner--critical[data-fatal]")) return;
  var items = (typeof ALERTS !== "undefined" && ALERTS.items) || [];
  var active = items.filter(function (a) { return !a.acknowledged_at && a.severity !== "info"; });
  if (!active.length) { area.innerHTML = ""; return; }
  var critical = active.some(function (a) { return a.severity === "critical"; });
  area.innerHTML = '<div class="banner banner--' + (critical ? "critical" : "warning") + '">' +
    '<span class="banner__icon">' + icon("alert-triangle") + "</span><span>" +
    esc(active.length + " active alert" + (active.length === 1 ? "" : "s") + ": " +
      active.slice(0, 3).map(function (a) { return a.title; }).join(" · ") + (active.length > 3 ? " …" : "")) +
    '</span><a class="link" href="#" data-goto="alerts">Review alerts</a></div>';
}

function loadDashboard(force) {
  /* Called on a timer as well: only refresh while the overview is visible. */
  if (force !== true && !overviewActive()) return;

  Promise.all([
    api("/api/dashboard"),
    api("/api/history?minutes=60"),
    api("/api/alerts/locks"),
    api("/api/executions?limit=8")
  ]).then(function (results) {
    var dash = results[0], history = results[1], locks = results[2], activity = results[3];
    if (dash.error) throw new Error(dash.error);

    var sys = dash.system || {};
    var online = sys.status === "ONLINE";
    setStatus(online, online ? sys : null);

    /* Database status */
    if (online) {
      setKpi("db", "Online", (sys.database || "Database") + (sys.host ? " · " + sys.host : ""), "success");
    } else {
      setKpi("db", "Offline", sys.error ? String(sys.error).slice(0, 80) : "Database is not reachable", "critical");
    }

    /* Services */
    var svc = dash.health && dash.health.services;
    if (Array.isArray(svc) && svc.length) {
      var up = svc.filter(function (s) { return String(s.ACTIVE_STATUS || "").toUpperCase() === "YES"; }).length;
      setKpi("svc", up + " / " + svc.length, up === svc.length ? "All services active" : (svc.length - up) + " not active", up === svc.length ? "success" : "critical");
    } else {
      setKpi("svc", null, "Unavailable", "");
    }
    renderServicesTable(svc);

    /* Memory — a zero total means the metric could not be read, not 0% used. */
    var m = dash.metrics || {};
    var mem = m.memory || {};
    var bar = $("kpi-mem-bar");
    if (online && mem.total_bytes) {
      setKpi("mem", Number(mem.usage_percent).toFixed(1) + "%", fmtBytes(mem.used_bytes) + " used of " + fmtBytes(mem.total_bytes));
      bar.style.width = Math.max(0, Math.min(100, mem.usage_percent)) + "%";
      bar.className = "meter__fill is-" + kpiClass(mem.usage_percent);
      $("ov-mem-now").textContent = Number(mem.usage_percent).toFixed(1) + "%";
    } else {
      setKpi("mem", null, "Unavailable");
      bar.style.width = "0";
      $("ov-mem-now").textContent = "—";
    }

    /* Connections */
    var points = (history && history.points) || [];
    var conn = m.connections || {};
    if (online && conn.active != null) {
      var sub = "Open right now";
      var past = points.map(function (p) { return p.connections; }).filter(function (v) { return v != null; });
      if (past.length >= 2) {
        var avg = past.reduce(function (a, b) { return a + b; }, 0) / past.length;
        sub = "Avg " + avg.toFixed(1) + " over the last hour";
      }
      setKpi("conn", fmtNumber(conn.active), sub);
      $("ov-conn-now").textContent = fmtNumber(conn.active);
    } else {
      setKpi("conn", null, "Unavailable");
      $("ov-conn-now").textContent = "—";
    }

    /* Blocked transactions (thresholds match the backend alert rules) */
    if (locks && locks.count != null && !locks.error) {
      var n = Number(locks.count);
      setKpi("locks", fmtNumber(n), n === 0 ? "No lock waits" : n + " transaction" + (n === 1 ? "" : "s") + " waiting", n === 0 ? "success" : n >= 5 ? "critical" : "warning");
    } else {
      setKpi("locks", null, "Unavailable", "");
    }

    /* Charts use only recorded snapshots */
    lineChart($("ov-chart-memory"), historySeries(points, "memory_usage"), { color: "--color-accent", unit: "%", decimals: 1 });
    lineChart($("ov-chart-connections"), historySeries(points, "connections"), { color: "--color-cyan" });

    $("alerts-area").innerHTML = "";
    if (typeof loadAlerts === "function") loadAlerts(true);
    renderActivity($("ov-activity"), activity);
    markUpdated();
  }).catch(function (e) {
    setStatus(false);
    ["db", "svc", "mem", "conn", "locks"].forEach(function (id) { setKpi(id, null, "Unavailable", ""); });
    $("kpi-mem-bar").style.width = "0";
    renderServicesTable({ error: e.message });
    setState($("ov-chart-memory"), "error", "Chart unavailable.");
    setState($("ov-chart-connections"), "error", "Chart unavailable.");
    $("alerts-area").innerHTML = '<div class="banner banner--critical" data-fatal="1"><span class="banner__icon">' + icon("x-circle") +
      "</span><span>Overview unavailable: " + esc(e.message) + "</span></div>";
  });
}
PAGE_LOADERS.dashboard = function () { loadDashboard(true); };

/* ---------- COMPOSITE HEALTH CHECK ---------- */
function healthVisualState(state) {
  state = String(state || "UNKNOWN").toUpperCase();
  if (state === "OK" || state === "HEALTHY") return "ok";
  if (state === "WARNING") return "warning";
  if (state === "CRITICAL") return "critical";
  if (state === "UNAVAILABLE") return "error";
  if (state === "INFO" || state === "NOT CONFIGURED") return "info";
  return "unknown";
}

function healthIcon(state) {
  var v = healthVisualState(state);
  if (v === "ok") return "✓";
  if (v === "warning") return "⚠";
  if (v === "critical") return "✕";
  if (v === "error") return "✕";
  if (v === "info") return "ℹ";
  return "?";
}

function healthSignalValue(name, check) {
  check = check || {};
  if (name === "services") return (check.online != null ? check.online : "—") + "/" + (check.total != null ? check.total : "—") + " online";
  if (name === "memory") return check.used_percent != null ? Number(check.used_percent).toFixed(1) + "%" : "—";
  if (name === "cpu") return check.used_percent != null ? Number(check.used_percent).toFixed(1) + "%" : (check.note || "—");
  if (name === "disk") return check.max_used_percent != null ? Number(check.max_used_percent).toFixed(1) + "%" : "—";
  if (name === "blocked_transactions") {
    var count = check.blocked_transactions != null ? Number(check.blocked_transactions) : 0;
    return count + (count === 1 ? " blocked" : " blocked");
  }
  if (name === "backup_status") {
    var backup = String(check.status || check.state || "Unknown").toUpperCase();
    if (backup === "NO BACKUP FOUND") return "No backup";
    if (backup === "NOT CONFIGURED") return "Not set up";
    if (backup === "FAILED") return "Failed";
    return backup === "OK" ? "OK" : (check.status || check.state || "Unknown");
  }
  if (name === "replication") {
    var repl = String(check.status || check.state || "Unknown").toUpperCase();
    if (repl === "NOT CONFIGURED") return "Not set up";
    if (repl === "ERROR") return "Error";
    if (repl === "OK") return "OK";
    return check.status || check.state || "Unknown";
  }
  if (name === "expensive_statements") {
    var cnt = check.count != null ? Number(check.count) : 0;
    return cnt + (cnt === 1 ? " query" : " queries");
  }
  if (name === "uptime") {
    if (check.uptime_hours != null) {
      var hrs = Number(check.uptime_hours);
      if (hrs >= 24) return Math.floor(hrs / 24) + "d " + Math.floor(hrs % 24) + "h";
      return Math.floor(hrs) + "h";
    }
    return check.state || "—";
  }
  return check.state || "Unknown";
}

function healthDetailValue(name, check) {
  check = check || {};
  if (name === "memory") {
    if (check.used_gb != null && check.total_gb != null) {
      return Number(check.used_gb).toFixed(1) + " GB of " + Number(check.total_gb).toFixed(1) + " GB";
    }
    return check.used_percent != null ? Number(check.used_percent).toFixed(1) + "% used" : "";
  }
  if (name === "cpu") return check.used_percent != null ? Number(check.used_percent).toFixed(1) + "% used" : "";
  if (name === "disk") return check.max_used_percent != null ? Number(check.max_used_percent).toFixed(1) + "% used" : "";
  if (name === "services") {
    var online = Number(check.online || 0);
    var total = Number(check.total || 0);
    return total + " total";
  }
  if (name === "uptime") {
    if (check.uptime_hours != null) return Number(check.uptime_hours).toFixed(0) + " hours";
    return "";
  }
  return "";
}

function healthIssueLabel(name, check) {
  check = check || {};
  if (name === "services") {
    var online = Number(check.online || 0);
    var total = Number(check.total || 0);
    var offline = Number(check.offline || Math.max(total - online, 0));
    if (total > 0 && offline > 0) return { title: offline + " service" + (offline === 1 ? "" : "s") + " offline", desc: "Some HANA services are not running. Check service status.", action: "View Services" };
    return total > 0 ? { title: total + " services online", desc: "All services are running normally.", action: null } : { title: "Service status not reported", desc: "Could not determine service status.", action: null };
  }
  if (name === "memory") {
    if (check.used_percent != null) {
      var pct = Number(check.used_percent);
      if (pct >= 90) return { title: "Memory usage critical (" + pct.toFixed(1) + "%)", desc: "Memory is over 90% used. Consider reducing workload or adding memory.", action: "View Details" };
      if (pct >= 75) return { title: "Memory usage elevated (" + pct.toFixed(1) + "%)", desc: "Memory is between 75-90% used. Monitor closely.", action: "View Details" };
      return { title: "Memory at " + pct.toFixed(1) + "%", desc: "Memory usage is within normal range.", action: null };
    }
    return { title: "Memory usage not reported", desc: "Could not determine memory usage.", action: null };
  }
  if (name === "cpu") {
    if (check.used_percent != null) {
      var pct = Number(check.used_percent);
      if (pct >= 90) return { title: "CPU usage critical (" + pct.toFixed(1) + "%)", desc: "CPU is over 90% used. Investigate high CPU consumers.", action: "View Details" };
      if (pct >= 75) return { title: "CPU usage elevated (" + pct.toFixed(1) + "%)", desc: "CPU is between 75-90% used. Monitor closely.", action: "View Details" };
      return { title: "CPU at " + pct.toFixed(1) + "%", desc: "CPU usage is within normal range.", action: null };
    }
    return { title: "CPU usage not reported", desc: "Could not determine CPU usage.", action: null };
  }
  if (name === "disk") {
    if (check.max_used_percent != null) {
      var pct = Number(check.max_used_percent);
      if (pct >= 90) return { title: "Disk usage critical (" + pct.toFixed(1) + "%)", desc: "Disk is over 90% used. Free up space immediately.", action: "View Details" };
      if (pct >= 75) return { title: "Disk usage elevated (" + pct.toFixed(1) + "%)", desc: "Disk is between 75-90% used. Plan for cleanup.", action: "View Details" };
      return { title: "Disk at " + pct.toFixed(1) + "%", desc: "Disk usage is within normal range.", action: null };
    }
    return { title: "Disk usage not reported", desc: "Could not determine disk usage.", action: null };
  }
  if (name === "blocked_transactions") {
    var count = Number(check.blocked_transactions || 0);
    if (count > 5) return { title: count + " blocked transactions", desc: "High number of blocked transactions detected. Investigate locks.", action: "View Locks" };
    if (count > 0) return { title: count + " blocked transaction" + (count === 1 ? "" : "s"), desc: "Some transactions are blocked. Monitor for resolution.", action: "View Locks" };
    return { title: "No blocked transactions", desc: "No lock contention detected.", action: null };
  }
  if (name === "backup_status") {
    var backup = String(check.status || check.state || "Unknown").toUpperCase();
    if (backup === "NO BACKUP FOUND") return { title: "No backup detected", desc: "No backup has been found. Configure backups to prevent data loss.", action: "Configure Backup" };
    if (backup === "NOT CONFIGURED") return { title: "Backups not configured", desc: "Backups are not set up. Configure backup schedule.", action: "Configure Backup" };
    if (backup === "FAILED") return { title: "Backup failed", desc: "Last backup failed. Check backup logs and configuration.", action: "View Logs" };
    if (backup === "OK") return { title: "Backups healthy", desc: "Backups are configured and running.", action: null };
    return { title: "Backup status needs attention", desc: check.status || check.state || "Unknown backup status.", action: null };
  }
  if (name === "replication") {
    var repl = String(check.status || check.state || "Unknown").toUpperCase();
    if (repl === "NOT CONFIGURED") return { title: "Replication not configured", desc: "System replication is not set up. Configure for high availability.", action: "Configure Replication" };
    if (repl === "CRITICAL" || repl === "ERROR") return { title: "Replication error", desc: "Replication has an error. Check replication status.", action: "View Status" };
    if (repl === "OK") return { title: "Replication healthy", desc: "Replication is configured and running.", action: null };
    return { title: "Replication needs attention", desc: check.status || check.state || "Unknown replication status.", action: null };
  }
  if (name === "expensive_statements") {
    var cnt = check.count != null ? Number(check.count) : 0;
    if (cnt > 5) return { title: cnt + " expensive queries", desc: "High number of expensive queries detected. Review and optimize.", action: "View Queries" };
    if (cnt > 0) return { title: cnt + " expensive quer" + (cnt === 1 ? "y" : "ies"), desc: "Some expensive queries detected. Monitor performance.", action: "View Queries" };
    return { title: "No expensive queries", desc: "Query performance is within normal range.", action: null };
  }
  if (name === "uptime") {
    if (check.uptime_hours != null) {
      var hrs = Number(check.uptime_hours);
      if (hrs < 1) return { title: "Recently restarted", desc: "System was recently restarted. Monitor for stability.", action: null };
      if (hrs < 24) return { title: "Uptime: " + Math.floor(hrs) + " hours", desc: "System has been running for less than 24 hours.", action: null };
      return { title: "Uptime: " + Math.floor(hrs / 24) + "d " + Math.floor(hrs % 24) + "h", desc: "System has been running for more than 24 hours.", action: null };
    }
    return { title: "Uptime not reported", desc: "Could not determine system uptime.", action: null };
  }
  return { title: healthSignalValue(name, check), desc: "", action: null };
}

function formatHealthCheckedAt(value) {
  if (!value) return "Just now";
  var parsed = new Date(value);
  if (isNaN(parsed.getTime())) return value;
  var now = new Date();
  var diff = Math.floor((now - parsed) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return Math.floor(diff / 60) + " minutes ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " hours ago";
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function setHealthLoading() {
  var card = $("health-card");
  card.className = "card health-card is-loading";
  $("health-status").className = "health-card__status is-loading";
  $("health-status").innerHTML = '<span class="health-card__status-icon">↻</span> CHECKING';
  $("health-headline").textContent = "Running the complete operational assessment…";
  $("health-timestamp").textContent = "";
  $("health-checks").innerHTML = '<div class="health-check__empty">Checking services, memory, CPU, disk, locks, backups, and replication…</div>';
  $("health-issues").innerHTML = "";
  $("health-summary").textContent = "";
}

function renderHealthCheck(result) {
  var health = String(result.health || "UNKNOWN").toUpperCase();
  var checks = result.checks || {};
  var visual = healthVisualState(health);
  var card = $("health-card");
  var status = $("health-status");
  card.className = "card health-card is-" + visual;
  status.className = "health-card__status is-" + visual;
  status.innerHTML = '<span class="health-card__status-icon">' + healthIcon(health) + '</span> ' + health;
  $("health-timestamp").textContent = "Last checked: " + formatHealthCheckedAt(result.checked_at);

  // Headline
  var system = checks.system_status || {};
  var headline = system.database ? system.database + " · " : "";
  if (health === "HEALTHY") {
    headline += "All systems are operating normally.";
  } else if (health === "WARNING") {
    headline += "System is online but has non-critical issues that need attention.";
  } else if (health === "CRITICAL") {
    headline += "URGENT: Critical issues require immediate attention.";
  } else {
    headline += "Review the health check results below.";
  }
  $("health-headline").textContent = headline;

  // Health checks grid
  var signals = [
    ["services", "Services"],
    ["memory", "Memory"],
    ["cpu", "CPU"],
    ["disk", "Disk"],
    ["blocked_transactions", "Locks"],
    ["backup_status", "Backups"],
    ["replication", "Replication"]
  ];
  $("health-checks").innerHTML = signals.map(function (signal) {
    var name = signal[0], label = signal[1];
    var check = checks[name] || {};
    var state = healthVisualState(check.state);
    var value = healthSignalValue(name, check);
    var detail = healthDetailValue(name, check);
    return '<div class="health-check is-' + state + '">' +
      '<span class="health-check__icon is-' + state + '">' + healthIcon(check.state) + '</span>' +
      '<span class="health-check__label">' + esc(label) + '</span>' +
      '<span class="health-check__value">' + esc(value) + '</span>' +
      (detail ? '<span class="health-check__detail">' + esc(detail) + '</span>' : '') +
      '</div>';
  }).join("");

  // Critical issues section
  var issues = [];
  signals.forEach(function (signal) {
    var name = signal[0];
    var check = checks[name] || {};
    var issue = healthIssueLabel(name, check);
    var state = healthVisualState(check.state);
    if (state === "warning" || state === "critical" || state === "error") {
      issues.push({ state: state, title: issue.title, desc: issue.desc, action: issue.action });
    }
  });

  var issuesHtml = "";
  if (issues.length === 0) {
    issuesHtml = '<div class="health-issues__empty">✓ No issues detected</div>';
  } else {
    issuesHtml = '<div class="health-issues__title">⚠ Critical Issues</div>' +
      '<ul class="health-issues__list">' +
      issues.map(function (issue) {
        return '<li class="health-issues__item is-' + issue.state + '">' +
          '<div class="health-issues__item-title">' + esc(issue.title) + '</div>' +
          '<div class="health-issues__item-desc">' + esc(issue.desc) + '</div>' +
          '</li>';
      }).join("") +
      '</ul>';
  }
  $("health-issues").innerHTML = issuesHtml;

  // Summary message
  var summaryEl = $("health-summary");
  summaryEl.className = "health-summary is-" + visual;
  if (health === "HEALTHY") {
    summaryEl.textContent = "✓ All systems are operating normally.";
  } else if (health === "WARNING") {
    summaryEl.textContent = "⚠ System is online but has non-critical issues that need attention.";
  } else if (health === "CRITICAL") {
    summaryEl.textContent = "✕ URGENT: Critical issues require immediate attention.";
  } else {
    summaryEl.textContent = "Review the health check results above.";
  }
}

function renderHealthError(message) {
  var card = $("health-card");
  card.className = "card health-card is-error";
  $("health-status").className = "health-card__status is-error";
  $("health-status").innerHTML = '<span class="health-card__status-icon">✕</span> ERROR';
  $("health-headline").textContent = "Health check unavailable";
  $("health-timestamp").textContent = "";
  $("health-checks").innerHTML = '<div class="health-card__error">Health check error: ' + esc(message || "Could not reach the tool endpoint.") + '</div>';
  $("health-issues").innerHTML = "";
  $("health-summary").textContent = "";
}

var LAST_HEALTH_RESULT = null;

function runHealthCheck() {
  var button = $("health-run");
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("is-loading");
  button.innerHTML = '<span class="health-card__run-icon" aria-hidden="true">↻</span> Checking';
  setHealthLoading();
  runTool("hana_health_check", {}, "overview").then(function (result) {
    if (!result || result.error) throw new Error((result && result.error) || "The health tool returned no result.");
    LAST_HEALTH_RESULT = result;
    renderHealthCheck(result);
  }).catch(function (error) {
    renderHealthError(error && error.message);
  }).then(function () {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.innerHTML = '<span class="health-card__run-icon" aria-hidden="true">↻</span> Run check';
  });
}

function renderHealthReport(result) {
  var meta = $("health-report-meta");
  var summary = $("health-report-summary");
  var findings = $("health-report-findings");
  var checks = $("health-report-checks");
  if (!result) {
    meta.textContent = "Run a health check first.";
    summary.textContent = "";
    findings.innerHTML = "";
    checks.innerHTML = "";
    return;
  }
  var health = String(result.health || "UNKNOWN").toUpperCase();
  meta.textContent = "Verdict: " + health + " · Last checked " + formatHealthCheckedAt(result.checked_at);
  summary.textContent = result.summary || "";
  var list = Array.isArray(result.findings) ? result.findings : [];
  findings.innerHTML = list.length
    ? '<div class="health-report-section-title">Findings</div><ul class="health-report-findings__list">' +
      list.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>"
    : '<div class="health-report-section-empty">No findings — all signals are nominal.</div>';
  var sections = result.checks || {};
  var rows = Object.keys(sections).map(function (name) {
    var section = sections[name] || {};
    return {
      name: name,
      state: String(section.state || "UNKNOWN").toUpperCase(),
      detail: healthReportCheckDetail(name, section)
    };
  });
  checks.innerHTML = '<div class="health-report-section-title">Per-check details</div>' +
    '<table class="health-report-table"><thead><tr><th>Check</th><th>State</th><th>Details</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return "<tr><td>" + esc(r.name) + "</td>" +
        '<td><span class="status-pill ' + healthVisualState(r.state).replace("unknown", "warn") + '"><span class="pill-dot"></span>' + esc(r.state) + "</span></td>" +
        "<td>" + esc(r.detail) + "</td></tr>";
    }).join("") + "</tbody></table>";
}

function healthReportCheckDetail(name, section) {
  if (!section || typeof section !== "object") return "";
  if (section.error) return "error: " + section.error;
  var entries = [];
  Object.keys(section).forEach(function (key) {
    if (key === "state" || key === "note") return;
    var value = section[key];
    if (value === null || value === undefined) return;
    if (typeof value === "object") return;
    entries.push(key + ": " + value);
  });
  if (section.note) entries.push("note: " + section.note);
  return entries.join(" · ");
}

function openHealthReport() {
  var modal = $("health-report-modal");
  if (!modal) return;
  renderHealthReport(LAST_HEALTH_RESULT);
  modal.hidden = false;
}

function closeHealthReport() {
  var modal = $("health-report-modal");
  if (modal) modal.hidden = true;
}

$("health-run").addEventListener("click", runHealthCheck);
var healthReportLink = $("health-full-report");
if (healthReportLink) {
  healthReportLink.addEventListener("click", function (event) {
    event.preventDefault();
    openHealthReport();
  });
}
var healthReportClose = $("health-report-close");
if (healthReportClose) healthReportClose.addEventListener("click", closeHealthReport);
var healthReportBackdrop = $("health-report-backdrop");
if (healthReportBackdrop) healthReportBackdrop.addEventListener("click", closeHealthReport);
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeHealthReport();
});
