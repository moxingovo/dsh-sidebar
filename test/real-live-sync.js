'use strict'
// Manual harness (not CI): boots the real extension.js against the live server
// with a mock VS Code API and records every message the webview would receive.
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const PORT = Number(process.env.DSH_PORT || 3080)
const SID = process.env.DSH_SESSION || 'session-624cf097-9cc3-4e3a-bb0a-a6fcc8337dc3'
const sent = []
let webviewView = null
const config = { port: PORT, attachExisting: true, spawnIfMissing: false, checkout: '', command: '', extraArgs: [], autoOpen: false, followWorkspace: true, stopOnExit: false }
const out = { append() {}, appendLine(l) { if (/error|FAIL|auth|attached|session\.list/.test(String(l))) console.log('  [ext]', String(l).slice(0, 150)) }, show() {}, dispose() {} }
const mockWebview = {
  html: '', options: {},
  postMessage(m) { sent.push({ t: Date.now(), m }) },
  onDidReceiveMessage(cb) { mockWebview._cb = cb; return { dispose() {} } },
  asWebviewUri: (u) => u, cspSource: '',
}
const vscode = {
  workspace: { getConfiguration: () => ({ ...config, get: (k) => config[k] }), workspaceFolders: [{ uri: { fsPath: process.cwd() } }], onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => out,
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
    showErrorMessage: (m) => console.log('  [toast]', m), showInformationMessage: () => {}, showWarningMessage: () => {},
    createWebviewPanel: () => ({ webview: mockWebview, iconPath: null, reveal() {}, onDidDispose() {} }),
    registerWebviewViewProvider: (id, provider) => { if (id === 'dshWebViewAux') webviewView = provider; return { dispose() {} } },
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    registerUriHandler: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
  Uri: { joinPath: (...p) => { const j = path.join(...p); return { fsPath: j, path: j, toString: () => 'file:///' + j.split(path.sep).join('/') } }, parse: (s) => ({ fsPath: s, path: s, toString: () => s }), file: (s) => ({ fsPath: s, path: s, toString: () => s }) },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1 }, ViewBadge: class {},
}
const origLoad = Module._load
Module._load = function (request) { if (request === 'vscode') return vscode; return origLoad.apply(this, arguments) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  ext.activate({ subscriptions: [], extensionUri: path.join(__dirname, '..'), globalState: { get: () => undefined, update: async () => {} } })
  for (let i = 0; i < 100 && !webviewView; i++) await sleep(100)
  if (!webviewView) { console.log('view provider never registered'); process.exit(1) }
  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 100 && !mockWebview._cb; i++) await sleep(100)
  await sleep(3000)
  const before = sent.length
  console.log('opening session', SID)
  mockWebview._cb({ type: 'openSession', sessionId: SID })
  let opened = null
  for (let i = 0; i < 150 && !opened; i++) { await sleep(100); opened = sent.find((x) => x.m.type === 'sessionOpened') }
  console.log('sessionOpened:', opened ? ((opened.m.events || []).length + ' records') : 'NEVER')
  const afterOpen = sent.length
  // provoke live durable events without a model call: a slash command on the session
  const title = ((opened.m.projections && opened.m.projections.values && opened.m.projections.values.title) || 'probe') + ''
  const body = JSON.stringify({ type: 'client-request', rpcId: 'x1', method: 'session/rename', payload: { args: { request: { sessionId: SID, title } } } })
  const token = /http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]{20,})/.exec(fs.readFileSync('C:/Users/20906/.dsh/web-016.log', 'utf8'))[1]
  const cookie = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/?token=' + token, headers: { host: '127.0.0.1:' + PORT } }, (res) => { resolve(String(res.headers['set-cookie'] || '').split(';')[0]); res.resume() })
    req.on('error', () => resolve(''))
  })
  const cmd = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/session/rename', method: 'POST', headers: { host: '127.0.0.1:' + PORT, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => resolve(t.slice(0, 200))) })
    req.on('error', (e) => resolve('ERR ' + e.message))
    req.write(body); req.end()
  })
  console.log('session/rename (same title) ->', cmd)
  await sleep(4000)
  const live = sent.slice(afterOpen).filter((x) => x.m.type === 'frame')
  const kinds = new Map()
  for (const x of live) { const k = x.m.kind + ':' + (x.m.frame && x.m.frame.type); kinds.set(k, (kinds.get(k) || 0) + 1) }
  const conns = sent.filter((x) => x.m.type === 'connection').map((x) => x.m.state)
  console.log('connection messages:', JSON.stringify(conns))
  const states = sent.filter((x) => x.m.type === 'serverState').map((x) => x.m.state)
  console.log('serverState messages:', JSON.stringify(states))
  console.log('frames after openSession (' + live.length + '):')
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log('   ' + v + '  ' + k)
  const evs = live.filter((x) => x.m.frame && x.m.frame.type === 'session/event')
  console.log('session/event frames:', evs.length, evs.length ? JSON.stringify(evs[evs.length - 1].m.frame).slice(0, 220) : '')
  process.exit(0)
})()