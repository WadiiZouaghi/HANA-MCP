/* ---------- SQL CONSOLE ---------- */
var SQL_HIST_KEY = "hana_sql_history";
var LAST_SQL_ROWS = [];
var SQL_PAGE_SIZE = 50;
var SQL_CURRENT_PAGE = 1;
var SQL_SORT_COL = null;
var SQL_SORT_DIR = 1;

function getSqlHistory() {
  try {
    var h = JSON.parse(localStorage.getItem(SQL_HIST_KEY) || "[]");
    if (h.length && typeof h[0] === "string") {
      h = h.map(function (sql) { return { sql: sql, ts: Date.now(), success: true }; });
      try { localStorage.setItem(SQL_HIST_KEY, JSON.stringify(h)); } catch (e) {}
    }
    return h;
  }
  catch (e) { return []; }
}
function pushSqlHistory(sql, success) {
  if (!sql) return;
  var h = getSqlHistory().filter(function (s) { return s.sql !== sql; });
  h.unshift({ sql: sql, ts: Date.now(), success: !!success });
  if (h.length > 50) h.length = 50;
  try { localStorage.setItem(SQL_HIST_KEY, JSON.stringify(h)); } catch (e) {}
  renderSqlHistory();
}
function renderSqlHistory() {
  var h = getSqlHistory();
  var el = $("sql-history-list");
  var search = ($("sql-history-search") || {}).value || "";
  if (!h.length) { el.innerHTML = '<div class="sql-history-empty">No queries yet.</div>'; return; }
  var groups = {};
  var now = Date.now();
  var day = 86400000;
  h.forEach(function (item) {
    if (search && item.sql.toLowerCase().indexOf(search.toLowerCase()) < 0) return;
    var age = now - item.ts;
    var label = "Older";
    if (age < day) label = "Today";
    else if (age < day * 2) label = "Yesterday";
    else if (age < day * 7) label = "This Week";
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  });
  var html = "";
  var order = ["Today", "Yesterday", "This Week", "Older"];
  order.forEach(function (g) {
    if (!groups[g]) return;
    html += '<div class="sql-history__group"><div class="sql-history__group-label">' + esc(g) + "</div>";
    groups[g].forEach(function (item) {
      var cls = "sql-history__item";
      if (!item.success) cls += " sql-history__item--error";
      html += '<div class="' + cls + '" data-sql="' + escAttr(item.sql) + '">' +
        '<span class="sql-history__item__sql">' + esc(item.sql) + "</span>" +
        '<span class="sql-history__item__actions">' +
          '<button class="sql-history__action sql-history__rerun" title="Re-run">↻</button>' +
        '</span></div>';
    });
    html += "</div>";
  });
  el.innerHTML = html;
  el.querySelectorAll(".sql-history__item").forEach(function (item) {
    item.addEventListener("click", function (e) {
      if (e.target.classList.contains("sql-history__rerun")) {
        $("sql-editor").value = item.dataset.sql;
        $("sql-run").click();
        return;
      }
      $("sql-editor").value = item.dataset.sql;
      $("sql-editor").focus();
    });
  });
}
renderSqlHistory();

/* ---------- Collapsible history ---------- */
var historyCollapsed = false;
var sqlHistoryEl = $("sql-history");
var sqlHistoryToggle = $("sql-history-toggle");
if (sqlHistoryToggle && sqlHistoryEl) {
  sqlHistoryToggle.addEventListener("click", function () {
    historyCollapsed = !historyCollapsed;
    sqlHistoryEl.classList.toggle("is-collapsed", historyCollapsed);
    sqlHistoryToggle.textContent = historyCollapsed ? "+" : "−";
    if (historyCollapsed) {
      sqlHistoryEl.querySelector(".sql-history__search-wrap").hidden = true;
      sqlHistoryEl.querySelector(".sql-history__list").hidden = true;
      sqlHistoryEl.querySelector(".sql-history__head").querySelector("h3").hidden = true;
    } else {
      sqlHistoryEl.querySelector(".sql-history__search-wrap").hidden = false;
      sqlHistoryEl.querySelector(".sql-history__list").hidden = false;
      sqlHistoryEl.querySelector(".sql-history__head").querySelector("h3").hidden = false;
    }
  });
}
if ($("sql-history-search")) {
  $("sql-history-search").addEventListener("input", function () { renderSqlHistory(); });
}

