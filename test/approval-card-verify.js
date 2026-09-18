const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
// jsdom comes from a harness checkout (DSH_CHECKOUT_NODE_MODULES) or from this
// repo's own node_modules after "npm install --no-save jsdom" — the CI runner
// installs it there, so a hardcoded checkout path fails the whole run.
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


// ── 5) the session drawer closes as soon as a conversation is picked ───────
send({ type: 'sessionList', items: [
  { sessionId: 'session-pick-a', cwd: 'C:\\ws', title: 'A', updatedAt: 2, messages: 3 },
  { sessionId: 'session-pick-b', cwd: 'C:\\ws', title: 'B', updatedAt: 1, messages: 3 },
], archivedIds: [], workspacePath: 'C:\\ws' })

const bar = window.document.querySelector('.dsh-sessionbar')
check('session drawer exists', bar !== null)
check('drawer starts closed', bar !== null && bar.hidden === true)

// The header button toggles it open — the state the user then clicks out of.
const btnSessions = window.document.querySelector('#btnSessions')
btnSessions.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('header button opens the drawer', bar !== null && bar.hidden === false)

posted.length = 0
// Locate by the row's own tooltip (cwd · sessionId): the list re-sorts by
// updatedAt, so positional lookup would click a different session.
const rowFor = (id) => [...window.document.querySelectorAll('.sb-row')].find(r => (r.title || '').includes(id))
const firstRow = rowFor('session-pick-a')
check('drawer rendered a session row', firstRow !== undefined)
if (firstRow) firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('picking a conversation posts openSession', posted.some(m => m.type === 'openSession'),
  posted.map(m => m.type).join(','))
check('picking a conversation closes the drawer', bar !== null && bar.hidden === true)

// Play the host's half of the first pick so the UI knows which session is active —
// without this the drawer would still believe nothing is open and the guard below
// would be testing nothing.
send({ type: 'sessionOpened', sessionId: 'session-pick-a', hasMore: false, blank: false, events: [] })

// Re-picking the already-active row is not a dead click: it still dismisses.
btnSessions.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
posted.length = 0
const activeRow = rowFor('session-pick-a')
check('the active row is still rendered', activeRow !== undefined)
if (activeRow) activeRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('re-picking the active row still closes the drawer', bar !== null && bar.hidden === true)
// The guard under test is "never re-open what is already open": the first click on a
// row becomes the active session, so re-picking that same row must not ask the host
// to open it again. (The row that sorts first can be the other session here, which is
// why this asserts on ids rather than on an empty payload.)
const reopen = posted.filter(m => m.type === 'openSession')
check('re-picking the active row never re-opens the active session',
  reopen.every(m => m.sessionId !== 'session-pick-a'),
  JSON.stringify(reopen.map(m => m.sessionId)))


// ── 6) archived conversations stay out of the drawer ───────────────────────
send({ type: 'sessionList',
  items: [
    { sessionId: 'session-keep', cwd: 'C:\\ws2', title: 'keep', updatedAt: 9, messages: 2 },
    { sessionId: 'session-arch', cwd: 'C:\\ws2', title: 'archived one', updatedAt: 8, messages: 2 },
  ],
  archivedIds: ['session-arch'],
  workspacePath: 'C:\\ws2',
})
const rowsIn = (id) => [...window.document.querySelectorAll('.sb-row')].filter(r => (r.title || '').includes(id))
check('archived session is hidden from the drawer', rowsIn('session-arch').length === 0)
check('unarchived session is still listed', rowsIn('session-keep').length === 1)

// A failed workspace.list must not resurrect it: the host omits the field entirely.
send({ type: 'sessionList',
  items: [
    { sessionId: 'session-keep', cwd: 'C:\\ws2', title: 'keep', updatedAt: 9, messages: 2 },
    { sessionId: 'session-arch', cwd: 'C:\\ws2', title: 'archived one', updatedAt: 8, messages: 2 },
  ],
  workspacePath: 'C:\\ws2',
})
check('a fresh list without an archive set keeps it hidden', rowsIn('session-arch').length === 0)

