'use strict'
// Pill menus must keep working after the first pick.
//
// Regression: pillMenu() attached a document pointerdown handler that was only
// removed when it fired itself. Picking an item closed the menu without it, so
// from the second interaction on the stale handler (still holding the REMOVED
// menu) saw the click as 'outside', closed the NEW menu on pointerdown, and the
// item's click never fired — the user saw 'first switch instant, then nothing
// for a long time'.
//
// Run: node test/pill-menu-verify.js
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
const WEBVIEW = process.env.DSH_WEBVIEW_DIR || path.join(__dirname, '..', 'webview')
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', { url: 'https://dsh.local/', runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom
const doc = window.document
const posted = []
window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) })
// Count document-level pointerdown listeners: jsdom dispatches events straight at
// nodes (no hit testing), so a menu that a real browser would have closed under
// the cursor still receives the click here. The leak itself is observable.
let pointerListeners = 0
const origAdd = doc.addEventListener.bind(doc)
const origRemove = doc.removeEventListener.bind(doc)
const where = () => String(new Error().stack || '').split('\n').slice(2, 6).map((s) => { const m = /app\.js:(\d+):(\d+)/.exec(s); return m ? 'app.js:' + m[1] : (s.trim().split(' ')[1] || '?') }).join(' <- ').slice(0, 80)
doc.addEventListener = (type, handler, options) => { if (type === 'pointerdown') { pointerListeners++; if (process.env.DSH_TRACE) console.log('    [spy] + ' + pointerListeners + '  ' + where()) } return origAdd(type, handler, options) }
doc.removeEventListener = (type, handler, options) => { if (type === 'pointerdown') { pointerListeners--; if (process.env.DSH_TRACE) console.log('    [spy] - ' + pointerListeners + '  ' + where()) } return origRemove(type, handler, options) }
const load = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
load('markdown.js')
load('app.js')
const results = []
const check = (label, ok, detail) => { results.push({ label, ok }); console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + String(detail).slice(0, 140))) }
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const $ = (sel) => doc.querySelector(sel)
const menus = () => [...doc.querySelectorAll('.pill-menu')]
const tick = () => new Promise((r) => setTimeout(r, 30))
// A real browser dispatches pointerdown before click; the stale-listener bug only
// shows up with that order, so both are dispatched here.
const press = (node) => {
  node.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}
const SID = 'session-pill-0001'
const OPTIONS = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'danger-full-access', name: 'danger-full-access' },
]
;(async () => {
  send({ type: 'sessionOpened', sessionId: SID, hasMore: false, blank: false, events: [], projections: { asOfSeq: 0, values: { permissions: { currentValue: 'danger-full-access', options: OPTIONS } } }, models: { current: { provider: 'p', model: 'm' }, groups: [] } })
  await tick()
  check('the permission pill is enabled with options', $('#permPill') !== null && $('#permPill').disabled === false)
  // The boot skeleton keeps one permanent document pointerdown listener (context
  // meter). Everything the menus add must be gone again at the end.
  const baselineListeners = pointerListeners

  console.log('--- first pick ---')
  press($('#permPill'))
  await tick()
  check('the menu opens', menus().length === 1, menus().length + ' menus')
  const first = menus()[0] && menus()[0].querySelectorAll('.pill-item')[1]
  if (first) press(first)
  await tick()
  const firstPrompt = posted.filter((m) => m.type === 'prompt')
  check('the first pick posts its command', firstPrompt.length === 1 && String(firstPrompt[0].content[0].text) === '/permission workspace-write', JSON.stringify(firstPrompt.map((m) => m.content[0].text)))
  check('the menu is gone after picking', menus().length === 0, menus().length + ' menus')

  console.log('--- second pick (the regression) ---')
  press($('#permPill'))
  await tick()
  check('the menu opens again', menus().length === 1, menus().length + ' menus')
  const second = menus()[0] && menus()[0].querySelectorAll('.pill-item')[2]
  if (second) press(second)
  await tick()
  const prompts = posted.filter((m) => m.type === 'prompt')
  check('the second pick posts its command too', prompts.length === 2 && String(prompts[1].content[0].text) === '/permission danger-full-access', JSON.stringify(prompts.map((m) => m.content[0].text)))

  console.log('--- third pick, and no listener leak ---')
  press($('#permPill'))
  await tick()
  const third = menus()[0] && menus()[0].querySelectorAll('.pill-item')[0]
  if (third) press(third)
  await tick()
  const all = posted.filter((m) => m.type === 'prompt')
  check('the third pick posts exactly one more command', all.length === 3, JSON.stringify(all.map((m) => m.content[0].text)))
  check('never more than one menu in the DOM', menus().length === 0, menus().length + ' menus')

  console.log('--- outside click still closes ---')
  press($('#permPill'))
  await tick()
  const open = menus().length
  doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  await tick()
  check('clicking outside closes the menu', open === 1 && menus().length === 0, open + ' -> ' + menus().length)

  check('one permanent listener is the baseline', baselineListeners === 1, baselineListeners + ' listeners')
  check('no menu listener is left behind', pointerListeners === baselineListeners, pointerListeners + ' vs baseline ' + baselineListeners)

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
  process.exit(failed.length === 0 ? 0 : 1)
})()