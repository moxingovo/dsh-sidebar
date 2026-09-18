const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { JSDOM } = require(process.env.DSH_CHECKOUT_NODE_MODULES + '/jsdom')

const WEBVIEW = path.join(__dirname, '..', 'webview')
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'https://dsh.local/', runScripts: 'outside-only', pretendToBeVisual: true,
})
const { window } = dom

const posted = []
window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })

// markdown.js and app.js are plain scripts that attach to the window.
const load = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
load('markdown.js')
load('app.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

// The webview registers a window 'message' listener; drive it exactly like the host does.
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const cards = () => [...window.document.querySelectorAll('.approval-card')]
const cardText = (i) => { const c = cards()[i]; return c ? c.textContent.replace(/\s+/g, ' ').trim() : '(none)' }
const SID = 'session-test-0001'
const AID = 'appr-1111'

const askedEvent = { type: 'approval/asked', seq: 10, time: 1000, data: { id: AID, toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox to danger-full-access: probe' } }
const decidedEvent = { type: 'approval/decided', seq: 12, time: 2000, data: { id: AID, outcome: 'allowed-once' } }

// ── 1) open a session whose log already holds asked+decided ────────────────
send({ type: 'sessionOpened', sessionId: SID, hasMore: false, blank: false,
  events: [{ event: askedEvent }, { event: decidedEvent }] })
check('log replay renders exactly one approval card', cards().length === 1, 'cards=' + cards().length)
check('a decided approval renders as 已允许 (not a live pair of buttons)', cardText(0).includes('已允许'), cardText(0))

// ── 2) live frame replays the same request; must not duplicate ─────────────
const frame = { type: 'approval/requested', sessionId: SID, approvalId: AID, rpcId: 'rpc-live-1', toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: probe' }
send({ type: 'frame', kind: 'mux', frame })
check('live frame does not duplicate the card', cards().length === 1, 'cards=' + cards().length)

// ── 3) same frame replayed again (reconnect) still one card ───────────────
send({ type: 'frame', kind: 'mux', frame })
check('replayed frame still does not duplicate', cards().length === 1, 'cards=' + cards().length)

// ── 4) undecided request stays answerable and posts the full payload ──────
const SID2 = 'session-test-0002'
const AID2 = 'appr-2222'
send({ type: 'sessionOpened', sessionId: SID2, hasMore: false, blank: false,
  events: [{ event: { type: 'approval/asked', seq: 1, time: 1, data: { id: AID2, toolName: 'pwsh', reason: 'probe two' } } }] })
check('second session renders its own single card', cards().length === 1, 'cards=' + cards().length + ' text=' + cardText(0))
send({ type: 'frame', kind: 'mux', frame: { type: 'approval/requested', sessionId: SID2, approvalId: AID2, rpcId: 'rpc-live-2', toolName: 'pwsh', reason: 'probe two' } })
check('still one card after its live frame', cards().length === 1, 'cards=' + cards().length)

const allowBtn = [...cards()[0].querySelectorAll('button')].find(b => b.textContent.includes('允许'))
check('undecided card offers 允许', allowBtn !== undefined)
posted.length = 0
if (allowBtn) allowBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const answer = posted.find(m => m.type === 'approvalRespond')
check('clicking 允许 posts approvalRespond', answer !== undefined)
if (answer) {
  check('  carries sessionId', answer.sessionId === SID2, String(answer.sessionId))
  check('  carries approvalId', answer.approvalId === AID2, String(answer.approvalId))
  check('  carries the frame rpcId (not undefined)', answer.rpcId === 'rpc-live-2', String(answer.rpcId))
  check('  carries outcome', answer.outcome === 'allowed-once', String(answer.outcome))
}

const failed = results.filter(r => !r.ok)
console.log('')
console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map(f => f.label).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)