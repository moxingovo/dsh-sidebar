'use strict'
// What the sidebar calls a "conversation" — now driven over the 0.1.6 wire.
//
// Regression under test: the drawer listed every session whose cwd matched the
// workspace folder, including subagent sessions (a subagent's own working log,
// never a conversation the user opened) — 28 rows for 4 conversations.
//
// The old version mocked /api/session.list + /api/workspace.list; that wire is
// gone in 0.1.6 (cookie handshake, <ns>/<method> gateway, WebSocket mux), so it
// was asserting against a server the extension no longer speaks.
//
// Run: node test/session-list-filter-verify.js
const path = require('node:path')
const Module = require('node:module')
const { createMockServer } = require('./mock-016-server.js')

const WS = process.cwd()
const OTHER_WS = path.join(process.cwd(), '..', 'elsewhere')

const sessions = [
  { sessionId: 'session-root-a', cwd: WS, updatedAt: 50, running: true, blank: false },
  { sessionId: 'session-root-b', cwd: WS, updatedAt: 40, blank: false },
  { sessionId: 'child-1', cwd: WS, updatedAt: 90, parentSessionId: 'session-root-a', origin: 'subagent' },
  { sessionId: 'child-2', cwd: WS, updatedAt: 80, parentSessionId: 'child-1', origin: 'subagent' },
  { sessionId: 'fork-1', cwd: WS, updatedAt: 30, parentSessionId: 'session-root-a' },
  { sessionId: 'session-other-ws', cwd: OTHER_WS, updatedAt: 99 },
  { sessionId: 'session-archived', cwd: WS, updatedAt: 20 },
]
const archivedSessionIds = ['session-archived']

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

const mock = createMockServer({
  unary: { 'session/list': { items: sessions } },
  archivedSessionIds,
})

const sent = []
let webviewView = null
const config = {
  port: 0, attachExisting: true, spawnIfMissing: false,
  checkout: '', command: '', extraArgs: [],
  autoOpen: false, followWorkspace: false, stopOnExit: false,
}
const out = { append() {}, appendLine() {}, show() {}, dispose() {} }
const mockWebview = {
  html: '', options: {},
  postMessage(m) { sent.push(m) },
  onDidReceiveMessage(cb) { mockWebview._cb = cb; return { dispose() {} } },
  asWebviewUri: (u) => u, cspSource: '',
}
const vscode = {
  workspace: {
    getConfiguration: () => ({ ...config, get: (k) => config[k] }),
    workspaceFolders: [{ uri: { fsPath: WS } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => out,
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
    showErrorMessage: (m) => console.log('[error-toast]', m),
    showInformationMessage: () => {}, showWarningMessage: () => {},
    createWebviewPanel: () => ({ webview: mockWebview, iconPath: null, reveal() {}, onDidDispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      if (id === 'dshWebViewAux') webviewView = provider
      return { dispose() {} }
    },
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    registerUriHandler: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
  Uri: {
    joinPath: (...p) => { const j = path.join(...p); return { fsPath: j, path: j, toString: () => 'file:///' + j.split(path.sep).join('/') } },
    parse: (s) => ({ fsPath: s, path: s, toString: () => s }),
    file: (s) => ({ fsPath: s, path: s, toString: () => s }),
  },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { One: 1 },
  ViewBadge: class {},
}
const origLoad = Module._load
Module._load = function (request) { if (request === 'vscode') return vscode; return origLoad.apply(this, arguments) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  config.port = await mock.listen()
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  // A pre-existing cookie is what a reloaded window has; the mock accepts it.
  ext.activate({
    subscriptions: [], extensionUri: path.join(__dirname, '..'),
    globalState: { get: (k) => (k === 'dshWeb.cookie' ? 'dsh-auth-mock=v1.mock.mock' : undefined), update: async () => {} },
  })
  for (let i = 0; i < 60 && !webviewView; i++) await sleep(100)
  check('view provider registered', webviewView !== null)
  if (!webviewView) { mock.close(); process.exit(1) }
  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 60 && !mockWebview._cb; i++) await sleep(100)
  await sleep(1500)

  sent.length = 0
  mockWebview._cb({ type: 'listSessions' })
  let list = null
  for (let i = 0; i < 80 && list === null; i++) {
    await sleep(100)
    list = sent.find((m) => m.type === 'sessionList') || null
  }
  check('the host answers listSessions with a sessionList message', list !== null)
  if (list) {
    const ids = list.items.map((s) => s.sessionId)
    check('subagent sessions are not conversations', !ids.includes('child-1') && !ids.includes('child-2'), JSON.stringify(ids))
    check('  the nested one is dropped too (grandchild)', !ids.includes('child-2'))
    check('a fork stays (parentSessionId without origin)', ids.includes('fork-1'), JSON.stringify(ids))
    check('other workspaces stay out', !ids.includes('session-other-ws'))
    check('real conversations survive', ids.includes('session-root-a') && ids.includes('session-root-b'))
    check('the archived one is still handed over (the webview owns that view)', ids.includes('session-archived'))
    check('the archive set travels with the list', Array.isArray(list.archivedIds) && list.archivedIds.join() === archivedSessionIds.join(), JSON.stringify(list.archivedIds))
    check('the workspace path travels too', list.workspacePath === WS, String(list.workspacePath))
    check('of seven rows, three are dropped (two subagents + another workspace)', list.items.length === 4, String(list.items.length))
    check('the list came over the 0.1.6 gateway', mock.state.requests.some((r) => r.url === '/api/session/list'), mock.state.requests.map((r) => r.url).join(','))
    check('the workspace baseline came over the mux socket', mock.state.subscriptions.size > 0, String(mock.state.subscriptions.size))
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  mock.close()
  process.exit(failed.length === 0 ? 0 : 1)
})()