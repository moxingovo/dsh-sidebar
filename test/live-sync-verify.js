 'use strict'
// Live sync: durable events pushed while a session is open must reach the DOM
// without reopening it. Regression under test: the panel only showed a turn
// after the session was reopened (history refetch), so a running turn looked
// frozen.
//
// Run: node test/live-sync-verify.js
const fs = require('node:fs')
const path = require('node:path')
function loadJsdom() {
  const roots = []
  if (process.env.DSH_CHECKOUT_NODE_MODULES) roots.push(process.env.DSH_CHECKOUT_NODE_MODULES)
  roots.push(path.join(__dirname, '..', 'node_modules'))
  for (const root of roots) { try { return require(path.join(root, 'jsdom')) } catch {} }
  try { return require('jsdom') } catch {}
  throw new Error('jsdom not found')
}
const { JSDOM } = loadJsdom()
const WEBVIEW = path.join(__dirname, '..', 'webview')
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', { url: 'https://dsh.local/', runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom
const doc = window.document
const posted = []
window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })
const load = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
load('markdown.js')
load('app.js')
const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + String(detail).slice(0, 160))) }
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const transcript = () => (doc.querySelector('.dsh-messages') ? doc.querySelector('.dsh-messages').textContent : '')
const SID = 'session-live-0001'
const tick = () => new Promise((r) => setTimeout(r, 30))
const record = (event) => ({ type: 'event', event })
// Shapes copied from a live 0.1.6 log (session-log v3 wire entries).
const history = [
  record({ type: 'turn/start', seq: 10, time: 1000, data: { turn: 1 } }),
  record({ type: 'user/message', seq: 11, time: 1001, data: { content: [{ type: 'text', text: '第一条用户消息' }], source: { kind: 'user' }, role: 'user', id: 'm1' } }),
  record({ type: 'assistant/message', seq: 12, time: 1002, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一条助手回复' }] } } }),
  record({ type: 'turn/end', seq: 13, time: 1003, data: { turn: 1, reason: { kind: 'completed' } } }),
]
const live = (event) => send({ type: 'frame', kind: 'mux', frame: { type: 'session/event', sessionId: SID, event } })
const stream = (frame) => send({ type: 'frame', kind: 'mux', frame: { type: 'session/assistant-stream', sessionId: SID, frame } })

;(async () => {
  console.log('--- history on open ---')
  send({ type: 'sessionOpened', sessionId: SID, hasMore: false, blank: false, events: history })
  await tick()
  check('history renders the user message (data.content, not data.message.content)', transcript().includes('第一条用户消息'), transcript().slice(0, 120))
  check('history renders the assistant reply', transcript().includes('第一条助手回复'), transcript().slice(0, 120))

  console.log('--- live durable events ---')
  live({ type: 'turn/start', seq: 20, time: 2000, data: { turn: 2 } })
  await tick()
  live({ type: 'user/message', seq: 21, time: 2001, data: { content: [{ type: 'text', text: '第二条用户消息' }], source: { kind: 'user' }, role: 'user', id: 'm2' } })
  await tick()
  check('a live user message appears', transcript().includes('第二条用户消息'), transcript().slice(-160))
  check('  the echoed user row is not duplicated', transcript().split('第二条用户消息').length === 2, transcript().split('第二条用户消息').length - 1)
  live({ type: 'assistant/message', seq: 22, time: 2002, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二条助手回复' }] } } })
  await tick()
  check('a live assistant message appears', transcript().includes('第二条助手回复'), transcript().slice(-160))

  console.log('--- duplicate suppression ---')
  const before = transcript().length
  live({ type: 'user/message', seq: 21, time: 2001, data: { content: [{ type: 'text', text: '第二条用户消息' }], source: { kind: 'user' }, role: 'user', id: 'm2' } })
  await tick()
  check('a replayed seq is ignored', transcript().length === before, transcript().length + ' vs ' + before)

  console.log('--- streaming deltas ---')
  stream({ type: 'start', attemptId: 'a1', revision: 1, startedAfterSeq: 22, turn: 3, step: 1 })
  stream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 3000, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  stream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 3001, chunk: { type: 'text-delta', index: 0, text: '流式片段一' } })
  stream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 2, time: 3002, chunk: { type: 'text-delta', index: 0, text: '流式片段二' } })
  await tick()
  check('streaming text renders before the committed event', transcript().includes('流式片段一') && transcript().includes('流式片段二'), transcript().slice(-160))
  const grew = transcript().length
  stream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 2, time: 3003, chunk: { type: 'text-delta', index: 0, text: '重复片段' } })
  await tick()
  check('a chunk index at or below the applied one is ignored', transcript().length === grew, transcript().length + ' vs ' + grew)

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  process.exit(failed.length === 0 ? 0 : 1)
})()