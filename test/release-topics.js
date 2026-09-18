'use strict';
const fs = require('fs');
const https = require('node:https');
const token = fs.readFileSync(process.env.TEMP + '\\dsh-token.txt', 'utf8').trim();
const body = JSON.stringify({ names: ['deepseek', 'deepseek-harness', 'dsh-plugin', 'vscode', 'vscode-extension', 'sidebar', 'ai-chat'] });
const req = https.request({
  host: 'api.github.com',
  path: '/repos/moxingovo/dsh-web-panel/topics',
  method: 'PUT',
  headers: {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'dsh-release',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept': 'application/vnd.github+json',
  },
}, (res) => {
  let d = '';
  res.on('data', (c) => { d += c });
  res.on('end', () => {
    try { const j = JSON.parse(d); console.log('status=' + res.statusCode + ' topics=' + (j.names || []).join(', ')) } catch (e) { console.log('raw: ' + d.slice(0, 300)) }
  });
});
req.on('error', (e) => { console.error('ERR', e.message); process.exit(1) });
req.write(body);
req.end();