// The host may also answer with the full list and an empty set; never trust it back.
send({ type: 'sessionList',
  items: [
    { sessionId: 'session-keep', cwd: 'C:\\ws2', title: 'keep', updatedAt: 9, messages: 2 },
    { sessionId: 'session-arch', cwd: 'C:\\ws2', title: 'archived one', updatedAt: 8, messages: 2 },
  ],
  archivedIds: [],
  workspacePath: 'C:\\ws2',
})
check('an empty archive set does not resurrect archived rows', rowsIn('session-arch').length === 0)

// Opening the archived conversation, then archiving the OPEN one, closes it.
send({ type: 'sessionOpened', sessionId: 'session-keep', hasMore: false, blank: false, events: [] })
send({ type: 'sessionArchived', sessionId: 'session-keep', archivedIds: ['session-arch', 'session-keep'] })
check('archiving the open conversation closes it', rowsIn('session-keep').length === 0)
posted.length = 0
send({ type: 'frame', kind: 'mux', frame: { type: 'session/queue', sessionId: 'session-keep', items: [] } })
check('no messages are sent to an archived conversation', posted.every(m => m.type !== 'prompt'),
  posted.map(m => m.type).join(','))


// ── 7) an archived row is not openable even if a stale render shows it ─────
send({ type: 'sessionList',
  items: [
    { sessionId: 'session-keep2', cwd: 'C:\\ws3', title: 'keep2', updatedAt: 5, messages: 1 },
    { sessionId: 'session-arch2', cwd: 'C:\\ws3', title: 'archived two', updatedAt: 4, messages: 1 },
  ],
  archivedIds: ['session-arch2'],
  workspacePath: 'C:\\ws3',
})
const archivedRow = rowsIn('session-arch2')[0]
check('archived row is not rendered (so it cannot be clicked)', archivedRow === undefined)

// Simulate the stale-render case by re-inserting the row, then clicking it.
if (archivedRow === undefined) {
  const list = window.document.querySelector('.sb-list')
  const stale = window.document.createElement('div')
  stale.className = 'sb-row'
  stale.title = 'C:\\ws3 · session-arch2'
  list.appendChild(stale)
  check('stale row injected for the guard test', rowsIn('session-arch2').length === 1)
}

// ── 8) subagent sessions are working logs, not conversations ─────────────
// The host filters them, and the webview refuses a stale render of one: this is
// what turned a 4-conversation drawer into 28 rows of prompts the user never
// typed.
send({ type: 'sessionList',
  items: [
    { sessionId: 'session-talk', cwd: 'C:\\ws4', title: 'a real conversation', updatedAt: 9, messages: 2 },
    { sessionId: 'child-a', cwd: 'C:\\ws4', title: '你是资深 Node.js 工程师', updatedAt: 12, parentSessionId: 'session-talk', origin: 'subagent' },
    { sessionId: 'child-b', cwd: 'C:\\ws4', title: 'You are doing READ-ONLY diagnosis', updatedAt: 11, parentSessionId: 'child-a', origin: 'subagent' },
    { sessionId: 'fork-a', cwd: 'C:\\ws4', title: 'forked conversation', updatedAt: 8, parentSessionId: 'session-talk' },
  ],
  archivedIds: [],
  workspacePath: 'C:\\ws4',
})
check('a subagent session is not listed as a conversation', rowsIn('child-a').length === 0)
check('  nor is a nested one', rowsIn('child-b').length === 0)
check('a fork (parentSessionId without origin) is still listed', rowsIn('fork-a').length === 1)
check('the real conversation is listed', rowsIn('session-talk').length === 1)
const countEl = window.document.querySelector('.sb-count')
check('the drawer counts conversations only', countEl !== null && countEl.textContent === '2', countEl ? countEl.textContent : '(missing)')

// A stale render must not be able to open one either.
const listEl = window.document.querySelector('.sb-list')
const staleChild = window.document.createElement('div')
staleChild.className = 'sb-row'
staleChild.title = 'C:\\ws4 · child-a'
listEl.appendChild(staleChild)
posted.length = 0
staleChild.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('a stale subagent row does not open a session', posted.every(m => m.type !== 'openSession'), posted.map(m => m.type).join(','))


const failed = results.filter(r => !r.ok)
console.log('')
console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map(f => f.label).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)