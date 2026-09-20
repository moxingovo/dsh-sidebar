'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// dsh protocol client — 0.1.6 (Typert API Gateway) wire.
//
// Verified against 0.1.6-alpha.2 (packages/api/*, packages/client/connection):
//   auth      GET  /?token=<43>  → 303 + Set-Cookie: dsh-auth-<h>=v1.<p>.<sig>
//                  every /api request (and the WS upgrade) must carry that cookie;
//                  without it the server answers 401 "unauthorized".
//   unary     POST /api/<ns>/<method>
//                  {type:'client-request', rpcId, method:'<ns>/<method>',
//                   payload:{args:{<host param name>: value, …}}}
//                  → {type:'server-response', rpcId, result:{ok, value|error}}
//                  NOTE: args are NAMED by the host signature (`_request` for
//                  session/list, `request` for the rest), not positional.
//   streams   WS   /api/remote.mux
//                  → {type:'open', streamId, endpoint, payload:{args}}
//                  ← {type:'item'|'error'|'end', streamId, value?}
//                  session/follow  → opening snapshot + durable events
//                  workspace/follow→ workspace baseline + increments
//                  $events         → host→client events (approval/question waterfalls)
//   answer    POST /api/$events/result {args:{clientId, eventId, outcome}}
//
// Legacy names (`session.list`, `host.describe`, …) stay the internal API so the
// rest of the extension keeps calling what it always called; the mapping lives
// in ENDPOINTS below. Service version change → adapt HERE only.
// ─────────────────────────────────────────────────────────────────────────────
const http = require('node:http')
const crypto = require('node:crypto')
const { SimpleWebSocket } = require('./websocket')

/** Single WebSocket carrying every Remote stream (gateway REMOTE_STREAM_MUX_PATH). */
const MUX_PATH = '/api/remote.mux'

class RpcError extends Error {
  constructor(code, message, details) {
    super(message || String(code))
    this.name = 'RpcError'
    this.code = code
    this.details = details || {}
  }
}

const jsonBody = (value) => JSON.stringify(value)

/** Client-minted prompt identity (SessionRequestId is a uuid on the wire). */
const newRequestId = () => crypto.randomUUID()

/** Deep search for one key; the workspace baseline shape is not part of the public contract. */
function deepFind(value, key, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return undefined
  if (Array.isArray(value)) {
    for (const item of value) { const hit = deepFind(item, key, depth + 1); if (hit !== undefined) return hit }
    return undefined
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key]
  for (const item of Object.values(value)) { const hit = deepFind(item, key, depth + 1); if (hit !== undefined) return hit }
  return undefined
}

/**
 * Internal name → [endpoint, args(payload)]. Values are exactly the named
 * arguments the host signature declares (signal is never part of args).
 */
