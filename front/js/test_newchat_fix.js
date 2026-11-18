// Test script for chat.js new-chat history leakage fix
// Tests that pressing "new chat" during an active stream doesn't leak old history.

const fs = require('fs');
const assert = require('assert');
const path = require('path');

// ---- Minimal AbortController mock ----
class MockAbortController {
  constructor() { this.signal = { aborted: false }; }
  abort() { this.signal.aborted = true; }
}

// ---- Mock browser environment ----
let stored = {};
const localStorageMock = {
  getItem: (k) => stored[k] || null,
  setItem: (k, v) => { stored[k] = String(v); },
  removeItem: (k) => { delete stored[k]; },
  clear: () => { stored = {}; },
};

const elements = {};
function makeElement(tag) {
  const el = {
    tag, style: {}, _hidden: false, _innerHTML: '', _textContent: '',
    _dataset: {}, _classList: [], _children: [], _parent: null,
    _disabled: false,
    get hidden() { return el._hidden; },
    set hidden(v) { el._hidden = v; },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = v; el._children = []; },
    get textContent() { return el._textContent; },
    set textContent(v) { el._textContent = v; },
    get classList() {
      return {
        add: (c) => { if (!el._classList.includes(c)) el._classList.push(c); },
        remove: (c) => { el._classList = el._classList.filter(x => x !== c); },
      };
    },
    get dataset() { return el._dataset; },
    get children() { return el._children; },
    appendChild(child) { el._children.push(child); child._parent = el; return child; },
    removeChild(child) { const i = el._children.indexOf(child); if (i >= 0) el._children.splice(i, 1); child._parent = null; return child; },
    querySelector(sel) {
      const noop = { addEventListener: () => {}, innerHTML: '', querySelector: () => null, querySelectorAll: () => [], parentNode: null, closest: () => null, dataset: {}, style: {}, textContent: '', appendChild: () => {}, insertBefore: () => {} };
      if (sel === '.assistant-summary') return { innerHTML: '', appendChild: () => {}, querySelector: () => noop };
      if (sel === '.chat-results') return { innerHTML: '' };
      if (sel === '.chat-cancel') return null;
      if (sel === '.chat-msg-body') return { querySelector: () => null, insertBefore: () => {} };
      if (sel === '.chat-narrative') return null;
      if (sel === '.chat-reasoning-body') return { textContent: '' };
      if (sel === '[data-act="copy"]') return noop;
      return noop;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    get isConnected() { return el._parent !== null; },
    get scrollTop() { return el._scrollTop || 0; },
    set scrollTop(v) { el._scrollTop = v; },
    get scrollHeight() { return el._scrollHeight || 0; },
    get disabled() { return el._disabled; },
    set disabled(v) { el._disabled = v; },
  };
  return el;
}

body = makeElement('body');
documentMock = {
  body,
  documentElement: body,
  querySelector: (sel) => sel === '.main' ? body : null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  hidden: false,
  visibilityState: 'visible',
  createElement: (tag) => makeElement(tag),
};

function $(id) {
  if (!elements[id]) elements[id] = makeElement('div');
  return elements[id];
}

// Track fetch calls
let fetchCalls = [];

function api(url, opts) {
  return Promise.resolve({ ok: true, rows: [], points: [] });
}

// Mock fetch: returns error+fallback event (simulating unreachable LLM)
function mockFetch(url, opts) {
  fetchCalls.push({ url, opts });
  const signal = opts && opts.signal;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('Aborted')); return; }
    setTimeout(() => {
      if (signal && signal.aborted) { reject(new Error('Aborted')); return; }
      const chunks = ['{"type":"error","error":"LLM request failed","fallback":true}\n'];
      let i = 0;
      const reader = {
        read: () => Promise.resolve({
          done: i >= chunks.length,
          value: i < chunks.length ? Buffer.from(chunks[i++]) : undefined,
        }),
      };
      resolve({ ok: true, body: { getReader: () => reader } });
    }, 10);
  });
}

global.ABORT_CONTROLLER = MockAbortController;
global.AbortController = MockAbortController;
global.localStorage = localStorageMock;
global.document = documentMock;
global.window = documentMock;  // minimal window mock
global.$ = $;
global.api = api;
global.fetch = mockFetch;
global.TextDecoder = class { decode(buf) { return buf.toString(); } };
global.DOMException = class extends Error { constructor(msg, name) { super(msg); this.name = name; } };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };

// Helpers used by chat.js
global.esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
global.escAttr = global.esc;
global.renderMarkdown = (s) => s || '';
global.ensureUsableSummary = (s) => s || 'No results.';
global.renderAgentHTML = (s) => s || '';
global.renderRelatedSuggestions = () => '';
global.narrateTool = () => 'working';
global.narrateRequest = () => 'working';
global.createToolChip = () => ({});
global.finishToolChip = () => {};
global.renderSqlHistory = () => {};
global.loadDashboard = () => {};
global.show = () => {};
global.VIEWS = ['dashboard', 'chat', 'sql'];
global.LAST_VIEW_KEY = 'last_view';
global.updateTopbar = () => {};

