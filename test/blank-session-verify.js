'use strict'
// 空白会话的进出规则(用户报的 bug:新建一个对话、没发消息就切走,它会一直留在列表里)。
//
// 规则(对齐 harness 的 blank 会话语义):
//   1) 没发过消息的新会话不占列表位 —— 只有"当前打开的那个"和"用户在里面打过字的"
//      才在抽屉里显示;切走即从列表消失;
//   2) 在里面打过的字不能丢 —— 草稿按会话记账,切回来还在;
//   3) 服务端没有会话删除接口(只有 workspace.archiveSession),所以宿主侧改成
//      reuse-or-create:已经有一个空白会话时,"新会话"直接复用它,不再造空壳。
//
// 前半段用 jsdom 驱真实 webview/app.js,后半段用 mock 0.1.6 网关驱真实 extension.js。
//
// Run: node test/blank-session-verify.js
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createMockServer } = require('./mock-016-server.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

// ── A) webview:列表过滤 + 草稿记账 ──────────────────────────────────────────
function loadJsdom() {
  const roots = []
  if (process.env.DSH_CHECKOUT_NODE_MODULES) roots.push(process.env.DSH_CHECKOUT_NODE_MODULES)
  roots.push(path.join(__dirname, '..', 'node_modules'))
  for (const root of roots) {
    try { return require(path.join(root, 'jsdom')) } catch {}
  }
  try { return require('jsdom') } catch {}
  throw new Error('jsdom not found (tried ' + roots.join(', ') + ') — set DSH_CHECKOUT_NODE_MODULES or run: npm install --no-save jsdom')
}
const { JSDOM } = loadJsdom()
const WEBVIEW = path.join(__dirname, '..', 'webview')
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'https://dsh.local/', runScripts: 'outside-only', pretendToBeVisual: true,
})
const { window } = dom
const posted = []
window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })
const loadWebview = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
loadWebview('markdown.js')
loadWebview('app.js')

