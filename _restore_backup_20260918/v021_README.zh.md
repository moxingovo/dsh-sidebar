# DSH Web Panel

把 DeepSeek Harness 的 Web GUI 嵌入 VS Code：attach（或自动启动）本机的 dsh web
服务器，在 iframe 里渲染完整界面——会话、终端、plan 审批、斜杠命令、token/缓存统计条
全部原样可用。

> 非官方社区扩展，与 DeepSeek 无关。

- **侧边栏视图**：活动栏的 DSH 图标 → "DSH Panel"。
- **编辑器标签页面板**（推荐，宽度更足）：命令面板 → `DSH: Open Panel`；默认**启动即自动打开**（可关，见 `dshWeb.autoOpen`）。
- 状态栏左侧的 **DSH** 项显示服务器状态（✓ 运行 / ⎌ 附着 / ⟳ 启动中 / ⛔ 错误），点击打开面板。
- **面板位置记忆**：DSH 标签页随窗口布局保存，重启 VS Code 后自动恢复到原位置。
- **多工作区跟随**：本扩展自启的服务器在工作区首个文件夹变化时自动用新目录重启（dsh 的 workspace 根 = 服务器 cwd），外部实例不受影响。
- **零额外窗口**：本扩展启动的 dsh 进程是隐藏的（windowsHide），不会像桌面快捷方式那样弹出一个 Electron/控制台窗口。
- **自愈**：附着的外部实例掉线（比如关闭了桌面窗口）会在 15 秒内被检测到并自动拉起隐藏实例接管；自启实例意外退出也会自动重启。

## 安装

从发布的 .vsix 安装：

```
code --install-extension dsh-webview-0.2.1.vsix
```

或自行打包：

```
cd dsh-webview
npx @vscode/vsce package
code --install-extension dsh-webview-0.2.1.vsix
```

## 零配置启动

默认：先探测 `dshWeb.port`（默认 3080）上是否已有 dsh 实例（以页面含
`__DSH_BOOT__` 为准）——有就 attach（复用你现有的所有会话）；没有就自动启动一个，
按顺序尝试（每级 120 秒）：

1. `dshWeb.command`（自定义覆盖）
2. `dshWeb.checkout`（指向的 checkout，若设置且存在）
3. PATH 里的 `dsh` CLI（官方 npm 全局安装：`npm i -g @deepseek-ai/dsh`）
4. `npx --yes @deepseek-ai/dsh`（按需下载 CLI，真正零设置）

服务器以 **cwd = 当前工作区第一个文件夹** 运行，因此每个项目有各自的 dsh workspace。
前提只有：VS Code ≥ 1.85 + Node.js（官方 dsh 安装本来就要求）。DeepSeek API key
在 GUI 里按官方引导配置。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `dshWeb.port` | 3080 | 附着/启动的端口 |
| `dshWeb.attachExisting` | true | 优先复用已运行的实例 |
| `dshWeb.spawnIfMissing` | true | 没有实例时自动启动 |
| `dshWeb.checkout` | 空（自动探测） | 可选：checkout 路径（用其 apps/cli/lib/bin.js 启动） |
| `dshWeb.command` | 空 | 整条启动命令覆盖（如 `pnpm dsh`），经 shell 在工作区目录执行 |
| `dshWeb.extraArgs` | [] | 追加参数（如 `--trusted-host`） |
| `dshWeb.autoOpen` | true | VS Code 启动时自动打开 DSH 面板 |
| `dshWeb.followWorkspace` | true | 自启服务器跟随工作区首文件夹变化重启 |
| `dshWeb.stopOnExit` | true | 退出 VS Code 时停掉本扩展启动的服务器（进程树级终止） |

排错看 **Output → DSH Server** 频道。

## 已知边界

- 面板内容是 dsh 自己的 Web 界面，**不是** Claude Code 面板的复刻。
- "DSH: Restart Server" 只重启本扩展启动的服务器；外部实例请自行重启后点 "DSH: Reload Panel"。
- VS Code 退出时对自启实例执行硬终止（Windows 下 taskkill /T）；dsh 会话日志带崩溃恢复，一般无碍。

## 开发

```
# 无头验证（mock vscode API；attach / 启动 / 真实拉起三条路径）
node test/mock-verify.js
node test/spawn-verify.js       # 需要可管道的 shell（无沙箱环境）
node test/real-launch-verify.js # 从 checkout 真实拉起 dsh
```

## License

MIT — 见 [LICENSE](LICENSE)。