// Suppress chat.js console.log
const origLog = console.log;
console.log = () => {};

// Load and execute chat.js
const chatJsPath = '/home/t0x1c2r00t/HANA-MCP/front/js/chat.js';
const chatJs = fs.readFileSync(chatJsPath, 'utf8');
try { eval(chatJs); } catch (e) {
  console.log = origLog;
  console.error('ERROR loading chat.js:', e.message, e.stack);
  process.exit(1);
}

console.log = origLog;

// Override DOM-dependent functions for headless testing
createToolChip = function() { return { querySelector: () => ({ classList: { remove: () => {} } }), dataset: {}, style: {} }; };
finishToolChip = function() {};

// ---- Tests ----
let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ': ' + e.message);
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ': ' + e.message);
  }
}

function resetState() {
  stored = {};
  currentConvId = null;
  activeConv = null;
  busy = false;
  streamAborted = false;
  currentFetchController = null;
  fetchCalls = [];
}

// ---- Run all tests ----
(async function runAll() {
  // Synchronous tests
  test('newChat creates empty conversation', () => {
    resetState();
    newChat();
    assert.ok(activeConv, 'activeConv should be set');
    assert.strictEqual(activeConv.messages.length, 0, 'new conv messages should be empty');
    assert.ok(currentConvId, 'currentConvId should be set');
    assert.strictEqual(activeConv.id, currentConvId, 'activeConv.id should match currentConvId');
  });

  test('newChat aborts in-progress stream', () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    assert.ok(busy, 'should be busy during stream');
    assert.ok(currentFetchController, 'should have fetch controller');

    newChat();

    assert.strictEqual(busy, false, 'busy should be false after newChat');
    assert.strictEqual(streamAborted, true, 'streamAborted should be true after newChat');
    assert.strictEqual(activeConv.messages.length, 0, 'new conv should have empty messages');
    assert.strictEqual(currentFetchController, null, 'fetch controller should be nulled');
  });

  test('fallback() guards against streamAborted', () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    newChat();
    assert.strictEqual(streamAborted, true);
    assert.strictEqual(busy, false);
  });

  // Async tests
  await asyncTest('Race condition: old stream fallback blocked from writing to new conv', async () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    assert.ok(busy, 'should be busy');
    newChat();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(activeConv.messages.length, 0,
      'new conv should be empty - old stream fallback blocked, got ' + activeConv.messages.length + ' messages');
  });

  await asyncTest('After newChat, new message sends empty history', async () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    newChat();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(activeConv.messages.length, 0, 'new conv should be empty');
    fetchCalls = [];
    dispatch('how much memory is in use?');
    await new Promise(r => setTimeout(r, 50));
    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    assert.deepStrictEqual(body.history, [],
      'history should be empty for new conversation, got: ' + JSON.stringify(body.history));
  });

  await asyncTest('Normal flow: newChat clears history for next message', async () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(activeConv.messages.length >= 2, 'conv1 should have user+assistant messages');
    newChat();
    assert.strictEqual(activeConv.messages.length, 0, 'new conv should be empty');
    fetchCalls = [];
    dispatch('show disk usage');
    await new Promise(r => setTimeout(r, 50));
    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    assert.deepStrictEqual(body.history, [],
      'history should be empty for new conversation after newChat');
  });

  await asyncTest("openConv doesn't leak other conversations", async () => {
    resetState();
    newChat();
    dispatch('how healthy is my database?');
    await new Promise(r => setTimeout(r, 50));
    const conv1 = { id: currentConvId };
    assert.ok(activeConv.messages.length >= 2, 'conv1 should have messages');
    newChat();
    dispatch('how much memory is in use?');
    await new Promise(r => setTimeout(r, 50));
    const conv2 = { id: currentConvId };
    assert.ok(activeConv.messages.length >= 2, 'conv2 should have messages');
    openConv(conv1.id);
    assert.strictEqual(currentConvId, conv1.id);
    fetchCalls = [];
    dispatch('show disk usage');
    await new Promise(r => setTimeout(r, 50));
    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    const userMessages = body.history.filter(m => m.role === 'user');
    assert.ok(userMessages.length <= 1,
      'conv1 history should not contain conv2 messages. Found ' + userMessages.length + ' user messages');
    if (userMessages.length > 0) {
      const hasLeak = userMessages.some(m => m.text && m.text.includes('memory'));
      assert.ok(!hasLeak, 'conv1 history should not contain memory question from conv2');
    }
  });

  console.log('\n' + passed + '/' + total + ' tests passed');
  process.exit(passed === total ? 0 : 1);
})();
