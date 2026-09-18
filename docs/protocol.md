# DSH 服务端协议速查(v0.3.0 原生侧边栏基座)

> 面向 dsh-webview 扩展的协议映射说明。基线:deepseek-harness 0.1.0-rc.5
> (apps/cli/package.json),运行中服务以 POST /api/host.describe 的 version
> 字段为准。服务端协议变动时只改 src/protocol.js。

## 1. 传输

| 面 | 形式 |
|---|---|
| 请求 | POST /api/<method>,信封 {type:'client-request', rpcId, method, payload} → {type:'server-response', rpcId, result:{ok,value|error}};业务错误恒 HTTP 200 |
| 下行 | WebSocket(非 SSE)两条:/api/events.mux(会话帧)+ /api/events.host(宿主帧),upgrade 校验 Host=回环;帧信封 {type:'server-request', rpcId, method, payload},业务帧语义在 payload.type(本项目 client 已归一化:payload 展开 + 带上 rpcId) |
| 应答 | POST /api/respond,信封 {type:'client-response', rpcId, result:{ok:true,value}}(回答 approval/question 类 server-request) |

Node 扩展自实现最小 RFC6455 客户端(src/websocket.js),无第三方依赖;下行只收(服务端对上行非 close 帧回 1008)。

## 2. 会话 RPC

| 方法 | payload → value |
|---|---|
| session.list | {} → items[{sessionId, updatedAt, running, blank, cwd, agentPreset, projections{values{title,…}}}];工作区过滤在前端(cwd 归一化) |
| session.create | {cwd|workspaceId 二选一, agentPreset?, sessionId?} → {sessionId, agentPreset} |
| session.history | {sessionId, beforeSeq?, maxMessages?} → {events[{event, view?}], hasMore, projections{asOfSeq,values}} |
| session.prompt | {sessionId, mode:queue|steer, content:[{text…}|{image,mediaType,data,name}], clientTimeZone?} → {accepted, command?};content 以 / 开头且仅一个文本块 = slash 命令(如 /compact) |
| session.cancel / rename / fork{atSeq?} / selectModel{provider,model,reasoningEffort?} / models / attachment / updateQueue / search | 见 rpc-map |

## 3. 事件帧(WebSocket mux/host)

- mux: session/event(sessionEvent: type/seq/time/data,assistant/chunk 流式、tool/call|result、todo/write、approval/asked|decided、compaction/*、turn/*、step/*、request/context{contextWindow} 等)、session/projection(key∈ tokenUsage/contextPressure/contextBreakdown/title/todos/permissions/plan/goal/sessionStats/imageLimits/subagentTiming/subagent)、session/subscribed{lastSeq}、session/queue、session/jobs、approval/requested|resolved、question/requested|resolved。
- host: host/session-added|removed|status、host/workspace-changed|removed|order-changed、host/archived-sessions-changed、host/remote-event(如 agent-preset/selected)。
- chunk 类型:block-start{index,blockType},text-delta,reasoning-delta,tool-call-delta,block-end{index,block},usage。
- context-meter 用 contextPressure.pressureTokens/contextWindow(真实计量)或 tokenUsage 合计兜底并标注估算。

## 4. C1/C2/C3/C4 验证结论(2026-09-07 实测)

- C1 预设:会话级,但仅空白会话可切(agentPreset.select;已开始返回 agent-preset-locked)。UI:新建会话时选 + 空白期可切,开始后只读(测试已全绿)。
- C2 压缩:服务端经 slash 命令 /compact(session.prompt 触发),进度经 compaction/start|end|summary|prune 事件。
- C3 审批:approval/requested(mux)→ POST /api/respond{approvalId, outcome:'allowed-once'|'rejected'}→ approval/resolved。
- C4 视觉:prompt content 直接带 image 部件(base64 + mediaType);imageLimits projection 提供限额。

## 5. 服务端无改动

本扩展仅消费上述协议;不做 DSH_HOME 隔离(强制 spawn 时 DSH_HOME=~/.dsh);不跑 prune;不引入第二个 Gateway。
