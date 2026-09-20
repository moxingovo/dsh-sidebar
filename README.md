# DSH Sidebar

**English** | [简体中文](README.zh.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/moxingovo/dsh-sidebar/releases)

A **Claude Code-style native DSH sidebar** for VS Code: a self-written native
front-end (no iframe) that reuses your existing dsh web service
(127.0.0.1:3080 by default) and `~/.dsh` — no second gateway, no server changes.

> Unofficial community extension. Not affiliated with DeepSeek.
>
> **Harness compatibility**: 0.6.x speaks the **0.1.6** wire (Typert API Gateway:
> cookie-authenticated `/api/<ns>/<method>`, one `remote.mux` WebSocket, durable
> events plus process-local assistant frames). For DeepSeek Harness **0.1.0–0.1.5**
> use release **0.5.0**; the two wires are not interchangeable.

<p align="center"><a href="media/demo-panel.png"><img src="media/demo-panel.png" alt="DSH Sidebar: a Claude Code-style DSH sidebar inside VS Code (screenshot)" width="440"></a></p>

<sub>Screenshot not loading? Your network may block <code>raw.githubusercontent.com</code> — open <a href="media/demo-panel.png">media/demo-panel.png</a> or the <a href="https://cdn.jsdelivr.net/gh/moxingovo/dsh-sidebar@main/media/demo-panel.png">jsDelivr mirror</a>.</sub>

- **Look (Claude Code style)**: the header shows **the open conversation's name**
  with only two round buttons at its right — session list and new chat; the bottom
  function area is one rounded card with a **DeepSeek-blue ring** and a divider
  between the input and the toolbar, with pills / send button / context ring scaled
  to match.
- **Blank sessions & drafts**: a new conversation you leave without sending anything
  does not occupy a list slot; if you typed something there it stays (drafts are kept
  per conversation and never leak into another one), and the next "new chat" reuses
  that empty conversation instead of piling up another one.
- **Entry points (same as Claude Code)**: the **DeepSeek Harness icon** (DeepSeek
  blue) in the top-right auxiliary bar — click to summon the chat panel; the
  status-bar **DSH** item shows server state and toggles the panel; `Ctrl+Alt+D`.
- **Sessions**: current-workspace sessions only — create / switch / archive /
  rename / fork; the context meter shows real server-side token data.
- **Model & preset**: model + reasoning-effort pickers; preset switching is
  blank-session-only (locked once the conversation starts — a server constraint).
- **Capabilities**: streaming replies, stop, tool cards / approval cards / todos /
  timeline, image attachments (vision), `/compact`, Markdown + code blocks.
