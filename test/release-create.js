'use strict';
// Create the GitHub Release for the version in package.json and upload its vsix.
// Release notes are extracted from that version's CHANGELOG section.
// Token: DSH_GH_TOKEN, else %TEMP%/dsh-token.txt.
// Usage: node test/release-create.js [--dry-run]
const fs = require('fs');
const https = require('node:https');

const REPO = 'moxingovo/dsh-web-panel';
const version = JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8')).version;
const tag = 'v' + version;
const vsixName = 'dsh-webview-' + version + '.vsix';
const vsixPath = __dirname + '/../' + vsixName;
const dryRun = process.argv.includes('--dry-run');

function readToken() {
  if (process.env.DSH_GH_TOKEN) return process.env.DSH_GH_TOKEN.trim();
  return fs.readFileSync(process.env.TEMP + '\\dsh-token.txt', 'utf8').trim();
}

// The section runs to the next '## ' heading, so a new release never has to
// edit this script (it used to hardcode one version and its successor).
function sectionBody(v) {
  // Split on the '## ' headings instead of regexing a lazy body: a lazy match
  // against a multiline $ stops at the blank line right after the heading.
  const chunks = fs.readFileSync(__dirname + '/../CHANGELOG.md', 'utf8').split(/^## /m).slice(1);
  const chunk = chunks.find((c) => c.split(/\r?\n/, 1)[0].trim() === v);
  if (chunk === undefined) throw new Error('CHANGELOG.md has no section for ' + v);
  return chunk.slice(chunk.indexOf('\n') + 1).trim();
}

function notesFor(v) {
  const body = sectionBody(v);
  if (body === '') throw new Error('CHANGELOG.md section ' + v + ' is empty');
  return body + '\n\n安装:下载下方 ' + vsixName + ',VS Code 扩展面板 → ... → 从 VSIX 安装。';
}

function api(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.github.com', path, method, headers: { Authorization: 'Bearer ' + readToken(), 'User-Agent': 'dsh-release', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c });
      res.on('end', () => { if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 300))); else resolve(d ? JSON.parse(d) : null) });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const notes = notesFor(version);
  if (dryRun) {
    console.log('dry run: tag=' + tag + ' asset=' + vsixName + ' vsix exists=' + fs.existsSync(vsixPath));
    console.log('--- release notes ---\n' + notes);
    return;
  }
  if (!fs.existsSync(vsixPath)) throw new Error('missing ' + vsixName + ' — run npx @vscode/vsce package first');

  let rel;
  try {
    rel = await api('GET', '/repos/' + REPO + '/releases/tags/' + tag, {});
    console.log('release exists:', rel.html_url);
  } catch (e) {
    const body = JSON.stringify({ tag_name: tag, name: 'DSH Native Sidebar ' + tag, body: notes, draft: false });
    rel = await api('POST', '/repos/' + REPO + '/releases', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
    console.log('release created:', rel.html_url);
  }
  const existing = (rel.assets || []).find((a) => a.name === vsixName);
  if (existing) { await api('DELETE', '/repos/' + REPO + '/releases/assets/' + existing.id, {}); console.log('old asset deleted'); }
  const vsix = fs.readFileSync(vsixPath);
  const asset = await api('POST', '/repos/' + REPO + '/releases/' + rel.id + '/assets?name=' + vsixName, { 'Content-Type': 'application/octet-stream', 'Content-Length': vsix.length }, vsix);
  console.log('asset:', asset.browser_download_url, 'size=' + asset.size);
})().catch((e) => { console.error('ERR', e.message); process.exit(1) });
