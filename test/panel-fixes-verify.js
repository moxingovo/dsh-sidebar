'use strict'
// 一轮代码复查之后的回归:面板侧(webview/app.js + markdown.js)修掉的 8 个真实缺陷。
//
//   1. markdown 双重转义 —— 行内代码显示实体、URL 里的 & 被转两次
//   2. #dsh-queue 从来没进过 DOM —— 排队中的消息永远看不见(相关 CSS 也永远不匹配)
//   3. 归档集合只能单向更新 —— 权威空数组被忽略(取消归档后仍隐藏)、缺字段的回执被当空集合
//   4. session/follow 快照的每个投影共用一个 seq —— 除第一个外全被丢弃(重连后药丸/占用环不更新)
//   5. 待发附件是全局的 —— A 里贴的图会随 B 的第一条消息发出去
//   6. 更早的历史加载不出来 —— 按钮只在 prependHistory 里画(死锁),beforeSeq 恒为 undefined
//   7. 「已停止」不按会话过滤 —— 停别的会话会在当前对话里留一行
//   8. 「运行中」被塞进一个 7px 圆点里
//
// Run: node test/panel-fixes-verify.js
const fs = require('node:fs')
const path = require('node:path')
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
const load = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
load('markdown.js')
load('app.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}
const doc = window.document
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const tick = () => new Promise((r) => setTimeout(r, 0))
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const rowsFor = (id) => [...doc.querySelectorAll('.sb-row')].filter((r) => (r.title || '').includes(id))
const chips = () => [...doc.querySelectorAll('.attach-chip')]
;(async () => {
  const WS = 'C:\\ws'
  const A = 'session-a'
  const B = 'session-b'

  // ── 1) markdown:转义只做一次 ───────────────────────────────────────────────
  const md = (s) => window.DshMarkdown.render(s)
  const codeHtml = md('看看 `<div>` 这段')
  check('行内代码不再双重转义', codeHtml.includes('<code>&lt;div&gt;</code>') && !codeHtml.includes('&amp;lt;'), codeHtml.trim())
  const linkHtml = md('[x](https://e.test/?a=1&b=2)')
  check('链接 URL 里的 & 只转一次', linkHtml.includes('href="https://e.test/?a=1&amp;b=2"') && !linkHtml.includes('&amp;amp;'), linkHtml.trim())
  check('链接文字同样只转一次', md('[<b>](https://e.test/)').includes('&lt;b&gt;') && !md('[<b>](https://e.test/)').includes('&amp;lt;'))
  check('非 http(s)/mailto 链接仍然不成链', !md('[x](javascript:alert(1))').includes('<a '))

  // ── 2) 队列容器 ────────────────────────────────────────────────────────────
  check('#dsh-queue 在骨架里', doc.querySelector('#dsh-queue') !== null)

  // ── 3) 归档集合两个方向都要跟权威结果 ──────────────────────────────────────
  send({ type: 'sessionList', items: [
    { sessionId: A, cwd: WS, title: '甲', updatedAt: 30, blank: false },
    { sessionId: B, cwd: WS, title: '乙', updatedAt: 20, blank: false },
    { sessionId: 'session-c', cwd: WS, title: '丙', updatedAt: 10, blank: false },
  ], archivedIds: [B, 'session-c'], workspacePath: WS })
  check('归档的两条都隐藏', rowsFor(B).length === 0 && rowsFor('session-c').length === 0)
  send({ type: 'sessionList', items: [
    { sessionId: A, cwd: WS, title: '甲', updatedAt: 30, blank: false },
    { sessionId: B, cwd: WS, title: '乙', updatedAt: 20, blank: false },
  ], archivedIds: [], workspacePath: WS })
  check('权威空数组能解除隐藏(在别处取消归档后不必重载)', rowsFor(B).length === 1)
  send({ type: 'sessionArchived', sessionId: B })   // 回执没带 archivedIds
  check('缺 archivedIds 的回执不会清空整个归档集合', rowsFor('session-c').length === 0)

  // ── 4) 同一个 seq 的多个投影都要生效 ──────────────────────────────────────
  send({ type: 'sessionOpened', sessionId: A, hasMore: false, blank: false, events: [], projections: { asOfSeq: 1, values: {} } })
  const project = (key, value, seq) => send({ type: 'frame', kind: 'mux', frame: { type: 'session/projection', sessionId: A, key, value, seq } })
  project('tokenUsage', { tokens: 10, window: 100 }, 7)
  project('permissions', { currentValue: 'read-only' }, 7)
  project('imageLimits', { maxImagesPerMessage: 4 }, 7)
  check('同一 seq 的三个投影全部生效(不是只留第一个)',
    doc.querySelector('#permPill').textContent === '权限:只读',
    doc.querySelector('#permPill').textContent)
  project('permissions', { currentValue: 'danger-full-access' }, 5)
  check('同一个 key 的旧 seq 仍然被丢弃', doc.querySelector('#permPill').textContent === '权限:只读',
    doc.querySelector('#permPill').textContent)

  // ── 5) 排队消息真的画出来 ─────────────────────────────────────────────────
  project('inbox', { 'next-turn': [{ placement: 'queue', message: { content: [{ type: 'text', text: '排队中的一条' }] } }] }, 8)
  const queueBox = doc.querySelector('#dsh-queue')
  check('inbox 投影渲染到 #dsh-queue', queueBox !== null && !queueBox.hidden && queueBox.textContent.includes('排队中的一条'),
    queueBox ? queueBox.textContent : '(missing)')

  // ── 6) 待发附件按会话走 ───────────────────────────────────────────────────
  const file = new window.File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
  const paste = new window.Event('paste', { bubbles: true })
  paste.clipboardData = { files: [file], items: [], getData: () => '' }
  doc.querySelector('.dsh-input').dispatchEvent(paste)
  await tick()
  await tick()
  check('贴进 A 的图出现在托盘里', chips().length === 1, 'chips=' + chips().length)
  send({ type: 'sessionOpened', sessionId: B, hasMore: false, blank: false, events: [] })
  check('切到 B 后托盘是 B 自己的(空的)', chips().length === 0, 'chips=' + chips().length)
  send({ type: 'sessionOpened', sessionId: A, hasMore: false, blank: false, events: [] })
  check('切回 A 图还在', chips().length === 1, 'chips=' + chips().length)

  // ── 7) 更早的历史 ─────────────────────────────────────────────────────────
  send({ type: 'sessionOpened', sessionId: A, hasMore: true, blank: false, events: [
    { event: { type: 'user/message', seq: 10, time: 100, data: { content: [{ type: 'text', text: '第一条' }] } } },
    { event: { type: 'assistant/message', seq: 11, time: 200, data: { message: { content: [{ type: 'text', text: '回复' }] } } } },
  ] })
  const moreBtn = () => doc.querySelector('.load-more')
  check('有更早历史时按钮直接画出来(不再死锁)', moreBtn() !== null)
  posted.length = 0
  click(moreBtn())
  const ask = posted.find((m) => m.type === 'historyMore')
  check('翻页请求带最老一行的 seq 当游标', ask !== undefined && ask.beforeSeq === 10, JSON.stringify(ask))
  send({ type: 'historyPage', sessionId: A, hasMore: true, events: [
    { event: { type: 'user/message', seq: 3, time: 10, data: { content: [{ type: 'text', text: '更早的一条' }] } } },
  ] })
  const listed = doc.querySelector('.dsh-messages').textContent
  check('更早的消息插在最前面', listed.indexOf('更早的一条') >= 0 && listed.indexOf('更早的一条') < listed.indexOf('第一条'),
    listed.trim().slice(0, 40))
  check('按钮换成新游标(只留一个)', doc.querySelectorAll('.load-more').length === 1)
  posted.length = 0
  click(moreBtn())
  check('第二次翻页用更老的 seq', posted.find((m) => m.type === 'historyMore').beforeSeq === 3,
    JSON.stringify(posted.find((m) => m.type === 'historyMore')))

  // ── 8) 「已停止」与「运行中」 ─────────────────────────────────────────────
  const messages = () => doc.querySelector('.dsh-messages').textContent
  send({ type: 'cancelled', sessionId: 'session-elsewhere' })
  check('停别的会话不在当前对话里留「已停止」', !messages().includes('已停止'))
  send({ type: 'cancelled', sessionId: A })
  check('停当前会话仍然提示', messages().includes('已停止'))
  send({ type: 'sessionList', items: [
    { sessionId: 'session-run', cwd: WS, title: '跑着的', updatedAt: 99, running: true, blank: false },
  ], archivedIds: [], workspacePath: WS })
  const runChip = doc.querySelector('.sb-run')
  check('「运行中」是小绿点 + 文案(不再塞进圆点里)', runChip !== null && runChip.textContent === '运行中',
    runChip ? runChip.textContent : '(missing)')

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  process.exit(failed.length === 0 ? 0 : 1)
})()
