# DSH Web Panel

Embed the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
web GUI inside VS Code. Attaches to — or automatically starts — the local dsh web
server and renders the full GUI in an iframe: sessions, terminal, plan approval,
slash commands, todo, token/cache stats — everything, unchanged.

> Unofficial community extension. Not affiliated with DeepSeek.

- **Sidebar view**: DSH activity-bar icon → "DSH Panel".
- **Editor-tab panel** (recommended, wider): Command Palette → `DSH: Open Panel`;
  opens automatically on startup by default (`dshWeb.autoOpen`).
- **Status bar indicator** (✓ running / ⎌ attached / ⟳ starting / ⛔ error); click to open the panel.
- **Panel memory**: the DSH tab is restored with your window layout across restarts.
- **Workspace follow**: a self-started server restarts with the new cwd when the
  first workspace folder changes (dsh's workspace root = server cwd).
- **No extra windows**: the extension spawns dsh hidden (`windowsHide`); nothing pops up.
- **Self-healing**: if an attached instance dies (e.g. its desktop window was
  closed), it is detected within ~15s and a hidden instance takes over; a crashed
  self-started instance restarts automatically.

## Install

From a released `.vsix`:

```
code --install-extension dsh-webview-0.2.1.vsix
```

Or build it yourself:

```
cd dsh-webview
npx @vscode/vsce package
code --install-extension dsh-webview-0.2.1.vsix
```

## Zero-config launch

On startup the extension probes `dshWeb.port` (default 3080) and attaches if a
real dsh instance responds (page carries the `__DSH_BOOT__` manifest). Otherwise
it starts one, trying each strategy in order (120s each):

1. `dshWeb.command` (explicit override),
2. `dshWeb.checkout` (a deepseek-harness checkout, if set and present),
3. `dsh` on PATH (official npm install: `npm i -g @deepseek-ai/dsh`),
4. `npx --yes @deepseek-ai/dsh` (downloads the CLI on demand — zero setup).

The server runs with **cwd = the first workspace folder**, so each project gets
its own dsh workspace. Requirements: VS Code ≥ 1.85 and Node.js (both already
required by the official dsh setup). Configure your DeepSeek API key in the GUI
as usual.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dshWeb.port` | 3080 | Port to attach to or start on |
| `dshWeb.attachExisting` | true | Reuse a running instance instead of starting a new one |
| `dshWeb.spawnIfMissing` | true | Start a server when none is running |
| `dshWeb.checkout` | "" (auto) | Optional checkout path (launches `apps/cli/lib/bin.js`) |
| `dshWeb.command` | "" | Full command override, e.g. `pnpm dsh` (runs via shell in the workspace) |
| `dshWeb.extraArgs` | [] | Extra arguments appended to the launch, e.g. `--trusted-host` |
| `dshWeb.autoOpen` | true | Open the DSH panel automatically on startup |
| `dshWeb.followWorkspace` | true | Restart self-started server when the first folder changes |
| `dshWeb.stopOnExit` | true | Stop a self-started server when VS Code exits (process-tree kill) |

Troubleshooting: **Output → DSH Server**.

## Known boundaries

- The panel shows dsh's own web UI — it is **not** a Claude Code panel clone.
- "DSH: Restart Server" only restarts servers started by this extension; restart
  an external instance yourself, then run "DSH: Reload Panel".
- On exit, self-started servers are killed hard (taskkill /T on Windows); dsh
  session logs survive crashes, so this is generally harmless.

## Development

```
# headless checks (mock the vscode API; attach + spawn + real-launch paths)
node test/mock-verify.js
node test/spawn-verify.js      # needs pipe-capable shell (no sandbox)
node test/real-launch-verify.js # spawns the real dsh from the checkout
```

## License

MIT — see [LICENSE](LICENSE).
