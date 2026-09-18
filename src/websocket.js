'use strict'
// Minimal RFC6455 client for the dsh downlinks (extension host Node 18, no deps).
// The dsh server (packages/client/connection) upgrades /api/events.mux and
// /api/events.host to WebSocket and pushes JSON text frames (server-request
// envelopes). Downlink = read-only; we answer pings and close politely.
const http = require('node:http')
const crypto = require('node:crypto')

class SimpleWebSocket {
  constructor(url) {
    this.url = url
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.cb = {}
  }
  open(callbacks) {
    this.cb = callbacks || {}
    if (this.closed) return
    const u = new URL(this.url)
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'dsh-webview/0.3.0',
      },
    })
    this.req = req
    req.on('upgrade', (res, socket, head) => {
      this.socket = socket
      socket.setNoDelay(true)
      socket.on('data', (c) => this._feed(c))
      socket.on('error', (e) => {
        if (!this.closed && this.cb.onError) this.cb.onError(e)
      })
      socket.on('close', () => {
        if (!this.closed && this.cb.onClose) this.cb.onClose(1006, 'socket closed')
      })
      if (head && head.length) this._feed(head)
      if (this.cb.onOpen) this.cb.onOpen()
    })
    req.on('response', (res) => {
      // Non-101: e.g. 426 upgrade required → treat as failure
      res.resume()
      if (!this.closed && this.cb.onError) this.cb.onError(new Error('upgrade rejected: HTTP ' + res.statusCode))
      if (this.cb.onClose) this.cb.onClose(res.statusCode || 0, 'upgrade rejected')
    })
    req.on('error', (e) => {
      if (!this.closed && this.cb.onError) this.cb.onError(e)
      if (this.cb.onClose) this.cb.onClose(1006, e.message)
    })
    req.end()
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    try {
      this._sendFrame(0x8, Buffer.concat([
        Buffer.from([(code >> 8) & 0xff, code & 0xff]),
        Buffer.from(String(reason).slice(0, 120)),
      ]))
    } catch {}
    if (this.socket) {
      const s = this.socket
      this.socket = null
      try { s.end() } catch {}
      try { s.destroy() } catch {}
    }
    if (this.req) { try { this.req.destroy() } catch {} this.req = null }
  }

  _feed(chunk) {
    if (!chunk || !chunk.length) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const b = this.buffer
      if (b.length < 2) return
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) === 0x80
      let len = b[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        offset = 10
      }
      let maskKey = null
      if (masked) {
        if (b.length < offset + 4) return
        maskKey = b.subarray(offset, offset + 4)
        offset += 4
      }
      if (b.length < offset + len) return
      const payload = maskKey
        ? Buffer.from(b.subarray(offset, offset + len).map((x, i) => x ^ maskKey[i % 4]))
        : Buffer.from(b.subarray(offset, offset + len))
      this.buffer = b.subarray(offset + len)
      this._handle(opcode, payload)
      if (opcode === 0x8) return
    }
  }

  _handle(opcode, payload) {
    switch (opcode) {
      case 0x1: // text
        if (this.cb.onMessage) this.cb.onMessage(payload.toString('utf8'))
        break
      case 0x2: // binary
        if (this.cb.onMessage) this.cb.onMessage(payload)
        break
      case 0x9: // ping → pong
        this._sendFrame(0xa, payload)
        break
      case 0xa:
        break
      case 0x8: { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        try { this._sendFrame(0x8, payload.subarray(0, 2)) } catch {}
        if (!this.closed && this.cb.onClose) this.cb.onClose(code, 'close frame')
        this.closed = true
        if (this.socket) { try { this.socket.destroy() } catch {} this.socket = null }
        break
      }
      default:
        break
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket) return
    const p = payload || Buffer.alloc(0)
    const mask = crypto.randomBytes(4)
    const masked = Buffer.alloc(p.length)
    for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i % 4]
    let header
    if (p.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | p.length])
    } else if (p.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(p.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(p.length), 2)
    }
    this.socket.write(Buffer.concat([header, mask, masked]))
  }
}

module.exports = { SimpleWebSocket }