const doc = window.document
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const rowsFor = (id) => [...doc.querySelectorAll('.sb-row')].filter((r) => (r.title || '').includes(id))
const input = () => doc.querySelector('.dsh-input')
const setDraft = (text) => {
  const el = input()
  el.value = text
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const openSession = (id, blank, title) => send({
  type: 'sessionOpened', sessionId: id, hasMore: false, blank,
  events: title === undefined ? [] : [],
})

const WS = 'C:\\ws'
const OLD = 'session-old'
const NEW = 'session-new'
send({
  type: 'sessionList',
  items: [
    { sessionId: OLD, cwd: WS, title: '旧对话', updatedAt: 10, messages: 4, blank: false },
    { sessionId: NEW, cwd: WS, updatedAt: 20, messages: 0, blank: true },
  ],
  archivedIds: [],
  workspacePath: WS,
})

check('没打开的空白会话不占列表位', rowsFor(NEW).length === 0 && rowsFor(OLD).length === 1,
  'old=' + rowsFor(OLD).length + ' new=' + rowsFor(NEW).length)

openSession(NEW, true)
check('打开的空白会话显示为「新会话」', rowsFor(NEW).length === 1
  && (rowsFor(NEW)[0].querySelector('.sb-name') || {}).textContent === '新会话',
  (rowsFor(NEW)[0] && rowsFor(NEW)[0].textContent) || '(none)')
check('顶栏也跟着显示「新会话」', doc.querySelector('#hdrTitle').textContent === '新会话',
  doc.querySelector('#hdrTitle').textContent)

// 用户没打字就切回旧对话:这个新会话必须从列表里立刻消失(用户报的 bug)
posted.length = 0
openSession(OLD, false)
check('没打字就切走 → 空白会话从列表清掉', rowsFor(NEW).length === 0,
  'new=' + rowsFor(NEW).length + ' rows=' + [...doc.querySelectorAll('.sb-row')].length)
check('切走没有额外的服务端动作(删除接口不存在)', posted.every((m) => m.type !== 'deleteSession'),
  posted.map((m) => m.type).join(','))

// 再开一个新会话,这次打字,然后切走
openSession(NEW, true)
setDraft('这段字不能丢')
openSession(OLD, false)
check('打了字就切走 → 会话留在列表里', rowsFor(NEW).length === 1, 'new=' + rowsFor(NEW).length)
check('草稿不跟着串到旧对话', input().value === '', JSON.stringify(input().value))

openSession(NEW, true)
check('切回新会话 → 打的字还在', input().value === '这段字不能丢', JSON.stringify(input().value))

// 回到旧对话再打字,切回来时两边的草稿各归各的
openSession(OLD, false)
setDraft('旧对话的草稿')
openSession(NEW, true)
check('两个会话的草稿互不串台', input().value === '这段字不能丢', JSON.stringify(input().value))
openSession(OLD, false)
check('旧对话的草稿同样留着', input().value === '旧对话的草稿', JSON.stringify(input().value))

// 已有消息的会话任何时候都在
check('有消息的会话不受影响', rowsFor(OLD).length === 1)

// 发送失败不能把用户打的字弄丢:输入框先清空,服务端拒收后把原文放回去
setDraft('这条发不出去')
posted.length = 0
doc.querySelector('#btnSend').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('点发送后输入框立刻清空(不等服务端)',
  posted.some((m) => m.type === 'prompt') && input().value === '',
  posted.map((m) => m.type).join(',') + ' value=' + JSON.stringify(input().value))
send({ type: 'error', kind: 'session.models', message: '别的操作报错' })
check('别的操作报错不会动输入框', input().value === '', JSON.stringify(input().value))
send({ type: 'error', kind: 'session.prompt', message: '服务端拒收' })
check('发送失败 → 原文回到输入框', input().value === '这条发不出去', JSON.stringify(input().value))

// 顶栏「＋」:请求里要带上"当前会话已经聊过了",宿主才知道不能拿它去复用
const clickNew = () => {
  posted.length = 0
  doc.querySelector('#btnNewSession').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return posted.find((m) => m.type === 'createSession')
}
const askFromOld = clickNew()
check('在已聊过的会话里点新建 → 请求排除它',
  askFromOld !== undefined && askFromOld.excludeSessionId === OLD && askFromOld.cwd === WS,
  JSON.stringify(askFromOld))
openSession(NEW, true)
const askFromBlank = clickNew()
check('在空白新会话里点新建 → 不排除自己(留给宿主复用)',
  askFromBlank !== undefined && askFromBlank.excludeSessionId === undefined,
  JSON.stringify(askFromBlank))

// 宿主复用同一个会话时,不要再 openSession 一次(整套 history/models/presets 重拉)
posted.length = 0
send({ type: 'sessionCreated', sessionId: NEW })
check('复用同一个会话 → 不再重开一次', posted.every((m) => m.type !== 'openSession'),
  posted.map((m) => m.type).join(',') || '(none)')
send({ type: 'sessionCreated', sessionId: 'session-elsewhere' })
check('换成别的会话才 openSession',
  posted.some((m) => m.type === 'openSession' && m.sessionId === 'session-elsewhere'),
  posted.map((m) => m.type).join(','))

// ── B) host:新建会话优先复用空白会话 ──────────────────────────────────────
const WS_ROOT = process.cwd()
const sessions = [
  { sessionId: 'conv-a', cwd: WS_ROOT, title: '旧对话', updatedAt: 10, blank: false },
  { sessionId: 'blank-a', cwd: WS_ROOT, updatedAt: 20, blank: true },
]
const mockOptions = {
  unary: {
    'session/list': { items: sessions },
    'workspace/list': { items: [{ workspaceId: 'ws-1', path: WS_ROOT }], archivedSessionIds: [] },
    'session/create': { sessionId: 'created-fresh', agentPreset: 'default' },
  },
}
const mock = createMockServer(mockOptions)

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
    workspaceFolders: [{ uri: { fsPath: WS_ROOT } }],
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
/** 让面板拉一次列表(宿主缓存的刷新来源)。 */
const refreshList = async () => {
  sent.length = 0
  mockWebview._cb({ type: 'listSessions' })
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    if (sent.some((m) => m.type === 'sessionList')) return
  }
}
const createdId = async (timeoutMs) => {
  const before = sent.length
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    await sleep(100)
    const hit = sent.slice(before).find((m) => m.type === 'sessionCreated')
    if (hit) return hit.sessionId
  }
  return null
}

