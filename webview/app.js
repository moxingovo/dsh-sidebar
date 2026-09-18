'use strict'
// DSH native sidebar front-end (Claude Code style, 100% VS Code theme vars).
// Talks to the extension host via postMessage; all server I/O goes through
// the host (path B: webview ↔ extension.js ↔ dsh service on 3080).
// Wire semantics per src/protocol.js (rc.5 contract).
;(() => {
  const vscode = acquireVsCodeApi()
  const $ = (sel) => document.querySelector(sel)
  const md = window.DshMarkdown
  const S = {
    conn: 'connecting',
    server: { state: 'idle', label: '', error: '' },
    wsPath: null,
    describe: null,
    config: null,
    dshHome: null,
    sessions: [],
    archived: new Set(),
    openId: null,
    open: null,
    pending: new Map(),      // rpcId -> { kind, sessionId, payload }
    settingsOpen: false,
    timelineOpen: false,
    lastSessionId: null,
    needScroll: true,
    pill: {},
    silentCommand: false,
    lastPick: null,
    pendingPill: null,
  }
  const fmtTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }
    return (d.getMonth() + 1) + '/' + d.getDate()
  }
  const fmtNum = (n) => {
    if (n === undefined || n === null) return '–'
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k'
    return String(n)
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }
  function post(msg) { vscode.postMessage(msg) }
  function esc(s) { return md.escapeHtml(s) }

  function bootSkeleton() {
    const app = $('#app')
    clear(app)
    const root = el('div', 'dsh-root')
    // Claude Code 风格布局:顶部细条 + 消息区 + 底部圆角输入 + 药丸选择器
    root.innerHTML =
      '<header class="dsh-header">' +
      '  <div class="brand" title="DeepSeek Harness">&#10035; DSH <span class="brand-ver">v0.4.2</span></div>' +
      '  <div class="hdr-actions">' +
      '    <button class="iconbtn" id="btnSessions" title="会话列表">&#9776;</button>' +
      '    <button class="iconbtn" id="btnNewSession" title="新会话">&#10010;</button>' +
      '    <button class="iconbtn" id="btnSettings" title="设置">&#9881;</button>' +
      '    <button class="iconbtn" id="btnCollapse" title="收起面板">&#187;</button>' +
      '  </div>' +
      '</header>' +
      '<section class="dsh-sessionbar" hidden>' +
      '  <div class="sb-head"><span class="sb-title">会话</span><span class="sb-count"></span><button class="sb-toggle" title="展开/折叠会话列表">&#9662;</button></div>' +
      '  <div class="sb-list"></div>' +
      '</section>' +
      '<main class="dsh-main">' +
      '  <div class="dsh-banner" hidden></div>' +
      '  <div class="dsh-messages"></div>' +
      '  <div class="dsh-empty" hidden></div>' +
      '  <div class="dsh-composer">' +
      '    <div class="composer-card">' +
      '      <div class="attach-tray" hidden></div>' +
      '      <textarea class="dsh-input" rows="1" placeholder="输入消息,Enter 发送,Shift+Enter 换行"></textarea>' +
      '      <div class="composer-row">' +
      '        <div class="cc-left">' +
      '          <div class="hdr-selects">' +
      '            <button class="hdr-sel pill" id="permPill" title="沙箱权限"></button>' +
      '            <button class="hdr-sel pill" id="modelPill" title="模型"></button>' +
      '            <button class="hdr-sel pill" id="effortPill" title="推理档位"></button>' +
      '            <button class="hdr-sel pill" id="presetPill" title="预设(仅空白会话可切换)"></button>' +
      '          </div>' +
      '          <button class="iconbtn compact-btn" id="btnCompact" title="压缩会话">压缩</button>' +
      '        </div>' +
      '        <div class="cc-right">' +
      '          <div class="context-meter">' +
      '            <button class="cm-ring" id="cmRing" title="上下文占用"><svg viewBox="0 0 14 14" width="15" height="15"><circle class="cm-track" cx="7" cy="7" r="5.5"/><circle class="cm-arc" cx="7" cy="7" r="5.5" transform="rotate(-90 7 7)"/></svg></button>' +
      '            <div class="cm-panel" hidden></div>' +
      '          </div>' +
      '          <button class="sendbtn" id="btnSend" title="发送">&#8593;</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</main>' +
      '<aside class="dsh-settings" hidden></aside>'
    app.appendChild(root)
    const sbToggle = $('.sb-toggle')
    if (sbToggle) sbToggle.addEventListener('click', () => closeSessionBar())
    bindHeader()
    bindComposer()
    // 面板每 2 秒静默同步一次服务端模型状态(selectModel 无推送帧,只能短轮询)
    setInterval(() => { if (S.openId) post({ type: 'refreshModels', sessionId: S.openId }) }, 2000)
  }

  // ── harness 风格药丸菜单(替代原生 select 下拉) ──────────────────────────
  let menuEl = null
  function closePillMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null }
  }
  function pillMenu(anchor, items, onPick) {
    closePillMenu()
    const menu = el('div', 'pill-menu')
    for (const it of items) {
      const row = el('button', 'pill-item' + (it.checked ? ' checked' : ''))
      row.appendChild(el('span', 'pill-check', it.checked ? '✓' : ''))
      row.appendChild(el('span', 'pill-label', it.label))
      row.appendChild(el('span', 'pill-meta', it.meta || ''))
      row.addEventListener('click', () => {
        closePillMenu()
        if (it.value !== undefined) onPick(it.value, it)
      })
      menu.appendChild(row)
    }
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 200)) + 'px'
    menu.style.top = Math.min(r.bottom + 3, window.innerHeight - menu.scrollHeight - 8) + 'px'
    menuEl = menu
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== anchor) {
        closePillMenu()
        document.removeEventListener('pointerdown', close)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', close), 0)
    return menu
  }
  function permCurrentLabel() {
    const o = S.open
    const sel = o && o.permissions
    if (sel && sel.currentValue) return '权限:' + permName(sel.currentValue)
    return '权限:—'
  }

  function noSessionMenu(anchor, label) {
    pillMenu(anchor, [
      { label: '还没有打开会话', meta: '药丸作用于当前打开的会话', value: undefined },
      { label: '＋ 新建会话并继续', meta: '建在当前工作区', value: 'create' },
    ], (v) => {
      if (v === 'create') {
        S.pendingPill = label
        post({ type: 'createSession', cwd: S.wsPath })
      }
    })
  }

  function buildModelMenu(anchor) {
    const o = S.open
    if (!o || !S.openId) return noSessionMenu(anchor, 'model')
    const list = o.modelList || []
    const cur = currentModel()
    if (!list.length) {
      pillMenu(anchor, [{ label: '模型列表不可用', value: undefined }], () => {})
      return
    }
    pillMenu(anchor, list.map((m, i) => ({
      label: m.name,
      meta: m.provider,
      value: i,
      checked: cur && cur.provider === m.provider && cur.model === m.model,
    })), (i) => {
      const m = list[i]
      if (!m) return
      S.lastPick = { kind: 'model', t0: Date.now() }
      // 立即乐观更新(服务端实测 25-70ms,但 UI 不应等待 ack 才反馈)
      if (S.open && S.open.models && S.open.models.current) {
        S.open.models.current = { provider: m.provider, model: m.model, reasoningEffort: cur ? cur.reasoningEffort : undefined }
      }
      renderHeaderSelects()
      if (S.open.busy) pushSystemRow('模型已切换:' + m.name + ' — 运行中,下一轮生效')
      // 切模型保持当前推理档(服务端默认档只在未指定时使用)
      post({ type: 'selectModel', sessionId: S.openId, provider: m.provider, model: m.model, reasoningEffort: cur ? cur.reasoningEffort : undefined })
    })
  }

  function buildEffortMenu(anchor) {
    const o = S.open
    if (!o || !S.openId) return noSessionMenu(anchor, 'effort')
    const cur = currentModel()
    if (!cur) return
    // 从模型列表条目取 reasoning.efforts(当前选中对象本身不含该字段)
    const entry = (o.modelList || []).find((x) => x.provider === cur.provider && x.model === cur.model)
    const efforts = (entry && entry.reasoning && entry.reasoning.efforts) || []
    if (!efforts.length) return
    pillMenu(anchor, efforts.map((ef) => ({
      label: ef.name || ef.id,
      value: ef.id,
      checked: cur.reasoningEffort === ef.id,
    })), (v) => {
      S.lastPick = { kind: 'effort', t0: Date.now() }
      // 立即乐观更新推理档
      if (cur) cur.reasoningEffort = v
      renderHeaderSelects()
      post({ type: 'selectModel', sessionId: S.openId, provider: cur.provider, model: cur.model, reasoningEffort: v })
    })
  }

  function permName(v) {
    const known = { 'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '完整访问' }
    if (known[v]) return known[v]
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) return v.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    return v
  }

  function buildPermMenu(anchor) {
    const o = S.open
    if (!o || !S.openId) return noSessionMenu(anchor, 'perm')
    const sel = o.permissions || null
    if (!sel || !sel.options || !sel.options.length) {
      pillMenu(anchor, [{ label: '权限预设不可用(该会话预设未装权限插件)', value: undefined }], () => {})
      return
    }
    pillMenu(anchor, sel.options.map((opt) => ({
      label: permName(opt.value) || opt.name,
      meta: opt.description || '',
      value: opt.value,
      checked: sel.currentValue === opt.value,
    })), (v) => {
      // 与 harness 一致:直接执行 /permission <preset>,投影推送回来即完成
      if (S.openId) {
        S.silentCommand = true
        post({ type: 'prompt', sessionId: S.openId, mode: 'queue', content: [{ type: 'text', text: '/permission ' + v }] })
      }
      renderHeaderSelects()
    })
  }

  function bindHeader() {
    $('#btnSessions').addEventListener('click', () => {
      const bar = sessionBar()
      if (bar) bar.hidden = !bar.hidden
    })
    $('#btnNewSession').addEventListener('click', () => post({ type: 'createSession', cwd: S.wsPath }))
    $('#btnSettings').addEventListener('click', () => { S.settingsOpen = !S.settingsOpen; renderSettings() })
    $('#btnCollapse').addEventListener('click', () => post({ type: 'collapse' }))
    $('#permPill').addEventListener('click', (e) => buildPermMenu(e.currentTarget))
    $('#modelPill').addEventListener('click', (e) => {
      // 立即用缓存打开菜单(零等待);后台刷新只更新药丸标签,不重建菜单
      buildModelMenu(e.currentTarget)
      post({ type: 'refreshModels', sessionId: S.openId })
    })
    $('#effortPill').addEventListener('click', (e) => {
      buildEffortMenu(e.currentTarget)
      post({ type: 'refreshModels', sessionId: S.openId })
    })
    $('#presetPill').addEventListener('click', (e) => {
      const o = S.open
      if (!o || !S.openId || !o.blank) return
      const presets = (o.presets.presets || [])
      pillMenu(e.currentTarget, presets.map((p) => ({
        label: p.name || p.id,
        meta: p.isDefault ? '默认' : '',
        value: p.id,
        checked: o.preset === p.id,
      })), (v) => {
        post({ type: 'selectPreset', sessionId: S.openId, agentPreset: v })
      })
    })
    const cmRing = $('#cmRing')
    if (cmRing) {
      cmRing.addEventListener('click', (e) => {
        e.stopPropagation()
        const panel = $('.cm-panel')
        if (!panel) return
        panel.hidden = !panel.hidden
      })
      document.addEventListener('pointerdown', (e) => {
        const meter = $('.context-meter')
        const panel = $('.cm-panel')
        if (meter && panel && !panel.hidden && !meter.contains(e.target)) panel.hidden = true
      })
    }
  }

  function bindComposer() {
    const input = $('.dsh-input')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        sendPrompt()
      }
    })
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(200, input.scrollHeight) + 'px'
    })
    $('#btnSend').addEventListener('click', () => {
      // 运行中点击 = 停止;空闲时点击 = 发送(harness 同款单按钮)
      if (S.open && S.open.busy) post({ type: 'cancel', sessionId: S.openId })
      else sendPrompt()
    })
    $('#btnCompact').addEventListener('click', () => post({ type: 'compact', sessionId: S.openId }))
    $('.dsh-messages').addEventListener('scroll', () => {
      const m = $('.dsh-messages')
      S.needScroll = m.scrollTop + m.clientHeight > m.scrollHeight - 60
    })
  }

  const attachments = []
  async function addAttachment(file) {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const mediaType = file.type || 'image/png'
    let data = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      data += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    const base64 = btoa(data)
    attachments.push({ type: 'image', mediaType, data: base64, name: file.name })
    const tray = $('.attach-tray')
    tray.hidden = false
    const chip = el('span', 'attach-chip', file.name)
    const x = el('button', 'chip-x', '×')
    x.addEventListener('click', () => {
      const i = attachments.findIndex((a) => a.name === file.name)
      if (i >= 0) attachments.splice(i, 1)
      chip.remove()
      if (!attachments.length) tray.hidden = true
    })
    chip.appendChild(x)
    tray.appendChild(chip)
  }

  function currentModel() {
    const o = S.open
    if (!o || !o.models) return null
    return o.models.current || null
  }
  function currentEffort() {
    const m = currentModel()
    return m && m.reasoningEffort ? m.reasoningEffort : undefined
  }
  function addRow(node) {
    const m = $('.dsh-messages')
    m.appendChild(node)
    if (S.needScroll) m.scrollTop = m.scrollHeight
  }

  // ── host messages ─────────────────────────────────────────────────────────
  window.addEventListener('message', (e) => handle(e.data || {}))

  function handle(m) {
    switch (m.type) {
      case 'hello':
        S.conn = 'connecting'
        S.bootTries = (S.bootTries || 0) + 1
        // 握手自愈:VS Code 可能丢弃 webview 就绪前推送的消息,收不到则重试
        scheduleWatchdog()
        break
      case 'workspace':
        S.wsPath = m.path
        break
      case 'describe':
        S.describe = m.describe
        S.config = m.config
        // 服务能回 describe 即说明在运行,修正可能错过的 serverState 推送
        if (!S.server.state || S.server.state === 'idle') S.server.state = 'attached'
        renderEmpty()
        renderBanner()
        break
      case 'connection':
        S.conn = m.state
        renderBanner()
        // 连接就绪后重新拉会话列表(修复时序竞态)
        if (m.state === 'connected') post({ type: 'listSessions' })
        break
      case 'serverState':
        S.server = { state: m.state, label: m.label, error: m.error || '' }
        renderBanner()
        break
      case 'sessionList':
        S.sessions = m.items || []
        S.archived = new Set(m.archivedIds || [])
        if (m.workspacePath) S.wsPath = m.workspacePath
        renderSessionList()
        // A2: 记住上次会话,自动恢复
        if (!S.openId && S.lastSessionId && S.conn === 'connected') {
          const it = workspaceSessions().find((s) => s.sessionId === S.lastSessionId)
          if (it) post({ type: 'openSession', sessionId: it.sessionId })
        }
        break
      case 'sessionCreated':
        post({ type: 'openSession', sessionId: m.sessionId })
        break
      case 'sessionOpened':
        openSessionView(m)
        // 无会话时点药丸选了"新建会话并继续":建完自动打开对应菜单
        if (S.pendingPill) {
          const kind = S.pendingPill
          S.pendingPill = null
          setTimeout(() => {
            const anchor = kind === 'model' ? $('#modelPill') : kind === 'effort' ? $('#effortPill') : $('#permPill')
            if (!anchor) return
            if (kind === 'model') buildModelMenu(anchor)
            else if (kind === 'effort') buildEffortMenu(anchor)
            else buildPermMenu(anchor)
          }, 80)
        }
        break
      case 'historyPage':
        prependHistory(m)
        break
      case 'sessionClosed':
        if (S.openId === m.sessionId) { S.openId = null; S.open = null; renderAll() }
        break
      case 'frame':
        try { onFrame(m.kind, m.frame) } catch (err) { console.error('[frame-error]', err && err.stack || err) }
        break
      case 'promptAccepted':
        // 药丸触发的计划模式切换走静默通道:不渲染任何命令行/结果行
        if (m.command && m.command.text && !S.silentCommand) pushSystemRow(m.command.text)
        S.silentCommand = false
        break
      case 'cancelled':
        pushSystemRow('已停止')
        break
      case 'modelSelected':
        if (S.open && S.open.models) S.open.models.current = m.selected
        if (S.lastPick && (S.lastPick.kind === 'model' || S.lastPick.kind === 'effort')) {
          const ms = Date.now() - S.lastPick.t0
          S.lastPick = null
          if (ms > 800) pushSystemRow('切换耗时 ' + ms + 'ms(异常,超过 800ms)')
        }
        renderHeaderSelects()
        break
      case 'modelsRefreshed':
        if (S.open && S.openId === m.sessionId) {
          S.open.models = m.models
          S.open.modelList = flatModels(m.models)
          renderHeaderSelects()
          // 绝不重建已打开的菜单:替换菜单会吞掉用户进行中的点击
          S.menuKind = null
        }
        break
      case 'presetSelected':
        if (S.open) S.open.preset = m.agentPreset
        renderHeaderSelects()
        break
      case 'sessionRenamed':
        {
          const item = S.sessions.find((s) => s.sessionId === m.sessionId)
          if (item) { item.title = m.title; renderSessionList() }
          if (S.openId === m.sessionId) pushSystemRow('已重命名为「' + m.title + '」')
        }
        break
      case 'sessionArchived':
        S.archived = new Set(m.archivedIds || [])
        removeSessionRow(m.sessionId)
        break
      case 'sessionForked':
        post({ type: 'openSession', sessionId: m.sessionId })
        break
      case 'settings':
        S.config = m.config
        S.dshHome = m.dshHome
        renderSettings()
        break
      case 'error':
        pushSystemRow('错误: ' + m.message)
        break
      case 'reload':
        post({ type: 'boot' })
        break
      case 'configChanged':
        S.config = m.config
        break
      case 'lastSession':
        S.lastSessionId = m.sessionId || null
        if (S.lastSessionId && !S.openId) {
          const it = workspaceSessions().find((s) => s.sessionId === S.lastSessionId)
          if (it) post({ type: 'openSession', sessionId: it.sessionId })
        }
        break
      default:
        return
    }
  }
  // ── session list (A5 仅当前工作区 + A3 最近活动降序) ──────────────────────
  /** The session drawer; absent only before the skeleton boots. */
  function sessionBar() { return $('.dsh-sessionbar') }

  /**
   * Close the session drawer. Picking a conversation is a navigation act, so the
   * drawer must not stay覆盖 the chat it just opened — it used to stay open and
   * the user had to dismiss it by hand after every switch.
   */
  function closeSessionBar() {
    const bar = sessionBar()
    if (bar) bar.hidden = true
  }

  function workspaceSessions() {
    const pathNorm = (p) => p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : p
    const ws = pathNorm(S.wsPath)
    let items = S.sessions.filter((s) => !S.archived.has(s.sessionId))
    if (!S.showAllSessions && ws && S.wsPath) items = items.filter((s) => pathNorm(s.cwd) === ws)
    items = items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return items
  }

  function renderSessionList() {
    const list = $('.sb-list')
    clear(list)
    const items = workspaceSessions()
    $('.sb-count').textContent = String(items.length)
    if (!items.length) {
      const none = el('div', 'sb-empty')
      none.appendChild(el('span', '', S.sessions.length && S.wsPath && !S.showAllSessions ? '本工作区暂无会话(其他工作区共 ' + S.sessions.length + ' 个)' : S.wsPath ? '本工作区还没有会话' : '没有会话(未打开工作区)'))
      if (S.sessions.length && S.wsPath && !S.showAllSessions) {
        const showAll = el('button', 'act-btn', '显示全部')
        showAll.addEventListener('click', () => { S.showAllSessions = true; renderSessionList() })
        none.appendChild(showAll)
      }
      list.appendChild(none)
      return
    }
    for (const it of items) {
      const row = el('div', 'sb-row' + (it.sessionId === S.openId ? ' active' : ''))
      row.title = (it.cwd || '') + ' · ' + it.sessionId
      const projTitle = it.projections && it.projections.values && it.projections.values.title
      const title = it.sessionId === S.openId && S.open && S.open.title ? S.open.title : (projTitle || it.title || it.name)
      const head = el('div', 'sb-titleline')
      const name = el('span', 'sb-name', title || '新会话' + (it.blank ? '' : ' (无标题)'))
      head.appendChild(name)
      if (it.running) head.appendChild(el('span', 'sb-dot running', '运行中'))
      row.appendChild(head)
      const sub = el('div', 'sb-subline')
      sub.appendChild(el('span', 'sb-time', fmtTime(it.updatedAt)))
      if (it.agentPreset) sub.appendChild(el('span', 'sb-chip', it.agentPreset))
      const count = el('span', 'sb-count-chip', it.messages ? String(it.messages) : '')
      if (it.messages) sub.appendChild(count)
      row.appendChild(sub)
      row.addEventListener('click', () => {
        // Close first: the drawer is a switcher, and leaving it open hides the
        // conversation the click just opened. Also closes when re-picking the
        // active row, which otherwise looked like a dead click.
        closeSessionBar()
        if (S.openId !== it.sessionId) post({ type: 'openSession', sessionId: it.sessionId })
      })
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showSessionMenu(e, it, row)
      })
      list.appendChild(row)
    }
  }

  // 行内重命名(替代被 VS Code webview 禁用的原生 prompt)
  function inlineRename(row, it) {
    const nameEl = row.querySelector('.sb-name')
    if (!nameEl) return
    const input = document.createElement('input')
    input.className = 'sb-rename-input'
    input.value = it.title || ''
    input.setAttribute('spellcheck', 'false')
    nameEl.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (save) => {
      if (done) return
      done = true
      const t = input.value.trim()
      if (input.parentNode) input.replaceWith(nameEl)
      if (save && t && t !== (it.title || '')) post({ type: 'renameSession', sessionId: it.sessionId, title: t })
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(false))
  }

  function showSessionMenu(e, it, row) {
    const menu = el('div', 'ctx-menu')
    const mk = (label, fn) => {
      const b = el('button', 'ctx-item', label)
      b.addEventListener('click', () => { menu.remove(); fn() })
      menu.appendChild(b)
      return b
    }
    mk('重命名', () => inlineRename(row, it))
    mk('归档', () => post({ type: 'archiveSession', sessionId: it.sessionId }))
    mk('派生新会话(fork)', () => post({ type: 'forkSession', sessionId: it.sessionId }))
    if (it.running) mk('停止', () => post({ type: 'cancel', sessionId: it.sessionId }))
    document.body.appendChild(menu)
    menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px'
    menu.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px'
    setTimeout(() => {
      const off = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off) } }
      document.addEventListener('click', off)
    }, 0)
  }

  function removeSessionRow(sessionId) {
    S.sessions = S.sessions.filter((s) => s.sessionId !== sessionId)
    renderSessionList()
  }

  // ── open session ──────────────────────────────────────────────────────────
  function openSessionView(m) {
    S.openId = m.sessionId
    S.open = {
      id: m.sessionId,
      rows: [],
      title: null,
      hasMore: m.hasMore,
      blank: m.blank,
      models: m.models,
      modelList: flatModels(m.models),
      presets: m.presets || { presets: [] },
      preset: null,
      projections: m.projections ? m.projections.values || {} : {},
      projectionAsOf: m.projections ? m.projections.asOfSeq : -1,
      permissions: (m.projections && m.projections.values && m.projections.values.permissions) || null,
      busy: false,
      queue: [],
      approvals: new Map(),
      timeline: [],
      stream: null,
      contextWindow: null,
    }
    // 预设直接取自会话列表项(session.list 每项带 agentPreset),不依赖历史事件窗口
    const listItem = S.sessions.find((s) => s.sessionId === m.sessionId)
    if (listItem && typeof listItem.agentPreset === 'string' && listItem.agentPreset) S.open.preset = listItem.agentPreset
    if (m.events.length > 400) {
      const cut = m.events.length - 400
      S.open.skipped = cut
      foldHistoryEvents(m.events.slice(cut))
    } else {
      S.open.skipped = 0
      foldHistoryEvents(m.events)
    }
    // 历史折叠可能落在 turn/start 之后(turn/end 被截断)——不要因此卡亮停止按钮;
    // 若会话确实在跑,后续 live 帧会重新置位 busy。
    S.open.busy = false
    renderAll()
    post({ type: 'lastSession', sessionId: m.sessionId })
  }

  function flatModels(models) {
    if (!models) return []
    const out = []
    for (const g of models.groups || []) {
      for (const mdl of g.models || []) {
        out.push({ provider: g.id, model: mdl.id, name: mdl.name || mdl.id, reasoning: mdl.reasoning || null })
      }
    }
    return out
  }

  function foldHistoryEvents(events) {
    if (!S.open) return
    const rows = S.open.rows
    for (const entry of events) {
      foldEvent(entry.event, entry.view, rows)
      // seq 在 event 内部(历史条目形状为 {event:{seq,...}})
      const seq = (entry.event && entry.event.seq) ?? entry.seq
      if (typeof seq === 'number' && seq > (S.open.lastAppliedSeq ?? -1)) S.open.lastAppliedSeq = seq
    }
    if (S.open.stream && S.open.stream.assistant) {
      finalizeStreamingAssistant(S.open.stream.assistant)
      S.open.stream = null
    }
  }

  function foldEvent(ev, view, rows) {
    const d = ev.data || {}
    const t = ev.type
    S.open.timeline.push({ seq: ev.seq, time: ev.time, type: t })
    switch (t) {
      case 'turn/start':
        S.open.busy = true
        S.open.stream = { turn: d.turn, assistant: null, blocks: new Map(), tools: new Map(), lastStep: 0 }
        break
      case 'turn/end':
        S.open.busy = false
        if (S.open.stream && S.open.stream.assistant) finalizeStreamingAssistant(S.open.stream.assistant)
        S.open.stream = null
        break
      case 'step/start':
        if (S.open.stream) S.open.stream.lastStep = d.step
        break
      case 'user/message': {
        const parts = partsOf(d.message && d.message.content)
        if (!parts.length) break // 空内容帧不渲染(服务端可能回放空帧)
        // 斜杠命令不渲染为消息:切换类操作(如 /plan)应表现为直接切换,
        // 其反馈由 plan/mode 徽标与命令结果行提供(harness 亦以命令芯片呈现)
        if (parts.length === 1 && parts[0].type === 'text' && /^\/\S/.test(String(parts[0].text || ''))) break
        rows.push({ kind: 'user', parts, ts: ev.time })
        break
      }
      case 'agent-preset/selected':
        if (d && typeof d.agentPreset === 'string' && d.agentPreset) {
          S.open.preset = d.agentPreset
          renderHeaderSelects()
        }
        break
      case 'assistant/chunk':
        foldChunk(d, rows)
        break
      case 'assistant/message': {
        const st = S.open.stream
        const content = d.message && d.message.content
        const row = st && st.assistant ? st.assistant : { kind: 'assistant', blocks: [], ts: ev.time }
        row.blocks = (content || []).filter((b) => b.type !== 'tool-call').map((b) => ({
          type: b.type === 'reasoning' ? 'reasoning' : 'text',
          text: typeof b.text === 'string' ? b.text : '',
        }))
        if (row._built) renderAssistantBlocks(row)
        if (!st || !st.assistant) rows.push(row)
        if (st) st.assistant = null
        break
      }
      case 'tool/call': {
        const id = d.callId
        const pending = S.open.stream && S.open.stream.tools.get(id)
        if (pending) {
          pending.name = d.name
          pending.args = d.arguments
          break
        }
        const row = { kind: 'tool', callId: id, name: d.name, args: d.arguments, status: 'running', resultText: '', dispatches: [], ts: ev.time, view: view || null }
        rows.push(row)
        break
      }
      case 'tool/result': {
        const callId = d.message && d.message.source && d.message.source.callId
        const row = findToolRow(rows, callId)
        if (row) {
          row.status = 'ok'
          row.resultText = resultTextOf(d.message && d.message.content)
          if (row._built) renderToolResult(row)
        }
        break
      }
      case 'tool/code-dispatch-start':
      case 'tool/code-dispatch': {
        const callId = d.rootCallId || d.parentCallId
        const row = findToolRow(rows, callId)
        if (row) {
          row.dispatches.push({
            name: d.name,
            path: pathOfArgs(d.arguments),
            preview: previewOf(d.content),
            isError: !!d.isError,
            content: contentTextOf(d.content),
          })
          if (row._built) renderToolDispatches(row)
        }
        break
      }
      case 'todo/write': {
        const items = (d.todos || d.items || d.tasks || []).map((it) => ({
          id: it.id || it.content || '',
          content: it.content || it.title || it.text || '',
          status: it.status || '',
        }))
        if (items.length) rows.push({ kind: 'todo', items, ts: ev.time })
        break
      }
      case 'approval/asked': {
        // rpcId 只出现在 server-request 帧（approval/requested）里，历史事件没有。
        // 仍把它建成一张「待应答」的卡片，等 mux 重放 approval/requested 时再由
        // applyApprovalRequest 补上 rpcId —— 否则点击按钮会带着 rpcId=undefined 回传，
        // 服务端按 rpcId 路由不到 pending 项，直接 not-pending。
        const askedId = approvalEventId(d)
        const existing = [...rows].reverse().find((r) => r.kind === 'approval' && r.approvalId === askedId)
        if (!existing) {
          rows.push({ kind: 'approval', approvalId: askedId, toolName: d.toolName || '', reason: d.reason || '', decided: false, outcome: null, ts: ev.time })
        }
        break
      }
      case 'approval/decided': {
        const decidedId = approvalEventId(d)
        const last = [...rows].reverse().find((r) => r.kind === 'approval' && r.approvalId === decidedId)
        if (last) { last.decided = true; last.outcome = d.outcome; refreshApprovalRow(last) }
        break
      }
      case 'compaction/summary':
        rows.push({ kind: 'system', text: '已压缩: ' + String(d.summary || d.text || '会话历史已压缩'), ts: ev.time })
        break
      case 'compaction/prune':
        rows.push({ kind: 'system', text: '已修剪工具结果(' + (d.shadowedToolResults ?? d.items ?? '?') + ')', ts: ev.time })
        break
      case 'compaction/start':
        rows.push({ kind: 'system', text: '开始压缩会话…', ts: ev.time })
        break
      case 'session/title':
        if (S.open) { S.open.title = d.title || null }
        break
      case 'plan/mode':
        rows.push({ kind: 'system', text: '计划模式: ' + (d.active ? '已开启' : '已关闭'), ts: ev.time })
        break
      case 'request/context':
        if (d && d.contextWindow) S.open.contextWindow = d.contextWindow
        break
      default:
        break
    }
  }

  function foldChunk(d, rows) {
    const st = S.open.stream
    if (!st) return
    const c = d.chunk || {}
    const index = c.index === undefined ? 0 : c.index
    if (c.type === 'block-start') {
      if (!st.assistant) {
        st.assistant = { kind: 'assistant', blocks: [], ts: Date.now(), _streamParts: new Map(), _built: false }
        rows.push(st.assistant)
      }
      st.lastBlockType = c.blockType
      st.blocks.set(index, { type: c.blockType === 'reasoning' ? 'reasoning' : c.blockType === 'tool-call' || c.blockType === 'tool' ? 'tool' : 'text', text: '', assembled: null })
      return
    }
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const b = st.blocks.get(index)
      if (b) { b.text += c.text; streamDelta(st, index, c.text, c.type === 'reasoning-delta' ? 'reasoning' : 'text') }
      return
    }
    if (c.type === 'tool-call-delta') {
      const b = st.blocks.get(index)
      if (b) { b.text += c.argumentsDelta || ''; b.toolId = c.id; b.toolName = c.name }
      return
    }
    if (c.type === 'block-end') {
      const block = c.block || {}
      const existing = st.blocks.get(index)
      if (block.type === 'tool-call' || block.type === 'tool') {
        const row = { kind: 'tool', callId: block.id, name: block.name, args: block.arguments, status: 'running', resultText: '', dispatches: [], ts: Date.now(), view: null }
        if (st.tools) st.tools.set(block.id, row)
        rows.push(row)
        st.blocks.delete(index)
        return
      }
      if (existing) {
        existing.assembled = block
        existing.text = typeof block.text === 'string' ? block.text : existing.text
        blockDone(st, index, existing)
      }
      return
    }
  }

  function findToolRow(rows, callId) {
    if (!callId) return null
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.kind === 'tool' && (r.callId === callId || (callId.startsWith(r.callId || '') && (callId.includes(':code:') || callId.startsWith(r.callId + ':'))))) return r
    }
    return null
  }

  function partsOf(content) {
    return (content || []).flatMap((b) => b.type === 'text' ? [{ type: 'text', text: b.text }] : b.type === 'image' ? [{ type: 'image', name: b.name || '图片', hasData: false }] : [])
  }
  function resultTextOf(content) {
    const txt = contentTextOf(content)
    return txt.length > 300 ? txt.slice(0, 300) + '…' : txt
  }
  function contentTextOf(content) {
    return (content || []).map((b) => (typeof b.text === 'string' ? b.text : b.type === 'tool-result' ? (b.content || []).map((x) => x.text || '').join('\\n') : '')).join('\\n')
  }
  function pathOfArgs(args) {
    if (typeof args === 'string') { try { const o = JSON.parse(args); return o.file_path || o.path || '' } catch { return '' } }
    return (args && args.file_path) || (args && args.path) || ''
  }
  function previewOf(content) {
    const t = contentTextOf(content)
    return t.length > 160 ? t.slice(0, 160) + '…' : t
  }
  // ── row rendering (live + history, theme-variable based) ──────────────────
  function renderRow(row) {
    let node = null
    switch (row.kind) {
      case 'user': {
        const wrap = el('div', 'msg user')
        const meta = el('div', 'msg-meta', '你')
        wrap.appendChild(meta)
        const body = el('div', 'msg-body')
        for (const p of row.parts || []) {
          if (p.type === 'text' && p.text) {
            const d = el('div', 'md', '')
            d.innerHTML = md.render(p.text)
            wireMd(d)
            body.appendChild(d)
          }
          if (p.type === 'image') body.appendChild(el('div', 'img-chip', '📷 ' + (p.name || '图片')))
        }
        wrap.appendChild(body)
        // 重新发送(预填编辑器编辑后发送,需求 v0.2-18 轻量实现)
        const act = el('div', 'msg-actions')
        const resend = el('button', 'act-btn', '重新发送')
        resend.title = '将这条消息填入输入框,编辑后按 Enter 重发'
        resend.addEventListener('click', () => {
          const text = (row.parts || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
          const input = $('.dsh-input')
          input.value = text
          input.focus()
          input.style.height = 'auto'
          input.style.height = Math.min(200, input.scrollHeight) + 'px'
        })
        act.appendChild(resend)
        wrap.appendChild(act)
        node = wrap
        break
      }
      case 'assistant':
        node = renderAssistant(row)
        break
      case 'tool':
        node = renderTool(row)
        break
      case 'todo':
        node = renderTodo(row)
        break
      case 'approval':
        node = renderApproval(row)
        break
      case 'system': {
        node = el('div', 'msg system')
        node.appendChild(el('div', 'md', row.text || ''))
        break
      }
      default:
        node = el('div', 'msg system', '')
    }
    row._built = true
    row._dom = node
    return node
  }

  function renderAssistant(row) {
    const wrap = el('div', 'msg assistant')
    const meta = el('div', 'msg-meta', 'DSH')
    wrap.appendChild(meta)
    const body = el('div', 'msg-body')
    wrap.appendChild(body)
    const act = el('div', 'msg-actions')
    const copy = el('button', 'act-btn', '复制')
    copy.addEventListener('click', () => {
      const text = (row.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')
      post({ type: 'copyText', text })
    })
    act.appendChild(copy)
    wrap.appendChild(act)
    row._body = body
    row._parts = new Map()
    row._streamNodes = new Map()
    renderAssistantBlocks(row)
    return wrap
  }

  function renderAssistantBlocks(row) {
    const body = row._body
    if (!body) return
    clear(body)
    row._parts = row._parts || new Map()
    row._parts.clear()
    for (const b of row.blocks) {
      if (b.type === 'tool') continue
      if (b.type === 'reasoning') {
        const det = el('details', 'reasoning')
        const sum = el('summary', '', shortText(b.text || '推理过程'))
        det.appendChild(sum)
        const inner = el('div', 'reasoning-content md', '')
        inner.innerHTML = md.render(b.text || '')
        wireMd(inner)
        det.appendChild(inner)
        body.appendChild(det)
      } else {
        const div = el('div', 'md textblock', '')
        div.innerHTML = md.render(b.text || '')
        wireMd(div)
        body.appendChild(div)
      }
    }
  }
  function shortText(t) {
    const s = String(t || '').replace(/\\s+/g, ' ').trim()
    return s.length > 90 ? s.slice(0, 90) + '…' : s
  }

  function renderTool(row) {
    const wrap = el('div', 'tool-card' + (row.status === 'running' ? ' running' : row.status === 'err' ? ' err' : ''))
    const head = el('div', 'tool-head')
    const icon = el('span', 'tool-icon', row.status === 'running' ? '⟳' : row.status === 'err' ? '✗' : '✓')
    head.appendChild(icon)
    head.appendChild(el('span', 'tool-name', row.name || (row.view && row.view.title) || '工具'))
    if (row.view && row.view.kind) head.appendChild(el('span', 'tool-kind', String(row.view.kind)))
    if (row.status === 'running') head.appendChild(el('span', 'tool-spin', '运行中…'))
    const toggle = el('button', 'tool-toggle', '详情')
    toggle.addEventListener('click', () => { wrap.classList.toggle('open') })
    head.appendChild(toggle)
    wrap.appendChild(head)
    const detail = el('div', 'tool-detail')
    detail.hidden = true
    const mdArgs = el('div', 'tool-args')
    mdArgs.textContent = prettyArgs(row)
    detail.appendChild(mdArgs)
    const disp = el('div', 'tool-dispatch')
    detail.appendChild(disp)
    const res = el('div', 'tool-result')
    detail.appendChild(res)
    wrap.appendChild(detail)
    row._detail = { wrap, detail, disp, res }
    renderToolDispatches(row)
    renderToolResult(row)
    return wrap
  }
  function prettyArgs(row) {
    let args = row.args
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch {}
    }
    if (typeof args === 'object' && args !== null) return JSON.stringify(args, null, 2)
    return String(args || '')
  }
  function renderToolDispatches(row) {
    const d = row._detail
    if (!d) return
    clear(d.disp)
    for (const entry of (row.dispatches || [])) {
      const line = el('div', 'dispatch-line' + (entry.isError ? ' err' : ''))
      const icon = el('span', 'disp-icon', entry.isError ? '✗' : '·')
      line.appendChild(icon)
      line.appendChild(el('span', 'disp-name', entry.name))
      if (entry.path) line.appendChild(el('span', 'disp-path', entry.path))
      line.title = entry.preview || entry.content || ''
      d.disp.appendChild(line)
    }
  }
  function renderToolResult(row) {
    const d = row._detail
    if (!d) return
    clear(d.res)
    if (row.status !== 'running' && row.resultText) {
      const pre = el('pre', 'result-text', row.resultText.length > 1200 ? row.resultText.slice(0, 1200) + '\\n…' : row.resultText)
      d.res.appendChild(pre)
    } else {
      d.res.textContent = ''
      if (row.status === 'running') d.res.textContent = 'tool result 尚未返回…'
    }
  }

  function renderTodo(row) {
    const wrap = el('div', 'todo-card')
    const head = el('div', 'todo-head', '任务清单')
    wrap.appendChild(head)
    const list = el('div', 'todo-items')
    for (const it of row.items || []) {
      const line = el('div', 'todo-item ' + (it.status || ''))
      const mark = el('span', 'todo-mark', it.status === 'completed' || it.status === 'done' ? '✓' : '○')
      line.appendChild(mark)
      line.appendChild(el('span', 'todo-text', it.content))
      list.appendChild(line)
    }
    wrap.appendChild(list)
    return wrap
  }

  /**
   * 权限请求的稳定 id。
   *
   * 会话日志里 approval/asked|decided 的 data 字段名是 **id**
   * （见 dsh user-approval：session.append('approval/asked', { id, toolName })），
   * 而 server-request 帧里叫 **approvalId**。之前回放一律读 d.approvalId 拿到 undefined，
   * 于是同一张卡片被建两次（去重匹配不上），且 approval/decided 也回填不上。
   */
  function approvalEventId(d) {
    if (!d) return undefined
    return d.id || d.approvalId
  }

  function renderApproval(row) {
    const wrap = el('div', 'approval-card')
    const head = el('div', 'approval-head')
    head.appendChild(el('span', 'approval-icon', '⚠'))
    head.appendChild(el('span', 'approval-title', '权限请求: ' + (row.toolName || '工具')))
    if (row.reason) head.appendChild(el('span', 'approval-reason', row.reason))
    wrap.appendChild(head)
    const body = el('div', 'approval-actions')
    if (row.decided) {
      body.appendChild(el('span', 'approval-outcome', '已' + (row.outcome === 'allowed-once' ? '允许' : '拒绝')))
    } else {
      const allow = el('button', 'btn success', '允许')
      allow.addEventListener('click', () => post({ type: 'approvalRespond', sessionId: S.openId, approvalId: row.approvalId, outcome: 'allowed-once', ...(row.rpcId ? { rpcId: row.rpcId } : {}) }))
      const deny = el('button', 'btn danger', '拒绝')
      deny.addEventListener('click', () => post({ type: 'approvalRespond', sessionId: S.openId, approvalId: row.approvalId, outcome: 'rejected', ...(row.rpcId ? { rpcId: row.rpcId } : {}) }))
      body.appendChild(allow)
      body.appendChild(deny)
    }
    wrap.appendChild(body)
    return wrap
  }

  function pushSystemRow(text) {
    if (!S.open) return
    const row = { kind: 'system', text, ts: Date.now() }
    S.open.rows.push(row)
    appendRow(row)
  }

  function appendRow(row) {
    const node = renderRow(row)
    addRow(node)
  }

  // ── live streaming DOM patching ───────────────────────────────────────────
  function streamDelta(st, index, deltaText, kind) {
    const a = st.assistant
    if (!a) return
    ensureStreamDom(a)
    let node = a._streamNodes && a._streamNodes.get(index)
    if (!node) {
      const holder = el(kind === 'reasoning' ? 'details' : 'div', kind === 'reasoning' ? 'reasoning streaming' : 'md textblock streaming')
      if (kind === 'reasoning') {
        const sum = el('summary', '', '推理中…')
        holder.appendChild(sum)
        const inner = el('div', 'reasoning-content')
        holder.appendChild(inner)
        a._body.appendChild(holder)
        a._streamNodes.set(index, { kind, node: inner, summary: sum, root: holder })
      } else {
        a._body.appendChild(holder)
        a._streamNodes.set(index, { kind, node: holder, root: holder })
      }
      node = a._streamNodes.get(index)
    }
    node.node.textContent += deltaText
    if (kind === 'reasoning' && node.summary && node.summary.textContent === '推理中…') {
      node.summary.textContent = shortText(node.node.textContent)
    }
    if (S.needScroll === undefined || S.needScroll) {
      const m = $('.dsh-messages')
      m.scrollTop = m.scrollHeight
    }
  }

  function blockDone(st, index, existing) {
    const a = st.assistant
    if (!a || !existing) return
    const node = a._streamNodes && a._streamNodes.get(index)
    const text = existing.text || ''
    if (existing.type === 'reasoning') {
      if (node) {
        node.node.innerHTML = md.render(text)
        wireMd(node.node)
        node.summary.textContent = shortText(text)
        node.root.classList.add('done')
      }
      a.blocks.push({ type: 'reasoning', text, _index: index })
      if (node) a._streamNodes.delete(index)
    } else if (existing.type === 'text') {
      if (node) {
        node.root.innerHTML = md.render(text)
        wireMd(node.root)
        node.root.classList.add('done')
      }
      a.blocks.push({ type: 'text', text, _index: index })
      if (node) a._streamNodes.delete(index)
    }
  }

  function finalizeStreamingAssistant(a) {
    if (!a) return
    if (a._streamNodes) {
      for (const [index, node] of a._streamNodes) {
        if (node.kind === 'reasoning') {
          node.node.innerHTML = md.render(node.node.textContent)
          wireMd(node.node)
          node.summary.textContent = shortText(node.node.textContent)
        } else {
          node.root.innerHTML = md.render(node.node.textContent)
          wireMd(node.root)
        }
      }
      a._streamNodes.clear()
    }
  }

  function ensureStreamDom(a) {
    if (!a._body) {
      const before = a._built
      const node = renderAssistant(a)
      if (!before) {
        const m = $('.dsh-messages')
        m.appendChild(node)
      }
      a._streamNodes = new Map()
      return
    }
    if (!a._streamNodes) a._streamNodes = new Map()
  }
  // ── live frames ───────────────────────────────────────────────────────────
  function onFrame(kind, frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'session/event' && frame.sessionId === S.openId) {
      applyLive(frame.event, frame.view)
      return
    }
    if (frame.type === 'session/projection' && frame.sessionId === S.openId) applyProjection(frame)
    if (frame.type === 'approval/requested' && frame.sessionId === S.openId) applyApprovalRequest(frame)
    if (frame.type === 'approval/resolved' && frame.sessionId === S.openId) applyApprovalResolved(frame)
    if (frame.type === 'question/requested' && frame.sessionId === S.openId) applyQuestionRequest(frame)
    if (frame.type === 'session/queue' && frame.sessionId === S.openId) applyQueue(frame)
    if (frame.type === 'session/subscribed' && frame.sessionId === S.openId && S.open) {
      const asOf = frame.lastSeq
      S.open.serveAsOf = asOf
      if ((S.open.lastAppliedSeq ?? -1) < asOf - 20) {
        post({ type: 'openSession', sessionId: S.openId })
      }
    }
    if (frame.type === 'host/session-status' && frame.sessionId === S.openId) {
      if (S.open) { S.open.busy = frame.running; renderSendState() }
    }
    if (frame.type === 'host/session-added' || frame.type === 'host/workspace-changed' || frame.type === 'host/archived-sessions-changed') {
      post({ type: 'listSessions' })
    }
    if (frame.type === 'host/session-removed') {
      S.sessions = S.sessions.filter((s) => s.sessionId !== frame.sessionId)
      renderSessionList()
    }
    if (frame.type === 'host/remote-event' && frame.event === 'agent-preset/selected') {
      const parts = frame.args || []
      if (parts[0] === S.openId) { S.open.preset = parts[1]; renderHeaderSelects() }
    }
  }

  function applyLive(ev, view) {
    const o = S.open
    if (!o) return
    // 按 seq 去重:历史已折叠或已处理过的事件不再重复应用(否则每条消息出现多条重复/空行)
    if (typeof ev.seq === 'number' && ev.seq <= (o.lastAppliedSeq ?? -1)) return
    S.open.lastAppliedSeq = o.lastAppliedSeq = ev.seq
    const beforeLen = o.rows.length
    foldEvent(ev, view || null, o.rows)
    for (let i = beforeLen; i < o.rows.length; i++) {
      appendRow(o.rows[i])
    }
    if (ev.type === 'turn/end') {
      renderSendState()
      renderContextMeter()
    }
    if (ev.type === 'assistant/message' || ev.type === 'user/message' || ev.type === 'turn/start' || ev.type === 'tool/result') {
      renderSendState()
      renderContextMeter()
    }
  }

  function applyProjection(frame) {
    const o = S.open
    if (!o) return
    if (o.projectionAsOf !== undefined && frame.seq <= (o.projectionAsOf ?? -1)) return
    o.projectionAsOf = frame.seq
    o.projections[frame.key] = frame.value
    if (frame.key === 'tokenUsage' || frame.key === 'contextPressure' || frame.key === 'contextBreakdown') renderContextMeter()
    if (frame.key === 'title' && typeof frame.value === 'string') {
      o.title = frame.value
      renderSessionList()
    }
    if (frame.key === 'permissions') { o.permissions = frame.value; renderHeaderSelects() }
    if (frame.key === 'imageLimits') { o.imageLimits = frame.value }
  }

  function applyApprovalRequest(frame) {
    const o = S.open
    if (!o) return
    o.pending = o.pending || new Map()
    o.pending.set(frame.approvalId, { kind: 'approval', rpcId: frame.rpcId, approvalId: frame.approvalId, toolName: frame.toolName, reason: frame.reason, sessionId: frame.sessionId })
    // 历史回放可能已经建过同一 approvalId 的卡片：补上 rpcId 并重绘，
    // 不要插第二张（两张卡片会各自持有一份状态，用户点哪张都不确定）。
    const existing = [...o.rows].reverse().find((r) => r.kind === 'approval' && r.approvalId === frame.approvalId)
    if (existing) {
      existing.rpcId = frame.rpcId
      existing.toolName = frame.toolName || existing.toolName
      existing.reason = frame.reason || existing.reason
      existing.live = true
      refreshApprovalRow(existing)
      return
    }
    const row = { kind: 'approval', approvalId: frame.approvalId, toolName: frame.toolName, reason: frame.reason || '', decided: false, outcome: null, ts: Date.now(), rpcId: frame.rpcId, live: true }
    o.rows.push(row)
    appendRow(row)
  }

  function applyApprovalResolved(frame) {
    const o = S.open
    if (!o) return
    const row = o.rows.slice().reverse().find((r) => r.kind === 'approval' && r.approvalId === frame.approvalId)
    if (row) {
      row.decided = true
      row.outcome = frame.outcome
      refreshApprovalRow(row)
    }
  }

  /**
   * 就地重绘一张 approval 卡片（状态变化后按钮/结果需要跟着变）。
   * 之前这里调用的是并不存在的 renderApprovalRow()，一旦命中就是 ReferenceError。
   */
  function refreshApprovalRow(row) {
    if (!row || !row._built || !row._dom || !row._dom.parentNode) return
    const fresh = renderApproval(row)
    row._dom.parentNode.replaceChild(fresh, row._dom)
    row._dom = fresh
  }

  function applyQuestionRequest(frame) {
    const o = S.open
    if (!o) return
    const q = frame.questions || []
    const wrap = el('div', 'question-card')
    wrap.appendChild(el('div', 'question-head', '需要你的回答'))
    q.forEach((item) => {
      const field = el('div', 'q-item')
      field.appendChild(el('div', 'q-text', item.question || ''))
      if (item.options && item.options.length) {
        const sel = document.createElement('select')
        const opt = el('option', '', '— 请选择 —')
        opt.value = ''
        sel.appendChild(opt)
        for (const op of item.options) { const oo = el('option', '', op.label + (op.description ? ' (' + op.description + ')' : '')); oo.value = op.label; sel.appendChild(oo) }
        field.appendChild(sel)
      } else {
        const ta = el('textarea', 'q-input')
        ta.placeholder = '输入回答…'
        field.appendChild(ta)
      }
      wrap.appendChild(field)
    })
    const submit = el('button', 'btn primary', '提交回答')
    submit.addEventListener('click', () => {
      const answers = []
      const fields = wrap.querySelectorAll('.q-item')
      fields.forEach((f, i) => {
        const qq = q[i]
        if (!qq) return
        const input = f.querySelector('textarea') || f.querySelector('select')
        const val = input && input.value
        if (val !== undefined && val !== '') answers.push({ id: qq.id, selected: [val] })
      })
      // 一个问题只能被「认领」一次：提交后立刻禁用，否则第二次点击必然收到
      // not-pending（服务端已把该 rpcId 从 pending 表移除），用户看到的就是那句莫名的报错。
      submit.disabled = true
      submit.textContent = '已提交'
      post({ type: 'questionAnswer', sessionId: S.openId, rpcId: frame.rpcId, answers })
    })
    wrap.appendChild(submit)
    const m = $('.dsh-messages')
    m.appendChild(wrap)
    if (S.needScroll) m.scrollTop = m.scrollHeight
  }

  function applyQueue(frame) {
    const o = S.open
    if (!o) return
    o.queue = frame.items || []
    renderQueue()
  }

  // ── composer / prompt ─────────────────────────────────────────────────────
  function sendPrompt() {
    const input = $('.dsh-input')
    const text = input.value.trim()
    if (!text && !attachments.length) return
    if (!S.openId) return
    const content = []
    if (text) content.push({ type: 'text', text })
    for (const a of attachments) content.push(a)
    const busy = S.open && S.open.busy
    post({ type: 'prompt', sessionId: S.openId, mode: busy ? 'steer' : 'queue', content })
    input.value = ''
    input.style.height = 'auto'
    attachments.length = 0
    const tray = $('.attach-tray')
    tray.hidden = true
    clear(tray)
    // 不做乐观回显:权威 user/message 事件经 mux 流到达后渲染(已按 seq 去重,避免重复/空气泡)
  }

  function renderSendState() {
    const send = $('#btnSend')
    if (!send) return
    const busy = S.open && S.open.busy
    send.classList.toggle('stop', !!busy)
    send.innerHTML = busy ? '&#9632;' : '&#8593;'
    send.title = busy ? '停止' : '发送'
    const input = $('.dsh-input')
    if (input) {
      if (busy) input.setAttribute('placeholder', '运行中:Enter 插入对话,点击 ■ 停止')
      else input.setAttribute('placeholder', '输入消息,Enter 发送,Shift+Enter 换行')
    }
  }

  function renderQueue() {
    const o = S.open
    const box = $('#dsh-queue')
    if (!box) return
    if (!o || !o.queue || !o.queue.length) { box.hidden = true; return }
    box.hidden = false
    clear(box)
    for (const item of o.queue) {
      const chip = el('div', 'queue-chip')
      const tag = el('span', 'queue-tag', item.placement === 'steer' ? '插入' : item.placement === 'context' ? '上下文' : '排队')
      chip.appendChild(tag)
      const txt = textOfMessage(item.message)
      chip.appendChild(el('span', 'queue-text', txt.length > 60 ? txt.slice(0, 60) + '…' : txt))
      box.appendChild(chip)
    }
  }
  function textOfMessage(message) {
    return (message && (message.text || (message.content || []).map((b) => b.text || '').join(' '))) || ''
  }

  // ── context meter (D1: 服务端 projections 优先,无则估算) ───────────────────
  function fmtTokens(n) {
    if (n === undefined || n === null) return '–'
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    return String(n)
  }

  function renderContextMeter() {
    const o = S.open
    const meter = $('.context-meter')
    if (!meter) return
    const arc = meter.querySelector('.cm-arc')
    const panel = meter.querySelector('.cm-panel')
    if (!arc || !panel) return
    if (!o) {
      arc.setAttribute('stroke-dasharray', '0 100')
      arc.classList.remove('warning', 'critical')
      meter.title = '上下文用量(打开会话后显示)'
      if (!panel.hidden) panel.hidden = true
      return
    }
    const p = o.projections || {}
    const pressure = p.contextPressure || {}
    const breakdown = p.contextBreakdown || null
    let tokens = pressure.pressureTokens
    let window = pressure.contextWindow || o.contextWindow
    if ((tokens === undefined || window === undefined) && p.tokenUsage) {
      const u = p.tokenUsage
      tokens = (u.uncachedInputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0)
    }
    if (tokens === undefined || !window) {
      arc.setAttribute('stroke-dasharray', '0 100')
      arc.classList.remove('warning', 'critical')
      meter.title = '上下文用量'
      return
    }
    const pct = Math.min(100, (tokens / window) * 100)
    const CIRC = 2 * Math.PI * 5.5
    arc.setAttribute('stroke-dasharray', (CIRC * pct / 100).toFixed(2) + ' ' + CIRC.toFixed(2))
    arc.classList.toggle('warning', pct > 70 && pct <= 90)
    arc.classList.toggle('critical', pct > 90)
    meter.title = '上下文已用 ' + pct.toFixed(0) + '%(~' + fmtTokens(tokens) + ' / ' + fmtTokens(window) + ')'
    const btn = $('#btnCompact')
    if (btn) btn.classList.toggle('urgent', pct > 90)
    // harness 同款展开面板:百分比 + 数字 + 三段拆分(系统/工具/消息)
    clear(panel)
    const head = el('div', 'cmp-head')
    head.appendChild(el('span', 'cmp-percent', pct.toFixed(0) + '%'))
    head.appendChild(el('span', 'cmp-figures', '~' + fmtTokens(tokens) + ' / ' + fmtTokens(window)))
    panel.appendChild(head)
    const bar = el('div', 'cmp-bar')
    const rows = [
      { key: 'systemTokens', label: '系统', cls: 'cmp-system' },
      { key: 'toolsTokens', label: '工具', cls: 'cmp-tools' },
      { key: 'messageTokens', label: '消息', cls: 'cmp-messages' },
    ]
    const bTotal = breakdown ? (breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens) : 0
    if (breakdown && bTotal > 0) {
      for (const r of rows) {
        const w = pct * (breakdown[r.key] || 0) / bTotal
        if (w > 0) {
          const seg = el('div', 'cmp-seg ' + r.cls)
          seg.style.width = w.toFixed(1) + '%'
          bar.appendChild(seg)
        }
      }
    } else {
      const seg = el('div', 'cmp-seg cmp-system')
      seg.style.width = pct.toFixed(1) + '%'
      bar.appendChild(seg)
    }
    panel.appendChild(bar)
    const dl = el('div', 'cmp-rows')
    for (const r of rows) {
      const row = el('div', 'cmp-row')
      const dt = el('span', 'cmp-label')
      dt.appendChild(el('span', 'cmp-swatch ' + r.cls))
      dt.appendChild(document.createTextNode(r.label))
      row.appendChild(dt)
      row.appendChild(el('span', 'cmp-val', '~' + fmtTokens(breakdown ? breakdown[r.key] : undefined)))
      dl.appendChild(row)
    }
    panel.appendChild(dl)
  }

  // ── header selects (模型/推理档/预设) ─────────────────────────────────────
  function presetName(id) {
    const o = S.open
    const p = o && (o.presets.presets || []).find((x) => x.id === id)
    return p ? (p.name || p.id) : (id || '—')
  }

  function renderHeaderSelects() {
    const perm = $('#permPill')
    const model = $('#modelPill')
    const effort = $('#effortPill')
    const preset = $('#presetPill')
    const o = S.open
    const setLabel = (pill, text) => { if (pill) pill.textContent = text }
    if (!o) {
      // 无会话也显示 harness 底栏元素;点按会提示"新建会话并继续",故保持可点
      const d0 = S.describe || {}
      setLabel(perm, '权限:—')
      perm.title = '先打开会话'
      setLabel(model, [d0.provider, d0.model].filter(Boolean).join(' / ') || '模型未连接')
      model.title = '点按可选择模型(无会话时会先引导新建)'
      setLabel(effort, d0.reasoningEffort ? '推理:' + d0.reasoningEffort : '推理:—')
      effort.title = '点按可选择推理档'
      setLabel(preset, '预设:—')
      preset.disabled = true
      return
    }
    const permAvail = !!(o.permissions && o.permissions.options && o.permissions.options.length)
    perm.disabled = !permAvail
    model.disabled = false
    effort.disabled = false
    setLabel(perm, permCurrentLabel())
    const list = o.modelList || []
    const cur = currentModel()
    if (cur) setLabel(model, cur.name || cur.model)
    else setLabel(model, list.length ? '选择模型' : '模型不可用')
    const m = cur && list.find((x) => x.provider === cur.provider && x.model === cur.model)
    const efforts = (m && m.reasoning && m.reasoning.efforts) || []
    const curEffort = cur && cur.reasoningEffort
    if (efforts.length) {
      const effName = (efforts.find((e2) => e2.id === curEffort) || efforts[0])
      setLabel(effort, '推理:' + (effName.name || effName.id))
    } else {
      setLabel(effort, '推理:—')
    }
    if (o.blank) {
      preset.disabled = false
      preset.title = '空白会话可切换预设'
      setLabel(preset, o.preset ? '预设:' + presetName(o.preset) : '新建会话选择预设…')
    } else {
      preset.disabled = true
      preset.title = '会话已开始,预设已固定(仅空白会话可切换)'
      setLabel(preset, '预设:' + presetName(o.preset))
    }
    renderContextMeter()
  }

  // ── banner / empty / settings / timeline ──────────────────────────────────
  function renderBanner() {
    const banner = $('.dsh-banner')
    if (!banner) return
    const bannerUp = S.server.state === 'attached' || S.server.state === 'ready'
    // 门控:拿到 describe 之后才可能判定"服务未运行";否则一律显示连接中
    if (bannerUp && S.conn === 'connected') { banner.hidden = true; return }
    banner.hidden = false
    clear(banner)
    const serverDown = S.describe !== null && !bannerUp
    if (serverDown) {
      banner.appendChild(el('span', 'banner-text', 'dsh 服务未运行(' + S.server.label + ')' + (S.server.error ? ': ' + S.server.error : '')))
      const open = el('button', 'btn', '打开浏览器')
      open.addEventListener('click', () => post({ type: 'openBrowser' }))
      banner.appendChild(open)
      const restart = el('button', 'btn', '重启服务')
      restart.addEventListener('click', () => post({ type: 'restartServer' }))
      banner.appendChild(restart)
      return
    }
    banner.appendChild(el('span', 'banner-text', '正在连接 dsh 服务…'))
    const retry = el('button', 'btn', '重试')
    retry.addEventListener('click', () => post({ type: 'boot' }))
    banner.appendChild(retry)
  }

  function renderEmpty() {
    const empty = $('.dsh-empty')
    if (!empty) return
    if (S.openId) { empty.hidden = true; return }
    empty.hidden = false
    clear(empty)
    // Claude Code 风格欢迎页(居中 logo + 标题 + 提示卡)
    const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    logo.setAttribute('viewBox', '0 0 24 24')
    logo.setAttribute('class', 'welcome-logo')
    const logoPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    logoPath.setAttribute('transform', 'translate(0.5 0.5) scale(0.46)')
    logoPath.setAttribute('fill', '#4D6BFE')
    logoPath.setAttribute('d', "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z")
    logo.appendChild(logoPath)
    empty.appendChild(logo)
    empty.appendChild(el('div', 'empty-title', 'DSH 助手'))
    const d = S.describe || {}
    empty.appendChild(el('div', 'empty-tagline', '当前 ' + (d.provider || '—') + ' / ' + (d.model || '—') + (d.version ? ' · 服务 v' + d.version : '')))
    const btn = el('button', 'btn primary', '新会话')
    btn.addEventListener('click', () => post({ type: 'createSession', cwd: S.wsPath }))
    empty.appendChild(btn)
  }

  function renderAll() {
    const o = S.open
    const msg = $('.dsh-messages')
    clear(msg)
    if (o && o.skipped > 0) {
      const note = el('div', 'msg system large-note', '已折叠较早的 ' + o.skipped + ' 条事件(大会话防卡)')
      msg.appendChild(note)
    }
    if (!o || !o.rows.length) {
      renderEmpty()
    } else {
      // 开会话且有消息:欢迎/空态必须隐藏(否则与消息列表同屏各占一半)
      const emptyEl = $('.dsh-empty')
      if (emptyEl) emptyEl.hidden = true
      msg.hidden = false
      for (const row of o.rows) msg.appendChild(renderRow(row))
      if (S.needScroll) msg.scrollTop = msg.scrollHeight
    }
    renderHeaderSelects()
    renderSendState()
    renderQueue()
    renderContextMeter()
    renderBanner()
    renderSessionList()
  }

  function prependHistory(m) {
    const o = S.open
    if (!o || m.sessionId !== o.id) return
    const rows = []
    const saved = o.rows
    o.rows = []
    for (const entry of m.events || []) {
      foldEvent(entry.event, entry.view, o.rows)
    }
    o.stream = null
    const newRows = o.rows
    o.rows = saved
    o.hasMore = m.hasMore
    const msg = $('.dsh-messages')
    if (m.hasMore) {
      const more = el('button', 'btn load-more', '加载更早消息')
      more.addEventListener('click', () => {
        const first = o.rows.find((r) => r._seq)
        post({ type: 'historyMore', sessionId: o.id, beforeSeq: (first && first._seq) || m.seq })
      })
      msg.insertBefore(more, msg.firstChild)
    }
    for (let i = newRows.length - 1; i >= 0; i--) {
      const node = renderRow(newRows[i])
      msg.insertBefore(node, msg.firstChild)
    }
    o.rows = newRows.concat(o.rows)
  }

  function renderTimelinePanel() {
    const o = S.open
    const banner = $('.dsh-banner')
    if (!banner) return
    if (!S.timelineOpen) { renderBanner(); return }
    banner.hidden = false
    clear(banner)
    const head = el('span', 'banner-text', '时间线(' + ((o && o.timeline.length) || 0) + ' 事件)')
    banner.appendChild(head)
    const closeBtn = el('button', 'btn', '关闭')
    closeBtn.addEventListener('click', () => { S.timelineOpen = false; renderBanner() })
    banner.appendChild(closeBtn)
    banner.title = (o ? o.timeline.slice(-40).map((t) => fmtTime(t.time) + ' ' + t.type).join('\\n') : '')
  }

  function renderSettings() {
    const aside = $('.dsh-settings')
    if (!aside) return
    aside.hidden = !S.settingsOpen
    if (!S.settingsOpen) return
    clear(aside)
    const h = el('div', 'settings-head', '设置')
    aside.appendChild(h)
    const close = el('button', 'iconbtn', '×')
    close.addEventListener('click', () => { S.settingsOpen = false; renderSettings() })
    h.appendChild(close)
    const c = S.config || {}
    const d = S.describe || {}
    const rows = [
      ['服务地址', 'http://127.0.0.1:' + (c.port ?? 3080)],
      ['端口', String(c.port ?? '–')],
      ['服务版本', d.version || '–'],
      ['主机目录(cwd)', d.cwd || '–'],
      ['当前模型', (d.provider || '') + ' / ' + (d.model || '–')],
      ['DSH_HOME', S.dshHome || '–'],
      ['attachExisting', String(c.attachExisting)],
      ['spawnIfMissing', String(c.spawnIfMissing)],
      ['followWorkspace', String(c.followWorkspace)],
      ['stopOnExit', String(c.stopOnExit)],
      ['autoOpen(展开侧边栏)', String(c.autoOpen)],
    ]
    for (const [k, v] of rows) {
      const line = el('div', 'set-row')
      line.appendChild(el('span', 'set-key', k))
      line.appendChild(el('span', 'set-val', v))
      aside.appendChild(line)
    }
    const btns = el('div', 'set-actions')
    const open = el('button', 'btn', '在浏览器中打开')
    open.addEventListener('click', () => post({ type: 'openBrowser' }))
    const reload = el('button', 'btn', '重载侧边栏')
    reload.addEventListener('click', () => post({ type: 'reload' }))
    const restart = el('button', 'btn', '重启服务(仅自启实例)')
    restart.addEventListener('click', () => post({ type: 'restartServer' }))
    btns.appendChild(open)
    btns.appendChild(reload)
    btns.appendChild(restart)
    aside.appendChild(btns)
  }

  function wireMd(root) {
    if (!root) return
    root.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.copybtn')
      if (!btn) return
      const pre = btn.closest('.codeblock')
      if (pre) {
        const code = pre.querySelector('code')
        post({ type: 'copyText', text: code ? code.textContent : '' })
        btn.textContent = '已复制'
        setTimeout(() => { btn.textContent = '复制' }, 1200)
      }
    })
    const links = root.querySelectorAll && root.querySelectorAll('a')
    if (links) for (const a of links) a.addEventListener('click', (e) => {
      e.preventDefault()
      if (a.href) post({ type: 'openUrl', url: a.href })
    })
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  let watchdogTimer = null
  function scheduleWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      const tries = S.bootTries || 0
      if ((!S.describe || S.conn !== 'connected') && tries < 3) {
        console.log('[dsh] boot watchdog: re-handshaking (try ' + tries + ')')
        post({ type: 'boot' })
      }
    }, 3000)
  }
  function boot() {
    bootSkeleton()
    renderBanner()
    renderEmpty()
    post({ type: 'boot' })
    post({ type: 'listSessions' })
    post({ type: 'lastSession' })
    scheduleWatchdog()
  }
  boot()
})()
