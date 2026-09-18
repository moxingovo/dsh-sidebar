'use strict'
// dsh-webview: embed the DeepSeek Harness web GUI in VS Code.
// Attaches to a running dsh web server on dshWeb.port, or starts one with
// cwd = the first workspace folder (default launcher: the built CLI entry of
// the dshWeb.checkout checkout). Renders the GUI in an iframe, both as a
// sidebar view (id dshWebView) and as an editor-tab panel (DSH: Open Panel).
const vscode = require('vscode')
const { spawn } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const CFG = 'dshWeb'
let output
let statusBar
let manager
let context
let disposing = false
const webviews = new Set()

const cfg = () => vscode.workspace.getConfiguration(CFG)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonce = () => crypto.randomBytes(16).toString('base64')

function urlOf(port) {
  return 'http://127.0.0.1:' + port
}

// Minimal shell-safe quoting for building a command line (avoids the Node
// DEP0190 deprecation of args arrays with shell: true). Simple tokens pass
// through unchanged; anything else gets quoted per platform.
function shellQuote(arg) {
  const s = String(arg)
  if (/^[A-Za-z0-9_./:@%+=\\-]+$/.test(s)) return s
  if (process.platform === 'win32') return '"' + s.replace(/"/g, '""') + '"'
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
function shellCommand(prefix, args) {
  return (prefix + ' ' + args.map(shellQuote).join(' ')).trim()
}

// Resolve a real node executable. In the extension host process.execPath is
// the VS Code binary, not node; PATH may also be trimmed depending on how
// VS Code was launched, so check an env override, common install locations
// and finally `where node` before falling back to PATH lookup at spawn time.
function findNode() {
  const candidates = []
  const push = (p) => { if (typeof p === 'string' && p && !candidates.includes(p)) candidates.push(p) }
  push(process.env.DSH_NODE)
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) push(path.join(base, 'nodejs', 'node.exe'))
  }
  if (process.platform === 'win32') {
    try {
      const out = require('node:child_process').execFileSync('where.exe', ['node'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      for (const line of out.split(/\r?\n/)) push(line.trim())
    } catch {}
  }
  for (const c of candidates) if (fs.existsSync(c)) return c
  return 'node'
}

// Probe the port: a 2xx index page carrying the __DSH_BOOT__ manifest counts
// as a real dsh web instance (avoids attaching to unrelated services).
function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c; if (body.length > 300000) { res.destroy(); resolve(false) } })
      res.on('end', () => resolve(res.statusCode < 400 && body.includes('__DSH_BOOT__')))
      res.on('error', () => resolve(false))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

class ServerManager {
  constructor() {
    this.state = 'idle' // idle | starting | ready | attached | error
    this.label = 'stopped'
    this.err = ''
    this.child = null
    this.cwd = null
    this.port = cfg().port
    this.starting = null
    this.expectExit = false
  }

  get url() { return urlOf(this.port) }

  async ensure() {
    if (this.state === 'ready' || this.state === 'attached') return
    if (this.state === 'starting') { await this.starting; return }
    const p = this.start()
    this.starting = p
    try { await p } finally { this.starting = null }
  }

