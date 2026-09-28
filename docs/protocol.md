# DSH 服务端协议速查(0.1.6 Typert API Gateway)

> 面向 dsh-webview 扩展的协议映射说明。基线:**deepseek-harness 0.1.6**
> (`apps/cli/package.json`)。协议变动时只改 `src/protocol.js` —— 网关端点、命名
> 参数、帧名与归一化全部集中在那一个文件里,`extension.js` 与 `webview/app.js`
> 只说这里定义的内部名。
>
> 0.1.0–0.1.5 是另一套 wire(单层 `POST /api/<method>` + 两条 SSE
> `/api/events.mux` 与 `/api/events.host` + `POST /api/respond`),本项目的 0.5.0 是那条线的
> 最后一版;两套 wire 互不兼容,不要按本文档去调旧 harness。

## 1. 鉴权(先换 cookie,再开 socket)

| 步 | 形式 |
|---|---|
| 1 | `dsh web` 启动时把启动 token 打到 stdout:`http://127.0.0.1:<port>/?token=<43 位 base64url>`;受管启动器落在 `~/.dsh/logs/server-<stamp>.log`,手工启动落在 `~/.dsh/web*.log` |
| 2 | `GET /?token=<token>` → **303 + `Set-Cookie`**,cookie 名形如 `dsh-auth-<authority>`(HMAC 密钥在凭据库里,所以 cookie 跨重启有效,只需换一次;303 本身故意不跟随) |
| 3 | 之后所有 `/api` 请求与 `remote.mux` 的升级请求都必须带这个 cookie,否则 401 |

扩展的 token 候选是**全量**的:按文件 mtime 新→旧、同一文件内后出现优先
(`extension.js` 的 `launchTokenCandidates`),因为过期 token 的 401 与"服务没了"
在表面上完全一样。拿到 cookie 后存 `globalState` 复用。

传输层用 `node:http` 而不是 `fetch`:扩展宿主里 `fetch` 换 token 会被 401,而同进程
`http.get` 是 303;`fetch` 的 `redirect:'manual'` 在部分运行时还被规范过滤成不可读的
opaque redirect(拿不到 `Set-Cookie`)。整个扩展不依赖 `fetch`。

## 2. 一元 RPC

```
POST /api/<ns>/<method>            content-type: application/json, cookie 必需
{ type:'client-request', rpcId, method:'<ns>/<method>', payload:{ args:{…} } }
→ { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error:{code,message,details} } }
```

业务错误恒为 HTTP 200,只有未鉴权是 401;`result.ok !== true` 一律抛 `RpcError`。
参数是**命名参数**(`payload.args` 的键必须与宿主签名同名),不是位置数组。

| 内部名 | 网关端点 | 实参 → 备注 |
|---|---|---|
| `host.describe` | `settings/describe` | `{}` → 版本、能力面 |
| `session.list` | `session/list` | `{_request:{}}` → `items[]`;工作区过滤在前端做(cwd 归一化),`origin:'subagent'` 的行剔除 |
| `session.models` | `session/modelCatalog` | `{}` → 目录里当前模型叫 `default`,归一化成 `current` 再给面板 |
| `session.prompt` | `session/prompt` | `{request:{requestId,sessionId,mode:'queue'\|'steer',content[],clientTimeZone?}}`;`requestId` 是客户端铸的 uuid |
| `session.cancel` | `session/cancel` | `{request:{sessionId}}` |
| `session.rename` | `session/rename` | `{request:{sessionId,title}}` |
| `session.fork` | `session/fork` | `{request:{sessionId,atSeq?}}` |
| `session.create` | `session/create` | `{request:{workspaceId?\|cwd?,agentPreset?,sessionId?}}`;响应是 `{workspace:{workspaceId}}` 时必须剥一层(0.4.2 的入组修复) |
| `session.selectModel` | `session/selectModel` | `{request:{sessionId,provider,model,reasoningEffort?}}`;不产生任何推送帧,跨端一致靠按需刷新 + `modelSelection` 投影 |
| `workspace.create` | `workspace/create` | `{request:{path}}` |
| `workspace.archiveSession` | `workspace/archiveSession` | `{request:{sessionId}}`(服务端无物理删除,归档 ≠ 删除) |
| `workspace.unarchiveSession` | `workspace/unarchiveSession` | `{request:{sessionId}}` |
| `agentPreset.list` | `agentPresets/list` | `{}` |
| `agentPreset.select` | `agentPresets/select` | `{agentId,agentPreset}`;宿主签名是 `select(agent, agentPreset)`,Agent 过线叫 `agentId`。会话级,已开始的会话返回 `agent-preset-locked` |
| `permissionPreset.catalog` | `permissionPresets/catalog` | 选项在这条一元目录里;`permissions` 投影只给 `currentValue` |
| `commands.execute` | `commands/execute` | `{agentId,line,submittedAttachments:[]}`;0.1.6 把 `attachments` 改名 `submittedAttachments`,用旧名报 `missing "submittedAttachments"; unexpected "attachments"` |
| `workspace.list` | — | **0.1.6 没有这条一元方法**;工作区行与归档集合改由 `workspace/follow` 的基线给出,见 §4 |
| `session.history` | `session/follow` / `session/page` | 流,见 §4 |
| `approvalRespond` / `questionAnswer` | `$events/result` | 见 §5 |

