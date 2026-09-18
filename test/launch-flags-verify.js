'use strict'
// Whatever starts the server must start it the same way.
//
// Regression under test: the extension's own spawn path launched bare
// "node apps/cli/lib/bin.js web --port 3080" while the managed launcher
// (~/.dsh/run-server.cmd) passed --max-old-space-size=8192, so a server that
// won the port race from VS Code ran with a smaller heap and could abort
// (exit 0xC0000409) where the managed one would have failed one request.
//
// This drives the checkout launcher against a FAKE checkout whose bin.js records
// its own process.argv, so the flags are asserted without starting a real server.
//
// Run: node test/launch-flags-verify.js
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── fake checkout ───────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fake-checkout-'))
const binDir = path.join(root, 'apps', 'cli', 'lib')
fs.mkdirSync(binDir, { recursive: true })
const argvFile = path.join(root, 'argv.json')
fs.writeFileSync(path.join(binDir, 'bin.js'), [
  'const fs = require("node:fs")',
  'const http = require("node:http")',
  'fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({ argv: process.argv, execArgv: process.execArgv, heapLimit: require("node:v8").getHeapStatistics().heap_size_limit }))',
  'const i = process.argv.indexOf("--port")',
  'const port = Number(process.argv[i + 1])',
  'http.createServer((req, res) => {',
  '  res.writeHead(200, { "content-type": "text/html" })',
  '  res.end("<!DOCTYPE html><html><body><script>window.__DSH_BOOT__={}</script></body></html>")',
  '}).listen(port, "127.0.0.1")',
].join('\n'))

const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

// ── mocks ───────────────────────────────────────────────────────────────────
const statusBar = { text: '', tooltip: '', command: '', show() {}, dispose() {} }
let viewProvider = null
const commands = {}
const seen = []
const config = {
  port: 3197, attachExisting: false, spawnIfMissing: true,
  checkout: root, command: '', extraArgs: [], nodeArgs: [], nodeMaxOldSpaceMb: 8192,
  autoOpen: false, followWorkspace: false, stopOnExit: true,
}
const out = { append() {}, appendLine(l) { seen.push(String(l)) }, show() {}, dispose() {} }
const vscode = {
  workspace: {
    getConfiguration: () => ({ ...config, get: (k) => config[k] }),
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => out,
    createStatusBarItem: () => statusBar,
    showErrorMessage: (m) => console.log('[err-toast]', m),
    showInformationMessage: () => {}, showWarningMessage: () => {},
    createWebviewPanel: () => ({ webview: { html: '' }, iconPath: null, reveal() {}, onDidDispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      if (id === 'dshWebViewAux') viewProvider = provider
      return { dispose() {} }
    },
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    registerUriHandler: () => ({ dispose() {} }),
  },
  commands: { registerCommand: (id, h) => { commands[id] = h; return { dispose() {} } }, executeCommand: async () => {} },
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
process.env.FAKE_ARGV_FILE = argvFile

;(async () => {
  config.port = await freePort()
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  ext.activate({ subscriptions: [], extensionUri: path.join(__dirname, '..') })
  for (let i = 0; i < 50 && !viewProvider; i++) await sleep(100)
  check('view provider registered', viewProvider !== null)
  viewProvider.resolveWebviewView({
    webview: { html: '', options: {}, postMessage() {}, onDidReceiveMessage: () => ({ dispose() {} }), asWebviewUri: (u) => u, cspSource: '' },
    onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {},
  })
  check('opening the sidebar view started a launch', seen.some((l) => l.includes('launching via')))
  for (let i = 0; i < 120 && !fs.existsSync(argvFile); i++) await sleep(250)
  check('the checkout launcher started a process', fs.existsSync(argvFile))
  if (fs.existsSync(argvFile)) {
    const rec = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    const argv = rec.argv
    const flags = rec.execArgv || []
    check('the heap ceiling is passed', flags.includes('--max-old-space-size=8192'), JSON.stringify(flags))
    check('  and the child really got it', rec.heapLimit > 6 * 1024 * 1024 * 1024, Math.round(rec.heapLimit / 1024 / 1024) + ' MB')
    check('a fatal error leaves a report', flags.includes('--report-on-fatalerror'), JSON.stringify(flags))
    check('  the report directory is set', flags.some((f) => f.startsWith('--report-directory=')), JSON.stringify(flags))
    check('the system trust store is used (node >= 22.15)', flags.includes('--use-system-ca'), JSON.stringify(flags))
    check('node options never leak into the server arguments', argv.length === 5, JSON.stringify(argv))
    check('the script path comes first among positionals', String(argv[1]).endsWith('bin.js'), String(argv[1]))
    check('the web command line survives', argv.slice(2, 4).join(' ') === 'web --port', argv.slice(2, 4).join(' '))
    check('  on the configured port', Number(argv[4]) === config.port, String(argv[4]))
    check('the launch line logs the flags', seen.some((l) => l.includes('launching via') && l.includes('--max-old-space-size=8192')),
      seen.find((l) => l.includes('launching via')) || '(no launch line)')
  }
  for (let i = 0; i < 40 && !statusBar.text.includes('$(check)'); i++) await sleep(250)
  check('the extension reached ready against the launched server', statusBar.text.includes('$(check)'), statusBar.text)

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log((results.length - failed.length) + '/' + results.length + ' checks passed')
  for (const f of failed) console.log('  - ' + f.label)
  try { ext.deactivate() } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('harness error:', e); process.exit(2) })
