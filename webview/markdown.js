'use strict'
// Minimal Markdown renderer for the DSH sidebar (no external deps, CSP-safe).
// Subset: fenced code blocks, headings, hr, blockquotes, ordered/unordered
// lists, paragraphs, inline code / bold / italic / strike / links.
;(() => {
  const BT = String.fromCharCode(96) // backtick
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function inline(s) {
    let out = escapeHtml(s)
    const codes = []
    out = out.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), (_, c) => {
      codes.push(c)
      return '\u0000CODE' + (codes.length - 1) + '\u0000'
    })
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => {
      if (/^https?:\/\//.test(url) || /^mailto:/.test(url)) {
        return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(t) + '</a>'
      }
      return escapeHtml(t)
    })
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => '<code>' + escapeHtml(codes[Number(i)]) + '</code>')
    return out
  }
  function render(text) {
    const src = String(text ?? '').replace(/\r\n?/g, '\n')
    const lines = src.split('\n')
    const out = []
    let i = 0
    let para = []
    const flush = () => {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = [] }
    }
    while (i < lines.length) {
      const line = lines[i]
      const fence = /^```([\w+.-]*)\s*$/.exec(line.trim())
      if (fence) {
        flush()
        const lang = fence[1] || ''
        const buf = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
        i++
        out.push('<pre class="codeblock" data-lang="' + escapeHtml(lang) + '"><div class="codehead"><span>' + escapeHtml(lang || 'code') + '</span><button class="copybtn" title="复制">复制</button></div><code>' + escapeHtml(buf.join('\n')) + '</code></pre>')
        continue
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) { flush(); const lvl = Math.min(3, h[1].length); out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'); i++; continue }
      if (/^\s*>/.test(line)) {
        flush()
        const buf = []
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>')
        continue
      }
      if (/^\s*-+\s*$/.test(line) && line.trim().length <= 3) { flush(); out.push('<hr>'); i++; continue }
      const ul = /^\s*[-*+]\s+/.test(line)
      const ol = /^\s*\d+[.)]\s+/.test(line)
      if (ul || ol) {
        flush()
        const tag = ul ? 'ul' : 'ol'
        const items = []
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
          i++
        }
        out.push('<' + tag + '>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + tag + '>')
        continue
      }
      if (line.trim() === '') { flush(); i++; continue }
      para.push(line.trim())
      i++
    }
    flush()
    return out.join('\n')
  }
  window.DshMarkdown = { render, escapeHtml }
})()