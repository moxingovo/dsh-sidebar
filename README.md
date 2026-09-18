# DSH Web Panel

A **Claude Code-style native DSH sidebar** for VS Code: a self-written native
front-end (no iframe) that reuses your existing dsh web service
(127.0.0.1:3080 by default) and `~/.dsh` — no second gateway, no server changes.

> Unofficial community extension. Not affiliated with DeepSeek.

- **Entry points (same as Claude Code)**: the **DeepSeek Harness icon** (DeepSeek
  blue) in the top-right auxiliary bar — click to summon the chat panel; the
  status-bar **DSH** item shows server state and toggles the panel; `Ctrl+Alt+D`.
- **Sessions**: current-workspace sessions only — create / switch / archive /
  rename / fork; the context meter shows real server-side token data.
- **Model & preset**: model + reasoning-effort pickers; preset switching is
  blank-session-only (locked once the conversation starts — a server constraint).
- **Capabilities**: streaming replies, stop, tool cards / approval cards / todos /
  timeline, image attachments (vision), `/compact`, Markdown + code blocks.
- **Protocol**: `POST /api/*` RPC plus dual WebSocket downlinks (mux/host
  frames) — see [docs/protocol.md](https://github.com/moxingovo/dsh-web-panel/blob/HEAD/docs/protocol.md).

## Install

From a released `.vsix`:

```
code --install-extension dsh-webview-0.3.1.vsix
```

Or build it yourself (run in the repo root):

```
npx @vscode/vsce package
pwsh -File test\fix-vsix.ps1   # repairs vsce's UTF-8 mangling of package.json
code --install-extension dsh-webview-0.3.1.vsix
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

```
node test/mock-verify.js      # mock vscode API contract checks
node test/ui-smoke.js         # jsdom render checks of the webview UI (24 checks)
node test/protocol-smoke.js   # end-to-end against a real service (create/stream/stop/archive)
node test/bridge-e2e.js       # full bridge chain (mock vscode + real 3080)
```

## License

MIT — see [LICENSE](https://github.com/moxingovo/dsh-web-panel/blob/HEAD/LICENSE).