## 3. 单条 WebSocket:逻辑流协议

整条下行只有**一个** socket:`ws://127.0.0.1:<port>/api/remote.mux`(升级同样要 cookie)。
它是"多路流复用",本项目用其中的三条逻辑流:两条长订阅(`workspace/follow`、`$events`)
加一条按需的 `session/follow`。

| 方向 | 帧 |
|---|---|
| 上行 | `{type:'open', streamId, endpoint, payload:{args}}` 开一条流;`{type:'cancel', streamId}` 关它 |
| 下行 | `{type:'item', streamId, value}` 一个 `value` 帧;`{type:'end', streamId}` 正常结束;`{type:'error', streamId, error}` 失败 |

`streamId` 由客户端铸(`s1`、`s2`…)。**断线即全灭**:所有逻辑流的帧都走这一条 socket,
所以 `onError`/`onClose` 必须同时上报 `mux` 与 `host` 两条流 down,否则重连后 host 流
会被一直当成活的(0.6.0 修的正是这个);重连后由 `RemoteStream.openOn(socket)` 把所有
未关闭的流重新 `open` 一次。socket 掉线后 3 秒自行重连(仅 `attached`/`ready` 状态)。

`src/websocket.js` 是最小 RFC6455 客户端(无第三方依赖),**只收**:服务端对上行非
close 帧回 1008。

## 4. 三条流的帧语义

### 4.1 `workspace/follow` — 工作区基线

`onWorkspaceFrame` 用 `deepFind` 抠 `items` 与 `archivedSessionIds`(基线结构不在公开契约
里,所以是深找而不是写死路径)。字段缺失时**保留已有值**,不当作空集合 —— 把"读不到"
当成"没有归档"会让已归档会话立刻漏回列表。每次帧都 emit `host/workspace-changed`,
带归档集合时另 emit `host/archived-sessions-changed`。

### 4.2 `$events` — 宿主事件与 waterfall

| 下行 `value` | 处理 |
|---|---|
| `{type:'ready', clientId}` | 记下 `clientId`(应答 waterfall 时要带),并上报 host 流 up |
| `{type:'emit', event, args}` | **不要求应答**。`api-session/status`→运行中小圆点;`api-session/added`/`removed`;`api-session/activity`(列表排序);其余归到 `host/remote-event` |
| `{type:'waterfall', eventId, agentId, event, request}` | 要求应答,见 §5 |
| `{type:'cancel', eventId}` | 撤销某个待应答项 |

把 `emit` 当 waterfall 处理是 0.6.0 前的缺陷:它会在 `undefined` id 下登记一个假的
pending 项并把载荷丢掉,抽屉的"运行中"圆点因此永不动。

### 4.3 `session/follow` — 打开一个会话

```
open: session/follow, args = {request:{address:{kind:'session', sessionId}, assistantStream:true}}
```

