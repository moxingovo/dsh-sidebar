'use strict'
// Approval and question answers must reach the Host.
//
// 0.1.6 replaced the old POST /api/respond {type:'client-response', rpcId} with the
// event RPC: a pending waterfall arrives on the $events stream carrying
// {event, eventId, agentId, request}, and the answer goes back through
// POST /api/$events/result as {clientId, eventId, outcome:{kind:'result', value}}.
//
// Run: node test/respond-wire-verify.js
const path = require('node:path')
const Module = require('node:module')
const { createMockServer } = require('./mock-016-server.js')

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

const SESSION = 'session-aaaa'
const mock = createMockServer({})

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
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
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
const framesOf = (type) => sent.filter((m) => m.type === 'frame' && m.frame && m.frame.type === type).map((m) => m.frame)
const resultPosts = () => mock.state.requests.filter((r) => r.url === '/api/$events/result')

;(async () => {
  config.port = await mock.listen()
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  ext.activate({
    subscriptions: [], extensionUri: path.join(__dirname, '..'),
    globalState: { get: (k) => (k === 'dshWeb.cookie' ? 'dsh-auth-mock=v1.mock.mock' : undefined), update: async () => {} },
  })
  for (let i = 0; i < 60 && !webviewView; i++) await sleep(100)
  check('extension registered the dshWebViewAux view provider', webviewView !== null)
  if (!webviewView) { mock.close(); process.exit(1) }
  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 60 && !mockWebview._cb; i++) await sleep(100)
  check('webview message channel wired', typeof mockWebview._cb === 'function')
  // The $events subscription has to be live before a waterfall can arrive.
  for (let i = 0; i < 60; i++) {
    if ([...mock.state.subscriptions.values()].some((s) => s.endpoint === '$events')) break
    await sleep(100)
  }
  check('the $events stream is subscribed', [...mock.state.subscriptions.values()].some((s) => s.endpoint === '$events'))

  // ── approval ────────────────────────────────────────────────────────────
  mock.waterfall('approval/request', { toolName: 'pwsh', callId: 'call-1', reason: 'run a command' }, 'evt-approval')
  let card = null
  for (let i = 0; i < 40 && !card; i++) { await sleep(100); card = framesOf('approval/requested')[0] || null }
  check('the approval card reaches the webview', card !== null, JSON.stringify(card))
  check('  it carries the waterfall eventId as rpcId', card && card.rpcId === 'evt-approval', card && String(card.rpcId))
  check('  it carries the agent/session id', card && card.sessionId === SESSION, card && String(card.sessionId))
  check('  it carries the tool name', card && card.toolName === 'pwsh', card && String(card.toolName))

  mock.state.requests.length = 0
  mockWebview._cb({ type: 'approvalRespond', sessionId: SESSION, approvalId: card ? card.approvalId : 'evt-approval', outcome: 'allowed-once', rpcId: 'evt-approval' })
  let answer = null
  for (let i = 0; i < 40 && !answer; i++) { await sleep(100); answer = resultPosts()[0] || null }
  check('the approval answer posts to /api/$events/result', answer !== undefined && answer !== null)
  if (answer) {
    const payload = answer.body.payload.args
    check('  it addresses the opening client generation', payload.clientId === 'mock-client', String(payload.clientId))
    check('  it answers the waterfall eventId', payload.eventId === 'evt-approval', String(payload.eventId))
    check('  outcome kind is result', payload.outcome && payload.outcome.kind === 'result', JSON.stringify(payload.outcome))
    check('  outcome value is the ApprovalOutcome string', payload.outcome && payload.outcome.value === 'allowed-once', JSON.stringify(payload.outcome))
  }

  // ── question ────────────────────────────────────────────────────────────
  mock.waterfall('user-questions/request', { questions: [{ id: 'color', question: 'Which colour?', options: [{ label: 'red' }] }] }, 'evt-question')
  let question = null
  for (let i = 0; i < 40 && !question; i++) { await sleep(100); question = framesOf('question/requested')[0] || null }
  check('the question card reaches the webview', question !== null, JSON.stringify(question))
  check('  it carries the waterfall eventId as rpcId', question && question.rpcId === 'evt-question', question && String(question.rpcId))

  mock.state.requests.length = 0
  mockWebview._cb({ type: 'questionAnswer', sessionId: SESSION, rpcId: 'evt-question', answers: [{ id: 'color', selected: ['red'] }] })
  let reply = null
  for (let i = 0; i < 40 && !reply; i++) { await sleep(100); reply = resultPosts()[0] || null }
  check('the question answer posts to /api/$events/result', reply !== undefined && reply !== null)
  if (reply) {
    const payload = reply.body.payload.args
    check('  it answers the question eventId', payload.eventId === 'evt-question', String(payload.eventId))
    const value = payload.outcome && payload.outcome.value
    check('  the value is AskUserQuestionAnswer ({answers:[…]})', !!(value && Array.isArray(value.answers)), JSON.stringify(value))
    check('  answers survive verbatim', !!(value && value.answers[0] && value.answers[0].id === 'color' && value.answers[0].selected[0] === 'red'), JSON.stringify(value))
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  mock.close()
  process.exit(failed.length === 0 ? 0 : 1)
})()