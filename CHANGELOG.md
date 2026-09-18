# Changelog

## 0.6.1

(2026-09-19) 修复:**桌面 harness 重启后侧边栏不会自动恢复**。健康定时器只探测端口,而重启时端口会在 45 秒接管预算内恢复 → manager 状态始终是 `attached`、没有任何状态变化、也没人重开那条 socket,面板就一直卡在"正在连接",必须手动重载窗口。现在 socket 掉线后 3 秒自行重连(仅 attached/ready 状态,disconnect 时取消)。
另外:本地 `real-launch-verify.js` 默认使用 `~/deepseek-harness-0.1.6`(回退链解析到的是旧 harness,读不了 0.1.6 迁移过的凭据存储)。

## 0.6.0

(2026-09-19) 跟进 **DeepSeek Harness 0.1.6-alpha.2(Typert API Gateway)**:旧版 wire 在 0.1.6 上完全不可用(探测、鉴权、API、事件流全变),本版把协议层重写并补齐功能缺口。回归脚本 `test/*.js` 共 9 个套件 129 项断言全绿。

### 协议层(0.1.6 wire)
- 重写 `src/protocol.js`:`POST /api/<ns>/<method>` 命名参数网关、`session/list` 的 `_request` 参数、WS 单路 `remote.mux` 的逻辑流(`open`/`cancel`,帧为 `item`/`error`/`end`)。
- 鉴权:0.1.6 的 `/api` 与 WS 升级都要求 `dsh-auth-<authority>` cookie。扩展改为**先换 cookie 再开 socket**(此前先开 socket,首次连接必然 401,面板要重开一次才活);token 候选全量尝试(按文件 mtime 新→旧、同文件内后出现优先),cookie 存 globalState 复用。
- 传输层改用 `node:http`(扩展宿主里的 `fetch` 换 token 被服务端 401,同进程 `http.get` 却是 303),整个扩展不再依赖 `fetch`。
- 新增映射:`session.prompt`(客户端铸 `requestId`)、`commands.execute`(0.1.6 把 `attachments` 改名为 `submittedAttachments`)、`permissionPresets/catalog`、`session/modelCatalog`(目录里当前模型叫 `default`,归一化成 `current`)。

### 实时事件
- 打通 `$events` host 流:`api-session/status`(运行中小圆点)、`api-session/added`/`removed`、`api-session/activity`(列表排序);过去这些 `emit` 帧被当成 waterfall 处理,事件被丢弃。
- 修复 connection 状态:host 流从未上报 up,面板 `connected = muxUp && hostUp` 恒为假 —— 黄色"正在连接"永不消失。
- 流式打字:0.1.6 把增量移到进程内帧 `session/assistant-stream`;按**帧游标**去重(chunk 自带的是会重复的块号)。
- 问答卡片:0.1.6 的事件名是 `user-questions/request`(旧名 `question/request` 导致提问卡永不显示)。
- 权限药丸:0.1.6 的 `permissions` 投影只有 `currentValue`,选项在 `permissionPresets/catalog`;切换只追加 `permission/preset` 事件,现已在 webview 里折叠。
- 队列面板改由 `inbox` 投影驱动;抽屉标题改为"显式 title 优先 + `session/title` 事件更新 + 回合结束重拉"。

### 界面缺陷
- 修复药丸菜单**第二次点不动**:关闭监听用 `setTimeout` 挂载且不摘除,陈旧监听会关掉新菜单;改为同步挂载 + 身份守卫,并加入监听器计数回归。
- 修复**用户自己的消息不显示**:0.1.6 把 parts 放在 `data.content`(旧版在 `data.message.content`)。
- 插件注入的上下文(如 `user-approval` 的审批策略通知)不再冒充用户气泡,改为系统行。
- 去掉每 2 秒轮询模型目录(它会重建标题栏、吞掉点击);模型/推理药丸改为按需刷新 + `modelSelection` 投影驱动。
- 代码模式子调用行:事件名 `tool/code-dispatch*` → `tool/ptc-dispatch*`。

