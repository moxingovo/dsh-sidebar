'use strict'
// 顶栏 + 底部功能区的外观契约(向 Claude Code 靠拢的那次改造)。
//
// 三条回归:
//   1) 顶栏左侧不再是「✳ DSH v0.4.2」品牌条,而是当前对话的名字;
//   2) 顶栏右侧只保留会话列表(☰)与新建会话(＋),设置与收起两个钮已删除;
//   3) 底部功能区整块一圈 DeepSeek 蓝描边,输入区与工具行之间一条分隔线。
//
// 结构与视觉分两条腿测:DOM 断言驱真实 app.js 渲染(jsdom 不做布局),
// 颜色/圆角/分隔线这类只能读 app.css 的样式文本。
//
// Run: node test/header-composer-verify.js
const fs = require('node:fs')
const path = require('node:path')
// jsdom comes from a harness checkout (DSH_CHECKOUT_NODE_MODULES) or from this
// repo's own node_modules after "npm install --no-save jsdom".
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
window.acquireVsCodeApi = () => ({ postMessage: () => {} })

// markdown.js and app.js are plain scripts that attach to the window.
const load = (f) => window.eval(fs.readFileSync(path.join(WEBVIEW, f), 'utf8'))
load('markdown.js')
load('app.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}
const send = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }))
const doc = window.document
const titleText = () => {
  const n = doc.querySelector('#hdrTitle')
  return n ? n.textContent : '(missing)'
}

// ── 1) 顶栏结构:标题在左,两个圆钮在右 ──────────────────────────────────
const header = doc.querySelector('.dsh-header')
check('顶栏渲染出来了', header !== null)
check('左侧是对话标题节点', doc.querySelector('.dsh-header .hdr-title#hdrTitle') !== null)
const ids = [...doc.querySelectorAll('.dsh-header button')].map((b) => b.id)
check('右侧只剩会话列表与新建会话', ids.join(',') === 'btnSessions,btnNewSession', ids.join(','))
check('设置钮已删除', doc.querySelector('#btnSettings') === null)
check('收起面板钮已删除', doc.querySelector('#btnCollapse') === null)
check('版本号不再出现在顶栏', header !== null && !header.textContent.includes('v0.4.2'),
  header ? header.textContent.trim() : '(missing)')
check('品牌条(✳ DSH)不再出现在顶栏', doc.querySelector('.dsh-header .brand') === null)

// ── 2) 标题跟着当前对话走 ────────────────────────────────────────────────
const CONV = 'practice.cpp 第 5-10 行'
check('首帧顶栏就是产品名(不是空条)', titleText() === 'DeepSeek Harness', titleText())
send({
  type: 'sessionList',
  items: [{ sessionId: 'session-cc', cwd: 'C:\\ws', title: CONV, updatedAt: 5, messages: 3, blank: false }],
  archivedIds: [],
  workspacePath: 'C:\\ws',
})
check('列表到位但没开对话时,仍是产品名', titleText() === 'DeepSeek Harness', titleText())
send({ type: 'sessionOpened', sessionId: 'session-cc', hasMore: false, blank: false, events: [] })
check('打开对话后显示该对话名', titleText() === CONV, titleText())
send({ type: 'sessionRenamed', sessionId: 'session-cc', title: '重命名后的对话' })
check('改名后顶栏即时跟随', titleText() === '重命名后的对话', titleText())
send({ type: 'sessionOpened', sessionId: 'session-blank', hasMore: false, blank: true, events: [] })
check('空白会话显示「新会话」而不是版本号', titleText() === '新会话', titleText())

// ── 3) 底部功能区:一圈蓝描边 + 卡内分隔线 ───────────────────────────────
const card = doc.querySelector('.dsh-composer .composer-card')
check('功能区是一张整卡', card !== null)
check('  输入框在卡内', card !== null && card.querySelector('.dsh-input') !== null)
check('  工具行也在卡内(描边包住整块功能区)',
  card !== null && card.querySelector('.composer-row .sendbtn') !== null)

