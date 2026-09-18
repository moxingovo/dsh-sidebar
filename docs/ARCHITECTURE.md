# 架构说明(DSH Web Panel)

本扩展把 DeepSeek Harness 的**服务端协议**直接暴露为 VS Code 原生侧边栏,
不内嵌网页、不复刻 WebUI、不引入第二个 Gateway。三层结构:

```
┌─ webview(webview/app.js + app.css + markdown.js)───────────┐
│  Claude Code 风格 UI:会话抽屉 / 消息流 / harness 底栏      │
│ (权限·模型·推理·预设药丸 + 占用环 + 发送/停止单按钮)      │
└─────────────── postMessage(JSON) ────────────────────────┘
┌─ Extension Host(extension.js)─────────────────────────────┐
│  ServerManager:探测/附着/自启 3080,DSH_HOME=~/.dsh        │
│  PanelBridge:webview ↔ 协议客户端 双向桥接与重试          │
│  DshClient(src/protocol.js):POST /api/* RPC               │
│  + 双 WebSocket 下行(src/websocket.js 极简 RFC6455)       │
└─────────────── 127.0.0.1:3080 ────────────────────────────┘
┌─ DeepSeek Harness 服务端(不动、不改)──────────────────────┐
│  client-request/client-response 信封、mux/host 帧、       │
│  会话/工作区/预设/投影/审批……                              │
└────────────────────────────────────────────────────────────┘
```

## 关键设计决策

1. **附着优先,绝不自启第二实例破坏会话**:探测成功即 attach,与桌面
   harness 共享全部会话;仅当 `spawnIfMissing` 且无实例时才自启。
2. **会话归属用 `workspaceId`**:实测服务端 `session.create` 传 `cwd` 不会
   入组(落"未分组"),必须查/建工作区后传 `workspaceId`。
3. **跨端同步的现实边界**(重要):
   - `selectModel` **不产生任何推送帧/投影**(实测 mux 流零帧),因此模型/
     推理档跨端一致靠**2 秒短轮询** + 每次点开药丸即时拉取;面板→服务端
     是即时 RPC。
   - 沙箱权限走 `/permission <preset>` 命令 + `permissions` **投影**,投影
     会推送,因此权限两端**天然实时同步**。
   - 计划模式(/plan)有 `plan/mode` 事件推送;本 UI 不渲染(按需求移除药丸)。
4. **消息可靠性**:历史折叠记录 `lastAppliedSeq`,直播帧按 seq 去重;空内容
   帧跳过;斜杠命令不渲染为消息(静默切换)。
5. **图标/状态的环境排障**(历史踩坑,见 README 排障节):
   - VS Code 扩展扫描缓存残留旧目录引用会导致扩展"损坏"且新版本永不加载;
   - 辅助栏容器图标由**全局存储** `workbench.auxiliarybar.pinnedPanels`
     驱动,需在 VS Code 完全退出后修改;运行中修改会被退出回写覆盖;
   - 本构建(1.136)不渲染 secondarySidebar 容器图标,常驻入口采用
     `editor/title` 菜单 + titleBar 模式 + 活动栏兜底。

## 代码约定

- **纯 JavaScript,零构建**:`node --check` + mock-verify(扩展契约)+
  ui-smoke(jsdom 渲染)+ protocol-smoke / bridge-e2e(真实服务端)。
- webview 与宿主之间只传**可序列化 JSON**;服务端 RPC 信封格式见
  [docs/protocol.md](docs/protocol.md)。
- 版本号三处同步:package.json、extension.js 的 hello、面板标题 brand-ver。
- UI 为全中文设计(按需求),不做 l10n 双语切换——这是与参考实现
  (skymecode/deepseek-harness-for-vscode)的**有意差异**,勿照搬其
  package.nls/l10n 机制。
- Windows 打包必跑 `test/fix-vsix.ps1`(vsce 会把 package.json 中文按 GBK
  转码损坏)。

## 已知限制

- 模型/推理档跨端同步有 ≤2s 延迟(协议无推送,见上);若上游为
  `selectModel` 增加投影推送,可在此处降为 0 延迟。
- 权限药丸依赖会话预设安装权限插件,未安装时显示"权限:—"。
- 未实现:会话搜索、多选删除(服务端无物理删除)、l10n。
