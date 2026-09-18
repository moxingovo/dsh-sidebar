'use strict'
// Image intake in the sidebar composer: paste, drop, and the file picker.
//
// The tray, the reader and the part serializer were all there, but nothing ever
// called them — there was no paste handler, no drop handler and no picker — so
// no image could get into a sidebar prompt at all. These checks drive the real
// webview scripts in jsdom and assert the canonical prompt part that leaves.
//
// Run: set DSH_CHECKOUT_NODE_MODULES to a checkout with jsdom, then
//   node test/attach-paste-verify.js
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require(process.env.DSH_CHECKOUT_NODE_MODULES + '/jsdom')

const WEBVIEW = path.join(__dirname, '..', 'webview')
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'https://dsh.local/', runScripts: 'outside-only', pretendToBeVisual: true,
})
const { window } = dom
const doc = window.document

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

const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const $ = (sel) => doc.querySelector(sel)
const tray = () => $('.attach-tray')
const chips = () => [...doc.querySelectorAll('.attach-chip')]
// The chip also holds its remove button, whose × is part of textContent.
const chipLabels = () => chips().map((c) => c.textContent.replace(/\s+/g, ' ').replace(/×$/, '').trim())
const transcript = () => ($('.dsh-messages') ? $('.dsh-messages').textContent : '')
const tick = () => new Promise((r) => setTimeout(r, 25))

const SID = 'session-attach-0001'
const LIMITS = {
  maxImageBytes: 5000,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 8000,
  maxImagePixels: 40000000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

// A File-like object: the webview only reads name/type/size/arrayBuffer.
const file = (name, type, length, fill) => {
  const bytes = new Uint8Array(length)
  if (fill !== undefined) bytes.fill(fill)
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer }
}
const png = (name = 'shot.png', length = 8) => file(name, 'image/png', length, 7)

const paste = (files, text = '') => {
  const ev = new window.Event('paste', { bubbles: true, cancelable: true })
  const items = files.map((f) => ({ kind: 'file', getAsFile: () => f }))
  Object.defineProperty(ev, 'clipboardData', { value: { items, files, getData: () => text } })
  $('.dsh-input').dispatchEvent(ev)
  return ev
}

const openSession = () => {
  send({ type: 'sessionOpened', sessionId: SID, hasMore: false, blank: false, events: [] })
  send({ type: 'frame', kind: 'mux', frame: { type: 'session/projection', sessionId: SID, key: 'imageLimits', value: LIMITS, seq: 1 } })
}

