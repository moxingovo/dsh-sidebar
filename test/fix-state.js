'use strict'
// DSH state fix v5 — MINIMAL surgery on VS Code storage.
// MUST be run with VS Code FULLY CLOSED. Idempotent; one backup per DB.
//
// Touches ONLY:
//  - global aux pinnedPanels:        remove chat + stale 'dsh'; ensure claude + dsh-aux pinned
//  - global aux placeholderPanels:   remove chat + stale 'dsh'
//  - global panel.chat.hidden:       ensure chat view isHidden:true
//  - workspace aux viewContainersWorkspaceState: remove chat + stale 'dsh'; ensure claude + dsh-aux visible
//  - workspace panel viewContainersWorkspaceState: remove chat + stale 'dsh' (keep everything else)
//  - workspace workbench.panel.chat: force view isHidden:true
//  - workspace auxiliarybar.activepanelid: clear if it points at chat
//  - stale keys: workbench.view.extension.dsh.* (exact ids only, never dsh-aux)
// NEVER touches activity bar / panel pinned lists (v4 bug: they were stripped).
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')

const CHAT = 'workbench.panel.chat'
const STALE = 'workbench.view.extension.dsh'
const OURS = 'workbench.view.extension.dsh-aux'
const CC = 'workbench.view.extension.claude-sidebar-secondary'

function backupOnce(dbPath) {
  const bak = dbPath + '.bak-dsh'
  if (!fs.existsSync(bak)) {
    try { fs.copyFileSync(dbPath, bak) } catch (e) { console.log('  backup fail:', e.message) }
  }
}

function getJson(db, key) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
  if (!row) return null
  try { return JSON.parse(String(row.value)) } catch { return null }
}

function setJson(db, key, val) {
  const s = JSON.stringify(val)
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
  if (row) db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(s, key)
  else db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, s)
}

function delKey(db, key) {
  db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key)
}

// Remove ids in [removeIds]; keep everything else. Returns [list, changed].
function filterOut(list, removeIds) {
  const next = []
  let changed = false
  for (const x of list) {
    if (x && typeof x.id === 'string' && removeIds.has(x.id)) { changed = true; continue }
    next.push(x)
  }
  return [next, changed]
}

function ensureEntry(list, id, maker) {
  if (list.some((x) => x && x.id === id)) return [list, false]
  return [[...list, maker()], true]
}

function processWorkspace(dbPath) {
  const db = new DatabaseSync(dbPath)
  let changed = false
  const mark = (c) => { if (c) changed = true }

  const aux = getJson(db, 'workbench.auxiliarybar.viewContainersWorkspaceState')
  if (Array.isArray(aux)) {
    let [l, c] = filterOut(aux, new Set([CHAT, STALE]))
    let [l2, c2] = ensureEntry(l, OURS, () => ({ id: OURS, visible: true }))
    let [l3, c3] = ensureEntry(l2, CC, () => ({ id: CC, visible: true }))
    mark(c || c2 || c3)
    setJson(db, 'workbench.auxiliarybar.viewContainersWorkspaceState', l3)
  }

  const panel = getJson(db, 'workbench.panel.viewContainersWorkspaceState')
  if (Array.isArray(panel)) {
    let [l, c] = filterOut(panel, new Set([CHAT, STALE]))
    mark(c)
    setJson(db, 'workbench.panel.viewContainersWorkspaceState', l)
  }

  const chatView = getJson(db, CHAT)
  if (chatView === null || typeof chatView !== 'object') {
    setJson(db, CHAT, { 'workbench.panel.chat.view.copilot': { collapsed: false, isHidden: true } })
    mark(true)
  } else {
    const v = chatView['workbench.panel.chat.view.copilot']
    if (!v || v.isHidden !== true) {
      setJson(db, CHAT, { ...chatView, 'workbench.panel.chat.view.copilot': { collapsed: false, isHidden: true } })
      mark(true)
    }
  }
  delKey(db, CHAT + '.numberOfVisibleViews')

  const activeId = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('workbench.auxiliarybar.activepanelid')
  if (activeId && String(activeId.value).includes(CHAT)) { delKey(db, 'workbench.auxiliarybar.activepanelid'); mark(true) }
  if (activeId && String(activeId.value) === STALE) { setJson(db, 'workbench.auxiliarybar.activepanelid', OURS); mark(true) }

  for (const k of ['workbench.view.extension.dsh.state', 'workbench.view.extension.dsh.state.hidden', 'workbench.view.extension.dsh.numberOfVisibleViews', 'memento/webviewView.dshWebView']) delKey(db, k)

  db.close()
  return changed
}

function processGlobal(dbPath) {
  const db = new DatabaseSync(dbPath)
  let changed = false
  const mark = (c) => { if (c) changed = true }

  const pin = getJson(db, 'workbench.auxiliarybar.pinnedPanels')
  if (Array.isArray(pin)) {
    let [l, c] = filterOut(pin, new Set([CHAT, STALE]))
    let [l2, c2] = ensureEntry(l, OURS, () => ({ id: OURS, pinned: true, visible: false, order: 102 }))
    let [l3, c3] = ensureEntry(l2, CC, () => ({ id: CC, pinned: true, visible: false, order: 101 }))
    mark(c || c2 || c3)
    setJson(db, 'workbench.auxiliarybar.pinnedPanels', l3)
  }

  const ph = getJson(db, 'workbench.auxiliarybar.placeholderPanels')
  if (Array.isArray(ph)) {
    let [l, c] = filterOut(ph, new Set([CHAT, STALE]))
    mark(c)
    setJson(db, 'workbench.auxiliarybar.placeholderPanels', l)
  }

  setJson(db, 'workbench.panel.chat.hidden', [{ id: 'workbench.panel.chat.view.copilot', isHidden: true }])

  db.close()
  return changed
}

let globalChanged = false
let wsPatched = 0
let wsChanged = 0
let errors = 0

const globalPath = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb')
if (fs.existsSync(globalPath)) {
  backupOnce(globalPath)
  try {
    globalChanged = processGlobal(globalPath)
    console.log('global:', globalChanged ? 'CHANGED' : 'already-clean')
  } catch (e) { errors++; console.log('global ERROR:', e.message) }
} else {
  console.log('global: not found at ' + globalPath)
}

const wsRoot = path.join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage')
if (fs.existsSync(wsRoot)) {
  for (const dir of fs.readdirSync(wsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dbPath = path.join(wsRoot, dir.name, 'state.vscdb')
    if (!fs.existsSync(dbPath)) continue
    backupOnce(dbPath)
    try {
      const c = processWorkspace(dbPath)
      wsPatched++
      if (c) { wsChanged++; console.log('workspace:', dir.name, 'CHANGED') }
    } catch (e) { errors++; console.log('workspace ERROR:', dir.name, e.message) }
  }
}

console.log('')
console.log('SUMMARY globalChanged=' + globalChanged + ' workspaces=' + wsPatched + ' changed=' + wsChanged + ' errors=' + errors)
if (errors === 0) console.log('OK — state fixed. Now reopen VS Code: chat gone, DSH icon pinned top-right.')
