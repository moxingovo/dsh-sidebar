'use strict'
// Mock DSH 0.1.6 server for the regression suites: the cookie handshake, the
// unary <ns>/<method> gateway, and the /api/remote.mux WebSocket that carries
// workspace/follow baselines, the $events host stream and session/follow.
//
// The old suites drove a plain HTTP mock of the 0.1.0 wire (/api/session.list,
// /api/respond); that wire is gone, so they silently stopped testing anything.
const http = require('node:http')
const crypto = require('node:crypto')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MUX_PATH = '/api/remote.mux'

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const b1 = buffer[offset]
    const b2 = buffer[offset + 1]
    const masked = (b2 & 0x80) !== 0
    let len = b2 & 0x7f
    let headerLen = 2
    if (len === 126) { if (buffer.length - offset < 4) break; len = buffer.readUInt16BE(offset + 2); headerLen = 4 }
    else if (len === 127) { if (buffer.length - offset < 10) break; len = Number(buffer.readBigUInt64BE(offset + 2)); headerLen = 10 }
    const maskLen = masked ? 4 : 0
    if (buffer.length - offset < headerLen + maskLen + len) break
    let payload = buffer.subarray(offset + headerLen + maskLen, offset + headerLen + maskLen + len)
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4)
      payload = Buffer.from([...payload].map((byte, i) => byte ^ mask[i % 4]))
    }
    const opcode = b1 & 0x0f
    if (opcode === 1) frames.push(payload.toString('utf8'))
    else if (opcode === 8) frames.push(null)
    offset += headerLen + maskLen + len
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * @param options.token - launch token the mock accepts.
 * @param options.unary - map of `<ns>/<method>` to the value it returns.
 * @param options.workspaces, options.archivedSessionIds - workspace/follow baseline.
 * @param options.records, options.projections - session/follow snapshot.
 */
function createMockServer(options = {}) {
  const token = options.token || 'mock-launch-token-abcdefghijklmnopqrstuvwxyz01'
  const state = { requests: [], sockets: new Set(), subscriptions: new Map(), cookie: null }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
      state.cookie = 'dsh-auth-mock=v1.mock.mock'
      res.writeHead(303, { location: '/', 'set-cookie': state.cookie + '; HttpOnly; SameSite=Strict', 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const authed = String(req.headers.cookie || '').includes('dsh-auth-mock=')
      if (!authed) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('dsh web authentication required\n'); return }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!DOCTYPE html><html><body><script>window.__DSH_BOOT__={}</script></body></html>')
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let json = null
      try { json = JSON.parse(body) } catch {}
      state.requests.push({ url: url.pathname, body: json, cookie: req.headers.cookie || '' })
      const method = url.pathname.replace(/^\/api\//, '')
      const value = Object.prototype.hasOwnProperty.call(options.unary || {}, method) ? options.unary[method] : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: (json && json.rpcId) || 'mock', result: { ok: true, value } }))
    })
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    state.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { frames, rest } = decodeFrames(buffer)
      buffer = rest
      for (const raw of frames) {
        if (raw === null) { socket.end(); continue }
        let message = null
        try { message = JSON.parse(raw) } catch { continue }
        if (message.type === 'open') {
          state.subscriptions.set(message.streamId, { endpoint: message.endpoint, socket })
          const send = (value) => socket.write(encodeText(JSON.stringify({ type: 'item', streamId: message.streamId, value })))
          if (message.endpoint === 'workspace/follow') {
            send({ items: options.workspaces || [], archivedSessionIds: options.archivedSessionIds || [] })
          } else if (message.endpoint === '$events') {
            send({ type: 'ready', clientId: 'mock-client' })
          } else if (message.endpoint === 'session/follow') {
            send({
              type: 'snapshot', cursor: 0, records: options.records || [], hasMore: false,
              projections: { asOfSeq: 0, values: options.projections || {} },
            })
          }
        } else if (message.type === 'cancel') {
          state.subscriptions.delete(message.streamId)
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => state.sockets.delete(socket))
  })

  const broadcast = (predicate, frame) => {
    for (const [streamId, sub] of state.subscriptions) {
      if (!predicate(sub)) continue
      sub.socket.write(encodeText(JSON.stringify({ type: 'item', streamId, value: frame })))
    }
  }

  return {
    server,
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => { for (const socket of state.sockets) { try { socket.destroy() } catch {} } server.close() },
    /** A plain host emit, e.g. api-session/status. */
    emit: (event, args) => broadcast((sub) => sub.endpoint === '$events', { type: 'emit', event, args }),
    /** A host waterfall needing an answer, e.g. approval/request. */
    waterfall: (event, request, eventId, agentId) => broadcast((sub) => sub.endpoint === '$events', {
      type: 'waterfall',
      event,
      eventId: eventId || 'evt-1',
      agentId: agentId || options.agentId || 'session-aaaa',
      request,
    }),
    /** Push a durable session event into session/follow subscribers. */
    sessionEvent: (event) => broadcast((sub) => sub.endpoint === 'session/follow', { type: 'event', event }),
  }
}

module.exports = { createMockServer, MUX_PATH }