### 测试
- 新增 `test/mock-016-server.js`:会说 0.1.6 wire 的 mock(cookie 握手、命名参数网关、`remote.mux` WS 握手 + 帧编解码、workspace/`$events`/session-follow 订阅)。两个旧套件(`respond-wire`、`session-list-filter`)从旧 wire 迁到它之上,并把审批/问答的应答断言改为 `POST /api/$events/result`。
- 新增 `test/live-sync-verify.js`(jsdom 实时折叠路径)、`test/pill-menu-verify.js`(菜单生命周期与监听器泄漏)。

## 0.5.0

(2026-09-18) 以 **0.3.5 稳定线**为基线,修掉会话列表 / 附件 / 服务自启的实质缺陷。回归脚本 `test/*.js` 共 103 项断言全绿。

### 会话列表
- 修复:**子代理(subagent)会话被当成对话列进抽屉**。子代理自己干活的会话日志带 `origin: "subagent"`,harness 客户端只在父会话的 subagent catalog 里挂它们、从不当对话;侧边栏此前只按 `cwd` 过滤,于是抽屉里塞满用户从没开过的行(标题就是子代理提示词,如"你是资深…/You are doing…")。现在 host 与 webview 双层过滤,判据用 `origin` 而**不是** `parentSessionId`——派生会话(fork)也带后者,不能连带藏掉。
- 修复:归档集合被单次 `workspace.list` 失败清空,已归档会话漏回列表且可被打开/发消息。现在失败重试 3 次,仍失败则**不发送该字段**,由 webview 保留已有集合;陈旧渲染里的归档行点开会被拒绝并说明原因。
- 修复:选中会话后会话抽屉不自动关闭(切换会话后抽屉一直盖着刚打开的对话)。
- 修复:权限(approval)卡片重复——事件里字段是 `id`,读成了 `approvalId`,去重失效,同一请求渲染两张卡片。

### 附件(图片)
- 新增:**粘贴 / 拖拽 / 文件选择器**三种方式往输入框添加图片。此前 `addAttachment()`、附件托盘、发送序列化都已存在,但**没有任何地方调用它们**(无 paste/drop 监听、无选择器),图片根本进不来。
- 按 harness 的 `imageLimits` 投影预检(单张大小 / 条数上限 / 合计上限),超限直接拒绝并在对话里写明原因,而不是提交后才失败。
- 多图按添加顺序发送,序列化形状与 harness 客户端一致(`{type:"image",mediaType,data,name}`);修掉"同名文件互相顶掉"的去重错误(两张 `image.png` 会互相顶掉)。

### 权限药丸 / 服务连接
- 修复:权限请求与问答的应答报文缺 `sessionId`、且 `rpcId` 丢失,服务端返回 `{accepted:false}`,界面显示"server rejected response to undefined"。
- 加固:**扩展自启服务时使用与受管启动器一致的参数** —— `--max-old-space-size=8192 --report-on-fatalerror --report-directory=<DSH_HOME>/reports --use-system-ca`。此前自启的是裸 `node bin.js`:没有堆上限(大会话序列化会以静默 `0xC0000409` 中止)、没有崩溃报告、也没走系统证书库。
- 加固:端口无响应不再立刻"接管"——附着时先等待(默认 30 秒,`dshWeb.attachWaitSeconds`)给受管启动器留重启窗口,接管前要求连续探测确认(默认 45 秒,`dshWeb.takeoverAfterSeconds`)。此前一次 1.5 秒超时的探测失败就会让扩展抢走端口并顶掉受管实例。
- 加固:自启服务退出时退避重启,5 分钟内 3 次后停止自动重启并给出提示(此前固定 1.5 秒一次无限重启,表现为"harness 一直崩")。
- 新增设置:`dshWeb.attachWaitSeconds`、`dshWeb.takeoverAfterSeconds`、`dshWeb.nodeMaxOldSpaceMb`、`dshWeb.nodeArgs`(同时补充 README 设置表)。

