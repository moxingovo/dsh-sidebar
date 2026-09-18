'use strict'
// Fix VS Code's extension scan cache so it points at the 0.3.1 directory.
// Root cause: the cache (C:\Users\20906\.vscode\extensions\extensions.json)
// still references the DELETED 0.3.0 dir. VS Code trusts it at startup, hits
// ENOENT, marks the extension broken, and never discovers 0.3.1.
// MUST be run with VS Code FULLY CLOSED. Idempotent; backs up first.
const fs = require('node:fs')
const path = require('node:path')

const EXT_DIR = path.join(process.env.USERPROFILE, '.vscode', 'extensions')
const CACHE = path.join(EXT_DIR, 'extensions.json')
const VER = process.argv[2] || '0.3.2'
const NEW_DIR_NAME = 'local-dsh.dsh-webview-' + VER
const NEW_PATH = path.join(EXT_DIR, NEW_DIR_NAME)
const NEW_PATH_FWD = NEW_PATH.replace(/\\/g, '/')
const NEW_EXTERNAL = 'file:///' + NEW_PATH_FWD.replace(/:/g, '%3A').replace(/\//g, '/')

if (!fs.existsSync(CACHE)) {
  console.log('cache not found:', CACHE)
  process.exit(2)
}
if (!fs.existsSync(path.join(NEW_PATH, 'package.json'))) {
  console.log('ERROR: extension dir missing:', NEW_PATH)
  process.exit(2)
}

if (!fs.existsSync(CACHE + '.bak-dsh')) fs.copyFileSync(CACHE, CACHE + '.bak-dsh')

const list = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
let entry = list.find((x) => x && x.identifier && x.identifier.id === 'local-dsh.dsh-webview')
if (entry) {
  entry.version = VER
  entry.relativeLocation = NEW_DIR_NAME
  entry.location = {
    $mid: 1,
    fsPath: NEW_PATH,
    _sep: 1,
    external: NEW_EXTERNAL,
    path: '/' + NEW_PATH_FWD,
    scheme: 'file',
  }
  delete entry.metadata
  console.log('updated cache entry -> ' + VER)
} else {
  list.push({
    identifier: { id: 'local-dsh.dsh-webview' },
    version: '0.3.1',
    location: {
      $mid: 1,
      fsPath: NEW_PATH,
      _sep: 1,
      external: NEW_EXTERNAL,
      path: '/' + NEW_PATH_FWD,
      scheme: 'file',
    },
    relativeLocation: NEW_DIR_NAME,
  })
  console.log('added cache entry -> 0.3.1')
}
fs.writeFileSync(CACHE, JSON.stringify(list))

// Drop the profile-level scan caches so they rebuild from extensions.json.
const profRoot = path.join(process.env.APPDATA, 'Code', 'CachedProfilesData')
if (fs.existsSync(profRoot)) {
  for (const dir of fs.readdirSync(profRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const p = path.join(profRoot, dir.name)
    for (const f of ['extensions.user.cache', 'extensions.builtin.cache']) {
      const fp = path.join(p, f)
      if (fs.existsSync(fp)) {
        if (!fs.existsSync(fp + '.bak-dsh')) fs.copyFileSync(fp, fp + '.bak-dsh')
        fs.unlinkSync(fp)
        console.log('dropped cache:', fp)
      }
    }
  }
}

// Also fix the global placeholder iconUrl if it points at the old dir.
const { DatabaseSync } = require('node:sqlite')
const gdbPath = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb')
if (fs.existsSync(gdbPath)) {
  if (!fs.existsSync(gdbPath + '.bak-dsh')) fs.copyFileSync(gdbPath, gdbPath + '.bak-dsh')
  const db = new DatabaseSync(gdbPath)
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('workbench.auxiliarybar.placeholderPanels')
  if (row) {
    let list2 = []
    try { list2 = JSON.parse(String(row.value)) } catch {}
    let changed = false
    for (const x of list2) {
      if (!x || x.id !== 'workbench.view.extension.dsh-aux') continue
      if (!x.iconUrl || String(x.iconUrl.path || '').includes('dsh-webview-0.3.0')) {
        x.iconUrl = { $mid: 1, path: '/' + NEW_PATH_FWD + '/media/dsh.svg', scheme: 'file' }
        changed = true
      }
    }
    if (changed) {
      db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify(list2), 'workbench.auxiliarybar.placeholderPanels')
      console.log('placeholder iconUrl fixed -> 0.3.1')
    }
  }
  db.close()
}

console.log('DONE — reopen VS Code; the extension should load as ' + VER + '.')