- **Protocol**: 0.1.6 Typert gateway — `POST /api/<ns>/<method>` with named args,
  a browser-session cookie minted from the launch token, and one `/api/remote.mux`
  socket carrying every stream (session follow, workspace baseline, `$events`) —
  see [docs/protocol.md](https://github.com/moxingovo/dsh-sidebar/blob/HEAD/docs/protocol.md).

## Install

From a released `.vsix`:

```
code --install-extension dsh-webview-0.6.2.vsix
```

Or build it yourself (run in the repo root):

```
npx @vscode/vsce package
pwsh -File test\fix-vsix.ps1   # repairs vsce's UTF-8 mangling of package.json
code --install-extension dsh-webview-0.6.2.vsix
```

> ⚠️ Known issue: on some Windows environments `vsce package` re-encodes the
> Chinese text in `package.json` as GBK mojibake and can even break the JSON.
> Always run `test\fix-vsix.ps1` after packaging.

## Zero-config launch

On startup the extension probes `dshWeb.port` (default 3080) and attaches if a
dsh instance responds. Otherwise it starts one, trying in order:
`dshWeb.command` → `dshWeb.checkout` → `dsh` on PATH → `npx @deepseek-ai/dsh`.
The server runs with **cwd = the first workspace folder** and `DSH_HOME` pinned
to `~/.dsh` (identical to attach — never isolated).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dshWeb.port` | 3080 | Port to attach to or start on |
| `dshWeb.attachExisting` | true | Reuse a running instance instead of starting a new one |
| `dshWeb.spawnIfMissing` | true | Start a server when none is running |
| `dshWeb.checkout` | "" (auto) | Optional checkout path (launches `apps/cli/lib/bin.js`) |
| `dshWeb.command` | "" | Full command override, e.g. `pnpm dsh` |
| `dshWeb.extraArgs` | [] | Extra arguments, e.g. `--trusted-host` |
| `dshWeb.attachWaitSeconds` | 30 | Seconds to wait for a launcher before starting a server of our own |
| `dshWeb.takeoverAfterSeconds` | 45 | Seconds an attached server may stay silent before we take the port over |
| `dshWeb.nodeMaxOldSpaceMb` | 8192 | `--max-old-space-size` for the node we launch (0 = Node's default) |
| `dshWeb.nodeArgs` | [] | Extra flags for the node executable itself (checkout launcher) |
| `dshWeb.followWorkspace` | true | Restart self-started server when the first folder changes |
| `dshWeb.stopOnExit` | true | Stop a self-started server when VS Code exits |

Troubleshooting: **Output → DSH** (logs connection and protocol traffic).

## Troubleshooting: missing top-right icon / persistent "Chat" tab

Two independent root causes, both fixed by the bundled one-click `fix-dsh.cmd`:

### Cause 1: the extension scan cache points at a deleted old-version folder

VS Code caches its extension scan in `.vscode\extensions\extensions.json`. If a new
version is installed by deleting the old folder, VS Code still looks for the old path
at startup → ENOENT → the extension is marked broken and the new version in the same
folder is **never discovered** (hence no icon).

Fix: `test\fix-cache.js` — rewrites the cache entry to the new path, drops the
profile-level scan caches (forcing a full rescan), and repairs the placeholder icon
path. Backups are created automatically.

### Cause 2: auxiliary-bar container icons / Chat tab persistence live in global storage

VS Code 1.136 stores auxiliary-bar container icons (title-bar / right-edge strip) in
**global** storage `workbench.auxiliarybar.pinnedPanels`; the Chat tab's persistence
lives there too. Patching only the per-workspace state is ineffective, and edits made
while VS Code is running get overwritten on exit.

Fix: `test\fix-state.js` — removes Chat from the global pinned list, registers
`dsh-aux`, hides the Chat view across all workspace DBs, and backs up every
`state.vscdb` (`.bak-dsh`); idempotent.

### Usage

1. **Fully exit VS Code** (all windows, including minimized);
2. Double-click `fix-dsh.cmd` on the Desktop (it refuses to run while VS Code is open);
3. Reopen VS Code → the blue harness icon appears top-right, Chat is gone.

## Development

No build step: plain JS, checked with `node --check` plus a set of regression scripts
(`test/*.js`; 10 suites carry assertions, 217 checks in total right now).

```
node test/respond-wire-verify.js        # approval/question answer wire shape (18 checks, mock 0.1.6 gateway)
node test/session-list-filter-verify.js # session-list filtering (workspace / subagent / archived)
node test/blank-session-verify.js       # blank-session lifecycle + per-session drafts + reuse cache + failed-send restore (31 checks)
node test/panel-fixes-verify.js         # markdown escaping, queue rendering, archive set, projections, attachments, paging (22 checks)
node test/header-composer-verify.js     # header & composer structure + style contract (34 checks)
node test/approval-card-verify.js       # approval card rendering + dedup (35 checks, jsdom)
node test/live-sync-verify.js           # live event folding (8 checks)
node test/pill-menu-verify.js           # pill menu lifecycle + listener leaks (11 checks)
node test/spawn-verify.js               # launch chain (checkout / dsh CLI / npx)
node test/launch-flags-verify.js        # launch argument assembly
node test/attach-paste-verify.js        # image attachment paste/drop
node test/real-launch-verify.js         # spawns the real dsh web server (needs a local checkout; manual)
```

The jsdom-backed suites need `DSH_CHECKOUT_NODE_MODULES` pointing at a `node_modules`
that has jsdom.

`approval-card-verify.js` runs the real `webview/app.js` in jsdom and drives it with
the same host messages the extension sends. It pins the field-name contract behind
the duplicate-card bug: session-log events carry the approval id as `data.id`, while
server-request frames carry it as `approvalId`; reading only the latter makes the id
`undefined`, so the log card and the replayed frame render as two identical cards and
`approval/decided` never settles either.

`respond-wire-verify.js` is the regression guard for the sidebar's permission and
question buttons: it stands up a fake 0.1.6 gateway, activates the extension against
it, pushes an `approval/*` and a `question/*` waterfall into the sidebar webview, and
asserts the answer frame that goes back out — `POST /api/$events/result` carrying the
opening `clientId` and the waterfall `eventId`. The payload is validated against
`approvalResponsePayloadSchema` / `questionResponsePayloadSchema`, both of which also
require `sessionId`; a wrong shape is rejected with `{accepted:false}` and surfaces to
the user as `server rejected response to undefined`.

## License

MIT — see [LICENSE](https://github.com/moxingovo/dsh-sidebar/blob/HEAD/LICENSE).
