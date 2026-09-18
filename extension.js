'use strict'
// dsh-webview: native DSH sidebar for VS Code.
// Replaces the old iframe-embedded web GUI (R1) with a self-written native
// chat front-end (Claude Code style). Back-end = the existing dsh web service
// on dshWeb.port (127.0.0.1:3080) — no second gateway, no DSH_HOME isolation.
// Protocol lives in src/protocol.js (P0 mapping module, see service rc.5).
const vscode = require('vscode')
const { spawn } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { DshClient } = require('./src/protocol')

const CFG = 'dshWeb'
let output
let statusBar
let manager
let context
let disposing = false
const bridges = new Set()
let webviewBodies = null

const cfg = () => vscode.workspace.getConfiguration(CFG)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonce = () => crypto.randomBytes(16).toString('base64')
const homeDsh = () => path.join(os.homedir(), '.dsh')

function urlOf(port) {
  return 'http://127.0.0.1:' + port
}

// Minimal shell-safe quoting for building a command line (avoids the Node
// DEP0190 deprecation of args arrays with shell: true).
function shellQuote(arg) {
  const s = String(arg)
  if (/^[A-Za-z0-9_./:@%+=\-]+$/.test(s)) return s
  if (process.platform === 'win32') return '"' + s.replace(/"/g, '""') + '"'
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
function shellCommand(prefix, args) {
  return (prefix + ' ' + args.map(shellQuote).join(' ')).trim()
}

// Resolve a real node executable (in the extension host process.execPath is
// the VS Code binary, not node).
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

// Probe the port: any HTTP listener answering JSON on /api counts (the dsh
// service root it; keep the old __DSH_BOOT__ check as a secondary signal).
//
// The timeout is deliberately generous: the server's own stall-watch logs
// multi-second event-loop stalls under load, and a 1.5s budget turned a busy
// server into an apparently dead one.
function probe(port, timeoutMs = 4000) {
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

/**
 * Confirm the port is really down, not merely busy. One missed probe is not
 * evidence — it is what made the extension declare an attached server dead,
 * spawn a local instance on top of it, and keep that instance even after the
 * managed launcher had already started a properly configured replacement.
 */
async function probeDead(port, attempts = 3, gapMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    if (await probe(port)) return false
    if (i < attempts - 1) await sleep(gapMs)
  }
  return true
}

/**
 * Node flags for the checkout launcher. The managed launcher
 * (~/.dsh/run-server.cmd) passes the same set, and that is the point: whichever
 * program wins the port must start the server the same way. Without the heap
 * ceiling a large session serialization takes V8 down with a silent
 * exit 0xC0000409 instead of failing one request; without the report flags that
 * death leaves no evidence; and without the system CA the trust-store tools
 * fail behind a TLS-inspecting proxy.
 */
const DEFAULT_MAX_OLD_SPACE_MB = 8192

function nodeFlags() {
  const flags = []
  const configured = cfg().nodeMaxOldSpaceMb
  const mb = Number(configured === undefined || configured === null ? DEFAULT_MAX_OLD_SPACE_MB : configured)
  if (Number.isFinite(mb) && mb > 0) flags.push('--max-old-space-size=' + Math.floor(mb))
  const reports = path.join(homeDsh(), 'reports')
  try { fs.mkdirSync(reports, { recursive: true }) } catch {}
  flags.push('--report-on-fatalerror', '--report-directory=' + reports)
  if (supportsSystemCa()) flags.push('--use-system-ca')
  for (const extra of cfg().nodeArgs ?? []) flags.push(String(extra))
  return flags
}

// --use-system-ca exists from Node 22.15/23.2 on; an older node exits on the
// unknown option, so the flag is only sent to a node that understands it.
let systemCaSupport
function supportsSystemCa() {
  if (systemCaSupport !== undefined) return systemCaSupport
  systemCaSupport = false
  try {
    const out = require('node:child_process').execFileSync(findNode(), ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const [major, minor] = String(out).trim().replace(/^v/, '').split('.').map(Number)
    systemCaSupport = major > 22 || (major === 22 && minor >= 15)
  } catch (err) {
    output.appendLine('[dsh] could not read the node version — leaving --use-system-ca off (' + (err && err.message) + ')')
  }
  return systemCaSupport
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
    this.crashes = []
    this.downSince = 0
  }

  get url() { return urlOf(this.port) }

  async ensure() {
    if (this.state === 'ready' || this.state === 'attached') return
    if (this.state === 'starting') { await this.starting; return }
    const p = this.start()
    this.starting = p
    try { await p } finally { this.starting = null }
  }

  /**
   * Wait for the server this port is supposed to have. "Nothing answers right
   * now" is not "nothing will": a managed launcher needs ~20s to boot a
   * replacement after a restart. Spawning into that window is what let the
   * extension steal the port from the launcher and keep it.
   */
  async awaitExisting() {
    const budget = Math.max(0, Number(cfg().attachWaitSeconds ?? 30)) * 1000
    const deadline = Date.now() + budget
    let announced = false
    for (;;) {
      if (await probe(this.port)) {
        this.setState('attached', 'attached :' + this.port)
        output.appendLine('[dsh] attached to existing server on :' + this.port)
        return true
      }
      if (Date.now() >= deadline) {
        if (announced) output.appendLine('[dsh] still nothing on :' + this.port + ' after ' + Math.round(budget / 1000) + 's')
        return false
      }
      if (!announced) {
        announced = true
        output.appendLine('[dsh] nothing on :' + this.port + ' yet — waiting up to ' + Math.round(budget / 1000) + 's for a launcher before starting our own')
      }
      await sleep(1000)
    }
  }

  // B1: spawn 强制 DSH_HOME=~/.dsh(与 attachExisting 完全一致,绝不隔离)
  spawnEnv() {
    return { ...process.env, DSH_HOME: homeDsh() }
  }

  async start() {
    this.port = cfg().port
    this.setState('starting', 'connecting…')
    output.appendLine('[dsh] probing ' + this.url)
    if (cfg().attachExisting && await this.awaitExisting()) return
    if (!cfg().spawnIfMissing) {
      throw this.fail('no dsh server on port ' + this.port + ' and dshWeb.spawnIfMissing is off — start dsh web yourself or enable the setting.')
    }
    this.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
    const args = ['web', '--port', String(this.port), ...(cfg().extraArgs ?? [])]
    const plans = []
    if (cfg().command) {
      plans.push({
        label: cfg().command + ' ' + args.join(' '),
        make: () => spawn(shellCommand(cfg().command, args), { shell: true, cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
      })
    } else {
      const co = cfg().checkout
      if (co) {
        const bin = path.join(co, 'apps', 'cli', 'lib', 'bin.js')
        if (fs.existsSync(bin)) {
          const flags = nodeFlags()
          plans.push({
            label: 'node ' + flags.join(' ') + ' ' + bin,
            make: () => spawn(findNode(), [...flags, bin, ...args], { cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
          })
        } else {
          output.appendLine('[dsh] dshWeb.checkout launcher not found (' + bin + ') — falling back to CLI detection')
        }
      }
      if (process.platform === 'win32') {
        plans.push({
          label: 'dsh',
          make: () => spawn(shellCommand('dsh', args), { shell: true, cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
        })
        plans.push({
          label: 'npx @deepseek-ai/dsh',
          make: () => spawn(shellCommand('npx --yes @deepseek-ai/dsh', args), { shell: true, cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
        })
      } else {
        plans.push({
          label: 'dsh',
          make: () => spawn('dsh', args, { cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] }),
        })
        plans.push({
          label: 'npx @deepseek-ai/dsh',
          make: () => spawn('npx', ['--yes', '@deepseek-ai/dsh', ...args], { cwd: this.cwd, env: this.spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] }),
        })
      }
    }

    let lastErr = ''
    for (const plan of plans) {
      if (disposing) return
      output.appendLine('[dsh] launching via ' + plan.label + '  (cwd=' + this.cwd + ' DSH_HOME=' + homeDsh() + ')')
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
        this.setState('idle', 'stopped')
        this.broadcast('serverState')
        if (!this.expectExit && !disposing && cfg().spawnIfMissing) {
          // A silent 0xC0000409 exit is a crash, not a shutdown: restarting it
          // every 1.5s turns one bad state into a visible crash loop. Back off,
          // and stop after three crashes in five minutes with the code on screen.
          const now = Date.now()
          this.crashes = (this.crashes ?? []).filter((t) => now - t < 300000)
          this.crashes.push(now)
          if (this.crashes.length > 3) {
            this.fail('自启的 dsh 服务 5 分钟内退出 ' + this.crashes.length + ' 次(最后一次 code=' + code + '),已停止自动重启。'
              + '查看 DSH 输出通道与 ' + path.join(homeDsh(), 'reports') + ',或修好后执行 “DSH: 重启服务”。')
            return
          }
          const delay = 1500 * this.crashes.length
          output.appendLine('[dsh] self-started server exited — restarting in ' + delay + 'ms (' + this.crashes.length + '/3 crashes in 5min)')
          setTimeout(() => { if (!this.child && !disposing) this.ensure().catch(() => {}) }, delay)
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
    throw this.fail('could not launch dsh (' + (lastErr || 'all launch strategies failed') + '). Install it via "npm i -g @deepseek-ai/dsh", or set dshWeb.command / dshWeb.checkout. See the DSH output channel.')
  }

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
    this.broadcast('serverState')
  }

  async restart() {
    if (this.state !== 'ready' || !this.child) {
      // 附着外部实例(桌面 harness)或失败态:重新探测并附着,而不是弹误导提示
      output.appendLine('[dsh] restart requested (attached/external) — reconnecting')
      this.setState('idle', 'reconnecting…')
      try { await this.ensure() } catch (e) { output.appendLine('[dsh] reconnect failed: ' + e.message) }
      return
    }
    output.appendLine('[dsh] restart requested')
    this.expectExit = true
    this.kill()
    await sleep(800)
    this.setState('idle', 'stopped')
    await this.ensure()
  }

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
    for (const b of bridges) b.onServerMessage(command, this)
  }

  dispose() {
    this.kill()
  }
}

function refreshStatus() {
  const icons = { idle: '$(circle-slash)', starting: '$(sync~spin)', ready: '$(check)', attached: '$(plug)', error: '$(error)' }
  statusBar.text = (icons[manager?.state] ?? '$(circle-slash)') + ' DSH'
  statusBar.tooltip = 'DSH 原生侧边栏 — ' + (manager?.label ?? 'stopped') + ' (' + (manager?.url ?? '?') + ')\n点击:展开/收起侧边栏'
  statusBar.command = 'dshPanel.toggle'
}

// ── webview asset assembly ───────────────────────────────────────────────────
// Keep CSS/JS in separate files for maintainability; they are inlined into a
// single CSP-clean HTML document (script-src nonce, no resource origins).
function webviewBodiesRead() {
  if (webviewBodies) return webviewBodies
  // context.extensionUri is a vscode.Uri — join through Uri, read via fsPath.
  const read = (...segments) => fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, ...segments).fsPath, 'utf8')
  webviewBodies = {
    css: read('webview', 'app.css'),
    js: read('webview', 'markdown.js') + '\n' + read('webview', 'app.js'),
  }
  return webviewBodies
}

function webviewHtml(port) {
  const n = nonce()
  const b = webviewBodiesRead()
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\'; script-src \'nonce-' + n + '\';">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<style>' + b.css + '</style>'
    + '</head><body><div id="app"></div>'
    + '<script nonce="' + n + '">' + b.js + '</script>'
    + '</body></html>'
}

// ── panel bridge: one adapter per webview ────────────────────────────────────

class PanelBridge {
  constructor(webview) {
    this.webview = webview
    this.client = null
    this.port = null
    this.alive = true
    this.connected = false
    this.muxUp = false
    this.hostUp = false
    this.currentSessionId = null
    this.serverRoot = null // harness 服务端工作区根目录(describe.cwd),会话以它分组
    webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.error('handler', e)))
  }

  send(message) {
    if (this.alive) this.webview.postMessage(message)
  }

  error(kind, e) {
    this.send({ type: 'error', kind, message: String(e && e.message || e) })
    output.appendLine('[dsh] ' + kind + ' error: ' + String(e && e.stack || e))
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return
    output.appendLine('[dsh] webview -> ' + m.type + (m.sessionId ? ' ' + m.sessionId : ''))
    switch (m.type) {
      case 'boot': return this.boot()
      case 'describe': return this.pushDescribe()
      case 'listSessions': return this.listSessions(m)
      case 'createSession': return this.createSession(m)
      case 'openSession': return this.openSession(m)
      case 'closeSession': return this.closeSession(m)
      case 'historyMore': return this.historyMore(m)
      case 'prompt': return this.sendPrompt(m)
      case 'cancel': return this.sendCancel(m)
      case 'selectModel': return this.selectModel(m)
      case 'refreshModels': return this.refreshModels(m)
      case 'selectPreset': return this.selectPreset(m)
      case 'renameSession': return this.renameSession(m)
      case 'archiveSession': return this.archiveSession(m)
      case 'forkSession': return this.forkSession(m)
      case 'compact': return this.compact(m)
      case 'approvalRespond': return this.approvalRespond(m)
      case 'questionAnswer': return this.questionAnswer(m)
      case 'copyText': return this.copyText(m)
      case 'restartServer': return this.restartServer()
      case 'openUrl': return this.openUrl(m)
      case 'collapse': return this.collapse()
      case 'expandView': return this.expandView()
      case 'openBrowser': return this.openBrowser()
      case 'getSettings': return this.pushSettings()
      case 'lastSession': return this.lastSession(m)
      default: return
    }
  }

  async boot() {
    // ensure the service, then attach the protocol client and describe.
    try { await manager.ensure() } catch (e) { this.error('boot', e) }
    this.port = manager.port
    this.send({ type: 'hello', port: this.port, version: '0.4.2' })
    this.send({ type: 'workspace', path: firstWorkspacePath() })
    this.connect()
    await this.pushDescribe()
  }

  connect() {
    this.disconnect()
    const log = (a, b, c) => output.appendLine('[dsh] ' + String(a) + (b !== undefined ? ' ' + String(b) : '') + (c !== undefined ? ' ' + String(c) : ''))
    const client = new DshClient({ baseUrl: urlOf(this.port), log })
    this.client = client
    client.on('mux', (frame) => this.sendFrame('mux', frame))
    client.on('host', (frame) => this.sendFrame('host', frame))
    client.on('up', (info) => {
      if (info.stream === 'mux') this.muxUp = true
      if (info.stream === 'host') this.hostUp = true
      this.updateState()
    })
    client.on('down', (info) => {
      if (info.stream === 'mux') this.muxUp = false
      if (info.stream === 'host') this.hostUp = false
      this.updateState()
    })
    output.appendLine('[dsh] protocol client on ' + urlOf(this.port))
    client.open()
    // 主动首次拉取:避免 webview 的 listSessions 早于客户端连接而丢失
    setTimeout(() => { this.pushDescribe().catch(() => {}); this.listSessions({}).catch(() => {}) }, 1200)
  }

  sendFrame(kind, frame) {
    this.send({ type: 'frame', kind, frame })
  }

  updateState() {
    const next = this.muxUp && this.hostUp
    if (next !== this.connected) {
      this.connected = next
      this.send({ type: 'connection', state: next ? 'connected' : 'reconnecting' })
    }
  }

  disconnect() {
    this.muxUp = false
    this.hostUp = false
    this.connected = false
    if (this.client) { this.client.close(); this.client = null }
  }

  onServerMessage(command, mgr) {
    if (!this.alive) return
    if (command === 'serverState') {
      this.send({ type: 'serverState', state: mgr.state, label: mgr.label, port: mgr.port, error: mgr.err })
      if (mgr.state === 'ready' || mgr.state === 'attached') {
        this.port = mgr.port
        if (!this.client) { this.connect(); this.pushDescribe().catch(() => {}) }
      } else if (mgr.state === 'idle' || mgr.state === 'error') {
        this.disconnect()
      }
    } else if (command === 'reload') {
      this.send({ type: 'reload' })
      this.disconnect()
      this.connect()
    }
  }

  async rpc(method, payload) {
    if (!this.client) throw new Error('未连接到 dsh 服务')
    return this.client.request(method, payload)
  }

  async pushDescribe() {
    try {
      const desc = await this.rpc('host.describe', {})
      this.send({ type: 'describe', describe: desc, config: settingsSnapshot() })
    } catch (e) { this.error('describe', e) }
  }

  async listSessions(m) {
    try {
      // 客户端可能尚未就绪(webview 消息先于 boot 完成)——带重试等待
      let list = null
      for (let i = 0; i < 5; i++) {
        try { list = await this.rpc('session.list', {}); break } catch (err) {
          if (!this.client) { await sleep(800); continue }
          throw err
        }
      }
      if (list === null) throw new Error('未连接到 dsh 服务')
      // The archive set must never be silently emptied: `sessionList` carries the whole
      // workspace, and the webview filters archived ids out of it. A `catch(() => [])`
      // here used to mean "one failed call" → empty set → every archived conversation
      // reappeared in the drawer and could be opened and messaged again. Retry, and on
      // final failure omit the field so the webview keeps the set it already has.
      let archivedIds = null
      for (let i = 0; i < 3; i++) {
        try {
          const workspaces = await this.rpc('workspace.list', {})
          archivedIds = workspaces.archivedSessionIds || []
          break
        } catch (err) {
          if (!this.client) { await sleep(800); continue }
          output.appendLine('[dsh] workspace.list failed (' + i + '): ' + (err && err.message))
          await sleep(400)
        }
      }
      // 会话列表 = VS Code 当前文件夹对应的 harness 工作区(大小写/斜杠归一化匹配)
      const ws = firstWorkspacePath()
      const inWorkspace = (ws && list.items || []).filter((s) => normPath(s.cwd) === normPath(ws))
      // …再剔掉 subagent 的子会话。它们是子代理自己跑任务的会话日志,不是用户开的对话:
      // DSH 客户端把它们挂在父会话的 subagent catalog 里,从不列进对话列表。列在这里
      // 就是抽屉里那一堆 "你是资深…/You are doing…" 行——既点不出所以然,归档也挡不住
      // (归档只隐藏,不删除,而它们本来就不该出现)。
      const items = inWorkspace.filter(isConversation)
      const subagents = inWorkspace.length - items.length
      output.appendLine('[dsh] session.list total=' + (list.items || []).length + ' workspace=' + (ws || '(none)') + ' conversations=' + items.length + ' subagentSessions=' + subagents + ' archived=' + (archivedIds === null ? '(unavailable — keeping current)' : archivedIds.length))
      this.send({
        type: 'sessionList',
        items,
        ...archivedIds === null ? {} : { archivedIds },
        workspacePath: ws || null,
      })
    } catch (e) { this.error('session.list', e) }
  }

  async createSession(m) {
    try {
      // 新会话必须落在 harness 工作区(实证:cwd 不会入组,workspaceId 才会)
      const wsRoot = firstWorkspacePath() || os.homedir()
      const workspaces = await this.rpc('workspace.list', {}).catch(() => ({ items: [] }))
      let target = (workspaces.items || []).find((w) => normPath(w.path) === normPath(wsRoot)) || null
      if (!target) {
        // workspace.create 返回 { workspace:{workspaceId,...}, created } —— 兼容两种结构
        const created = await this.rpc('workspace.create', { path: wsRoot }).catch(() => null)
        target = (created && (created.workspace || created)) || null
      }
      const wsId = target && typeof target.workspaceId === 'string' ? target.workspaceId : null
      if (!target) output.appendLine('[dsh] workspace lookup/create failed for ' + wsRoot + ' — falling back to cwd')
      const payload = {
        ...(wsId ? { workspaceId: wsId } : { cwd: wsRoot }),
        ...(m.agentPreset ? { agentPreset: m.agentPreset } : {}),
      }
      output.appendLine('[dsh] session.create workspace=' + (wsId || '(none)') + ' root=' + wsRoot)
      const value = await this.rpc('session.create', payload)
      this.send({ type: 'sessionCreated', sessionId: value.sessionId, agentPreset: value.agentPreset })
      await this.listSessions({})
    } catch (e) { this.error('session.create', e) }
  }

  async openSession(m) {
    try {
      this.currentSessionId = m.sessionId
      const [history, models, presets] = await Promise.all([
        this.rpc('session.history', { sessionId: m.sessionId }),
        this.rpc('session.models', { sessionId: m.sessionId }).catch(() => null),
        this.rpc('agentPreset.list', {}).catch(() => ({ presets: [], authorable: false })),
      ])
      const blank = !(history.events || []).some((e) => e.event.type === 'turn/start')
      this.send({
        type: 'sessionOpened',
        sessionId: m.sessionId,
        events: history.events || [],
        projections: history.projections || null,
        hasMore: !!history.hasMore,
        blank,
        models: models || null,
        presets: presets || { presets: [] },
      })
      context.globalState.update('dshPanel.lastSessionId', m.sessionId)
    } catch (e) { this.error('session.history', e) }
  }

  async closeSession(m) {
    this.send({ type: 'sessionClosed', sessionId: m.sessionId })
  }

  async historyMore(m) {
    try {
      const h = await this.rpc('session.history', { sessionId: m.sessionId, beforeSeq: m.beforeSeq, maxMessages: m.maxMessages || 40 })
      this.send({ type: 'historyPage', sessionId: m.sessionId, events: h.events || [], hasMore: !!h.hasMore })
    } catch (e) { this.error('session.history', e) }
  }

  async sendPrompt(m) {
    try {
      const payload = { sessionId: m.sessionId, mode: m.mode || 'queue', content: m.content || [] }
      const value = await this.rpc('session.prompt', payload)
      this.send({ type: 'promptAccepted', sessionId: m.sessionId, command: value.command || null })
      // optimistic user echo so the composer clears instantly; the event
      // stream carries the authoritative user/message.
      this.send({ type: 'promptSent', sessionId: m.sessionId })
    } catch (e) { this.error('session.prompt', e) }
  }

  async sendCancel(m) {
    try {
      await this.rpc('session.cancel', { sessionId: m.sessionId })
      this.send({ type: 'cancelled', sessionId: m.sessionId })
    } catch (e) { this.error('session.cancel', e) }
  }

  async refreshModels(m) {
    try {
      const sid = m.sessionId || this.currentSessionId
      if (!sid) return
      const models = await this.rpc('session.models', { sessionId: sid })
      this.send({ type: 'modelsRefreshed', sessionId: sid, models })
    } catch (e) { this.error('session.models', e) }
  }

  async selectModel(m) {
    const t0 = Date.now()
    try {
      const payload = { sessionId: m.sessionId, provider: m.provider, model: m.model }
      if (m.reasoningEffort) payload.reasoningEffort = m.reasoningEffort
      const value = await this.rpc('session.selectModel', payload)
      output.appendLine('[dsh] selectModel ok ' + (Date.now() - t0) + 'ms ' + m.provider + '/' + m.model + (m.reasoningEffort ? ' effort=' + m.reasoningEffort : ''))
      this.send({ type: 'modelSelected', sessionId: m.sessionId, selected: value.selected })
    } catch (e) {
      output.appendLine('[dsh] selectModel FAIL ' + (Date.now() - t0) + 'ms ' + String(e && e.message || e))
      this.error('session.selectModel', e)
    }
  }

  async selectPreset(m) {
    try {
      const value = await this.rpc('agentPreset.select', { sessionId: m.sessionId, agentPreset: m.agentPreset })
      this.send({ type: 'presetSelected', sessionId: m.sessionId, agentPreset: value.agentPreset })
    } catch (e) { this.error('agentPreset.select', e) }
  }

  async renameSession(m) {
    try {
      const value = await this.rpc('session.rename', { sessionId: m.sessionId, title: m.title })
      this.send({ type: 'sessionRenamed', sessionId: m.sessionId, title: value.title, seq: value.seq })
    } catch (e) { this.error('session.rename', e) }
  }

  async archiveSession(m) {
    try {
      const value = await this.rpc('workspace.archiveSession', { sessionId: m.sessionId })
      this.send({ type: 'sessionArchived', sessionId: m.sessionId, archivedIds: value.archivedSessionIds })
    } catch (e) { this.error('workspace.archiveSession', e) }
  }

  async forkSession(m) {
    try {
      const payload = { sessionId: m.sessionId }
      if (m.atSeq !== undefined) payload.atSeq = m.atSeq
      const value = await this.rpc('session.fork', payload)
      this.send({ type: 'sessionForked', parent: m.sessionId, sessionId: value.sessionId })
    } catch (e) { this.error('session.fork', e) }
  }

  async compact(m) {
    try {
      const value = await this.rpc('session.prompt', { sessionId: m.sessionId, mode: 'queue', content: [{ type: 'text', text: '/compact' }] })
      this.send({ type: 'promptAccepted', sessionId: m.sessionId, command: value.command || null })
    } catch (e) { this.error('compact', e) }
  }

  async approvalRespond(m) {
    try {
      // 服务端 approvalResponsePayloadSchema 要求三件套：sessionId / approvalId / outcome。
      // 之前漏了 sessionId，即使 rpcId 对了也会被判定 bad-response（网关返回 accepted:false）。
      if (!m.sessionId) throw new Error('approvalRespond 缺少 sessionId')
      await this.respondRpc(m.rpcId, { sessionId: m.sessionId, approvalId: m.approvalId, outcome: m.outcome })
      this.send({ type: 'approvalResponded', sessionId: m.sessionId, approvalId: m.approvalId, outcome: m.outcome })
    } catch (e) { this.error('approvalRespond', e) }
  }

  async questionAnswer(m) {
    try {
      // 服务端 questionResponsePayloadSchema 要求 { sessionId, answer: { answers } }：
      // answers 必须包在 answer 里，且同样需要 sessionId。
      if (!m.sessionId) throw new Error('questionAnswer 缺少 sessionId')
      await this.respondRpc(m.rpcId, { sessionId: m.sessionId, answer: { answers: m.answers || [] } })
      this.send({ type: 'questionAnswered', sessionId: m.sessionId, questionRpcId: m.rpcId })
    } catch (e) { this.error('questionAnswer', e) }
  }

  async respondRpc(rpcId, value) {
    if (!this.client) throw new Error('未连接到 dsh 服务')
    return this.client.respond(rpcId, value)
  }

  async copyText(m) {
    await vscode.env.clipboard.writeText(String(m.text ?? ''))
    this.send({ type: 'copied', ok: true })
  }

  async restartServer() {
    await manager.restart()
  }

  async openUrl(m) {
    const url = String(m.url || '')
    if (!/^https?:\/\//.test(url)) return
    await vscode.env.openExternal(vscode.Uri.parse(url))
  }

  async collapse() {
    // R2: 收起右侧面板,右上角容器图标负责恢复(与 Claude Code 行为一致)
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
  }

  async expandView() {
    await vscode.commands.executeCommand('workbench.view.extension.dsh-aux')
  }

  async openBrowser() {
    const port = this.port ?? manager?.port ?? cfg().port
    await vscode.env.openExternal(vscode.Uri.parse(urlOf(port) + '/'))
  }

  async pushSettings() {
    this.send({ type: 'settings', config: settingsSnapshot(), dshHome: homeDsh() })
  }

  async lastSession(m) {
    this.send({ type: 'lastSession', sessionId: await context.globalState.get('dshPanel.lastSessionId') ?? null })
  }

  dispose() {
    this.alive = false
    this.disconnect()
  }
}

function firstWorkspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
}

/**
 * Whether a session-list entry is a user conversation rather than a subagent's
 * own working session.
 *
 * A subagent session is the only thing that carries `origin: 'subagent'` — the
 * session header validator accepts no other origin value, and a fork carries
 * `parentSessionId` WITHOUT it, so keying on parentSessionId would hide the
 * user's own derived conversations. The DSH client files subagent sessions
 * under their parent's catalog and never lists them as conversations.
 */
function isConversation(s) {
  return s.origin !== 'subagent'
}

function normPath(p) {
  // 分隔符归一 + 去尾 + 小写,容忍 C:/ 与 C:\ 混用
  return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : p
}

function settingsSnapshot() {
  return {
    port: cfg().port,
    attachExisting: cfg().attachExisting,
    spawnIfMissing: cfg().spawnIfMissing,
    checkout: cfg().checkout,
    command: cfg().command,
    extraArgs: cfg().extraArgs ?? [],
    attachWaitSeconds: cfg().attachWaitSeconds,
    takeoverAfterSeconds: cfg().takeoverAfterSeconds,
    nodeMaxOldSpaceMb: cfg().nodeMaxOldSpaceMb,
    nodeArgs: cfg().nodeArgs ?? [],
    followWorkspace: cfg().followWorkspace,
    stopOnExit: cfg().stopOnExit,
    autoOpen: cfg().autoOpen,
  }
}

// ── view provider (sidebar only — R1: no editor-tab panel) ──────────────────
class DshViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true }
    view.webview.html = webviewHtml(manager.port)
    const bridge = new PanelBridge(view.webview)
    bridges.add(bridge)
    view.onDidDispose(() => {
      bridges.delete(bridge)
      bridge.dispose()
    })
    manager.ensure().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))
  }
}

