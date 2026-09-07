/* ---------- AI CHAT (two-pane) ---------- */
var CHAT_KEY = "hana_chat_conversations";
var CHAT_SB_COLLAPSED = "hana_chat_sb_collapsed";
var currentConvId = null;
var activeConv = null; /* in-memory active conversation; guarantees continuity even if localStorage is unavailable */
var busy = false;
var pickedSql = null; /* SQL chosen by chooseSteps for a specific object/bulk query */
var agentEnabled = false; /* true when the LLM agent loop is configured server-side */

/* ---------- conversation persistence ---------- */
function loadConvs() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY) || "[]"); } catch (e) { return []; }
}
function saveConvs(convs) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(convs)); } catch (e) { }
}
function getConv(id) {
  if (id && activeConv && activeConv.id === id) return activeConv;
  return loadConvs().filter(function (c) { return c.id === id; })[0] || null;
}
function upsertConv(conv) {
  try {
    var convs = loadConvs();
    var hit = convs.filter(function (c) { return c.id === conv.id; })[0];
    if (hit) {
      var hitIdx = convs.indexOf(hit);
      convs.splice(hitIdx, 1);
      Object.assign(hit, conv);
      convs.unshift(hit);
    } else {
      convs.unshift(conv);
    }
    saveConvs(convs);
  } catch (e) { }
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
  var allConvs = loadConvs();
  var convs = allConvs;
  var search = $("chat-sb-search");
  var drawer = $("chat-drawer");
  var q = (search.value || "").toLowerCase();
  if (q) {
    convs = convs.filter(function (c) { return c.title.toLowerCase().indexOf(q) >= 0; });
  }
  if (!allConvs.length) {
    drawer.classList.add("is-empty");
    search.disabled = true;
    search.value = "";
  } else {
    drawer.classList.remove("is-empty");
    search.disabled = false;
  }
  var groups = { "Today": [], "Yesterday": [], "Previous 7 days": [], "Older": [] };
  convs.forEach(function (c) { groups[groupLabel(c.created)].push(c); });
  Object.keys(groups).forEach(function (g) {
    groups[g].sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
  });
  var el = $("chat-sb-groups");
  if (!convs.length) {
    el.innerHTML = '<div class="chat-sb-empty">No conversations match your search.</div>';
    updateConvHeader();
    return;
  }
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
  updateConvHeader();
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
/* confirmation modal */
var clearConfirmCb = null;
function showClearConfirm(cb) {
  clearConfirmCb = cb;
  var modal = $("confirm-modal");
  if (modal) modal.hidden = false;
}
function hideClearConfirm() {
  var modal = $("confirm-modal");
  if (modal) modal.hidden = true;
  clearConfirmCb = null;
}
var confirmModal = $("confirm-modal");
var confirmCancel = $("confirm-cancel");
var confirmBackdrop = $("confirm-backdrop");
var confirmOk = $("confirm-ok");
if (confirmCancel) confirmCancel.addEventListener("click", hideClearConfirm);
if (confirmBackdrop) confirmBackdrop.addEventListener("click", hideClearConfirm);
if (confirmOk) confirmOk.addEventListener("click", function () {
  if (clearConfirmCb) clearConfirmCb();
  hideClearConfirm();
});

var chatClearAll = $("chat-clear-all");
if (chatClearAll) chatClearAll.addEventListener("click", function () {
  showClearConfirm(function () {
    saveConvs([]);
    activeConv = null;
    currentConvId = null;
    renderSidebar();
    showWelcome();
  });
});
var chatSbSearch = $("chat-sb-search");
if (chatSbSearch) chatSbSearch.addEventListener("input", renderSidebar);
var chatSbNew = $("chat-sb-new");
if (chatSbNew) chatSbNew.addEventListener("click", function () { newChat(); });
/* conversations drawer toggle */
var chatToggleConv = $("chat-toggle-conv");
if (chatToggleConv) chatToggleConv.addEventListener("click", function () {
  var drawer = $("chat-drawer");
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderSidebar();
});
var chatDrawerClose = $("chat-drawer-close");
if (chatDrawerClose) chatDrawerClose.addEventListener("click", function () {
  $("chat-drawer").hidden = true;
});

/* ---------- file attachment handling ---------- */
$("chat-file").addEventListener("change", function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var lower = file.name.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".txt")) {
    alert("Only .csv and .txt files are supported.");
    e.target.value = "";
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    var content = String(reader.result || "");
    if (content.length > 50000) {
      content = content.slice(0, 50000) + "\n\n[… file truncated to 50k characters …]";
    }
    pendingAttachment = { name: file.name, content: content };
    showAttachmentPreview(file.name);
  };
  reader.onerror = function () { alert("Could not read the file."); };
  reader.readAsText(file);
  e.target.value = "";
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
function updateConvHeader() {
  var header = $("chat-conv-header");
  var titleEl = $("chat-conv-title");
  var countEl = $("chat-conv-count");
  var conv = getConv(currentConvId);
  if (!conv || !conv.messages.length) {
    if (header) header.hidden = true;
    return;
  }
  if (header) header.hidden = false;
  if (titleEl) titleEl.textContent = conv.title || "New chat";
  if (countEl) countEl.textContent = conv.messages.length + " message" + (conv.messages.length !== 1 ? "s" : "");
}
function newChat() {
  newConv();
  $("chat-thread-inner").innerHTML = ""; // clear stale messages from the previous conversation
  showWelcome();
  updateConvHeader();
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
    if (m.role === "user") {
      appendUserMsg(m.text, false, m.attachment);
    } else if (m.model) {
      var agentDiv = appendAgentMsg(m, false);
      if (m.steps && m.steps.length) {
        renderResultGrids(agentGridResults(m.steps), agentDiv.querySelector(".chat-results"));
      }
    } else {
      var assistantDiv = appendAssistantMsg(m, false);
      if (m.steps && m.steps.length) {
        renderResultGrids(m.steps, assistantDiv.querySelector(".chat-results"));
      }
    }
  });
  showThread();
  var thread = $("chat-thread");
  thread.scrollTop = thread.scrollHeight;
}

function appendUserMsg(text, persist, attachment) {
  var inner = $("chat-thread-inner");
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg--user";
  var bubble = esc(text);
  if (attachment && attachment.name) {
    bubble += '<div class="chat-attachment">📎 ' + esc(attachment.name) + "</div>";
  }
  div.innerHTML = '<div class="chat-msg-avatar">U</div>' +
    '<div class="chat-msg-body"><div class="chat-msg-bubble">' + bubble + "</div></div>";
  inner.appendChild(div);
  var thread = $("chat-thread");
  thread.scrollTop = thread.scrollHeight;
  if (persist) {
    var conv = getConv(currentConvId);
    if (conv) {
      conv.title = conv.messages.length ? conv.title : (text.slice(0, 40) + (text.length > 40 ? "…" : ""));
      conv.messages.push({ role: "user", text: text, attachment: attachment || null });
      upsertConv(conv);
      renderSidebar();
      updateConvHeader();
    }
  }
  return div;
}