/* ---------- SQL snippets (pills) ---------- */
document.querySelectorAll(".sql-snippet").forEach(function (btn) {
  btn.addEventListener("click", function () {
    $("sql-editor").value = btn.dataset.sql;
    updateEditor();
    $("sql-editor").focus();
  });
});

/* ---------- Syntax highlighting ---------- */
var SQL_KEYWORDS = "SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|ASC|DESC|BETWEEN|LIKE|EXISTS|OVER|PARTITION|BY|CAST|CONVERT|CURRENT|DATE|TIME|TIMESTAMP|CURRENT_USER|SESSION_USER|SYSTEM_USER|USER|CURRENT_SCHEMA|CURRENT_CONNECTION|TOP|SET|VALUES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|VIEW|SCHEMA|PROCEDURE|FUNCTION|TRIGGER|MERGE|CALL|DECLARE|BEGIN|END|IF|THEN|ELSE|LOOP|WHILE|FOR|RETURN|EXIT|CONTINUE|GOTO|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|UNLOCK|GRANT|REVOKE|COMMENT|PASS|WITH|RECURSIVE|TEMPORARY|TEMP|GLOBAL|LOCAL|COLUMN|CONSTRAINT|PRIMARY|FOREIGN|KEY|REFERENCES|UNIQUE|CHECK|DEFAULT|AUTO_INCREMENT|IDENTITY|SEQUENCE|NEXTVAL|CURRVAL|LASTVAL|ROW_NUMBER|RANK|DENSE_RANK|PERCENT_RANK|CUME_DIST|NTILE|LAG|LEAD|FIRST_VALUE|LAST_VALUE|NTH_VALUE|AGGREGATE|CALC|COLUMN|STORE|FORWARD|ONLY|READ|WRITE|WITH|PARAMETERS|CS|NONE|UNNEST|JOIN|LEFT|OUTER|INNER|CROSS|NATURAL|FULL".split("|");
var SQL_FUNCTIONS = "COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|CONVERT|TRIM|SUBSTRING|UPPER|LOWER|LENGTH|CHAR_LENGTH|REPLACE|REGEXP_REPLACE|REGEXP_LIKE|REGEXP_SUBSTR|CONCAT|CONCAT_WS|FORMAT|TO_CHAR|TO_VARCHAR|TO_NVARCHAR|TO_INT|TO_BIGINT|TO_SMALLINT|TO_TINYINT|TO_DOUBLE|TO_REAL|TO_DECIMAL|TO_NUMBER|TO_DATE|TO_TIME|TO_TIMESTAMP|ADD_DAYS|ADD_MONTHS|ADD_YEARS|DAYS_BETWEEN|MONTHS_BETWEEN|YEARS_BETWEEN|SECONDS_BETWEEN|MINUTES_BETWEEN|HOURS_BETWEEN|WEEKS_BETWEEN|QUARTERS_BETWEEN|EXTRACT|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|WEEK|QUARTER|DAYOFWEEK|DAYOFWEEK_ISO|DAYOFMONTH|DAYOFYEAR|WEEKDAY|WEEKOFYEAR|WEEKOFMONTH|ISOWEEK|ISOWEEKDAY|ISOWEEKYEAR|IS_YEAR|IS_QUARTER|IS_MONTH|IS_WEEK|IS_DAY|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|NOW|SYSDATE|SYSTIME|SYSTIMESTAMP|UTC_TIMESTAMP|GETDATE|DATEADD|DATEDIFF|DATENAME|DATEPART|TIMESTAMPADD|TIMESTAMPDIFF|MAKEDATE|MAKETIME|STR_TO_DATE|DATE_FORMAT|TIME_FORMAT|IFNULL|IF|IFNULL|DECODE|GREATEST|LEAST|SIGN|ABS|MOD|POWER|SQRT|EXP|LN|LOG|LOG10|ROUND|TRUNC|CEIL|FLOOR|PI|RAND|RADIANS|DEGREES|SIN|COS|TAN|ASIN|ACOS|ATAN|ATAN2|COT|DEGREES|RADIANS|HEX|UNHEX|BIN|OCT|LPAD|RPAD|SPACE|REPEAT|REVERSE|STRCMP|SOUNDEX|DIFFERENCE|MD5|SHA1|SHA2|ENCRYPT|DECRYPT|COMPRESS|UNCOMPRESS|ENCODE|DECODE|UUID|UUID_SHORT|VERSION|USER|CURRENT_USER|SESSION_USER|SYSTEM_USER|CURRENT_ROLE|CURRENT_SCHEMA|CURRENT_CATALOG|CURRENT_PATH|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|CURRENT_UTCTIME|CURRENT_UTCTIMESTAMP|LOCALUTCTIME|LOCALUTCTIMESTAMP|CURRENT_TIMEZONE|CURRENT_UTCTIMEZONE|CURRENT_APPLICATIONUSER|CURRENT_CLIENT|CURRENT_CONNECTION|CURRENT_ISOLATIONLEVEL|CURRENT_PACKAGE|CURRENT_PACKAGE_SCHEMA|CURRENT_PACKAGE_OWNER|CURRENT_PACKAGE_PATH|CURRENT_QUERY|CURRENT_SCHEMA|CURRENT_SESSION_GROUP|CURRENT_STATEMENT|CURRENT_TRANSACTION|CURRENT_USER|CURRENT_UTCOFFSET|CURRENT_UTCTIME|CURRENT_UTCTIMESTAMP|CURRENT_UTCTIMEZONE|DATABASE_NAME|HOST|PORT|SCHEMA_NAME|SERVER_NAME|SERVICE_NAME|SID|THREAD|THREAD_ID|TRACE_FILE|USER_NAME|VERSION|XMLAGG|XMLCOLATTVAL|XMLELEMENT|XMLFOREST|XMLGROUP|XMLPI|XMLQUERY|XMLROOT|XMLROW|XMLTABLE|XMLTEXT|XMLXSROBJECT|XSLTREGISTER|XSLTUNREGISTER|XSLEXISTS|XSLEXISTSFORUPDATE|XSLEXISTSNOTNULL|XSLTREGISTER|XSLTUNREGISTER|XSLEXISTS|XSLEXISTSFORUPDATE|XSLEXISTSNOTNULL|JSON_VALUE|JSON_QUERY|JSON_EXISTS|JSON_OBJECT|JSON_ARRAY|JSON_OBJECTAGG|JSON_ARRAYAGG|JSON_TABLE|JSON_SERIALIZE|JSON_DESERIALIZE|JSON_IS_VALID|JSON_LENGTH|JSON_KEYS|JSON_DEPTH|JSON_PRETTY|JSON_REMOVE|JSON_REPLACE|JSON_SET|JSON_INSERT|JSON_MERGE|JSON_MERGE_PRESERVE|JSON_MERGE_KEEP|JSON_MERGE_PATCH|JSON_PRESERVE|JSON_KEEP|JSON_PATCH|JSON_MULTISET|JSON_MULTISET_EXCEPT|JSON_MULTISET_INTERSECT|JSON_MULTISET_UNION|JSON_MULTISET_INTERSECT|JSON_MULTISET_EXCEPT|JSON_MULTISET_UNION|JSON_MULTISET_INTERSECT|JSON_MULTISET_EXCEPT|JSON_MULTISET_UNION|JSON_MULTISET_INTERSECT|JSON_MULTISET_EXCEPT|JSON_MULTISET_UNION|JSON_MULTISET_INTERSECT|JSON_MULTISET_EXCEPT|JSON_MULTISET_UNION".split("|");

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function highlightSql(sql) {
  if (!sql) return "";
  var escaped = escapeHtml(sql);
  escaped = escaped.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="sql-hl-string">$1</span>');
  escaped = escaped.replace(/(--[^\n]*)/g, '<span class="sql-hl-comment">$1</span>');
  escaped = escaped.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="sql-hl-comment">$1</span>');
  escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="sql-hl-number">$1</span>');
  var kwRe = new RegExp("\\b(" + SQL_KEYWORDS.join("|") + ")\\b", "gi");
  escaped = escaped.replace(kwRe, '<span class="sql-hl-keyword">$1</span>');
  var fnRe = new RegExp("\\b(" + SQL_FUNCTIONS.join("|") + ")\\s*(?=\\()", "gi");
  escaped = escaped.replace(fnRe, '<span class="sql-hl-function">$1</span>');
  return escaped;
}
function updateEditor() {
  var editor = $("sql-editor");
  var highlight = $("sql-highlight");
  var lineNumbers = $("sql-line-numbers");
  if (!editor || !highlight || !lineNumbers) return;
  highlight.innerHTML = highlightSql(editor.value);
  var lines = editor.value.split("\n").length;
  var nums = [];
  for (var i = 1; i <= lines; i++) nums.push(i);
  lineNumbers.innerHTML = nums.join("<br>");
}