const css = fs.readFileSync(path.join(WEBVIEW, 'app.css'), 'utf8')
/** 取一条规则的声明体;选择器必须顶到行首,免得 .iconbtn 命中 .hdr-actions .iconbtn。 */
const ruleFor = (selector) => {
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\{([^}]*)\\}', 'm')
  const m = pattern.exec(css)
  return m ? m[1] : ''
}
const cardRule = ruleFor('.composer-card')
check('卡片描边是 DeepSeek 蓝', /border:\s*1px solid var\(--dsh-accent\)/.test(cardRule), cardRule.trim())
check('卡片圆角与 CC 一致(12px)', /border-radius:\s*12px/.test(cardRule), cardRule.trim())
const rowRule = ruleFor('.composer-row')
check('输入区与工具行之间有一条分隔线', /border-top:\s*1px solid/.test(rowRule), rowRule.trim())
const headerRule = ruleFor('.dsh-header')
check('顶栏高度走共享变量(--dsh-header-h)', /height:\s*var\(--dsh-header-h\)/.test(headerRule), headerRule.trim())
check('顶栏底边一条分隔线', /border-bottom:\s*1px solid/.test(headerRule), headerRule.trim())
check('共享变量本身是 44px', /--dsh-header-h:\s*44px/.test(css), '')
const drawerRule = ruleFor('.dsh-sessionbar')
check('会话抽屉起点跟着顶栏高度,不再写死 34px',
  /top:\s*var\(--dsh-header-h\)/.test(drawerRule) && !/top:\s*34px/.test(drawerRule), drawerRule.trim())
const titleRule = ruleFor('.hdr-title')
check('长标题省略号截断', /text-overflow:\s*ellipsis/.test(titleRule) && /white-space:\s*nowrap/.test(titleRule), titleRule.trim())
const btnRule = ruleFor('.hdr-actions .iconbtn')
check('顶栏按钮是圆钮', /border-radius:\s*50%/.test(btnRule), btnRule.trim())
check('圆钮不波及输入区的基础 .iconbtn', !/border-radius:\s*50%/.test(ruleFor('.iconbtn')), ruleFor('.iconbtn').trim())

// ── 4) 功能区整体放大(竖直方向)与随之内缩放的控件 ─────────────────────
/** 读一条规则里的 px 数值;没有该声明返回 NaN。 */
const px = (rule, prop) => {
  const m = new RegExp(prop + ':\\s*([\\d.]+)px').exec(rule)
  return m ? Number(m[1]) : NaN
}
/** 同名规则的最后一处(窄面板覆写写在文件末尾,生效的是它)。 */
const ruleForLast = (selector) => {
  const at = css.lastIndexOf(selector + ' {')
  if (at < 0) return ''
  const end = css.indexOf('}', at)
  return end < 0 ? '' : css.slice(at + selector.length, end)
}
const inputRule = ruleFor('.dsh-input')
check('输入区明显加高(≥60px)', px(inputRule, 'min-height') >= 60, 'min-height=' + px(inputRule, 'min-height'))
check('输入字号跟着放大(≥14px)', px(inputRule, 'font-size') >= 14, 'font-size=' + px(inputRule, 'font-size'))
check('输入区自动增长上限抬高(≥220px)', px(inputRule, 'max-height') >= 220, 'max-height=' + px(inputRule, 'max-height'))
const pillRule = ruleFor('.hdr-sel.pill')
check('药丸变高(≥26px)', px(pillRule, 'height') >= 26, 'height=' + px(pillRule, 'height'))
check('药丸字号放大(≥12px)', px(pillRule, 'font-size') >= 12, 'font-size=' + px(pillRule, 'font-size'))
const pillNarrow = ruleForLast('.hdr-sel.pill')
check('窄面板覆写的药丸也跟着放大(≥11px)', pillNarrow === pillRule || px(pillNarrow, 'font-size') >= 11, 'font-size=' + px(pillNarrow, 'font-size'))
const compactRule = ruleFor('#btnCompact')
check('压缩钮与药丸同高(≥28px)', px(compactRule, 'height') >= 28, 'height=' + px(compactRule, 'height'))
const sendRule = ruleFor('.sendbtn')
check('发送键放大(≥32px)', px(sendRule, 'width') >= 32 && px(sendRule, 'height') >= 32, px(sendRule, 'width') + '×' + px(sendRule, 'height'))
const rowRule2 = ruleFor('.composer-row')
check('工具行内边距同比加大(≥6px 顶)', px(rowRule2, 'padding-top') >= 6 || /padding:\s*6px/.test(rowRule2), rowRule2.trim())

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(failed.length === 0 ? '[verify] ALL PASS (' + results.length + ' checks)' : '[verify] FAILED: ' + failed.map((f) => f.label).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