function getRelatedSuggestions(steps) {
  var toolSuggestions = {
    "hana_health_check": [
      { label: "Check Memory", prompt: "how much memory is in use?" },
      { label: "View Replication", prompt: "show replication status" },
      { label: "Backup Status", prompt: "show backup status" }
    ],
    "hana_memory": [
      { label: "Check CPU", prompt: "show cpu usage" },
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Disk Usage", prompt: "show disk usage" }
    ],
    "hana_cpu": [
      { label: "Check Memory", prompt: "how much memory is in use?" },
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Active Connections", prompt: "show active connections" }
    ],
    "hana_disk": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Table Sizes", prompt: "show largest tables" },
      { label: "Trace Files", prompt: "show trace files" }
    ],
    "hana_connections": [
      { label: "Blocked Transactions", prompt: "any blocked transactions?" },
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Active Statements", prompt: "show active statements" }
    ],
    "hana_replication": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Backup Status", prompt: "show backup status" },
      { label: "Services Status", prompt: "show services status" }
    ],
    "hana_backup_status": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Replication Status", prompt: "show replication status" },
      { label: "Disk Usage", prompt: "show disk usage" }
    ],
    "hana_blocked_transactions": [
      { label: "Active Connections", prompt: "show active connections" },
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Services Status", prompt: "show services status" }
    ],
    "hana_services": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Memory Usage", prompt: "how much memory is in use?" },
      { label: "CPU Usage", prompt: "show cpu usage" }
    ],
    "hana_expensive_statements": [
      { label: "Blocked Transactions", prompt: "any blocked transactions?" },
      { label: "Active Connections", prompt: "show active connections" },
      { label: "Health Check", prompt: "how healthy is my database?" }
    ],
    "hana_table_sizes": [
      { label: "Disk Usage", prompt: "show disk usage" },
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Memory Usage", prompt: "how much memory is in use?" }
    ],
    "hana_trace_files": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Disk Usage", prompt: "show disk usage" },
      { label: "Services Status", prompt: "show services status" }
    ],
    "hana_system_status": [
      { label: "Memory Usage", prompt: "how much memory is in use?" },
      { label: "CPU Usage", prompt: "show cpu usage" },
      { label: "Connections", prompt: "show active connections" }
    ],
    "hana_execute_query": [
      { label: "Health Check", prompt: "how healthy is my database?" },
      { label: "Memory Usage", prompt: "how much memory is in use?" },
      { label: "CPU Usage", prompt: "show cpu usage" }
    ]
  };

  if (!steps || !steps.length) return [];
  var primaryTool = steps[0].name;
  return toolSuggestions[primaryTool] || [];
}

function renderRelatedSuggestions(steps) {
  var suggestions = getRelatedSuggestions(steps);
  if (!suggestions.length) return "";
  var html = '<div class="chat-related"><div class="chat-related-title">💡 Related:</div><div class="chat-related-items">';
  suggestions.forEach(function (s) {
    html += '<button class="chat-related-btn" data-prompt="' + escAttr(s.prompt) + '">' + esc(s.label) + '</button>';
  });
  html += "</div></div>";
  return html;
}