### 兼容性
- harness 侧需在 `session.prompt` 路径派发命令注册表:`/permission` 等斜杠命令由服务端执行并把结果放进响应的 `command` 槽(harness 0.1.0-rc.5 缺这段实现,补丁提交 `513f7f4e14`)。缺它时权限药丸会退化成"发一条聊天消息"。

### 版本线说明
- `0.4.0`–`0.4.2` 是另一条 UI 重构线(药丸菜单即时展开、单卡片输入、行内重命名、`workspace.create` 结构修复、CI 打包等)。本版**不包含**那批 UI 改动,但已并入其提交历史(`merge`,0.4.x 的 tag 与 release 均保留),并采纳了它的发布工具链、CHANGELOG、`.vscodeignore`、`docs/ARCHITECTURE.md`、`THIRD_PARTY_NOTICES.md` 与 CI 工作流。

## 0.4.2

- 修复:`workspace.create` 响应结构解析错误(返回的是 `{workspace:{workspaceId,...}}`,少剥一层),导致**新窗口 / 未建过工作区的文件夹**里新建的会话既没有 workspaceId 也没有 cwd → 落到服务端默认目录 → 在 harness 里显示为"未分组",同时**不出现在该窗口的"本工作区"会话列表**。现在会先按窗口文件夹匹配工作区,匹配不到就调用 `workspace.create` 自动建立,再以 `workspaceId` 建会话,新会话正确入组且 cwd 等于该文件夹。

## 0.4.1

- 修复:历史事件水位读取错误字段,导致 `session/subscribed` 触发无限重拉循环(面板卡顿、RPC 轰炸的根因);现读 `event.seq`。
- 修复:"重启服务"对附着外部实例(桌面 harness)时改为直接重新探测并附着,不再弹误导提示。
- 修复:服务短暂掉线进入 error 后无自愈;现每 15 秒自动重试,桌面 harness 重启后面板自动恢复。
- 修复:药丸菜单在后台刷新时被整体替换,吞掉用户点击——现在刷新只更新标签,绝不重建已打开的菜单(模型/推理档切换卡顿、点了没反应的根因)。
- 修复:未打开会话时点模型/推理/权限药丸无任何反应;现在会弹出引导菜单("新建会话并继续"),建完自动打开对应菜单。
- 修复:会话重命名改用抽屉内行内编辑(原生 `prompt` 在 VS Code webview 中被禁用,此前点击永远无效)。
- 修复:重命名成功后抽屉行标题即时更新。

## 0.4.0

(2026-09-07)

- **Claude Code 式原生侧边栏**(替换 0.2.x 的 iframe 内嵌 WebUI):
  - 活动栏/辅助栏双入口 + 标题栏图标(`editor/title` + titleBar 模式);
  - 会话列表与 harness 本工作区同步(`workspaceId` 建会话,正确入组);
  - 流式对话、停止、工具卡/审批卡/Todo、Markdown、上下文占用环(harness 同款 14px 环 + 三段拆分面板);
  - harness 底栏移植:沙箱权限药丸(`/permission`,三档:只读/工作区写入/完整访问,投影双向实时同步)、模型/推理档药丸(2 秒同步轮询 + 点击即时开菜单)、预设药丸(空白会话可切,会话开始后锁定);
  - 发送/停止单按钮;运行中 Enter = 插入对话(steer);
  - 消息按 seq 去重,消除重复/空消息气泡。
- 修复:扩展扫描缓存指向已删旧目录导致扩展损坏;全局 `workbench.auxiliarybar.pinnedPanels` 状态手术;vsce 打包中文编码损坏(`test/fix-vsix.ps1`)。
- 一键排障:`fix-dsh.cmd`(缓存+状态双修,需完全退出 VS Code 后运行)。

## 0.3.x

原生侧边栏基座:协议客户端(`POST /api/*` + 双 WebSocket 下行)、会话/消息渲染、模型/预设切换、context-meter。详见 git log。

## 0.2.x 及更早

iframe 内嵌 dsh Web GUI 版(已被 0.3.x 起替代)。