/* ---------- Editor scroll sync ---------- */
function syncEditorScroll() {
  var editor = $("sql-editor");
  var highlight = $("sql-highlight");
  var lineNumbers = $("sql-line-numbers");
  if (!editor || !highlight || !lineNumbers) return;
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
  lineNumbers.scrollTop = editor.scrollTop;
}

/* ---------- Auto-completion (basic) ---------- */
var SQL_AUTO_KEYWORDS = SQL_KEYWORDS.slice(0, 40);
function handleEditorKey(e) {
  var editor = $("sql-editor");
  if (!editor) return;
  if (e.key === "Tab") {
    e.preventDefault();
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + "  " + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
    updateEditor();
    return;
  }
  if (e.key === "Enter" && editor.value.substring(editor.selectionStart - 4, editor.selectionStart).toUpperCase() === "FROM") {
    e.preventDefault();
    var text = editor.value;
    var pos = editor.selectionStart;
    editor.value = text.substring(0, pos) + "\n  " + text.substring(pos);
    editor.selectionStart = editor.selectionEnd = pos + 2;
    updateEditor();
    return;
  }
}

/* ---------- Results pagination ---------- */
function renderTableRows(rows, tbody, sortCol, sortDir) {
  if (!rows || !rows.length) { tbody.innerHTML = ""; return; }
  var start = (SQL_CURRENT_PAGE - 1) * SQL_PAGE_SIZE;
  var end = Math.min(start + SQL_PAGE_SIZE, rows.length);
  var pageRows = rows.slice(start, end);
  if (sortCol) {
    pageRows = pageRows.slice().sort(function (a, b) {
      var va = a[sortCol], vb = b[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number") return (va - vb) * sortDir;
      var sa = String(va), sb = String(vb);
      return sa.localeCompare(sb) * sortDir;
    });
  }
  tbody.innerHTML = pageRows.map(function (r) {
    return "<tr>" + Object.keys(r).map(function (k) {
      return "<td>" + escapeHtml(String(r[k] == null ? "" : r[k])) + "</td>";
    }).join("") + "</tr>";
  }).join("");
  var pag = $("sql-pagination");
  var totalPages = Math.max(1, Math.ceil(rows.length / SQL_PAGE_SIZE));
  if (SQL_CURRENT_PAGE > totalPages) SQL_CURRENT_PAGE = totalPages;
  var pHtml = "";
  if (SQL_CURRENT_PAGE > 1) {
    pHtml += '<button class="sql-page-btn" data-page="' + (SQL_CURRENT_PAGE - 1) + '">‹ Prev</button>';
  }
  pHtml += '<span style="font-size:11px;color:var(--muted-foreground);font-family:var(--mono)">Page ' + SQL_CURRENT_PAGE + ' / ' + totalPages + '</span>';
  if (SQL_CURRENT_PAGE < totalPages) {
    pHtml += '<button class="sql-page-btn" data-page="' + (SQL_CURRENT_PAGE + 1) + '">Next ›</button>';
  }
  pag.innerHTML = pHtml;
  pag.querySelectorAll(".sql-page-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      SQL_CURRENT_PAGE = parseInt(btn.dataset.page, 10);
      renderTableRows(rows, tbody, SQL_SORT_COL, SQL_SORT_DIR);
    });
  });
}