function appendAssistantMsg(m, persist) {
  var inner = $("chat-thread-inner");
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg--ai";
  div.innerHTML = '<div class="chat-msg-avatar">✦</div>' +
    '<div class="chat-msg-body">' +
    '<div class="chat-results"></div>' +
    '<div class="assistant-summary">' + renderAgentHTML(m.summary || "") + "</div>" +
    renderRelatedSuggestions(m.steps) +
    '<div class="chat-msg-actions">' +
    '<button class="chat-msg-action chat-msg-action--primary" data-act="rerun">↻ Re-run</button>' +
    '<button class="chat-msg-action" data-act="copy">📋 Copy</button>' +
    '<button class="chat-msg-action agent-action--tertiary" data-act="docs">📚 Docs</button>' +
    "</div></div>";
  inner.appendChild(div);

  div.querySelector('[data-act="rerun"]').addEventListener("click", function () {
    if (busy) return;
    busy = true;
    runSteps(m.steps || [], div, {})
      .then(function () { busy = false; clearPromptLoading(); })
      .catch(function () { busy = false; clearPromptLoading(); });
  });
  div.querySelector('[data-act="copy"]').addEventListener("click", function () {
    var txt = m.summary || "";
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () { });
  });
  var docsBtn = div.querySelector('[data-act="docs"]');
  if (docsBtn) {
    docsBtn.addEventListener("click", function () {
      var toolName = (m.steps && m.steps.length && m.steps[0].name) || "";
      var url = "https://help.sap.com/viewer/";
      if (toolName) url += "?search=" + encodeURIComponent(toolName.replace(/^hana_/, ""));
      window.open(url, "_blank");
    });
  }
  var relatedBtns = div.querySelectorAll(".chat-related-btn");
  relatedBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (busy) return;
      dispatch(btn.dataset.prompt);
    });
  });
  if (persist) {
    var conv = getConv(currentConvId);
    if (conv) { conv.messages.push(m); upsertConv(conv); renderSidebar(); updateConvHeader(); }
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
  $("chat-send").classList.add("is-busy");
  var conv = activeConv || getConv(currentConvId) || newConv();
  currentConvId = conv.id;
  activeConv = conv;
  showThread();
  appendUserMsg(text, true);
  var aiDiv = appendAssistantMsg({ steps: steps, summary: '<span style="color:var(--text3)">Thinking…</span>' }, false);
  runSteps(steps, aiDiv, { userText: text })
    .then(function (summary) {
      var m = { role: "assistant", steps: steps, summary: summary };
      var conv2 = getConv(currentConvId);
      if (conv2) { conv2.messages.push(m); upsertConv(conv2); renderSidebar(); updateConvHeader(); }
      var thread = $("chat-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
      busy = false;
      clearPromptLoading();
      $("chat-send").disabled = false;
      $("chat-send").classList.remove("is-busy");
    })
    .catch(function () { busy = false; clearPromptLoading(); $("chat-send").disabled = false; $("chat-send").classList.remove("is-busy"); });
}

function userAsk(text, nullArg) { startThread(text, chooseSteps(text)); }

/* ---------- file attachment (csv / txt) ---------- */
var pendingAttachment = null;

function showAttachmentPreview(name) {
  var el = $("chat-attachment-preview");
  if (!el) return;
  el.hidden = false;
  el.innerHTML =
    '<span class="chat-attachment-chip">📎 ' + esc(name) + "</span>" +
    '<button class="chat-attachment-remove" id="chat-attachment-remove" title="Remove" type="button">✕</button>';
  var rm = $("chat-attachment-remove");
  if (rm) rm.addEventListener("click", clearAttachment);
}

function clearAttachment() {
  pendingAttachment = null;
  var el = $("chat-attachment-preview");
  if (el) { el.hidden = true; el.innerHTML = ""; }
}

/* ---------- render agent response ---------- */
var AGENT_SECTION_ICONS = {
  "Status": "🔔",
  "Key Metrics": "📊",
  "Critical Issues": "🚨",
  "Recommendations": "📝",
  "Summary": "📋",
  "Next Steps": "✅"
};

function inferStatus(value) {
  var v = (value || "").toLowerCase();
  if (v.indexOf("warning") >= 0 || v.indexOf("no backup") >= 0 || v.indexOf("not configured") >= 0 || v.indexOf("100.0%") >= 0 || v.indexOf("high") >= 0) return { cls: "agent-status-cell--warning", icon: "⚠️", label: "Warning" };
  if (v.indexOf("error") >= 0 || v.indexOf("failed") >= 0 || v.indexOf("stopped") >= 0 || v.indexOf("critical") >= 0) return { cls: "agent-status-cell--error", icon: "🚨", label: "Critical" };
  if (v.indexOf("online") >= 0 || v.indexOf("ok") >= 0 || v.indexOf("configured") >= 0 || v.indexOf("0 blocked") >= 0 || v.indexOf("0 detected") >= 0 || v.indexOf("healthy") >= 0) return { cls: "agent-status-cell--healthy", icon: "✅", label: "Healthy" };
  if (v.indexOf("unknown") >= 0 || v.indexOf("unavailable") >= 0 || v.indexOf("info") >= 0) return { cls: "", icon: "ℹ️", label: "Info" };
  return { cls: "", icon: "ℹ️", label: "Info" };
}

function renderAgentHTML(summary) {
  var html = renderMarkdown(summary || "");
  html = html.replace(/<h2>([^<]+)<\/h2>/gi, function (_, title) {
    var icon = AGENT_SECTION_ICONS[title.trim()] || "";
    return '<div class="agent-section-head"><span class="agent-section-icon">' + icon + '</span><span class="agent-section-title">' + title.trim() + '</span></div>';
  });
  html = html.replace(/<p>(Warning|WARNING|Healthy|HEALTHY|Error|ERROR|Critical|CRITICAL)[:\s]*([^<]*)<\/p>/gi, function (_, status, detail) {
    var cls = "agent-banner--" + status.toLowerCase();
    if (status.toLowerCase().indexOf("warn") >= 0) cls = "agent-banner--warning";
    else if (status.toLowerCase().indexOf("error") >= 0 || status.toLowerCase().indexOf("critical") >= 0) cls = "agent-banner--critical";
    else if (status.toLowerCase().indexOf("healthy") >= 0 || status.toLowerCase().indexOf("online") >= 0) cls = "agent-banner--healthy";
    return '<div class="agent-status-banner ' + cls + '"><span class="agent-status-icon">⚠️</span><span class="agent-status-text">' + esc(status) + (detail ? ": " + esc(detail) : "") + "</span></div>";
  });
  html = html.replace(/<table>/gi, '<table class="agent-metrics-table">');
  html = html.replace(/<ul>/gi, '<ul class="agent-list">');
  return html;
}

/* ---------- real agent loop (optional, server-configured) ---------- */
function dispatch(text) {
  var steps = chooseSteps(text);
  if (steps && steps.length && (steps[0] === "__greet__" || steps[0] === "__unknown__")) {
    startThread(text, steps);
    return;
  }
  if (agentEnabled || pendingAttachment) {
    streamAgentThread(text);
  } else {
    startThread(text, steps);
  }
}

function agentGridResults(steps) {
  return (steps || []).filter(function (s) { return !s.error && s.rows && s.rows.length; }).map(function (s) {
    return {
      name: s.name,
      rows: s.rows,
      rc: s.rc != null ? s.rc : (s.row_count != null ? s.row_count : s.rows.length),
      res: { sql: s.sql }
    };
  });
}

/* Append an assistant bubble whose tool steps were already executed server-side. */
function appendAgentMsg(result, persist) {
  var inner = $("chat-thread-inner");
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg--ai";
  div.innerHTML = '<div class="chat-msg-avatar">✦</div>' +
    '<div class="chat-msg-body">' +
    '<div class="chat-results"></div>' +
    '<div class="assistant-summary">' + renderAgentHTML(result.summary || "") + "</div>" +
    renderRelatedSuggestions(result.steps) +
    '<div class="chat-msg-actions">' +
    '<button class="chat-msg-action chat-msg-action--primary" data-act="rerun">↻ Re-run</button>' +
    '<button class="chat-msg-action" data-act="copy">📋 Copy</button>' +
    '<button class="chat-msg-action agent-action--tertiary" data-act="docs">📚 Docs</button>' +
    "</div></div>";
  inner.appendChild(div);

  div.querySelector('[data-act="rerun"]').addEventListener("click", function () {
    if (busy) return;
    busy = true;
    var prompt = convLastUser();
    var convR = getConv(currentConvId);
    var historyR = (convR ? convR.messages : []).map(function (m) {
      return { role: m.role, text: m.text || m.summary || "", attachment: m.attachment || null };
    });
    api("/api/chat/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: prompt, history: historyR }) })
      .then(function (res) {
        if (!res.error) {
          div.querySelector(".assistant-summary").innerHTML = renderAgentHTML(res.summary || "");
          var rg = div.querySelector(".chat-results"); rg.innerHTML = "";
          renderResultGrids(agentGridResults(res.steps || []), rg);
        }
      })
      .catch(function () { })
      .then(function () { busy = false; clearPromptLoading(); });
  });
  div.querySelector('[data-act="copy"]').addEventListener("click", function () {
    var txt = result.summary || "";
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () { });
  });
  var docsBtn = div.querySelector('[data-act="docs"]');
  if (docsBtn) {
    docsBtn.addEventListener("click", function () {
      var toolName = (result.steps && result.steps.length && result.steps[0].name) || "";
      var url = "https://help.sap.com/viewer/";
      if (toolName) url += "?search=" + encodeURIComponent(toolName.replace(/^hana_/, ""));
      window.open(url, "_blank");
    });
  }
  var relatedBtns = div.querySelectorAll(".chat-related-btn");
  relatedBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (busy) return;
      dispatch(btn.dataset.prompt);
    });
  });
  if (persist) {
    var conv = getConv(currentConvId);
    if (conv) { conv.messages.push(result); upsertConv(conv); renderSidebar(); updateConvHeader(); }
  }
  var thread = $("chat-thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
  return div;
}

/* Drive the conversation through the server-side agent loop, falling back
   to the keyword router if the model is unreachable. */
