'use strict'
// Headless verification of the approval/question answer wire shape.
//
// Regression under test: the sidebar's 权限请求 "允许/拒绝" buttons used to send
//   POST /api/respond { type:'client-response', rpcId:<lost>, result:{ ok:true,
//                       value:{ approvalId, outcome } } }
// The gateway routes client-responses by the echoed rpcId and then validates the
// payload against <domain>ResponsePayloadSchema (sessionId is mandatory), so that
// shape came back as { accepted:false } — surfaced to the user as the useless
// "server rejected response to undefined".
//
// This harness stands up a fake dsh gateway, activates the extension against it,
// pushes an approval/question frame into the sidebar webview, and asserts the
// envelope the extension actually posts.
//
// Run: node test/respond-wire-verify.js
const http = require('node:http')
const path = require('node:path')
const Module = require('node:module')

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

// ── fake dsh gateway ────────────────────────────────────────────────────────
const received = []
const server = http.createServer((req, res) => {
  // The extension's attach probe requires the service root to carry __DSH_BOOT__.
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
    if (req.url === '/api/respond') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
      return
    }
    // unary RPCs answer with a well-formed envelope
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: (json && json.rpcId) || 'x', result: { ok: true, value: {} } }))
  })
})

// ── vscode mock ─────────────────────────────────────────────────────────────
let webviewView = null
let dshClientRef = null
const config = {
  port: 0, attachExisting: true, spawnIfMissing: false,
  checkout: '', command: '', extraArgs: [],
  autoOpen: false, followWorkspace: false, stopOnExit: false,
}
const out = { append() {}, appendLine() {}, show() {}, dispose() {} }
const mockWebview = {
  html: '',
  options: {},
  postMessage() {},
  onDidReceiveMessage(cb) { mockWebview._cb = cb; return { dispose() {} } },
  asWebviewUri: (u) => u,
  cspSource: '',
}
const vscode = {
  workspace: {
    getConfiguration: () => ({ ...config, get: (k) => config[k] }),
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => out,
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
    showErrorMessage: (m) => console.log('[error-toast]', m),
    showInformationMessage: () => {},
    showWarningMessage: () => {},
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
  // The extension joins through Uri and then reads `.fsPath`, so the mock must
  // return a Uri-shaped object, not a bare string.
  Uri: {
    joinPath: (...p) => { const joined = path.join(...p); return { fsPath: joined, path: joined, toString: () => 'file:///' + joined.replace(/\\/g, '/') } },
    parse: (s) => ({ fsPath: s, path: s, toString: () => s }),
    file: (s) => ({ fsPath: s, path: s, toString: () => s }),
  },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { One: 1 },
  ViewBadge: class {},
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'vscode') return vscode
  return origLoad.apply(this, arguments)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  config.port = server.address().port
  const base = 'http://127.0.0.1:' + config.port
  console.log('fake dsh gateway on ' + base)

  const ext = require(path.join(__dirname, '..', 'extension.js'))
  const ctx = { subscriptions: [], extensionUri: path.join(__dirname, '..') }
  ext.activate(ctx)

  // Wait for the lazy startup probe to attach and the view provider to render.
  for (let i = 0; i < 60 && !webviewView; i++) await sleep(100)
  check('extension registered the dshWebViewAux view provider', webviewView !== null)
  if (!webviewView) return finish()

  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 60 && !mockWebview._cb; i++) await sleep(100)
  check('webview message channel wired', typeof mockWebview._cb === 'function')
  if (typeof mockWebview._cb !== 'function') return finish()

  // The extension bootstraps its API client lazily, so give it a moment before
  // asserting on the first outbound call.
  await sleep(1200)

  // ── approval answer ───────────────────────────────────────────────────────
  received.length = 0
  mockWebview._cb({
    type: 'approvalRespond', sessionId: 'session-aaaa', approvalId: 'appr-bbbb',
    outcome: 'allowed-once', rpcId: 'rpc-cccc',
  })
  await sleep(400)
  const approval = received.find((r) => r.url === '/api/respond')
  check('approval answer posts to /api/respond', approval !== undefined)
  if (approval) {
    check('approval envelope type', approval.body.type === 'client-response', approval.body.type)
    check('approval rpcId is the frame id (not undefined)', approval.body.rpcId === 'rpc-cccc', String(approval.body.rpcId))
    const v = approval.body.result && approval.body.result.value
    check('approval payload carries sessionId', v && v.sessionId === 'session-aaaa', v && String(v.sessionId))
    check('approval payload carries approvalId', v && v.approvalId === 'appr-bbbb', v && String(v.approvalId))
    check('approval payload carries outcome', v && v.outcome === 'allowed-once', v && String(v.outcome))
  }

  // ── question answer ───────────────────────────────────────────────────────
  received.length = 0
  mockWebview._cb({
    type: 'questionAnswer', sessionId: 'session-aaaa', rpcId: 'rpc-dddd',
    answers: [{ id: 'color', selected: ['red'] }],
  })
  await sleep(400)
  const question = received.find((r) => r.url === '/api/respond')
  check('question answer posts to /api/respond', question !== undefined)
  if (question) {
    const v = question.body.result && question.body.result.value
    check('question rpcId is the frame id (not undefined)', question.body.rpcId === 'rpc-dddd', String(question.body.rpcId))
    check('question payload carries sessionId', v && v.sessionId === 'session-aaaa', v && String(v.sessionId))
    check('answers nested under answer (server schema)', !!(v && v.answer && Array.isArray(v.answer.answers)), v && JSON.stringify(v.answer))
    check('answers survive verbatim', !!(v && v.answer && v.answer.answers[0] && v.answer.answers[0].id === 'color'))
  }

  // ── guard: missing sessionId must not silently post a malformed envelope ──
  received.length = 0
  mockWebview._cb({ type: 'approvalRespond', approvalId: 'appr-bbbb', outcome: 'rejected', rpcId: 'rpc-eeee' })
  await sleep(300)
  check('answer without sessionId does NOT post a malformed envelope', received.every((r) => r.url !== '/api/respond'))

  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  server.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