首个 `item` 是快照 `{type:'snapshot', cursor, records[], hasMore, projections:{values}}`:
`records` 即历史事件,`cursor` 成为该会话的已提交水位,`projections.values` 逐键展开成
`session/projection` 帧(每个投影**各自**用同一个 cursor 去重,不是共用一个"已应用到哪个
seq"的守卫 —— 共用一个会让重连后权限药丸/占用环不再更新)。

快照之后:

| `item` | 处理 |
|---|---|
| `{type:'assistant-stream', frame}` | 进程内增量流(0.1.6 把打字机增量从 `assistant/chunk` 挪到了这里),转发成 `session/assistant-stream`;按**帧游标**去重,chunk 自带的块号会重复 |
| `{type:'event', event}` 或裸事件 | 转发成 `session/event`,并把 `event.seq` 记为新水位 |

`assistant-stream` 内层 chunk 类型:`block-start{index,blockType}`、`text-delta`、
`reasoning-delta`、`tool-call-delta`、`block-end{index,block}`、`usage`。

同一时刻**只跟一个会话**:切走时 `closeFollow` 关掉旧流,否则服务端会一直为它序列化、
帧也一直推过来。打开过程中掉线必须 reject 本次 `openSession` 的 Promise,不然面板既没有
新会话也不报错。

翻更早的历史走 `session/page`(`{request:{address,throughSeq,beforeSeq,maxMessages}}`),
`throughSeq` 用当前水位;拿不到游标就不发请求。

### 4.4 会话事件名(0.1.6)

| 事件 | 面板 |
|---|---|
| `turn/start` `turn/end` | 忙碌标记;回合结束重拉一次列表(生成的标题此时才落地) |
| `step/start` | 当前 step |
| `user/message` | 用户气泡。parts 在 `data.content`(旧 wire 在 `data.message.content`);`source.kind === 'plugin'` 的是插件注入上下文,渲染成系统行而不是用户气泡 |
| `assistant/message` | 定稿的助手消息(tool-call 块剔除) |
| `assistant/chunk` | 走同一个折叠器 |
| `tool/call` `tool/result` | 工具卡 |
| `tool/ptc-dispatch-start` `tool/ptc-dispatch` | 代码模式子调用(旧名 `tool/code-dispatch*` 已不再发) |
| `todo/write` | 待办卡 |
| `approval/asked` `approval/decided` | 权限卡;事件里字段是 **`id`**,帧里是 `approvalId` —— 只读后者会去重失效、同一请求渲染两张卡 |
| `compaction/start` `summary` `prune` | /compact 进度 |
| `session/title` `agent-preset/selected` `permission/preset` `sandbox/mode` `model/selection` `plan/mode` `request/context` | 顶栏 / 药丸 / 占用环 |

投影(`session/projection` 的 key):`tokenUsage`、`contextPressure`、`contextBreakdown`、
`title`、`todos`、`permissions`、`plan`、`goal`、`sessionStats`、`imageLimits`、
`modelSelection`、`inbox`(队列面板)、`subagentTiming`、`subagent`。占用环优先用
`contextPressure.pressureTokens/contextWindow`(真实计量),退化到 `tokenUsage` 合计并标注估算。

## 5. 权限 / 问答的应答(waterfall)

```
下行 $events: {type:'waterfall', eventId, agentId, event:'approval/request',
               request:{id, sessionId, toolName, reason}}
             {type:'waterfall', eventId, agentId, event:'user-questions/request',
               request:{sessionId, questions[]}}
上行: POST /api/$events/result
      { type:'client-request', rpcId, method:'$events/result',
        payload:{ args:{ clientId, eventId, outcome:{ kind:'result', value } } } }
```

`clientId` 是 `$events` 的 `ready` 帧发的那个;`eventId` 是 waterfall 帧的 id(不是请求
体里的 `id`)。两个都要带对:缺 `sessionId` 或丢了 `rpcId` 时服务端回
`{accepted:false}`,界面显示"server rejected response to undefined"。

- 权限应答 `value` 走 `approvalResponsePayloadSchema`,含 `sessionId` 与
  `outcome:'allowed-once'|'rejected'` 类字段;
- 问答应答走 `questionResponsePayloadSchema`,同样要求 `sessionId`;
- 0.1.6 把问答题注册成 **`user-questions/request`**(旧名 `question/request`),
  只认旧名会让提问卡永不显示(兼容分支仍保留旧名)。

回归脚本 `test/respond-wire-verify.js` 起一个会说 0.1.6 的假网关,把 `approval/*` 与
`question/*` 灌进面板,断言回传的正是上面的形状。

## 6. 附带约束

- **预设**:会话级,但仅空白会话可切(`agent-preset-locked` 之后只读)。
- **压缩**:走斜杠命令 `/compact`(由 `commands.execute` 执行,不是 `session.prompt`
  的 `command` 槽 —— 0.1.6 的 prompt 没有那个槽)。
- **视觉**:`session.prompt` 的 `content` 直接带 image 部件(base64 + mediaType);
  限额来自 `imageLimits` 投影,超限在提交前就拒绝。
- **服务端零改动**:本项目只消费上述协议;不做 `DSH_HOME` 隔离(自启也强制
  `DSH_HOME=~/.dsh`);不跑 prune;不引入第二个 Gateway。

## 7. Mock 与验证

`test/mock-016-server.js` 是这条 wire 的最小假服务端(cookie 握手、命名参数网关、
`remote.mux` 握手与帧编解码、`workspace/follow` + `$events` + `session/follow` 订阅)。
`respond-wire-verify.js`、`session-list-filter-verify.js`、`blank-session-verify.js`
都跑在它之上;`live-sync-verify.js` 用 jsdom 跑真实 `webview/app.js` 验实时折叠路径。
`real-launch-verify.js` 会去拉真的 `dsh web`,需要本机 checkout,属手动测试而非 CI 门禁。