  async start() {
    this.port = cfg().port
    this.setState('starting', 'connecting…')
    output.appendLine('[dsh] probing ' + this.url)
    if (cfg().attachExisting && await probe(this.port)) {
      this.setState('attached', 'attached :' + this.port)
      output.appendLine('[dsh] attached to existing server on :' + this.port)
      return
    }
    if (!cfg().spawnIfMissing) {
      throw this.fail('no dsh server on port ' + this.port + ' and dshWeb.spawnIfMissing is off — start dsh web yourself or enable the setting.')
    }
    this.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
    const args = ['web', '--port', String(this.port), ...(cfg().extraArgs ?? [])]
    // Launch strategies, best first. Each gets up to 120s to become ready
    // before the next is tried (also covers slow npx cold downloads).
    const plans = []
    if (cfg().command) {
      plans.push({
        label: cfg().command + ' ' + args.join(' '),
        make: () => spawn(shellCommand(cfg().command, args), { shell: true, cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
      })
    } else {
      const co = cfg().checkout
      if (co) {
        const bin = path.join(co, 'apps', 'cli', 'lib', 'bin.js')
        if (fs.existsSync(bin)) {
          plans.push({
            label: 'node ' + bin,
            // NOTE: in the extension host, process.execPath is the VS Code
            // binary, not node — resolve a real node binary (see findNode).
            make: () => spawn(findNode(), [bin, ...args], { cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
          })
        } else {
          output.appendLine('[dsh] dshWeb.checkout launcher not found (' + bin + ') — falling back to CLI detection')
        }
      }
      // npm-global CLI (official install: npm i -g @deepseek-ai/dsh). Needs a
      // shell on Windows so dsh.cmd resolves.
      if (process.platform === 'win32') {
        plans.push({
          label: 'dsh',
          make: () => spawn(shellCommand('dsh', args), { shell: true, cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
        })
        // Universal fallback: fetch the CLI on demand (slow the first time).
        plans.push({
          label: 'npx @deepseek-ai/dsh',
          make: () => spawn(shellCommand('npx --yes @deepseek-ai/dsh', args), { shell: true, cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
        })
      } else {
        plans.push({
          label: 'dsh',
          make: () => spawn('dsh', args, { cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }),
        })
        plans.push({
          label: 'npx @deepseek-ai/dsh',
          make: () => spawn('npx', ['--yes', '@deepseek-ai/dsh', ...args], { cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }),
        })
      }
    }

    let lastErr = ''
    for (const plan of plans) {
      if (disposing) return
      output.appendLine('[dsh] launching via ' + plan.label + '  (cwd=' + this.cwd + ')')
      let child
      try {
        child = plan.make()
      } catch (err) {
        lastErr = plan.label + ': ' + err.message
        output.appendLine('[dsh] ' + lastErr)
        continue
      }
      this.child = child
      child.stdout.on('data', (d) => output.append(String(d)))
      child.stderr.on('data', (d) => output.append(String(d)))
      let settled = false
      child.on('error', (err) => {
        lastErr = plan.label + ': ' + (err.code ?? err.message)
        output.appendLine('[dsh] ' + lastErr)
      })
      child.on('close', () => { settled = true })
      child.on('exit', (code, signal) => {
        settled = true
        output.appendLine('[dsh] server exited code=' + code + ' signal=' + signal)
        if (this.child === child) this.child = null
        if (this.state === 'starting') {
          lastErr = plan.label + ': exited during startup (code ' + code + ')'
          return
        }
        // Runtime crash of a self-owned server → self-heal.
        this.setState('idle', 'stopped')
        this.broadcast('reload')
        if (!this.expectExit && !disposing && cfg().spawnIfMissing) {
          output.appendLine('[dsh] self-started server exited — restarting in 1.5s')
          setTimeout(() => { if (!this.child && !disposing) this.ensure().catch(() => {}) }, 1500)
        }
      })
      const deadline = Date.now() + 120000
      while (Date.now() < deadline && !settled) {
        if (await probe(this.port)) {
          this.setState('ready', 'running :' + this.port)
          output.appendLine('[dsh] ready on ' + this.url)
          return
        }
        await sleep(400)
      }
      if (this.state === 'ready' || this.state === 'attached') return
      this.kill()
    }
    throw this.fail('could not launch dsh (' + (lastErr || 'all launch strategies failed') + '). Install it via "npm i -g @deepseek-ai/dsh", or set dshWeb.command / dshWeb.checkout. See the DSH Server output channel.')
  }

  // Record an error state without throwing: event handlers (child exit/error)
  // must not throw inside the event loop; the startup wait-loop re-raises it.
  fail(message) {
    this.err = message
    this.setState('error', 'error')
    output.appendLine('[dsh] ERROR: ' + message)
    return new Error(message)
  }

  setState(state, label) {
    this.state = state
    this.label = label
    refreshStatus()
    if (state === 'ready' || state === 'attached') this.broadcast('reload')
  }

  async restart() {
    if (this.state !== 'ready' || !this.child) {
      vscode.window.showInformationMessage('DSH server was not started by this extension. Restart it yourself, then run "DSH: Reload Panel".')
      return
    }
    output.appendLine('[dsh] restart requested')
    this.expectExit = true
    this.kill()
    await sleep(800)
    this.setState('idle', 'stopped')
    await this.ensure()
  }

  // Kill the process tree on Windows (covers shell-launched children).
  kill() {
    if (!this.child) return
    const child = this.child
    this.child = null
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        try { child.kill() } catch {}
      }
    } else {
      try { child.kill() } catch {}
    }
  }

  broadcast(command) {
    for (const w of webviews) w.postMessage({ command, port: this.port })
  }

  dispose() {
    this.kill()
  }
}

function refreshStatus() {
  const icons = { idle: '$(circle-slash)', starting: '$(sync~spin)', ready: '$(check)', attached: '$(plug)', error: '$(error)' }
  statusBar.text = (icons[manager?.state] ?? '$(circle-slash)') + ' DSH'
  statusBar.tooltip = 'DSH Web Panel — ' + (manager?.label ?? 'stopped') + ' (' + (manager?.url ?? '?') + ')'
  statusBar.command = 'dshWebPanel.open'
}

function webviewHtml(port) {
  const n = nonce()
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src http://127.0.0.1:* http://localhost:*; script-src \'nonce-' + n + '\'; style-src \'unsafe-inline\';">'
    + '<style>html,body{height:100%;margin:0;padding:0;overflow:hidden;background:#0f1115}iframe{width:100%;height:100%;border:0;display:block}</style>'
    + '</head><body>'
    + '<iframe id="app" src="http://127.0.0.1:' + port + '/" allow="clipboard-read; clipboard-write; fullscreen"></iframe>'
    + '<script nonce="' + n + '">'
    + 'const vscode=acquireVsCodeApi();'
    + 'window.addEventListener("message",(e)=>{const m=e.data;if(m&&m.command==="reload"){document.getElementById("app").src="http://127.0.0.1:"+m.port+"/?_="+Date.now()}});'
    + '</script></body></html>'
}

async function openPanel() {
  try {
    await manager.ensure()
  } catch (e) {
    vscode.window.showErrorMessage('DSH: ' + e.message)
    return
  }
  if (openPanel.active) { openPanel.active.reveal(); return }
  const panel = vscode.window.createWebviewPanel('dshWebPanel', 'DSH', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dsh.svg')
  panel.webview.html = webviewHtml(manager.port)
  webviews.add(panel.webview)
  panel.onDidDispose(() => {
    webviews.delete(panel.webview)
    openPanel.active = null
  })
  openPanel.active = panel
}

// Restores the DSH editor tab with the window layout (panel position memory).
class DshPanelSerializer {
  deserializeWebviewPanel(panel) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dsh.svg')
    panel.webview.options = { enableScripts: true }
    panel.webview.html = webviewHtml(manager.port)
    webviews.add(panel.webview)
    panel.onDidDispose(() => {
      webviews.delete(panel.webview)
      if (openPanel.active === panel) openPanel.active = null
    })
    openPanel.active = panel
    manager.ensure().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))
  }
}

class DshViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true }
    view.webview.html = webviewHtml(manager.port)
    webviews.add(view.webview)
    view.onDidDispose(() => webviews.delete(view.webview))
    manager.ensure().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))
  }
}

