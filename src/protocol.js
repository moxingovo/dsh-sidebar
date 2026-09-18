'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// dsh protocol client (P0 通信层协议映射模块,需求书 §2 / §P0)
// Node-only, no vscode dependency: headless-testable against the real service.
//
// Wire contract (verified against packages/host/apiproxy, rc.5):
//   POST /api/<method>          envelope {type:'client-request', rpcId, method, payload}
//                               → {type:'server-response', rpcId, result:{ok,value|error}}
//   GET  /api/events.mux        SSE downlink: session frames
//   GET  /api/events.host       SSE downlink: host frames
//   POST /api/respond           envelope {type:'client-response', rpcId, result}
//                               (answers server-requests: approval/*, question/*)
// Service version change → adapt HERE only.
// ─────────────────────────────────────────────────────────────────────────────
const http = require('node:http')
const { SimpleWebSocket } = require('./websocket')

class RpcError extends Error {
  constructor(code, message, details) {
    super(message || String(code))
    this.name = 'RpcError'
    this.code = code
    this.details = details || {}
  }
}

/** One unary RPC call. Business errors throw RpcError (HTTP stays 2xx). */
async function call(baseUrl, method, payload = {}, log = () => {}) {
  const rpcId = 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  log('[req]', method, JSON.stringify(payload).slice(0, 400))
  const res = await fetch(baseUrl + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  let body
  try {
    body = await res.json()
  } catch {
    throw new RpcError('transport', method + ': non-JSON response (http ' + res.status + ')')
  }
  if (body.type !== 'server-response') {
    throw new RpcError('transport', method + ': unexpected envelope ' + String(body.type))
  }
  const result = body.result
  if (!result || result.ok !== true) {
    const e = (result && result.error) || {}
    throw new RpcError(e.code || 'rpc-error', e.message || method + ' failed', e.details)
  }
  return result.value
}

/** Answer a pending server-request (approval/question frame) via POST /api/respond. */
async function respond(baseUrl, rpcId, value, log = () => {}) {
  log('[respond]', String(rpcId))
  const res = await fetch(baseUrl + '/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  })
  const body = await res.json().catch(() => null)
  if (!body || body.accepted !== true) {
    throw new RpcError('respond-rejected', 'server rejected response to ' + String(rpcId))
  }
  return body
}

/**
 * Incremental SSE reader: feed() chunks; emits parsed payloads (JSON kept raw).
 * Frame convention: 'data: <json>' lines then a blank line; comment lines
 * (starting with ':') are ignored. A broken frame is reported via onBadFrame
 * and the parser stays in sync by discarding through the blank line.
 */
class SseParser {
  constructor({ onFrame, onBadFrame = () => {}, log = () => {} }) {
    this.onFrame = onFrame
    this.onBadFrame = onBadFrame
    this.log = log
    this.buffer = ''
  }
  feed(chunk) {
    this.buffer += chunk
    for (;;) {
      const i = this.buffer.indexOf('\n\n')
      if (i < 0) break
      const raw = this.buffer.slice(0, i)
      this.buffer = this.buffer.slice(i + 2)
      let dataLine = null
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) dataLine = line.slice(5).trimStart()
      }
      if (dataLine === null || dataLine === '') continue
      try {
        this.onFrame(JSON.parse(dataLine))
      } catch (e) {
        this.log('[sse] bad frame', e.message)
        this.onBadFrame(e)
      }
    }
  }
}

/**
 * One SSE downlink with automatic reconnect (exponential backoff + jitter).
 * Events via callbacks: onOpen (200 reached), onDown (stream lost → about to
 * retry), onFrame (parsed payload, JSON already the frame object).
 */
class SseStream {
  constructor({ path, baseUrl, onFrame, onOpen = () => {}, onDown = () => {}, backoff = { base: 800, max: 8000 }, log = () => {} }) {
    this.path = path
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.onFrame = onFrame
    this.onOpenCb = onOpen
    this.onDown = onDown
    this.backoff = backoff
    this.log = log
    this.attempt = 0
    this.req = null
    this.timer = null
    this.closed = false
    this.openedOnce = false
    this.parser = new SseParser({ onFrame: (f) => this.onFrame(f), log })
  }
  open() {
    if (this.closed) return
    if (this.openedOnce) {
      this.log('[sse] ' + this.path + ' retry…')
    }
    const url = this.baseUrl + this.path
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        this.log('[sse] ' + this.path + ' http ' + res.statusCode)
        this._down({ code: 'http-' + res.statusCode })
        return
      }
      const firstOpen = !this.openedOnce
      this.openedOnce = true
      this.attempt = 0
      this.onOpenCb(firstOpen)
      res.setEncoding('utf8')
      res.on('data', (c) => this.parser.feed(c))
      res.on('end', () => { this.log('[sse] ' + this.path + ' stream ended'); this._down({ code: 'stream-end' }) })
      res.on('error', (e) => { this.log('[sse] ' + this.path + ' error', e.message); this._down({ code: e.code || 'stream-error' }) })
    })
    this.req = req
    req.on('error', (e) => { this.log('[sse] ' + this.path + ' req error', e.message); this._down({ code: e.code || 'req-error' }) })
  }
  _down(error) {
    if (this.closed) return
    this.onDown(error)
    this._scheduleReconnect()
  }
  _scheduleReconnect() {
    if (this.closed || this.timer) return
    if (this.req) { try { this.req.destroy() } catch {} this.req = null }
    const cap = Math.min(this.backoff.max, this.backoff.base * (2 ** Math.min(this.attempt, 5)))
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2))
    this.attempt++
    this.log('[sse] ' + this.path + ' reconnect in ' + delay + 'ms')
    this.timer = setTimeout(() => { this.timer = null; this.open() }, delay)
  }
  close() {
    this.closed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.req) { try { this.req.destroy() } catch {} this.req = null }
  }
}