// 活动栏常驻图标(与 Claude Code 同款做法):点击即拉起右侧对话面板。
// 本 VS Code 构建(1.136)不渲染 secondarySidebar 容器图标(CC 的 doesNotSupport
// SecondarySidebar 上下文即为真),常驻入口只能走活动栏。
class DshLauncherProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: false }
    view.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="padding:10px;margin:0;font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background)">DeepSeek Harness<div style="opacity:.65;margin-top:6px">对话面板已打开在右侧。</div></body></html>'
    // 打开右侧辅助栏中的 DSH 视图(与点击 CC 图标打开右侧对话一致)
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.view.extension.dsh-aux').catch(() => {})
    }, 50)
  }
}

async function reloadPanels() {
  if (manager.state === 'attached') {
    const alive = await probe(manager.port)
    if (!alive) {
      output.appendLine('[dsh] attached server gone — reconnecting')
      manager.setState('idle', 'reconnecting…')
    }
  }
  if (manager.state !== 'ready' && manager.state !== 'attached') {
    try { await manager.ensure() } catch {}
  }
  manager.broadcast('reload')
  output.appendLine('[dsh] sidebar reload requested')
}

async function openInBrowser() {
  const port = manager?.port ?? cfg().port
  await vscode.env.openExternal(vscode.Uri.parse(urlOf(port) + '/'))
}