function startAgentThread(text) {
  if (busy) return;
  busy = true;
  $("chat-send").disabled = true;
  $("chat-send").classList.add("is-busy");
  var conv = activeConv || getConv(currentConvId) || newConv();
  currentConvId = conv.id;
  activeConv = conv;
  var history = conv.messages.map(function (m) {
    var entry = { role: m.role, attachment: m.attachment || null };

    if (m.role === "user") {
      entry.text = m.text || "";
    } else if (m.role === "assistant") {
      entry.text = m.summary || "";
      // CRITICAL: Pass full tool steps so agent sees what tools returned
      if (m.steps && m.steps.length) {
        entry.steps = m.steps;
      }
    }

    return entry;
  });

  showThread();
  var attachment = pendingAttachment;
  pendingAttachment = null;
  clearAttachment();
  appendUserMsg(text, false, attachment);
  var payload = { text: text, history: history };
  if (attachment) payload.attachment = attachment;
  var agentResult = { summary: '<span class="chat-streaming-cursor">Thinking<span class="dot"></span><span class="dot"></span><span class="dot"></span></span>', steps: [] };
  var aiDiv = appendAgentMsg(agentResult, false);
  api("/api/chat/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .then(function (res) {
      if (res.fallback) {
        var inner = $("chat-thread-inner");
        var kids = inner.children;
        inner.removeChild(kids[kids.length - 1]);
        inner.removeChild(kids[kids.length - 1]);
        busy = false;
        clearPromptLoading();
        $("chat-send").disabled = false;
        $("chat-send").classList.remove("is-busy");
        startThread(text, chooseSteps(text));
        return;
      }
      if (res.error) {
        aiDiv.querySelector(".assistant-summary").innerHTML = "**Agent error:** " + esc(res.error);
        agentResult.summary = "**Agent error:** " + esc(res.error);
      } else {
        aiDiv.querySelector(".assistant-summary").innerHTML = renderAgentHTML(res.summary || "");
        agentResult.summary = res.summary || "";
        renderResultGrids(agentGridResults(res.steps || []), aiDiv.querySelector(".chat-results"));
        var c2 = getConv(currentConvId);
        if (c2) {
          c2.messages.push({ role: "user", text: text, attachment: attachment || null });
          c2.messages.push({ role: "assistant", summary: res.summary, steps: res.steps, model: res.model });
          upsertConv(c2); renderSidebar(); updateConvHeader();
        }
      }
    })
    .catch(function (e) {
      aiDiv.querySelector(".assistant-summary").innerHTML = "**Agent error:** " + esc(e.message || String(e));
    })
    .then(function () {
      busy = false;
      clearPromptLoading();
      $("chat-send").disabled = false;
      $("chat-send").classList.remove("is-busy");
    });
}

/* Stream agent events for progressive UI updates. */
function streamAgentThread(text) {
  if (busy) return;
  busy = true;
  $("chat-send").disabled = true;
  $("chat-send").classList.add("is-busy");
  var conv = activeConv || getConv(currentConvId) || newConv();
  currentConvId = conv.id;
  activeConv = conv;
  var history = conv.messages.map(function (m) {
    var entry = { role: m.role, attachment: m.attachment || null };

    if (m.role === "user") {
      entry.text = m.text || "";
    } else if (m.role === "assistant") {
      entry.text = m.summary || "";
      if (m.steps && m.steps.length) {
        entry.steps = m.steps;
      }
    }

    return entry;
  });

  showThread();
  var attachment = pendingAttachment;
  pendingAttachment = null;
  clearAttachment();
  appendUserMsg(text, false, attachment);

  var payload = { text: text, history: history };
  if (attachment) payload.attachment = attachment;

  var agentResult = { summary: "", steps: [] };
  var aiDiv = appendAgentMsg(agentResult, false);
  var summaryEl = aiDiv.querySelector(".assistant-summary");
  var resultsEl = aiDiv.querySelector(".chat-results");
  summaryEl.innerHTML = '<div class="chat-streaming-cursor">Analyzing request<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';

  var fullText = "";
  var streamSteps = [];
  var chipMap = {};
  var toolset = null;
  var aborted = false;

  function cleanup() {
    aborted = true;
    busy = false;
    clearPromptLoading();
    $("chat-send").disabled = false;
    $("chat-send").classList.remove("is-busy");
  }

  function fallback() {
    var inner = $("chat-thread-inner");
    var kids = inner.children;
    if (kids.length >= 2) {
      inner.removeChild(kids[kids.length - 1]);
      inner.removeChild(kids[kids.length - 1]);
    }
    cleanup();
    startThread(text, chooseSteps(text));
  }

  var streamTimer = setTimeout(function () {
    if (!aborted) fallback();
  }, 30000);

  fetch("/api/chat/agent/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (!res.ok) throw new Error("Streaming endpoint unavailable");
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    function read() {
      return reader.read().then(function (result) {
        if (result.done) {
          if (!aborted) cleanup();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(function (line) {
          line = line.trim();
          if (!line) return;
          try {
            var event = JSON.parse(line);
            if (event.type === "error") {
              if (event.fallback) fallback();
              else {
                summaryEl.innerHTML = "**Agent error:** " + esc(event.error || "Unknown error");
                cleanup();
              }
            } else if (event.type === "thinking") {
              var msg = event.stage === "calling_model" ? "Calling model (round " + (event.round || 1) + ")" : "Preparing request";
              summaryEl.innerHTML = '<div class="chat-streaming-cursor">' + esc(msg) + '<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
            } else if (event.type === "tool_start") {
              if (!toolset) {
                toolset = document.createElement("div");
                toolset.className = "chat-toolset";
                var body = aiDiv.querySelector(".chat-msg-body");
                var narrative = body.querySelector(".chat-narrative");
                if (!narrative) {
                  narrative = document.createElement("div");
                  narrative.className = "chat-narrative";
                  narrative.textContent = narrateRequest(text, null);
                  body.insertBefore(narrative, summaryEl);
                }
                body.insertBefore(toolset, summaryEl);
              }
              summaryEl.innerHTML = '<span style="color:var(--text3)">' + esc(narrateTool(event.name)) + '…</span>';
              var chipWrap = createToolChip(toolset, event.name);
              chipMap[event.name] = chipWrap;
              streamSteps.push({ name: event.name, rows: [], rc: 0, res: {}, error: null, arguments: event.arguments || {} });
            } else if (event.type === "tool_complete") {
              var step = event.step;
              var chipWrap = chipMap[step.name];
              if (chipWrap) {
                finishToolChip(chipWrap, step.name, step, step.execution_ms || 0);
              }
              for (var i = 0; i < streamSteps.length; i++) {
                if (streamSteps[i].name === step.name) {
                  streamSteps[i] = step;
                  break;
                }
              }
            } else if (event.type === "token") {
              fullText += event.text;
              summaryEl.innerHTML = renderAgentHTML(fullText) + '<span class="chat-streaming-cursor--inline"><span class="cursor-blink">▊</span></span>';
            } else if (event.type === "done") {
              var finalSummary = event.summary || fullText;
              summaryEl.innerHTML = renderAgentHTML(finalSummary);
              if (resultsEl && event.steps && event.steps.length) {
                renderResultGrids(event.steps.filter(function(s) { return !s.error && s.rows && s.rows.length; }), resultsEl);
              }
              var c2 = getConv(currentConvId);
              if (c2) {
                c2.messages.push({ role: "user", text: text, attachment: attachment || null });
                c2.messages.push({ role: "assistant", summary: finalSummary, steps: event.steps || streamSteps, model: event.model });
                upsertConv(c2); renderSidebar(); updateConvHeader();
              }
            }
          } catch (e) {
            // ignore parse errors
          }
        });
        if (!result.done && !aborted) return read();
      });
    }
    return read();
  }).catch(function (e) {
    if (!aborted) fallback();
  }).then(function () {
    clearTimeout(streamTimer);
    if (!aborted) cleanup();
  });
}