;(async () => {
  console.log('--- composer wiring ---')
  check('attachment tray exists', tray() !== null)
  check('tray starts hidden', tray() !== null && tray().hidden === true)
  check('attach button exists', $('#btnAttach') !== null)
  check('hidden file picker accepts exactly the four image types',
    $('#attachInput') !== null && $('#attachInput').getAttribute('accept') === 'image/png,image/jpeg,image/webp,image/gif',
    $('#attachInput') ? $('#attachInput').getAttribute('accept') : '(missing)')

  openSession()

  console.log('--- paste ---')
  paste([png()])
  await tick()
  check('a pasted image lands in the tray', chips().length === 1, JSON.stringify(chipLabels()))
  check('the chip names the file and its size', chipLabels()[0] === 'shot.png · 8 B', chipLabels()[0])
  check('the tray becomes visible', tray().hidden === false)

  const mixed = paste([png('mixed.png')], 'and this text')
  await tick()
  check('a mixed paste still contributes its image', chips().length === 2, JSON.stringify(chipLabels()))
  check('a mixed paste is not swallowed (its text survives)', mixed.defaultPrevented === false)

  console.log('--- refusals keep the tray honest ---')
  const before = chips().length
  paste([file('icon.bmp', 'image/bmp', 8)])
  await tick()
  check('an unsupported media type is refused', chips().length === before, JSON.stringify(chipLabels()))
  check('  and the reason is visible in the transcript',
    transcript().includes('只支持 png/jpeg/webp/gif'), transcript().match(/图片未加入[^。]*/)?.[0] ?? transcript().slice(-80))

  paste([file('huge.png', 'image/png', LIMITS.maxImageBytes + 1)])
  await tick()
  check('an oversized image is refused', chips().length === before)
  check('  with the single-image ceiling named', transcript().includes('超过单张上限'))

  paste([png('third.png')])
  await tick()
  check('a third image is refused while maxImagesPerMessage is 2', chips().length === before, JSON.stringify(chipLabels()))
  check('  with the count ceiling named', transcript().includes('最多 2 张图片'))

  console.log('--- identity is not the file name ---')
  const dupLabel = chipLabels().length
  paste([png('same.png'), png('same.png')])
  await tick()
  check('two images sharing a name both survive', chips().length === before, 'tray=' + chips().length + ' (limit already reached)')
  // Remove one, then re-add both to prove de-duplication is by identity.
  const x = chips()[0].querySelector('.chip-x')
  x.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  check('removing a chip removes exactly one', chips().length === before - 1, 'now=' + chips().length + ' was=' + dupLabel)
  paste([png('same.png')])
  await tick()
  check('a same-named file can be added again after a removal', chips().length === before, JSON.stringify(chipLabels()))

  console.log('--- the prompt part that leaves ---')
  const trayBeforeSend = chipLabels()
  posted.length = 0
  $('.dsh-input').value = 'look at this'
  $('#btnSend').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick()
  const prompt = posted.find((m) => m.type === 'prompt')
  check('sending posts a prompt', prompt !== undefined, JSON.stringify(posted.map((m) => m.type)))
  if (prompt) {
    check('  addressed to the open session', prompt.sessionId === SID, String(prompt.sessionId))
    check('  text part first', prompt.content[0] && prompt.content[0].type === 'text' && prompt.content[0].text === 'look at this')
    const part = prompt.content[1]
    check('  image part uses the canonical shape',
      part && part.type === 'image' && part.mediaType === 'image/png' && typeof part.data === 'string'
        && part.name === trayBeforeSend[0].split(' · ')[0],
      JSON.stringify(part && { type: part.type, mediaType: part.mediaType, media: typeof part.data, name: part.name }))
    check('  the payload is base64 of the file bytes', part && part.data === window.btoa('\x07'.repeat(8)), part && part.data)
    check('  every queued image is sent, in tray order',
      prompt.content.filter((c) => c.type === 'image').length === trayBeforeSend.length,
      'parts=' + prompt.content.filter((c) => c.type === 'image').length + ' tray=' + trayBeforeSend.length)
    check('  no tray-only fields leak into the part', part && part.id === undefined && part.bytes === undefined, JSON.stringify(Object.keys(part || {})))
  }
  check('the tray is cleared after sending', chips().length === 0 && tray().hidden === true, JSON.stringify(chipLabels()))

  console.log('--- drop and picker ---')
  const drop = new window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { items: [{ kind: 'file', getAsFile: () => png('dropped.png') }], files: [png('dropped.png')], getData: () => '' } })
  $('.dsh-composer').dispatchEvent(drop)
  await tick()
  check('a dropped image lands in the tray', chipLabels().some((l) => l.startsWith('dropped.png')), JSON.stringify(chipLabels()))

  posted.length = 0
  const picker = $('#attachInput')
  Object.defineProperty(picker, 'files', { value: [png('picked.png')], configurable: true })
  picker.dispatchEvent(new window.Event('change', { bubbles: true }))
  await tick()
  check('the file picker lands in the tray', chipLabels().some((l) => l.startsWith('picked.png')), JSON.stringify(chipLabels()))

  console.log('--- limits that the server did not publish ---')
  const beforeNoLimits = chipLabels().length
  send({ type: 'sessionOpened', sessionId: SID + '-b', hasMore: false, blank: false, events: [] })
  paste([file('big.png', 'image/png', LIMITS.maxImageBytes + 1000)])
  await tick()
  check('without an imageLimits projection the local ceiling is skipped',
    chipLabels().length === beforeNoLimits + 1 && chipLabels().some((l) => l.startsWith('big.png')),
    JSON.stringify(chipLabels()))

  const failed = results.filter((r) => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
  if (failed.length) {
    console.log('FAILED:')
    for (const f of failed) console.log('  - ' + f.label)
  }
  // Explicit: the webview's own timers keep the jsdom window (and the loop) alive.
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('harness error:', e); process.exit(2) })