const ENDPOINTS = {
  'host.describe': ['settings/describe', () => ({})],
  'session.list': ['session/list', () => ({ _request: {} })],
  // The 0.1.6 catalog calls the selected entry 'default'; the webview reads
  // 'current', so the mapping normalizes instead of teaching the UI two shapes.
  'session.models': ['session/modelCatalog', () => ({}), (value) => ({
    ...value,
    current: value.current || value.default || null,
  })],
  // 0.1.6 has no command slot on the prompt: slash lines go through
  // commands.execute (see the extension's sendPrompt) and never reach here.
  'session.prompt': ['session/prompt', (p) => ({
    request: {
      requestId: p.requestId || newRequestId(),
      sessionId: p.sessionId,
      mode: p.mode === 'steer' ? 'steer' : 'queue',
      content: p.content || [],
      ...p.clientTimeZone === undefined ? {} : { clientTimeZone: p.clientTimeZone },
    },
  })],
  'session.cancel': ['session/cancel', (p) => ({ request: { sessionId: p.sessionId } })],
  'session.rename': ['session/rename', (p) => ({ request: { sessionId: p.sessionId, title: p.title } })],
  'session.fork': ['session/fork', (p) => ({ request: { sessionId: p.sessionId, ...p.atSeq === undefined ? {} : { atSeq: p.atSeq } } })],
  'session.create': ['session/create', (p) => ({
    request: {
      ...p.workspaceId === undefined ? {} : { workspaceId: p.workspaceId },
      ...p.cwd === undefined ? {} : { cwd: p.cwd },
      ...p.agentPreset === undefined ? {} : { agentPreset: p.agentPreset },
      ...p.sessionId === undefined ? {} : { sessionId: p.sessionId },
    },
  })],
  'session.selectModel': ['session/selectModel', (p) => ({
    request: {
      sessionId: p.sessionId, provider: p.provider, model: p.model,
      ...p.reasoningEffort === undefined ? {} : { reasoningEffort: p.reasoningEffort },
    },
  })],
  'workspace.create': ['workspace/create', (p) => ({ request: { path: p.path } })],
  'workspace.archiveSession': ['workspace/archiveSession', (p) => ({ request: { sessionId: p.sessionId } })],
  'workspace.unarchiveSession': ['workspace/unarchiveSession', (p) => ({ request: { sessionId: p.sessionId } })],
  'agentPreset.list': ['agentPresets/list', () => ({})],
  // The permission SELECTION arrives in the session projection, but 0.1.6 keeps
  // the choices in this unary catalog — the pill's menu is fed from here.
  'permissionPreset.catalog': ['permissionPresets/catalog', () => ({})],
  // The host signature is select(agent: Agent, agentPreset: string): an Agent
  // parameter crosses the wire as `agentId`.
  'agentPreset.select': ['agentPresets/select', (p) => ({ agentId: p.sessionId, agentPreset: p.agentPreset })],
  // 0.1.6 signature: execute(agent, line, submittedAttachments, signal). The
  // third argument was renamed from 'attachments'; sending the old name fails
  // with 'missing "submittedAttachments"; unexpected "attachments"'.
  'commands.execute': ['commands/execute', (p) => ({
    agentId: p.sessionId, line: p.line, submittedAttachments: [],
  })],
}