/* ---------- tool chip helpers ---------- */
var TOOL_NARRATIVE = {
  "hana_health_check": "Checking overall database health",
  "hana_memory": "Reviewing memory usage",
  "hana_cpu": "Reviewing CPU usage",
  "hana_disk": "Reviewing disk usage",
  "hana_connections": "Checking active connections",
  "hana_services": "Checking service status",
  "hana_blocked_transactions": "Looking for blocked transactions",
  "hana_replication": "Checking replication status",
  "hana_backup_status": "Checking backup status",
  "hana_expensive_statements": "Finding expensive statements",
  "hana_active_statements": "Reviewing active statements",
  "hana_table_sizes": "Looking at table sizes",
  "hana_trace_files": "Reviewing trace files",
  "hana_system_status": "Gathering system status",
  "hana_execute_query": "Running your query",
  "hana_metric_history": "Pulling metric history",
  "hana_compare_periods": "Comparing recent periods",
  "hana_detect_anomalies": "Detecting anomalies",
  "hana_discover_monitoring_views": "Discovering monitoring views",
  "hana_search_views": "Searching monitoring views",
  "hana_describe_view": "Describing a view",
  "hana_list_schemas": "Listing schemas",
  "hana_list_tables": "Listing tables",
  "hana_describe_table": "Describing a table"
};
function narrateTool(name) {
  if (!name) return "Working on your request";
  return TOOL_NARRATIVE[name] || ("Running " + name.replace(/^hana_/, "").replace(/_/g, " "));
}
function narrateRequest(userText, steps) {
  if (!userText) return "Working on your request…";
  var cleaned = userText.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Working on your request…";
  var lower = cleaned.toLowerCase();
  if (lower.endsWith("?") || /^(what|how|why|when|where|who|can|could|show|tell|list|find|check|get|is|are|do|does)\b/.test(lower)) {
    return 'Looking into "' + cleaned + '"';
  }
  return 'Handling "' + cleaned + '"';
}
function createToolChip(toolset, name) {
  var wrap = document.createElement("div");
  wrap.className = "toolchip-wrap";
  wrap.innerHTML = '<div class="toolchip busy"><span class="tc-status run"></span><span class="tc-name">' + esc(narrateTool(name)) + '</span></div>';
  toolset.appendChild(wrap);
  return wrap;
}
function finishToolChip(chipWrap, name, res, ms) {
  var chip = chipWrap.querySelector(".toolchip");
  var status = chipWrap.querySelector(".tc-status");
  chip.classList.remove("busy");
  if (res.error) {
    status.className = "tc-status err";
  } else {
    status.className = "tc-status ok";
  }
  var thread = $("chat-thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

/* ---------- run tool steps and build a smooth summary ---------- */
function runSteps(steps, aiDiv, opts) {
  return new Promise(function (resolve) {
    var body = aiDiv.querySelector(".chat-msg-body");
    var toolset = document.createElement("div");
    toolset.className = "chat-toolset";
    var summary = aiDiv.querySelector(".assistant-summary");
    var narrative = body.querySelector(".chat-narrative");
    if (!narrative) {
      narrative = document.createElement("div");
      narrative.className = "chat-narrative";
      body.insertBefore(narrative, toolset);
    }
    var userText = (opts && opts.userText) || convLastUser();
    narrative.textContent = narrateRequest(userText, steps);
    body.insertBefore(toolset, summary);
    summary.innerHTML = '<div class="chat-streaming-cursor">Reading system state<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    var results = [];
    var idx = 0;

    function next() {
      if (idx >= steps.length) {
        var single = results.length === 1;
        var nm = single ? results[0].name : "";
        var s = (single && nm !== "__greet__" && nm !== "__unknown__") ? buildFocusedSummary(results) : buildSummary(results);
        summary.innerHTML = renderAgentHTML(s);
        var resultsEl = aiDiv.querySelector(".chat-results");
        if (resultsEl) renderResultGrids(results, resultsEl);
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
      var chipWrap = createToolChip(toolset, name);
      var t0 = Date.now();
      var params = toolParams(name);
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 20000);
      api("/api/tool/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal: controller.signal })
        .then(function (res) {
          clearTimeout(timer);
          var ms = Date.now() - t0;
          finishToolChip(chipWrap, name, res, ms);
          if (res.error) {
            results.push({ name: name, error: res.error });
          } else {
            var rows = res.rows || [];
            if (!rows.length && res.points) rows = res.points;
            if (!rows.length && res.anomalies) rows = res.anomalies;
            var rc = res.row_count != null ? res.row_count : (rows.length || 0);
            results.push({ name: name, rows: rows, rc: rc, res: res, _ms: ms });
          }
          next();
        })
        .catch(function (e) {
          clearTimeout(timer);
          var err = (e && e.name === "AbortError") ? "Tool timed out after 20s" : (e.message || String(e));
          finishToolChip(chipWrap, name, { error: err }, Date.now() - t0);
          results.push({ name: name, error: err, _ms: Date.now() - t0 });
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

/* Focused narrative for a single monitoring tool (memory / cpu / connections). */
function buildFocusedSummary(results) {
  if (!results.length) return "No results were returned.";
  var r = results[0];
  if (r.error) return "**" + r.name + "** returned an error: " + esc(r.error);
  if (r.name === "hana_metric_history") {
    var pts = (r.res && r.res.points) || [];
    if (!pts.length) return "I don't have any metric history recorded yet. The dashboard snapshots the system every 30s, so ask again after it has been running a while.";
    var last = pts[pts.length - 1];
    return "Over the last **" + (r.res.window_minutes) + "** min I have **" + pts.length + "** snapshot(s). Latest: CPU **" + Math.round(last.cpu_usage * 10) / 10 + "%**, memory **" + Math.round(last.memory_usage * 10) / 10 + "%**, connections **" + last.connections + "**.";
  }
  if (r.name === "hana_compare_periods") {
    var cm = (r.res && r.res.metrics) || {};
    var clines = [];
    ["cpu_usage", "memory_usage", "connections"].forEach(function (k) {
      var d = cm[k]; if (!d) return;
      var dp = d.delta_pct != null ? (d.delta_pct >= 0 ? " +" : " ") + d.delta_pct + "%" : " n/a";
      clines.push("- **" + k.replace(/_/g, " ") + "**: " + (d.recent_avg != null ? d.recent_avg : "?") + " vs " + (d.prior_avg != null ? d.prior_avg : "?") + " (" + dp + ")");
    });
    return "Comparing the last **" + r.res.recent_minutes + "** min vs the **" + r.res.prior_minutes + "** min before:\n\n" + clines.join("\n");
  }
  if (r.name === "hana_detect_anomalies") {
    var an = (r.res && r.res.anomalies) || [];
    if (!an.length) return "No anomalies in the last **" + r.res.window_minutes + "** min (threshold " + r.res.threshold_std_devs + "σ). Metrics look stable.";
    var ahead = an.slice(0, 8).map(function (x) {
      return "- " + x.captured_at + " **" + x.metric + "** = " + x.value + " (mean " + x.mean + ", Δ" + x.deviation + ")";
    }).join("\n");
    return "Found **" + an.length + "** anomalous point(s) in the last **" + r.res.window_minutes + "** min:\n\n" + ahead + (an.length > 8 ? "\n\n…and " + (an.length - 8) + " more." : "");
  }
  if (r.name === "hana_health_check") {
    return (r.res && r.res.summary) || "The health check completed, but did not return a summary.";
  }
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
    out.push(used != null ? "You're currently using **" + fmtBytes2(used) + "** of memory." : "I couldn't read the current memory usage from the results.");
    if (limit != null) out.push("The allocation limit is **" + fmtBytes2(limit) + "**.");
    var pct = (used != null && limit != null) ? Math.round(used / limit * 100) : null;
    if (pct != null) out.push(pct >= 85 ? "That's **" + pct + "%** — getting high, worth watching." : pct >= 70 ? "That's **" + pct + "%** — creeping up, but still okay for now." : "That's **" + pct + "%** — comfortably within normal range.");
    return out.join("\n\n");
  }

  if (r.name === "hana_cpu") {
    var c = rows[0];
    var userT = num(c.TOTAL_CPU_USER_TIME) + num(c.TOTAL_CPU_SYSTEM_TIME);
    var totT = userT + num(c.TOTAL_CPU_IDLE_TIME);
    var util = totT ? Math.round(userT / totT * 100) + "%" : "n/a";
    return "CPU is running at about **" + util + "** on **" + (c.HOST || "the instance") + "**.";
  }

  if (r.name === "hana_connections") {
    var conn = rows[0];
    var connVal = conn.CONNECTIONS != null ? conn.CONNECTIONS : rows.length;
    return "You've got **" + connVal + "** active connection" + (connVal === 1 ? "" : "s") + " right now.";
  }

  if (rows.length) {
    return "**" + esc(r.name) + "** returned **" + rows.length + "** row(s).";
  }
  return "That check returned no rows right now.";
}

function buildSummary(results) {
  var ok = results.filter(function (r) { return !r.error; });
  var errors = results.filter(function (r) { return r.error; });
  var lines = [];

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

  if (results.some(function (r) { return r.name === "__unknown__"; })) {
    return "I'm a **read-only SAP HANA monitoring assistant**, so I can't help with that.\n\n" +
      "I **can** tell you about live database health, memory, CPU, connections, services, disk/storage, backups, blocked transactions, recent errors, expensive queries, and schema objects — all read-only.\n\n" +
      "Try a prompt like **\"how healthy is my database?\"** or **\"show disk usage\"**.";
  }

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
      ? "all **" + svcRows.length + "** services look healthy — " + svcNames.join(", ") + " on **" + host + "**."
      : "I didn't get service rows back.";
    lines.push("Your instance is running fine overall.");
    lines.push("**Services** — " + svcText);

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
      lines.push("**Memory** — " + ((used ? "currently using **" + used + "**" : "couldn't read current usage") + (limit ? " out of **" + limit + "**" : "") + "."));
    }

    var c = firstRow(results, "hana_cpu");
    if (c && (c.TOTAL_CPU_USER_TIME != null || c.TOTAL_CPU_ACTIVE_TIME != null)) {
      var userT = num(c.TOTAL_CPU_USER_TIME) + num(c.TOTAL_CPU_SYSTEM_TIME);
      var totT = userT + num(c.TOTAL_CPU_IDLE_TIME);
      var util = totT ? Math.round(userT / totT * 100) + "%" : "n/a";
      lines.push("**CPU** — about **" + util + "** utilization on **" + (c.HOST || host) + "**.");
    }

    var conn = firstRow(results, "hana_connections");
    var connVal = conn.CONNECTIONS != null ? conn.CONNECTIONS : (rowsOf(results, "hana_connections").length || 0);
    if (connVal) {
      lines.push("**Connections** — **" + connVal + "** active right now.");
    }

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
      lines.push("**Disk** — " + parts.join("; ") + ".");
    }

    var backupRows = rowsOf(results, "hana_backup_status");
    lines.push(backupRows.length
      ? "**Backups** — " + backupRows.length + " backup record(s) found."
      : "**Backups** — no records found. That's a gap worth noting: if the container or volume is lost, there's no recovery path.");

    var lockRows = rowsOf(results, "hana_blocked_transactions");
    lines.push(lockRows.length
      ? "**Locks** — **" + lockRows.length + "** blocked transaction(s) right now."
      : "**Locks** — all clear, nothing blocked.");

    if (errors.length) {
      lines.push("A couple of secondary checks didn't complete: " + errors.map(function (e) { return "**" + e.name + "** (" + esc(e.error) + ")"; }).join(", ") + ".");
    }
    return lines.join("\n\n");
  }

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
      if (!rows.length) { lines.push("No expensive statements recorded recently."); return; }
      lines.push("Found **" + rows.length + "** expensive statement(s).");
      return;
    }
    if (r.name === "hana_trace_files") {
      lines.push("Found **" + rows.length + "** trace file(s).");
      return;
    }
    if (r.name === "hana_execute_query") {
      lines.push("Query returned **" + (r.rc || rows.length) + "** row(s).");
      return;
    }
    if (r.name === "hana_discover_monitoring_views") {
      if (!rows.length) { lines.push("No monitoring (M_*) views were found in this instance."); return; }
      var groups = groupViews(rows);
      lines.push("Found **" + rows.length + "** monitoring views across **" + groups.length + "** categories.");
      return;
    }
    if (r.name === "hana_search_views") {
      lines.push(rows.length
        ? "Found **" + rows.length + "** matching view(s)."
        : "No views matched that search.");
      return;
    }
    if (rows.length) {
      lines.push("**" + esc(r.name) + "** returned **" + r.rc + "** row(s).");
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

/* Generate a short SQL-like preview for a tool result */
function toolSqlPreview(name, res) {
  if (name === "hana_execute_query" && res && res.sql) return res.sql;
  var params = toolParams(name);
  if (params.sql) return params.sql;
  if (params.table_name) return "SELECT * FROM " + (params.schema ? params.schema + "." : "") + params.table_name;
  if (params.view_name) return "SELECT * FROM " + (params.schema ? params.schema + "." : "") + params.view_name;
  if (params.keyword) return "SELECT * FROM M_* WHERE keyword LIKE '%" + params.keyword + "%'";
  return name;
}

/* Render structured data grids for tool results that have rows */
function renderResultGrids(results, container) {
  results.forEach(function (r) {
    if (r.error || !r.rows || !r.rows.length) return;
    var rows = r.rows.slice(0, 200);
    var cols = Object.keys(rows[0] || {});
    var rc = r.row_count != null ? r.row_count : (r.rows.length || 0);
    var ms = r._ms || "";
    var source = r.name;
    if (r.name === "hana_execute_query" && r.res && r.res.sql) source = r.res.sql;

    var meta = document.createElement("div");
    meta.className = "chat-result-meta";
    meta.innerHTML =
      '<span class="chat-result-meta__count">' + esc(String(rc)) + ' rows</span>' +
      (ms ? '<span class="chat-result-meta__time">' + esc(ms) + ' ms</span>' : '') +
      '<span class="chat-result-meta__source">' + esc(source) + '</span>' +
      '<div class="chat-result-meta__actions">' +
      '<button class="chat-result-meta__action" data-act="copy-all">Copy</button>' +
      '<button class="chat-result-meta__action" data-act="export-csv">Export CSV</button>' +
      '</div>';
    container.appendChild(meta);

    var wrap = document.createElement("div");
    wrap.className = "chat-table-wrap";
    var table = document.createElement("table");
    table.className = "chat-table";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    cols.forEach(function (c) {
      var th = document.createElement("th");
      th.textContent = c;
      th.dataset.col = c;
      th.innerHTML += ' <span class="sort-icon">▲</span>';
      th.addEventListener("click", function () {
        sortChatTable(table, c);
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      cols.forEach(function (c) {
        var td = document.createElement("td");
        var cellVal = row[c] != null ? String(row[c]) : "";
        td.textContent = cellVal;
        td.title = cellVal;
        td.dataset.value = cellVal;
        var action = document.createElement("span");
        action.className = "cell-action";
        action.textContent = "⧉";
        action.title = "Copy cell";
        action.addEventListener("click", function (e) {
          e.stopPropagation();
          var val = td.dataset.value || "";
          if (navigator.clipboard) navigator.clipboard.writeText(val).catch(function () { });
        });
        td.appendChild(action);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    meta.querySelector('[data-act="copy-all"]').addEventListener("click", function () {
      var txt = cols.join("\t") + "\n" + rows.map(function (row) { return cols.map(function (c) { return row[c] != null ? row[c] : ""; }).join("\t"); }).join("\n");
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () { });
    });
    meta.querySelector('[data-act="export-csv"]').addEventListener("click", function () {
      var csv = cols.join(",") + "\n" + rows.map(function (row) { return cols.map(function (c) { var v = row[c] != null ? String(row[c]) : ""; if (v.indexOf(",") >= 0 || v.indexOf('"') >= 0) v = '"' + v.replace(/"/g, '""') + '"'; return v; }).join(","); }).join("\n");
      var blob = new Blob([csv], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = (r.name || "result") + ".csv"; a.click();
      URL.revokeObjectURL(url);
    });
  });
}

function sortChatTable(table, col) {
  var tbody = table.querySelector("tbody");
  var rows = Array.from(tbody.querySelectorAll("tr"));
  var ths = Array.from(table.querySelectorAll("th"));
  var colIdx = ths.findIndex(function (th) { return th.dataset.col === col; });
  var asc = !table.dataset.sortCol || table.dataset.sortDir === "desc";
  table.dataset.sortCol = col;
  table.dataset.sortDir = asc ? "asc" : "desc";
  ths.forEach(function (th) {
    th.classList.toggle("sorted", th.dataset.col === col);
  });
  rows.sort(function (a, b) {
    var aTd = a.children[colIdx];
    var bTd = b.children[colIdx];
    var aText = (aTd ? (aTd.dataset.value || aTd.textContent).trim() : "").toLowerCase();
    var bText = (bTd ? (bTd.dataset.value || bTd.textContent).trim() : "").toLowerCase();
    var aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ""));
    var bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(aNum) && !isNaN(bNum)) return asc ? aNum - bNum : bNum - aNum;
    if (aText < bText) return asc ? -1 : 1;
    if (aText > bText) return asc ? 1 : -1;
    return 0;
  });
  rows.forEach(function (r) { tbody.appendChild(r); });
}

/* ---------- sensible params for chat tool calls ---------- */
function toolParams(name) {
  var map = {
    "hana_execute_sap_statement": { name: "HANA_Memory_Components_2.00.056+" },
    "hana_explain_sap_statement": { name: "HANA_Memory_Components_2.00.056+" },
    "hana_search_sap_library": { keyword: "memory" },
    "hana_search_sap_by_note": { note: "1969700" },
    "hana_search_sap_by_component": { component: "memory" },
    "hana_search_sap_by_table": { table: "M_MEMORY" }
  };
  if (name === "hana_execute_query") {
    return pickedSql
      ? { sql: pickedSql }
      : { sql: "SELECT TOP 200 SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS ORDER BY VIEW_NAME" };
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
  var greetings = /\b(hi|hello|hey|yo|howdy|good\s+(morning|afternoon|evening)|how\s+are\s+(you|u|r\s+u)|what'?s\s+up|sup|wassup|thanks|thank\s+you|thx|bye|goodbye|see\s+you|who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do)\b/;
  if (greetings.test(t)) {
    return ["__greet__"];
  }
  var offTopic = /\b(weather|stock|joke|poem|soccer|football|movie|movie|film|song|music|cook|cooking|recipe|pizza|fashion|shopping|love|girlfriend|boyfriend|kiss|dance|party|your mom|your mother|mommy|mother|mom|idiot|stupid|dumb|suck|ugly|hate|hates|loser|nonsense|garbage|rubbish)\b/i;
  if (offTopic.test(text)) {
    return ["__unknown__"];
  }
  pickedSql = null;
  var spec = text.match(/([A-Z_][A-Z0-9_]*\.[A-Z_][A-Z0-9_]*|[A-Z_][A-Z0-9_]{3,})/);
  if (spec) {
    var word = spec[1].toUpperCase();
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
  if (t.indexOf("health") >= 0 || t.indexOf("healthy") >= 0 || t.indexOf("system status") >= 0) return ["hana_health_check"];
  if (t.indexOf("blocked") >= 0 || t.indexOf("lock") >= 0) return ["hana_blocked_transactions", "hana_connections"];
  if (t.indexOf("disk") >= 0 || t.indexOf("storage") >= 0 || t.indexOf("volumes") >= 0 || t.indexOf("volume") >= 0) return ["hana_disk"];
  if (t.indexOf("memory") >= 0 || t.indexOf("ram") >= 0) return ["hana_memory"];
  if (t.indexOf("cpu") >= 0 || t.indexOf("core") >= 0) return ["hana_cpu"];
  if (t.indexOf("connect") >= 0) return ["hana_connections"];
  if (t.indexOf("expensive") >= 0 || t.indexOf("slow") >= 0) return ["hana_expensive_statements"];
  if (t.indexOf("replic") >= 0) return ["hana_replication"];
  if (t.indexOf("backup") >= 0) return ["hana_backup_status"];
  if (t.indexOf("user") >= 0) {
    var userMatch = text.match(/user\s+named\s+(\w+)/i);
    if (userMatch) {
      pickedSql = "SELECT USER_NAME, USER_ID FROM SYS.USERS WHERE USER_NAME LIKE '%" + userMatch[1] + "%' ORDER BY USER_NAME";
    } else {
      pickedSql = "SELECT USER_NAME, USER_ID FROM SYS.USERS ORDER BY USER_NAME";
    }
    return ["hana_execute_query"];
  }
  if (t.indexOf("table") >= 0 || t.indexOf("tables") >= 0) return ["hana_table_sizes"];
  if (t.indexOf("view") >= 0) {
    if (t.indexOf("find") >= 0 || t.indexOf("search") >= 0) {
      pickedSql = "SELECT TOP 200 SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS ORDER BY VIEW_NAME";
    } else {
      pickedSql = "SELECT TOP 200 SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS WHERE VIEW_NAME LIKE 'M_%' ORDER BY VIEW_NAME";
    }
    return ["hana_execute_query"];
  }
  if (t.indexOf("error") >= 0 || t.indexOf("issue") >= 0 || t.indexOf("problem") >= 0) return ["hana_trace_files", "hana_expensive_statements"];
  if (t.indexOf("log") >= 0 || t.indexOf("trace") >= 0) return ["hana_trace_files"];
  if (t.indexOf("service") >= 0) return ["hana_services"];
  if (t.indexOf("status") >= 0) return ["hana_system_status", "hana_services", "hana_memory", "hana_cpu", "hana_connections", "hana_disk", "hana_backup_status", "hana_blocked_transactions"];
  if (t) return ["hana_execute_query"];
  return ["__greet__"];
}

/* ---------- open a conversation ---------- */
function openConv(id) {
  var conv = getConv(id);
  if (!conv) return;
  currentConvId = id;
  activeConv = conv;
  renderSidebar();
  if (conv.messages.length) {
    renderThread(conv);
    updateConvHeader();
  } else {
    showWelcome();
    updateConvHeader();
  }
}

/* ---------- form submit ---------- */
$("chat-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var text = $("chat-input").value.trim();
  if (!text && !pendingAttachment) return;
  $("chat-input").value = "";
  $("chat-input").style.height = "auto";
  dispatch(text);
});

$("chat-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 140) + "px";
});
$("chat-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    var text = this.value.trim();
    if ((text || pendingAttachment) && !busy) {
      this.value = "";
      this.style.height = "auto";
      dispatch(text);
    }
  }
});

/* ---------- live connection indicator (polls /api/system/status) ---------- */
function pollConnection() {
  api("/api/system/status").then(function (s) {
    var online = s && s.status === "ONLINE";
    var dot = $("chat-ctx-dot");
    if (dot) dot.className = "chat-head-dot " + (online ? "online" : "error");
    var db = s.database || "HXE";
    var user = s.user || "SYSTEM";
    var ctxDb = $("chat-ctx-db");
    var ctxUser = $("chat-ctx-user");
    var ctxRo = $("chat-ctx-ro");
    if (ctxDb) ctxDb.textContent = db;
    if (ctxUser) ctxUser.textContent = user.toUpperCase();
    if (ctxRo) { ctxRo.textContent = online ? "Read-only" : "Offline"; ctxRo.className = "topbar__badge" + (online ? " topbar__badge--muted" : ""); }
    var errBanner = $("chat-error-banner");
    if (errBanner) errBanner.hidden = online;
    if (online) updateTopbar(s);
  }).catch(function () {
    var dot = $("chat-ctx-dot");
    if (dot) dot.className = "chat-head-dot reconnect";
    var ctxRo = $("chat-ctx-ro");
    if (ctxRo) ctxRo.textContent = "Reconnecting…";
    var errBanner = $("chat-error-banner");
    var errText = $("chat-error-text");
    if (errBanner) errBanner.hidden = false;
    if (errText) errText.textContent = "Gateway unavailable — cannot reach SAP HANA. Monitoring tools may still work when connection is restored.";
  });
}

/* ---------- chat init ---------- */
function loadAgentConfig() {
  api("/api/chat/config").then(function (c) {
    agentEnabled = !!c.enabled;
    document.body.classList.toggle("agent-on", agentEnabled);
  }).catch(function () {
    agentEnabled = false;
  });
}

var _pollTimer = null;
function startPoll() {
  if (_pollTimer) return;
  pollConnection();
  _pollTimer = setInterval(pollConnection, 15000);
}
function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
window.toggleConnectionPoll = function (on) {
  if (on) startPoll(); else stopPoll();
};

(function chatInit() {
  loadAgentConfig();
  startPoll();
  setTimeout(function () {
    var convs = loadConvs();
    if (convs.length) { currentConvId = convs[0].id; activeConv = convs[0]; renderSidebar(); }
    else { renderSidebar(); }
  }, 100);
})();

/* Re-poll when the user switches away from the chat view to avoid wasted
   API calls while they are on the dashboard or SQL console. */
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && $("view-chat") && $("view-chat").classList.contains("active")) {
    startPoll();
  } else {
    stopPoll();
  }
});

/* ---------- suggested prompt cards (onboarding) ---------- */
function clearPromptLoading() {
  var cards = document.querySelectorAll(".chat-prompt-card");
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove("is-loading");
}
document.addEventListener("click", function (e) {
  var card = e.target.closest(".chat-prompt-card");
  if (!card || busy) return;
  var grid = e.target.closest(".chat-prompt-strip");
  if (!grid) return;
  card.classList.add("is-loading");
  dispatch(card.dataset.prompt);
});

/* ---------- init ---------- */
(function initView() {
  var last = "dashboard";
  try { last = localStorage.getItem(LAST_VIEW_KEY) || "dashboard"; } catch (e) { }
  if (VIEWS.indexOf(last) < 0) last = "dashboard";
  show(last);
})();
renderSqlHistory();
pollConnection();
setInterval(loadDashboard, 30000);