function renderTable(rows, tbody, thead) {
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--muted-foreground)">No results</td></tr>';
    return;
  }
  var cols = Object.keys(rows[0]);
  thead.innerHTML = "<tr>" + cols.map(function (c) {
    var marker = SQL_SORT_COL === c ? (SQL_SORT_DIR === 1 ? " ▲" : " ▼") : "";
    return '<th data-col="' + escAttr(c) + '">' + esc(c) + marker + "</th>";
  }).join("") + "</tr>";
  thead.querySelectorAll("th").forEach(function (th) {
    th.addEventListener("click", function () {
      var col = th.dataset.col;
      if (SQL_SORT_COL === col) SQL_SORT_DIR *= -1;
      else { SQL_SORT_COL = col; SQL_SORT_DIR = 1; }
      SQL_CURRENT_PAGE = 1;
      renderTableRows(rows, tbody, SQL_SORT_COL, SQL_SORT_DIR);
      renderTable(rows, tbody, thead);
    });
  });
  SQL_CURRENT_PAGE = 1;
  renderTableRows(rows, tbody, SQL_SORT_COL, SQL_SORT_DIR);
}

/* ---------- Copy dropdown ---------- */
function rowsToCsv(rows) {
  if (!rows || !rows.length) return "";
  var cols = Object.keys(rows[0]);
  var lines = [cols.join(",")];
  rows.forEach(function (r) {
    lines.push(cols.map(function (c) {
      var v = r[c];
      if (v == null) return "";
      var s = String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(","));
  });
  return lines.join("\n");
}
function rowsToJson(rows) {
  if (!rows || !rows.length) return "[]";
  return JSON.stringify(rows, null, 2);
}
function rowsToMarkdown(rows) {
  if (!rows || !rows.length) return "";
  var cols = Object.keys(rows[0]);
  var lines = ["| " + cols.join(" | ") + " |"];
  lines.push("| " + cols.map(function () { return "---"; }).join(" | ") + " |");
  rows.forEach(function (r) {
    lines.push("| " + cols.map(function (c) { return String(r[c] == null ? "" : r[c]); }).join(" | ") + " |");
  });
  return lines.join("\n");
}
function copyRows(format) {
  if (!LAST_SQL_ROWS.length) return;
  var text = "";
  if (format === "csv") text = rowsToCsv(LAST_SQL_ROWS);
  else if (format === "json") text = rowsToJson(LAST_SQL_ROWS);
  else if (format === "md") text = rowsToMarkdown(LAST_SQL_ROWS);
  if (navigator.clipboard && text) {
    navigator.clipboard.writeText(text).then(function () {
      var btn = $("sql-copy-toggle");
      if (btn) { var orig = btn.textContent; btn.textContent = "Copied!"; setTimeout(function () { btn.textContent = orig; }, 1200); }
    }).catch(function () {});
  }
}
var copyToggle = $("sql-copy-toggle");
var copyMenu = $("sql-copy-menu");
if (copyToggle && copyMenu) {
  copyToggle.addEventListener("click", function (e) {
    e.stopPropagation();
    copyMenu.classList.toggle("is-open");
  });
  copyMenu.addEventListener("click", function (e) {
    var item = e.target.closest(".sql-copy-item");
    if (!item) return;
    copyRows(item.dataset.format);
    copyMenu.classList.remove("is-open");
  });
  document.addEventListener("click", function () { copyMenu.classList.remove("is-open"); });
}

/* ---------- Run query ---------- */
$("sql-run").addEventListener("click", function () {
  var sql = $("sql-editor").value.trim();
  if (!sql) return;
  $("sql-meta").textContent = "Running…";
  $("sql-error").hidden = true;
  $("sql-result-wrap").hidden = true;
  if (copyToggle) copyToggle.hidden = true;
  SQL_CURRENT_PAGE = 1;
  SQL_SORT_COL = null;
  SQL_SORT_DIR = 1;
  api("/api/tool/hana_execute_query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: sql })
  }).then(function (res) {
    if (res.error) {
      $("sql-error").textContent = "Error: " + res.error;
      $("sql-error").hidden = false;
      $("sql-meta").textContent = "";
      pushSqlHistory(sql, false);
      return;
    }
    var rows = res.rows || [];
    LAST_SQL_ROWS = rows;
    renderTable(rows, $("sql-table").querySelector("tbody"), $("sql-table").querySelector("thead"));
    $("sql-result-wrap").hidden = false;
    if (copyToggle) copyToggle.hidden = !rows.length;
    var meta = res.row_count + " row(s) in " + (res.execution_ms || 0).toFixed(1) + " ms";
    $("sql-meta").textContent = meta;
    $("sql-result-meta").textContent = meta;
    $("sql-result-count").textContent = rows.length + " total";
    pushSqlHistory(sql, true);
  }).catch(function (e) {
    $("sql-error").textContent = "Error: " + e.message;
    $("sql-error").hidden = false;
    $("sql-meta").textContent = "";
    pushSqlHistory(sql, false);
  });
});

/* ---------- Editor events ---------- */
var editor = $("sql-editor");
if (editor) {
  editor.addEventListener("input", updateEditor);
  editor.addEventListener("scroll", syncEditorScroll);
  editor.addEventListener("keydown", handleEditorKey);
  updateEditor();
}

/* ---------- Init ---------- */
renderSqlHistory();