/**
 * One WebSocket downlink with automatic reconnect (exponential backoff + jitter).
 * Same callback shape as SseStream; used by DshClient for the two event streams.
 */
class WsDownlink {
  constructor({ url, onFrame, onOpen = () => {}, onDown = () => {}, backoff = { base: 800, max: 8000 }, log = () => {} }) {
    this.url = url
    this.onFrame = onFrame
    this.onOpenCb = onOpen
    this.onDown = onDown
    this.backoff = backoff
    this.log = log
    this.attempt = 0
    this.timer = null
    this.socket = null
    this.closed = false
    this.openedOnce = false
  }
  open() {
    if (this.closed) return
    if (this.openedOnce) this.log('reconnect attempt')
    const ws = new SimpleWebSocket(this.url)
    this.socket = ws
    ws.open({
      onOpen: () => {
        const first = !this.openedOnce
        this.openedOnce = true
        this.attempt = 0
        this.onOpenCb(first)
      },
      onMessage: (raw) => {
        if (typeof raw !== 'string') return
        let frame
        try { frame = JSON.parse(raw) } catch (e) { this.log('bad frame', e.message); return }
        this.onFrame(frame)
      },
      onError: (e) => {
        this.log('error', e && e.message)
        this._down({ code: e && e.code || 'ws-error' })
      },
      onClose: () => {
        this._down({ code: 'ws-close' })
      },
    })
  }
  _down(error) {
    if (this.closed) return
    this.onDown(error)
    this._scheduleReconnect()
  }
  _scheduleReconnect() {
    if (this.closed || this.timer) return
    if (this.socket) {
      try { this.socket.close(1000) } catch {}
      this.socket = null
    }
    const cap = Math.min(this.backoff.max, this.backoff.base * (2 ** Math.min(this.attempt, 5)))
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2))
    this.attempt++
    this.log('reconnect in ' + delay + 'ms')
    this.timer = setTimeout(() => { this.timer = null; this.open() }, delay)
  }
  close() {
    this.closed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.socket) { try { this.socket.close(1000) } catch {} this.socket = null }
  }
}

/**
 * Full protocol session: unary RPC + both SSE downlinks + respond.
 * Events (on/off/emit): 'mux' frame | 'host' frame | 'down' {stream,error} | 'up' {stream}
 */
class DshClient {
  constructor({ baseUrl, log = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.log = log
    this.listeners = { mux: [], host: [], down: [], up: [] }
    this.mux = null
    this.host = null
  }
  on(event, cb) { (this.listeners[event] = this.listeners[event] || []).push(cb); return cb }
  off(event, cb) { const l = this.listeners[event]; if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1) } }
  emit(event, payload) { for (const cb of this.listeners[event] || []) { try { cb(payload) } catch (e) { this.log('[client] listener error', e.message) } } }
  request(method, payload) { return call(this.baseUrl, method, payload, this.log) }
  respond(rpcId, value) { return respond(this.baseUrl, rpcId, value, this.log) }
  open() {
    this.close()
    const mk = (name, path) => new WsDownlink({
      url: this.baseUrl + path,
      log: (a, b) => this.log('[' + name + ']', a, b === undefined ? '' : b),
      onFrame: (envelope) => {
        // 下行信封为 server-request: {type, rpcId, method, payload};业务帧语义在 payload
        if (!envelope || typeof envelope !== 'object') return
        const payload = envelope.payload || {}
        if (payload.type === 'stream/error') { this.emit('down', { stream: name, error: payload.error || {} }); return }
        this.emit(name, { ...payload, rpcId: envelope.rpcId })
      },
      onOpen: () => this.emit('up', { stream: name }),
      onDown: (error) => this.emit('down', { stream: name, error }),
    })
    this.mux = mk('mux', '/api/events.mux')
    this.host = mk('host', '/api/events.host')
    this.mux.open()
    this.host.open()
  }
  close() {
    if (this.mux) { this.mux.close(); this.mux = null }
    if (this.host) { this.host.close(); this.host = null }
  }
}

module.exports = { DshClient, call, respond, SseParser, SseStream, WsDownlink, RpcError }