function activate(ctx) {
  context = ctx
  output = vscode.window.createOutputChannel('DSH') // B5
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.show()
  manager = new ServerManager()
  refreshStatus()
  ctx.subscriptions.push(output, statusBar)
  // B3 命令清单
  ctx.subscriptions.push(vscode.commands.registerCommand('dshPanel.toggle', async () => {
    // 与 Claude Code 一致:打开右侧辅助栏容器视图(首次打开后右上角图标常驻)
    await vscode.commands.executeCommand('workbench.view.extension.dsh-aux')
  }))
  // 标题栏/编辑器标题图标入口(editor/title 菜单,同 Claude Code 的 orange icon)
  ctx.subscriptions.push(vscode.commands.registerCommand('dshPanel.openPanel', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.dsh-aux')
  }))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshPanel.openBrowser', openInBrowser))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshPanel.reload', reloadPanels))
  ctx.subscriptions.push(vscode.commands.registerCommand('dshPanel.restartServer', () => manager.restart().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))))
  // 仅右侧辅助栏容器(与 Claude Code 一致的右上角图标入口)
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('dshWebViewAux', new DshViewProvider(), {
    webviewOptions: { retainContextWhenHidden: true },
  }))
  // 活动栏常驻图标(本构建不渲染辅助栏容器图标;活动栏是唯一常驻入口)
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('dshLauncher', new DshLauncherProvider()))
  // R1 迁移:旧版(dshWebPanel 编辑器标签页)序列化残留——还原即自毁,不留与代码区抢位置的 UI
  ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer('dshWebPanel', {
    deserializeWebviewPanel(panel) {
      output.appendLine('[dsh] migrating: disposing stale editor-tab DSH panel (R1)')
      try { panel.dispose() } catch {}
    },
  }))
  ctx.subscriptions.push({ dispose: () => { for (const b of bridges) b.dispose(); bridges.clear() } })
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!cfg().followWorkspace || !manager.child || manager.state !== 'ready') return
    const first = firstWorkspacePath() ?? os.homedir()
    if (first === manager.cwd) return
    output.appendLine('[dsh] workspace folder changed to ' + first + ' — restarting with new workspace root')
    manager.restart().catch(() => {})
    for (const b of bridges) b.send({ type: 'workspace', path: firstWorkspacePath() })
  }))
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CFG + '.port') && manager.state === 'ready' && manager.child) {
      output.appendLine('[dsh] dshWeb.port changed — restarting')
      manager.restart().catch(() => {})
    }
    for (const b of bridges) b.send({ type: 'configChanged', config: settingsSnapshot() })
  }))
  // Lazy startup attach.
  ;(async () => {
    try {
      if (cfg().attachExisting && await probe(cfg().port)) manager.setState('attached', 'attached :' + cfg().port)
    } catch {}
  })()
  const healthTimer = setInterval(() => {
    if (manager.starting) return
    if (manager.state === 'error') {
      // 失败态自愈:定期重试(如桌面 harness 重启后自动恢复)
      output.appendLine('[dsh] health: retrying after error')
      manager.setState('idle', 'reconnecting…')
      manager.ensure().catch((e) => output.appendLine('[dsh] health retry failed: ' + e.message))
      return
    }
    if (manager.state !== 'attached') { manager.downSince = 0; return }
    probeDead(manager.port).then((dead) => {
      if (manager.state !== 'attached') return
      if (!dead) { manager.downSince = 0; return }
      if (!manager.downSince) manager.downSince = Date.now()
      const waited = Math.round((Date.now() - manager.downSince) / 1000)
      const budget = Math.max(0, Number(cfg().takeoverAfterSeconds ?? 45))
      if (waited < budget) {
        output.appendLine('[dsh] attached server is not answering (' + waited + 's of ' + budget + 's) — waiting for it to come back')
        return
      }
      // Only now is taking over honest: the port has been silent for the whole
      // budget while the launcher had every chance to bring its server back.
      output.appendLine('[dsh] attached server has not answered for ' + waited + 's — taking over with a local instance')
      manager.downSince = 0
      manager.setState('idle', 'reconnecting…')
      manager.ensure().catch((e) => vscode.window.showErrorMessage('DSH: ' + e.message))
    })
  }, 15000)
  ctx.subscriptions.push({ dispose: () => clearInterval(healthTimer) })
  // B2: 不再自动展开(与 Claude Code 一致:仅点击右上角容器图标/状态栏时打开)
}

function deactivate() {
  disposing = true
  if (manager) manager.expectExit = true
  if (manager && cfg().stopOnExit) manager.dispose()
  for (const b of bridges) b.dispose()
}

module.exports = { activate, deactivate }
