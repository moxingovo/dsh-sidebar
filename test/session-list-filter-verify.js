'use strict'
// What the sidebar calls a "conversation".
//
// Regression under test: the drawer listed every session whose cwd matched the
// workspace folder - including subagent sessions, which are a subagent's own
// working log rather than a conversation the user opened. On this machine that
// turned a 4-conversation drawer into 28 rows, 24 of them "你是资深.../You are
// doing..." prompts the user never typed and could not get rid of (archiving
// hides a session, it does not remove it from a list it never belonged to).
//
// The DSH client files sessions with origin === 'subagent' under their parent's
// subagent catalog and never lists them as conversations; this harness pins the
// host's own filter to that rule.
//
// Run: node test/session-list-filter-verify.js
const http = require('node:http')
const path = require('node:path')
const Module = require('node:module')

const WS = process.cwd()          // the mock reports this as workspaceFolders[0]
const OTHER_WS = path.join(process.cwd(), '..', 'elsewhere')

const sessions = [
  { sessionId: 'session-root-a', cwd: WS, updatedAt: 50, running: true, blank: false, agentPreset: 'code' },
  { sessionId: 'session-root-b', cwd: WS, updatedAt: 40, blank: false },
  // Subagent sessions: origin is the flag, and the header validator accepts no
  // other origin value.
  { sessionId: 'child-1', cwd: WS, updatedAt: 90, parentSessionId: 'session-root-a', origin: 'subagent' },
  { sessionId: 'child-2', cwd: WS, updatedAt: 80, parentSessionId: 'child-1', origin: 'subagent' },
  // A fork carries parentSessionId WITHOUT origin - a user's own conversation.
  { sessionId: 'fork-1', cwd: WS, updatedAt: 30, parentSessionId: 'session-root-a' },
  // Another workspace's conversation stays out of this workspace's drawer.
  { sessionId: 'session-other-ws', cwd: OTHER_WS, updatedAt: 99 },
  { sessionId: 'session-archived', cwd: WS, updatedAt: 20 },
]
const archivedSessionIds = ['session-archived']

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

const received = []
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!DOCTYPE html><html><body><script>window.__DSH_BOOT__={}</script></body></html>')
    return
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let json = null
    try { json = JSON.parse(body) } catch {}
    received.push({ url: req.url, body: json })
    const value = req.url === '/api/session.list' ? { items: sessions }
      : req.url === '/api/workspace.list' ? { items: [], archivedSessionIds }
        : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: (json && json.rpcId) || 'x', result: { ok: true, value } }))
  })
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  config.port = server.address().port
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  ext.activate({ subscriptions: [], extensionUri: path.join(__dirname, '..') })
  for (let i = 0; i < 60 && !webviewView; i++) await sleep(100)
  check('view provider registered', webviewView !== null)
  if (!webviewView) { server.close(); process.exit(1) }
  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 60 && !mockWebview._cb; i++) await sleep(100)
  await sleep(1500)

  sent.length = 0
  mockWebview._cb({ type: 'listSessions' })
  let list = null
  for (let i = 0; i < 40 && list === null; i++) {
    await sleep(100)
    list = sent.find((m) => m.type === 'sessionList') || null
  }
  check('the host answers listSessions with a sessionList message', list !== null)
  if (list) {
    const ids = list.items.map((s) => s.sessionId)
    check('subagent sessions are not conversations', !ids.includes('child-1') && !ids.includes('child-2'), JSON.stringify(ids))
    check('  the nested one is dropped too (grandchild)', !ids.includes('child-2'))
    check('a fork stays (parentSessionId without origin)', ids.includes('fork-1'), JSON.stringify(ids))
    check('other workspaces stay out', !ids.includes('session-other-ws'), JSON.stringify(ids))
    check('real conversations survive', ids.includes('session-root-a') && ids.includes('session-root-b'), JSON.stringify(ids))
    check('the archived one is still handed over (the webview owns that view)', ids.includes('session-archived'), JSON.stringify(ids))
    check('the archive set travels with the list', Array.isArray(list.archivedIds) && list.archivedIds.join() === archivedSessionIds.join(), JSON.stringify(list.archivedIds))
    check('the workspace path travels too', list.workspacePath === WS, String(list.workspacePath))
    check('of seven rows, three are dropped (two subagents + another workspace)', list.items.length === 4, String(list.items.length))
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log((results.length - failed.length) + '/' + results.length + ' checks passed')
  for (const f of failed) console.log('  - ' + f.label)
  server.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('harness error:', e); process.exit(2) })
