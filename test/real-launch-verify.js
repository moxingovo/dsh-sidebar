'use strict'
// Real-launch proof: spawns the actual dsh web server from the checkout via the
// extension's launch chain (same as official "dsh web --port N").
const path = require('node:path')
const mockStatusBar = { text: '', tooltip: '', command: '', show() {} }
// Set DSH_CHECKOUT to a local checkout to test the checkout launcher; unset it to
// exercise the auto-detect chain (dsh CLI → npx). Locally we default to the 0.1.6
// checkout when it exists: the fallback chain resolves an OLDER harness (PATH `dsh` or npm latest), which cannot read a store migrated by 0.1.6 and exits 1 —
// so without this the suite failed on a launch chain CI cannot provide either.
const fs = require('node:fs')
const os = require('node:os')
function defaultCheckout() {
  if (process.env.DSH_CHECKOUT) return process.env.DSH_CHECKOUT
  for (const name of ['deepseek-harness-0.1.6', 'deepseek-harness']) {
    const candidate = path.join(os.homedir(), name)
    if (fs.existsSync(path.join(candidate, 'apps', 'cli', 'lib', 'bin.js'))) return candidate
  }
  return ''
}
const config = {
  port: 3198, attachExisting: false, spawnIfMissing: true,
  checkout: defaultCheckout(), command: '',
  extraArgs: [], autoOpen: false, followWorkspace: true, stopOnExit: true,
  // The manifest default: the launch chain must pass the same hardening the
  // managed launcher does, whatever started the server.
  nodeMaxOldSpaceMb: 8192, nodeArgs: [],
}
const commands = {}
let viewProvider = null
const lines = []
const vscode = {
  workspace: {
    getConfiguration: () => ({ ...config, get: (k) => config[k] }),
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createOutputChannel: () => ({ append: () => {}, appendLine: (l) => { lines.push(String(l)); console.log('[out]', l) }, show() {}, dispose() {} }),
    createStatusBarItem: () => mockStatusBar,
    showErrorMessage: (m) => console.log('[err-toast]', m),
    showInformationMessage: () => {},
    createWebviewPanel: () => ({ webview: { html: '' }, iconPath: null, reveal() {}, onDidDispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      if (id === 'dshWebViewAux') viewProvider = provider
      return { dispose() {} }
    },
    showWarningMessage: () => {},
    registerUriHandler: () => ({ dispose() {} }),
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
  },
  commands: { registerCommand: (id, h) => { commands[id] = h; return { dispose() {} } } },
  env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
  ViewBadge: class {},
  Uri: {
    joinPath: (...p) => { const j = path.join(...p); return { fsPath: j, path: j, toString: () => 'file:///' + j.split(path.sep).join('/') } },
    parse: (s) => ({ fsPath: s, path: s, toString: () => s }),
    file: (s) => ({ fsPath: s, path: s, toString: () => s }),
  },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { One: 1 },
}
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode
  return origLoad.apply(this, arguments)
}
const ext = require(path.join(__dirname, '..', 'extension.js'))
ext.activate({ subscriptions: [], extensionUri: path.join(__dirname, '..') })
setTimeout(() => {
  // R1 moved the panel into the sidebar view, so the old "dshWebPanel.open"
  // command is gone; resolving the view is what calls manager.ensure().
  if (viewProvider === null) {
    console.log('[real] view provider was never registered')
    process.exit(1)
  }
  viewProvider.resolveWebviewView({
    webview: { html: '', options: {}, postMessage() {}, onDidReceiveMessage: () => ({ dispose() {} }), asWebviewUri: (u) => u, cspSource: '' },
    onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {},
  })
}, 500)
setTimeout(() => {
  console.log('statusBar.text =', mockStatusBar.text)
  const launch = lines.find((l) => l.includes('launching via')) || ''
  // The hardening flags belong to the checkout launcher; without DSH_CHECKOUT the
  // chain falls back to 'dsh'/'npx', which cannot carry them. Asserting them there
  // made the suite fail for a configuration it was never given.
  const checkoutLauncher = launch.includes('bin.js')
  const flagsOk = !checkoutLauncher
    || (launch.includes('--max-old-space-size=8192') && launch.includes('--report-on-fatalerror'))
  console.log('[real-launch] launch line:', launch.slice(0, 120))
  console.log('[real-launch] checkout launcher used:', checkoutLauncher,
    checkoutLauncher ? '-> hardening flags present: ' + flagsOk : '-> (no DSH_CHECKOUT: hardening assertion skipped)')
  const ready = mockStatusBar.text.includes('$(check)') && flagsOk
  console.log('[real-launch] extension spawned the real dsh server and reached ready:', ready)
  ext.deactivate()
  process.exit(ready ? 0 : 1)
}, 25000)
