'use strict';
// Set repo description + topics via GitHub API with clean UTF-8 (Node handles encoding).
const fs = require('fs');
const http = require('node:http');
const https = require('node:https');
const token = fs.readFileSync(process.env.TEMP + '\\dsh-token.txt', 'utf8').trim();
const body = JSON.stringify({
  description: 'Claude Code-style native DeepSeek Harness sidebar for VS Code: self-written chat UI (no iframe) reusing the existing dsh web service — workspace-synced sessions, sandbox-permission/model/reasoning pickers, context ring. / VS Code 里的 Claude Code 风格 DeepSeek Harness 原生侧边栏:自写聊天 UI(无 iframe),复用现有 dsh web 服务;工作区会话同步、沙箱权限/模型/推理档选择、上下文占用环。',
  topics: ['deepseek', 'deepseek-harness', 'dsh-plugin', 'vscode', 'vscode-extension', 'sidebar', 'ai-chat'],
});
const req = https.request({
  host: 'api.github.com',
  path: '/repos/moxingovo/dsh-web-panel',
  method: 'PATCH',
  headers: {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'dsh-release',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
}, (res) => {
  let d = '';
  res.on('data', (c) => { d += c });
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      console.log('status=' + res.statusCode);
      console.log('description=' + j.description);
      console.log('topics=' + (j.topics || []).join(', '));
    } catch (e) { console.log('raw: ' + d.slice(0, 400)) }
  });
});
req.on('error', (e) => { console.error('ERR', e.message); process.exit(1) });
req.write(body);
req.end();