/** One unary call against the gateway; business errors throw RpcError. */
async function call(baseUrl, method, payload = {}, log = () => {}) {
  const rpcId = 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  log('[req]', method, jsonBody(payload).slice(0, 400))
  const res = await httpRequest(baseUrl + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ type: 'client-request', rpcId, method, payload }),
  })
  let body
  try { body = JSON.parse(res.text) } catch {
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

/**
 * One logical Remote stream on /api/remote.mux. The socket is owned by
 * DshClient; this handle only tracks the stream id and its callbacks.
 */
class RemoteStream {
  constructor(client, endpoint, args, handlers = {}) {
    this.client = client
    this.endpoint = endpoint
    this.args = args || {}
    this.handlers = handlers
    this.id = 's' + String(++client.streamSeq)
    this.closed = false
  }
  /** (Re)issue the open message; called on connect and after every reconnect. */
  openOn(socket) {
    if (this.closed) return
    socket.send(jsonBody({ type: 'open', streamId: this.id, endpoint: this.endpoint, payload: { args: this.args } }))
  }
  item(value) { if (!this.closed && this.handlers.onItem) this.handlers.onItem(value, this) }
  end() { this.closed = true; this.client.streams.delete(this.id); if (this.handlers.onEnd) this.handlers.onEnd(this) }
  fail(error) { this.closed = true; this.client.streams.delete(this.id); if (this.handlers.onError) this.handlers.onError(error, this) }
  close() {
    if (this.closed) return
    this.closed = true
    this.client.streams.delete(this.id)
    try { this.client.socket && this.client.socket.send(jsonBody({ type: 'cancel', streamId: this.id })) } catch {}
  }
}

/**
 * One HTTP/1.1 request over \`node:http\`.
 *
 * \`fetch\` is avoided on purpose: inside the VS Code extension host the fetch
 * token exchange answered 401 for a token that very process then accepted over
 * http.get. Everything now shares the transport the mux upgrade uses — pinned
 * to 127.0.0.1, no proxy resolution, no Happy-Eyeballs family choice, and no
 * spec-filtered redirect responses.
 * @param url - absolute http URL.
 * @param options - method, headers, raw string body and timeout.
 * @returns status, response headers and the decoded body text.
 */
function httpRequest(url, options = {}) {
  const method = options.method || 'GET'
  const timeoutMs = options.timeoutMs || 20000
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch { reject(new RpcError('transport', 'not a url: ' + url)); return }
    const headers = { host: target.host }
    if (options.body !== undefined) {
      const bytes = Buffer.byteLength(options.body)
      headers['content-length'] = String(bytes)
    }
    Object.assign(headers, options.headers || {})
    const req = http.request({
      host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out after ' + timeoutMs + 'ms')))
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/**
 * Mint the browser-session cookie from a launch token.
 *
 * Deliberately raw `node:http` instead of `fetch`: inside the VS Code extension
 * host the fetch exchange answered 401 for a token the very same process then
 * accepted over http.get, and fetch's `redirect: 'manual'` is spec-filtered to
 * an opaque redirect (no readable Set-Cookie) in some runtimes. The exchange is
 * loopback-only and the 303 is deliberately not followed.
 * @param baseUrl - `http://127.0.0.1:<port>` without a trailing slash.
 * @param token - 43-char base64url launch token printed by `dsh web`.
 * @returns the raw status, first Set-Cookie value and a short body excerpt.
 */
function tokenExchange(baseUrl, token) {
  return new Promise((resolve, reject) => {
    let origin
    try { origin = new URL(baseUrl) } catch { reject(new RpcError('auth', 'not a url: ' + baseUrl)); return }
    const req = http.get({
      host: origin.hostname,
      port: origin.port || 80,
      path: '/?token=' + encodeURIComponent(token),
      headers: { host: origin.host, accept: 'text/html,*/*' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (body.length < 400) body += chunk })
      res.on('end', () => {
        const raw = res.headers['set-cookie']
        resolve({
          status: res.statusCode,
          setCookie: Array.isArray(raw) ? raw[0] : raw,
          body: String(body).trim().slice(0, 120),
        })
      })
      res.on('error', reject)
    })
    req.setTimeout(8000, () => req.destroy(new Error('token exchange timed out')))
    req.on('error', reject)
  })
}

/**
 * Full protocol session: cookie auth, unary RPC, one mux socket with logical
 * streams, and the event bus the extension listens on (`mux` / `host` / `up` / `down`).
 */
class DshClient {
  constructor({ baseUrl, log = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.log = log
    this.listeners = { mux: [], host: [], down: [], up: [] }
    this.cookie = null
    this.socket = null
    this.streams = new Map()
    this.streamSeq = 0
    this.closed = false
    this.clientId = null
    this.workspace = null          // { items, archivedSessionIds } from workspace/follow
    this.cursors = new Map()       // sessionId → last committed seq (from follow snapshots)
    this.follows = new Map()       // sessionId → RemoteStream
    this.events = new Map()        // approval/question id → { clientId, eventId }
  }

  on(event, cb) { (this.listeners[event] = this.listeners[event] || []).push(cb); return cb }
  off(event, cb) { const l = this.listeners[event]; if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1) } }
  emit(event, payload) { for (const cb of this.listeners[event] || []) { try { cb(payload) } catch (e) { this.log('[client] listener error', e.message) } } }

  // ── auth ───────────────────────────────────────────────────────────────────
  setCookie(cookie) { this.cookie = cookie || null }
  authHeaders() { return this.cookie ? { cookie: this.cookie } : {} }

  /**
   * Exchange a launch token for the browser-session cookie. The token is
   * printed per server process (`dsh web: http://…/?token=…`); the cookie it
   * yields is bound to this authority and survives restarts (its HMAC secret
   * lives in the credentials store), so it only has to be minted once.
   */
  async authenticate(token) {
    const res = await tokenExchange(this.baseUrl, token)
    const setCookie = res.setCookie
    if (!setCookie) {
      throw new RpcError('auth', 'token exchange returned no cookie (http ' + res.status
        + (res.body ? ' ' + JSON.stringify(res.body) : '') + ')')
    }
    this.cookie = setCookie.split(';')[0]
    this.log('[auth] cookie acquired (' + this.cookie.split('=')[0] + ')')
    return this.cookie
  }

  // ── unary ──────────────────────────────────────────────────────────────────
  async call(endpoint, args) {
    const rpcId = 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const res = await httpRequest(this.baseUrl + '/api/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: jsonBody({ type: 'client-request', rpcId, method: endpoint, payload: { args: args || {} } }),
    })
    if (res.status === 401) throw new RpcError('unauthorized', endpoint + ': not authenticated (401)')
    let body
    try { body = JSON.parse(res.text) } catch {
      throw new RpcError('transport', endpoint + ': non-JSON response (http ' + res.status + ')')
    }
    if (body.type !== 'server-response') throw new RpcError('transport', endpoint + ': unexpected envelope ' + String(body.type))
    const result = body.result
    if (!result || result.ok !== true) {
      const e = (result && result.error) || {}
      throw new RpcError(e.code || 'rpc-error', e.message || endpoint + ' failed', e.details)
    }
    return result.value
  }

  /** Internal-name request: maps to `<ns>/<method>` + named args (0.1.6 wire). */
  async request(name, payload = {}) {
    if (name === 'workspace.list') return this.workspaceList()
    if (name === 'session.history') return this.history(payload)
    const spec = ENDPOINTS[name]
    if (!spec) throw new RpcError('unsupported', 'no 0.1.6 mapping for ' + name)
    const value = await this.call(spec[0], spec[1](payload))
    return spec[2] ? spec[2](value) : value
  }

  /**
   * Workspace rows + archive set. 0.1.6 dropped the unary `workspace.list`;
   * the facts arrive as the `workspace/follow` baseline. Refusing (instead of
   * answering empty) matters: the caller treats an empty archive set as
   * "nothing is archived", which would resurrect archived conversations.
   */
  async workspaceList() {
    if (this.workspace) return this.workspace
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !this.closed) {
      await new Promise((r) => setTimeout(r, 100))
      if (this.workspace) return this.workspace
    }
    throw new RpcError('workspace-unavailable', 'workspace baseline not received yet')
  }

  // ── streams ────────────────────────────────────────────────────────────────
  /** Open one logical stream on the mux. Returns the handle (call .close()). */
  openStream(endpoint, args, handlers) {
    const stream = new RemoteStream(this, endpoint, args, handlers)
    this.streams.set(stream.id, stream)
    if (this.socket) stream.openOn(this.socket)
    return stream
  }

  /**
   * Follow one Session: the opening snapshot resolves this call, everything
   * after it is forwarded to the webview as the frames it already understands.
   */
  history(payload) {
    const sessionId = payload.sessionId
    if (payload.beforeSeq !== undefined) {
      // Scrollback: page strictly below the known cursor.
      return this.call('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: this.cursors.get(sessionId) ?? 0,
          beforeSeq: payload.beforeSeq,
          maxMessages: payload.maxMessages || 40,
        },
      }).then((value) => ({ events: value.records || [], hasMore: !!value.hasMore }))
    }
    const existing = this.follows.get(sessionId)
    if (existing && !existing.closed) existing.close()
    // 同一时刻只跟一个会话:切走之后旧 follow 还挂着,它的帧会一直被推过来、服务端
    // 也一直在为它序列化 —— 访问过的会话越多,这份开销只增不减。
    for (const [id, other] of this.follows) {
      if (id !== sessionId && !other.closed) other.close()
    }
    return new Promise((resolve, reject) => {
      let settled = false
      // 连接掉了也必须给这次"打开"一个交代:onClose/onError 只 emit down,不会 settle
      // 这个 Promise —— 否则点开会话会永远悬着,面板既没有新会话也不报错。
      const onDown = () => {
        if (settled) return
        settled = true
        this.off('down', onDown)
        reject(new RpcError('stream', 'mux socket closed while opening the session'))
      }
      this.on('down', onDown)
      const stream = this.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, assistantStream: true },
      }, {
        onItem: (frame) => {
          if (!frame || frame.type !== 'assistant-stream') this.log('[follow]', sessionId.slice(0, 18), frame && frame.type)
          if (!frame || typeof frame !== 'object') return
          if (frame.type === 'snapshot') {
            const cursor = typeof frame.cursor === 'number' ? frame.cursor : 0
            this.cursors.set(sessionId, cursor)
            this.emit('mux', { type: 'session/subscribed', sessionId, lastSeq: cursor })
            const values = (frame.projections && frame.projections.values) || {}
            for (const [key, value] of Object.entries(values)) {
              this.emit('mux', { type: 'session/projection', sessionId, key, value, seq: cursor })
            }
            if (!settled) {
              settled = true
              this.off('down', onDown)
              resolve({ events: frame.records || [], hasMore: !!frame.hasMore, projections: frame.projections || null })
            }
            return
          }
          if (frame.type === 'assistant-stream') {
            this.emit('mux', { type: 'session/assistant-stream', sessionId, frame: frame.frame || frame })
            return
          }
          const event = frame.event || frame
          if (event && event.type) {
            if (typeof event.seq === 'number') this.cursors.set(sessionId, event.seq)
            this.emit('mux', { type: 'session/event', sessionId, event })
          }
        },
        onError: (error) => { if (!settled) { settled = true; this.off('down', onDown); reject(new RpcError('stream', 'session/follow failed: ' + jsonBody(error))) } },
        onEnd: () => { if (!settled) { settled = true; this.off('down', onDown); reject(new RpcError('stream', 'session/follow ended before its snapshot')) } },
      })
      this.follows.set(sessionId, stream)
    })
  }

  /**
   * Stop following one Session (the panel closed it). Without this the follow stream
   * stays subscribed for the life of the connection, pushing frames nobody renders.
   * @param sessionId - session whose follow should be cancelled.
   */
  closeFollow(sessionId) {
    const stream = this.follows.get(sessionId)
    if (stream && !stream.closed) stream.close()
    this.follows.delete(sessionId)
  }

  /** Answer a pending host→client waterfall (approval/question) via $events/result. */
  async answer(eventId, value) {
    const entry = this.events.get(eventId)
    if (!entry) throw new RpcError('no-pending-event', 'no pending event ' + String(eventId))
    const result = await this.call('$events/result', {
      clientId: entry.clientId, eventId: entry.eventId, outcome: { kind: 'result', value },
    })
    this.events.delete(eventId)
    return result
  }

  /** Legacy shim: the old code answered by rpcId; ids are the same map keys here. */
  respond(rpcId, value) { return this.answer(rpcId, value) }

  // ── socket ─────────────────────────────────────────────────────────────────
  open() {
    this.close()
    this.closed = false
    const url = this.baseUrl.replace(/^http/, 'ws') + MUX_PATH
    const socket = new SimpleWebSocket(url, { headers: this.authHeaders() })
    this.socket = socket
    socket.open({
      onOpen: () => {
        this.log('[mux] connected')
        this.emit('up', { stream: 'mux' })
        for (const stream of this.streams.values()) stream.openOn(socket)
      },
      onMessage: (raw) => this.onMuxMessage(raw),
      // Both logical streams die with the one socket, so both must report down —
      // otherwise a reconnect leaves the host stream marked live forever.
      onError: (e) => {
        this.hostLive = false
        this.log('[mux] error', e && e.message)
        this.emit('down', { stream: 'mux', error: { code: (e && e.code) || 'ws-error' } })
        this.emit('down', { stream: 'host', error: { code: (e && e.code) || 'ws-error' } })
      },
      onClose: () => {
        this.hostLive = false
        this.log('[mux] closed')
        this.emit('down', { stream: 'mux', error: { code: 'ws-close' } })
        this.emit('down', { stream: 'host', error: { code: 'ws-close' } })
      },
    })
    // Workspace facts (rows + archive set) and the host event stream.
    this.openStream('workspace/follow', {}, {
      onItem: (frame) => this.onWorkspaceFrame(frame),
      onError: (error) => this.log('[workspace] error', jsonBody(error)),
    })
    this.openStream('$events', {}, {
      onItem: (frame) => this.onHostEvent(frame),
      onError: (error) => this.log('[$events] error', jsonBody(error)),
    })
  }

  onMuxMessage(raw) {
    if (typeof raw !== 'string') return
    let message
    try { message = JSON.parse(raw) } catch (e) { this.log('[mux] bad frame', e.message); return }
    // Assistant chunks arrive dozens per second; logging them buried every real
    // error in the output channel, so only frame kinds that change state show.
    if (!(message.type === 'item' && message.value && message.value.type === 'assistant-stream')) {
      this.log('[mux] <-', message.type, message.streamId || '')
    }
    const stream = this.streams.get(message.streamId)
    if (!stream) return
    if (message.type === 'item') stream.item(message.value)
    else if (message.type === 'end') stream.end()
    else if (message.type === 'error') stream.fail(message.error)
  }

  onWorkspaceFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    const archived = deepFind(frame, 'archivedSessionIds')
    const items = deepFind(frame, 'items')
    if (Array.isArray(items) || Array.isArray(archived)) {
      this.workspace = {
        items: Array.isArray(items) ? items : (this.workspace ? this.workspace.items : []),
        archivedSessionIds: Array.isArray(archived) ? archived : (this.workspace ? this.workspace.archivedSessionIds : []),
      }
    }
    this.emit('host', { type: 'host/workspace-changed' })
    if (Array.isArray(archived)) this.emit('host', { type: 'host/archived-sessions-changed', archivedSessionIds: archived })
  }

  /** Host→client events: approval/question waterfalls and forwarded notifications. */
  onHostEvent(frame) {
    if (!frame || typeof frame !== 'object') return
    // The $events stream is the "host" half of the connection. Nothing used to
    // report it up, so the panel's connected = muxUp && hostUp stayed false and
    // its yellow "connecting" banner never cleared. The first frame — normally
    // the opening {type:'ready'} — proves the stream is live.
    if (!this.hostLive) {
      this.hostLive = true
      this.emit('up', { stream: 'host' })
    }
    if (frame.type === 'ready') { this.clientId = frame.clientId; this.log('[$events] ready'); return }
    if (frame.type === 'cancel') {
      for (const [id, entry] of this.events) { if (entry.eventId === frame.eventId) this.events.delete(id) }
      return
    }
    // Plain emits carry args and want NO answer — treating them as waterfalls (the
    // old branch) registered a bogus pending entry under an undefined id and threw
    // the payload away, which is why the drawer's running dot never moved.
    if (frame.type === 'emit') {
      const args = Array.isArray(frame.args) ? frame.args : []
      const first = args[0]
      if (frame.event === 'api-session/status') {
        this.emit('host', { type: 'host/session-status', sessionId: first, running: args[1] === true })
        return
      }
      if (frame.event === 'api-session/added') {
        const summary = (first && typeof first === 'object') ? first : {}
        this.emit('host', { type: 'host/session-added', sessionId: summary.sessionId || null, summary })
        return
      }
      if (frame.event === 'api-session/removed') {
        this.emit('host', { type: 'host/session-removed', sessionId: first })
        return
      }
      if (frame.event === 'api-session/activity') {
        this.emit('host', { type: 'host/session-activity', sessionId: first, updatedAt: args[1] })
        return
      }
      this.emit('host', {
        type: 'host/remote-event', event: frame.event, args, sessionId: typeof first === 'string' ? first : null,
      })
      return
    }
    if (frame.type === 'waterfall') {
      const request = frame.request || {}
      const id = request.id || request.approvalId || request.questionId || frame.eventId
      this.events.set(id, { clientId: this.clientId, eventId: frame.eventId })
      const sessionId = frame.agentId || request.sessionId || null
      if (frame.event === 'approval/request') {
        this.emit('mux', { type: 'approval/requested', sessionId, approvalId: id, rpcId: frame.eventId, toolName: request.toolName, reason: request.reason })
      } else if (frame.event === 'user-questions/request' || frame.event === 'question/request') {
        // 0.1.6 registers the waterfall as 'user-questions/request'; the old
        // 'question/request' name meant the sidebar never rendered the card.
        this.emit('mux', { type: 'question/requested', sessionId, rpcId: frame.eventId, questions: request.questions || [] })
      } else {
        this.emit('host', { type: 'host/remote-event', event: frame.event, request, sessionId })
      }
      return
    }
    this.emit('host', { type: 'host/remote-event', event: frame.event || frame.type, frame })
  }

  close() {
    this.closed = true
    for (const stream of [...this.streams.values()]) stream.close()
    this.streams.clear()
    this.follows.clear()
    if (this.socket) { try { this.socket.close(1000) } catch {} this.socket = null }
  }
}

module.exports = { DshClient, call, RpcError, MUX_PATH, ENDPOINTS, deepFind }
