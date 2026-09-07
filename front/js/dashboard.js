/* ---------- DASHBOARD ---------- */
function updateDashBanner(dash, online) {
  var icon = $("dash-banner-icon");
  var title = $("dash-banner-title");
  var sub = $("dash-banner-sub");
  if (!icon || !title || !sub) return;
  var mem = (dash.metrics && dash.metrics.memory) || {};
  var cpu = (dash.metrics && dash.metrics.cpu) || {};
  var alerts = dash.alerts || {};
  var health = dash.health || {};
  var services = health.services || {};
  var backup = health.backup || {};
  var replication = health.replication || {};
  var backupState = String(backup.status || backup.state || "").toUpperCase();
  var replicationState = String(replication.status || replication.state || "").toUpperCase();
  var serviceState = String(services.state || "").toUpperCase();
  var locks = alerts.locks && alerts.locks.count;
  var crit = mem.usage_percent >= 85 || cpu.usage_percent >= 80 || serviceState === "CRITICAL" || Number(services.offline || 0) > 0 || backupState === "FAILED" || replicationState === "ERROR";
  var warn = mem.usage_percent >= 70 || cpu.usage_percent >= 60 || locks || (backupState && backupState !== "OK") || replicationState === "NOT CONFIGURED";
  var focus = [];

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
    title.textContent = Number(services.offline || 0) > 0 ? "Operational issues detected" : "Critical thresholds exceeded";
    if (mem.usage_percent >= 85) focus.push("memory usage is critical");
    if (cpu.usage_percent >= 80) focus.push("CPU usage is critical");
    if (serviceState === "CRITICAL" || Number(services.offline || 0) > 0) focus.push((Number(services.offline || 0) || 1) + " service" + ((Number(services.offline || 0) || 1) === 1 ? " is" : "s are") + " offline");
    if (backupState === "FAILED") focus.push("backup failed");
    if (replicationState === "ERROR") focus.push("replication error");
    sub.textContent = focus.length ? ("Review " + focus.slice(0, 3).join(" · ") + " before routine operations continue.") : "Review the flagged domains below before routine operations continue.";
  } else if (warn) {
    icon.className = "dash-banner__icon warn";
    icon.textContent = "⚠";
    title.textContent = "Review operational warnings";
    if (mem.usage_percent >= 70) focus.push("memory usage is elevated");
    if (cpu.usage_percent >= 60) focus.push("CPU usage is elevated");
    if (locks) focus.push(locks + " blocked transaction" + (Number(locks) === 1 ? "" : "s"));
    if (backupState === "NO BACKUP FOUND") focus.push("no backup detected");
    else if (backupState === "NOT CONFIGURED") focus.push("backups not configured");
    if (replicationState === "NOT CONFIGURED") focus.push("replication not configured");
    sub.textContent = focus.length ? ("Review " + focus.slice(0, 3).join(" · ") + " before routine operations continue.") : "Some domains deserve attention before routine operations continue.";
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
    if (pill) pill.classList.add(online ? "online" : "error");
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
    var memCls = kpiClass(memPct);
    var cpuCls = kpiClass(cpuPct);
    $("kpi-mem-val").textContent = pct(memPct);
    $("kpi-mem-val").className = "kpi-card__value " + memCls;
    $("kpi-memory").className = "kpi-card is-" + memCls;
    $("kpi-cpu-val").textContent = pct(cpuPct);
    $("kpi-cpu-val").className = "kpi-card__value " + cpuCls;
    $("kpi-cpu").className = "kpi-card is-" + cpuCls;
    $("kpi-conn-val").textContent = conn.active != null ? conn.active : "—";
    $("kpi-conn-val").className = "kpi-card__value";
    $("kpi-conn").className = "kpi-card";
    if (diskPct != null) {
      var diskCls = kpiClass(diskPct);
      $("kpi-disk-val").textContent = pct(diskPct);
      $("kpi-disk-val").className = "kpi-card__value " + diskCls;
      $("kpi-disk").className = "kpi-card is-" + diskCls;
    } else {
      $("kpi-disk-val").textContent = "—";
      $("kpi-disk-val").className = "kpi-card__value";
      $("kpi-disk").className = "kpi-card";
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
    if (pill) pill.classList.add("error");
    setStatus(false);
    updateTopbar({});
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
  api("/api/tool/hana_health_check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }).then(function (result) {
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

/* Initial load so the status pill moves off "Checking…" on first paint */
loadDashboard();