;(async () => {
  config.port = await mock.listen()
  const ext = require(path.join(__dirname, '..', 'extension.js'))
  ext.activate({
    subscriptions: [], extensionUri: path.join(__dirname, '..'),
    globalState: { get: (k) => (k === 'dshWeb.cookie' ? 'dsh-auth-mock=v1.mock.mock' : undefined), update: async () => {} },
  })
  for (let i = 0; i < 60 && !webviewView; i++) await sleep(100)
  check('view provider registered', webviewView !== null)
  if (!webviewView) { mock.close(); process.exit(1) }
  webviewView.resolveWebviewView({ webview: mockWebview, onDidDispose: () => ({ dispose() {} }), visible: true, show: () => {} })
  for (let i = 0; i < 60 && !mockWebview._cb; i++) await sleep(100)
  await sleep(1200)

  // 工作区里已经有一个空白会话 → 「新会话」复用它,不再 session.create,
  // 而且复用判断读的是 listSessions 存下来的缓存:一次 session.list 都不多发。
  mock.state.requests.length = 0
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT })
  const reuseId = await createdId(5000)
  const reuseUrls = mock.state.requests.map((r) => r.url)
  check('有空白会话时,新建复用它', reuseId === 'blank-a', String(reuseId))
  check('复用时不调用 session.create', !reuseUrls.includes('/api/session/create'), reuseUrls.join(',') || '(none)')
  check('复用判断走缓存,不再多付一次列表往返',
    !reuseUrls.includes('/api/session/list') && !reuseUrls.includes('/api/workspace/list'),
    reuseUrls.join(',') || '(none)')

  // 反复点新建:第二次同样立刻复用,且一个服务端往返都不用发(卡顿就出在这里)
  mock.state.requests.length = 0
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT })
  const reuseAgain = await createdId(5000)
  check('反复新建复用的还是同一个空白会话', reuseAgain === 'blank-a', String(reuseAgain))
  check('反复新建不再产生任何服务端往返', mock.state.requests.length === 0,
    mock.state.requests.map((r) => r.url).join(',') || '(none)')

  // 面板刷新列表(那个空白会话已经聊过 → 列表里没有了)→ 正常新建,同样不额外查列表
  mockOptions.unary['session/list'] = { items: [{ sessionId: 'conv-a', cwd: WS_ROOT, title: '旧对话', updatedAt: 10, blank: false }] }
  await refreshList()
  mock.state.requests.length = 0
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT })
  const freshId = await createdId(5000)
  const freshUrls = mock.state.requests.map((r) => r.url)
  check('没有可复用的空白会话时正常新建', freshId === 'created-fresh', String(freshId))
  check('新建确实走了 session.create', freshUrls.includes('/api/session/create'), freshUrls.join(','))
  // 新建后宿主会拉一次列表让新会话出现在抽屉里;复用判断不该再额外多拉一次。
  check('这次复用判断也没有多查一次列表(只剩新建后的那次刷新)',
    freshUrls.filter((u) => u === '/api/session/list').length === 1, freshUrls.join(','))

  // 面板明说"当前会话已经聊过了"(宿主缓存可能还是旧的 blank)→ 那个会话不许复用
  mockOptions.unary['session/list'] = { items: sessions }
  await refreshList()
  mock.state.requests.length = 0
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT, excludeSessionId: 'blank-a' })
  const excludedId = await createdId(5000)
  check('被面板排除的会话不会被复用', excludedId === 'created-fresh', String(excludedId))

  // 归档过的空白会话不能再被复用:归档只是隐藏,服务端列表里那条还在,
  // 宿主缓存必须跟着归档一起更新,否则归档过的空壳又会被翻出来复用。
  mockOptions.unary['session/list'] = { items: sessions }
  await refreshList()
  mockOptions.unary['workspace/archiveSession'] = { archivedSessionIds: ['blank-a'] }
  sent.length = 0
  mockWebview._cb({ type: 'archiveSession', sessionId: 'blank-a' })
  for (let i = 0; i < 40 && !sent.some((m) => m.type === 'sessionArchived'); i++) await sleep(100)
  check('归档回执发回面板', sent.some((m) => m.type === 'sessionArchived'),
    sent.map((m) => m.type).join(',') || '(none)')
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT })
  const afterArchive = await createdId(5000)
  check('归档过的空白会话不会被复用', afterArchive === 'created-fresh', String(afterArchive))

  // 带预设的「新建并继续」是有意为之:即使有空白会话也照旧新建
  mock.state.requests.length = 0
  sent.length = 0
  mockWebview._cb({ type: 'createSession', cwd: WS_ROOT, agentPreset: 'xingpan' })
  const presetId = await createdId(5000)
  check('带预设时仍然新建(不复用)', presetId === 'created-fresh', String(presetId))

  mock.close()
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  process.exit(failed.length === 0 ? 0 : 1)
})()
