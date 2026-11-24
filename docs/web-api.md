# OmO Web 内部接口

除静态资源外，以下接口仅供本机同源浏览器使用。成功返回 JSON（SSE 除外），错误为非 2xx `{error: string, code: string}`。POST 要求 `Content-Type: application/json`、同源 `Origin` 和 `X-OmO-Token`（从 `/api/bootstrap` 获取）。不支持跨域。

## 读取

- `GET /api/bootstrap` → `{ token, engine: {online,version?,error?}, workspaces: string[], sessions: Session[] }`
- `GET /api/sessions` → `{sessions: Session[]}`。`Session = { id, name, cwd, updatedAt, archived, settled, active, running }`；`id` 是 Web 端 UUID，与临时路由句柄无关。`updatedAt` 为毫秒。
- `GET /api/sessions/:id` → `{ session: Session, state, messages }`，原生状态经字段筛选后返回：`model`, `thinkingLevel`, `fastMode`, `isStreaming`, `isCompacting`, `currentTurnId`, `pendingDialogs`, `pendingQuestions`, `pendingMessageCount`, `permissionPreset`, `autoCompactionEnabled`, `contextUsage`, `usageTotals`。`model` 至多包含 `{id,provider,name,contextWindow,maxTokens,reasoning,input,supportedThinkingLevels}`。`messages` 保持原生 `role/content/timestamp/toolName/toolCallId/isError/stopReason/errorMessage` 形状。未加载的历史会话先显式执行 `resume`，然后读取。
- `GET /api/sessions/:id/options` → `{models, levels, commands}`，模型按上面的投影，命令含 `{name,description,source?}`。
- `GET /api/sessions/:id/details` → `{stats, queue, tree}`，分别为原生 `get_session_stats`、`get_pending_inputs`、`get_tree` 的数据（不含顶层文件路径）。
- `GET /api/events` → SSE。事件名为 `omo`，数据 `{type, sessionId?, ...}`。全局 `ready` / `engine` / `sessions` 通知重读状态；会话增量包括 `agent_start`, `agent_end`, `agent_settled`, `message_start`, `message_update`, `message_end`（`message` 是到目前为止的完整消息，不是单个 token），以及工具、问题、压缩、队列等原生事件。`agent_end` 只结束内部运行；`agent_settled` 才表示回合与自动重试、队列后续都已结束。`sessionId` 是 Web ID。断线重连先重读会话快照，事件不保证重放。

## 写入

- `POST /api/sessions` `{cwd, name?}` → `{session: Session}`，目录须为可选根之一。
- `POST /api/sessions/:id/actions`，body 为 `{action, ...}`，成功返回 `{result, session: Session}`。`result` 是筛选后的 RPC 结果；界面正常情况下只需以此为完成信号。

| `action` | 字段 |
| --- | --- |
| `resume` | — |
| `prompt` | `message`, `mode?: "prompt" \| "steer" \| "follow_up"`, `clientMessageId?`, `expectedTurnId?`, `images?: {type:"image",data:string,mimeType:string}[]` |
| `abort` | — |
| `rename` | `name` |
| `archive`, `settle`, `fast`, `autoCompaction` | `enabled: boolean` |
| `model` | `provider`, `modelId` |
| `thinking` | `level` |
| `compact` | `instructions?` |
| `clearQueue` | — |
| `navigate` | `targetId` (`null` for empty context) |
| `answer` | `requestId` 和 `value` / `confirmed` / `cancelled` / `answers` 中的一种；按照原生问题约定回传 |

附件最多 4 张，限 PNG/JPEG/GIF/WebP。工具批准、衍生动作或提问一律展示给操作者，不替操作者选值。