async function reloadPanels() {
  // Re-probe in case a user-owned server came up or moved ports, or an
  // attached instance died (e.g. its desktop window was closed).
  if (manager.state === 'attached') {
    const alive = await probe(manager.port)
    if (!alive) {
      output.appendLine('[dsh] attached server gone — reconnecting')
      manager.setState('idle', 'reconnecting…')
    }
  }
  if (manager.state !== 'ready' && manager.state !== 'attached') {
    try { await manager.ensure() } catch { /* keep old state; just refresh */ }
  }
  manager.broadcast('reload')
}

async function openInBrowser() {
  const port = manager?.port ?? cfg().port
  await vscode.env.openExternal(vscode.Uri.parse(urlOf(port) + '/'))
}

function activate(ctx) {
  context = ctx
  output = vscode.window.createOutputChannel('DSH Server')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.show()
  manager = new ServerManager()
  refreshStatus()
  ctx.subscriptions.push(output, statusBar)
  ctx.subscriptions.push(vscode.commands.registerCommand('dshWebPanel.open', openPanel))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshWebPanel.openBrowser', openInBrowser))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshWebPanel.reload', reloadPanels))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshWebPanel.restartServer', () => manager.restart().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))))
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('dshWebView', new DshViewProvider(), {
    webviewOptions: { retainContextWhenHidden: true },
  }))
  ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer('dshWebPanel', new DshPanelSerializer()))
  // Multi-workspace follow: dsh's workspace root is the server cwd, so restart
  // a self-started server when the first workspace folder changes.
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!cfg().followWorkspace || !manager.child || manager.state !== 'ready') return
    const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
    if (first === manager.cwd) return
    output.appendLine('[dsh] workspace folder changed to ' + first + ' — restarting with new workspace root')
    manager.restart().catch(() => {})
  }))
  // Restart a self-started server when the port setting changes.
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CFG + '.port') && manager.state === 'ready' && manager.child) {
      output.appendLine('[dsh] dshWeb.port changed — restarting')
      manager.restart().catch(() => {})
    }
  }))
  // Lazy startup attach: if the user's server is already up, adopt it.
  ;(async () => {
    try {
      if (cfg().attachExisting && await probe(cfg().port)) manager.setState('attached', 'attached :' + cfg().port)
    } catch {}
  })()
  // Keep an attached server honest: if it dies (e.g. the desktop window that
  // started it is closed), take over with a self-started hidden instance.
  const healthTimer = setInterval(() => {
    if (manager.state !== 'attached' || manager.starting) return
    probe(manager.port).then((alive) => {
      if (!alive && manager.state === 'attached') {
        output.appendLine('[dsh] attached server stopped responding — taking over with a local instance')
        manager.setState('idle', 'reconnecting…')
        manager.ensure().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))
      }
    })
  }, 15000)
  ctx.subscriptions.push({ dispose: () => clearInterval(healthTimer) })
  // Auto-open the panel so the window starts in the harness (disable with dshWeb.autoOpen).
  if (cfg().autoOpen) {
    setTimeout(() => { openPanel().catch(() => {}) }, 500)
  }
}

function deactivate() {
  disposing = true
  if (manager) manager.expectExit = true
  if (manager && cfg().stopOnExit) manager.dispose()
}

module.exports = { activate, deactivate }
