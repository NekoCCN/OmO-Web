# OmO Web 内部接口

除静态资源外，以下接口仅供本机同源浏览器使用。成功返回 JSON（SSE 除外），错误为非 2xx `{error: string, code: string}`。POST 要求 `Content-Type: application/json`、同源 `Origin` 和 `X-OmO-Token`（从 `/api/bootstrap` 获取）。不支持跨域。

## 读取

- `GET /api/bootstrap` → `{ token, engine: {online,version?,error?}, workspaces: string[], sessions: Session[], handoff: {supported,reason?} }`。`handoff.supported` 表示当前配置有私有认证宿主、同一 CLI profile 和必需的原生能力；不是具体会话的释放承诺。
- `GET /api/sessions` → `{sessions: Session[]}`。`Session = { id, name, cwd, updatedAt, archived, settled, active, running }`；`id` 是 Web 端 UUID，与临时路由句柄无关。`updatedAt` 为毫秒。
- `GET /api/sessions/:id` → `{ session: Session, state, messages, handoff: {eligible,reason?} }`，原生状态经字段筛选后返回：`model`, `thinkingLevel`, `fastMode`, `isStreaming`, `isCompacting`, `currentTurnId`, `pendingDialogs`, `pendingQuestions`, `pendingMessageCount`, `permissionPreset`, `autoCompactionEnabled`, `contextUsage`, `usageTotals`。`model` 至多包含 `{id,provider,name,contextWindow,maxTokens,reasoning,input,supportedThinkingLevels}`。`messages` 保持原生 `role/content/timestamp/toolName/toolCallId/isError/stopReason/errorMessage` 形状。未加载的历史会话先显式执行 `resume`，然后读取。`handoff.eligible` 是当前状态提示；实际释放时原生引擎会再次判断。
- `GET /api/sessions/:id/last-assistant` → `{text: string | null}`，只读取当前已加载会话的原生最后一条可复制助手文本。
- `GET /api/sessions/:id/options` → `{models, levels, commands}`，模型按上面的投影，命令含 `{name,description,source,invocation}`，其中 `source` 是 `extension`、`prompt` 或 `skill`，`invocation` 是规范的 `/命令` 或 `$技能`。不返回原生 `sourceInfo`。
- `GET /api/sessions/:id/details` → `{stats, queue, tree}`，分别为原生 `get_session_stats`、`get_pending_inputs`、`get_tree` 的数据（不含顶层文件路径）。
- `GET /api/sessions/:id/activity` → `Activity`。只接受已加载的 Web 会话 ID；服务端用内部 durable session ID 和该会话已授权的工作目录查找原生快照。没有加载的 Web 会话不会由该接口打开。
- `GET /api/cli-history` → `{available, sessions: CliSession[]}`。`CliSession = {id, name, cwd, updatedAt}`；`cwd` 为服务器授权的工作目录，`updatedAt` 为毫秒。`available:false` 表示读取已关闭或找不到可读的本地历史目录；`available:true` 且 `sessions:[]` 表示没有可显示的记录。
- `GET /api/cli-history/:id` → `{session: CliSession, messages}`。ID 是本进程最近一次 CLI 列表返回的选择键，不是原生 ID、Web ID 或路径；过期需重新读取列表。仅返回最新分支上可显示的对话投影，不返回原始 journal。
- `GET /api/cli-history/:id/activity` → `Activity`。先校验所选历史记录仍属于授权工作目录，再查找它的原生快照；列表、记录和快照都不接入 CLI 进程，不依赖 RPC 在线。
- `GET /api/cli-live` → `{available, sessions: CliLiveSession[]}`。`CliLiveSession = {id, name, cwd, attached, running}`。`id` 是此 Web 服务在发现时分配的稳定不透明键，不是原生会话、宿主、文件或 socket 标识；服务重启或原生身份变化后需重新发现。`attached` 是本 Web 服务的附着状态。`available:false` 表示实时发现不可用或已禁用；可用的空列表表示没有匹配候选。只读发现不会附着。
- `GET /api/cli-live/:id` → `{session: CliLiveSession, state: {running, compacting, turnId}, messages}`，需要先 `connect`。`turnId` 为当前回合字符串或 `null`；消息只投影可显示的文字、角色及可选时间戳、流式标记或可见会话投递类型。没有凭据、原生路由、transcript 路径、工具参数或交互表单。
- `GET /api/{sessions|cli-history|cli-live}/:id/branch-options` → `{canClone, forkMessages: [{entryId, text}]}`。仅预览，不启动分支写操作。三种 ID 不能混用：Web 用所选 Web 会话，CLI 历史用列表返回的授权记录（最后保存的上下文），实时 CLI 必须已连接、空闲、且能把当前 native leaf 与同 profile 的授权记录匹配。匹配失败不退回历史。
- `GET /api/events` → SSE。事件名为 `omo`，数据 `{type, sessionId?, ...}`。全局 `ready` / `engine` / `sessions` 通知重读状态；会话增量包括 `agent_start`, `agent_end`, `agent_settled`, `message_start`, `message_update`, `message_end`（`message` 是到目前为止的完整消息，不是单个 token），以及工具、问题、压缩、队列等原生事件。`agent_end` 只结束内部运行；`agent_settled` 才表示回合与自动重试、队列后续都已结束。`sessionId` 是 Web ID。断线重连先重读会话快照，事件不保证重放。

CLI 实时的事件仅为 `{type:"cli-live", id}`；客户端只刷新当前已连接且 ID 匹配的实时快照。连接成功及 SSE 重连读取基线，可重试快照读取，不自动重做任何动作。

`Activity` 是 `{status:"ok", updatedAt, connected?, language?, runs, tasks}` 或 `{status:"unavailable", reason}`。`updatedAt` 是快照时间（毫秒），`connected` 若有值，是快照写入时的状态；两者不代表当前活动。运行包括 DAG 节点、状态、尝试次数和依赖，任务包括子代理的摘要元数据；不返回 durable session ID、原始日志或快照文件路径。

## 写入

- `POST /api/sessions` `{cwd, name?}` → `{session: Session}`，目录须为可选根之一。
- `POST /api/sessions/:id/actions`，body 为 `{action, ...}`，成功返回 `{result, session: Session}`。`result` 是筛选后的 RPC 结果；界面正常情况下只需以此为完成信号。

| `action` | 字段 |
| --- | --- |
| `resume` | — |
| `prompt` | `message`, `mode?: "prompt" \| "steer" \| "follow_up"`, `clientMessageId?`, `expectedTurnId?`, `images?: {type:"image",data:string,mimeType:string}[]` |
| `command` | `invocation`, `arguments?`（单行文本）, `clientMessageId?`；在当前 Web 会话重新校验命令注册表和空闲状态。未知命令不降级为模型提示，忙碌时不排队。 |
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

### 同一会话顺序换端

- `POST /api/cli-history/:id/resume` `{}` → `{session: Session}`。ID 必须来自本进程最近的授权 CLI 历史列表。原生宿主持有者校验通过时，在 Web 打开同一份日志并保存或复用 Web 书签，不创建新原生会话、不复制日志。已有进程持有时会拒绝，不关闭它。
- `POST /api/sessions/:id/handoff` `{}` → `{session: Session, command: string}`。会话须已加载，且原生确认已安静释放同一份日志。成功时 `session.active:false`；`command` 是供操作者在本机终端手动运行的 Shell 文本，包含授权工作目录、同一 profile 和会话文件路径，不包含控制 socket 或其凭据。请求不接受目标路径或打断选项；失败不返回可执行命令，传输结果不明时不要自动重放。
- 同一个 Web `id` 后续仍用 `actions {action:"resume"}` 恢复。跨端书签会重新验证来源、原生持有者和 durable ID。客户端不要把已释放的旧路由、草稿或 Fork/Clone 结果当作原生所有权凭证。

### CLI 实时动作

`POST /api/cli-live/:id/actions` 只接受下表结构，未知字段拒绝。无附着返回 `409`；失效 ID 返回 `404`，需重新发现。`disconnect` 是幂等释放，未附着时返回 `{detached:false}`。

| `action` | 额外字段 | 成功结果 |
| --- | --- | --- |
| `connect` | 无 | 与实时快照相同 |
| `disconnect` | 无 | `{detached: boolean}`；只释放本 Web 服务的连接 |
| `input` | `mode: "prompt"`、`message`（普通纯文字，最多 64,000 字符）、`clientMessageId` | `{disposition:"started" \| "queued" \| "held", clientMessageId, duplicate}`；`held` 表示暂存，不等于已经执行 |
| `stop` | `expectedTurnId`（最近实时快照中看到的回合字符串） | `{interrupted:true, turnId}`；过期回合返回 `409`，不停止其他回合 |

不接受原生命令、私密交互、权限答复、路径、跨 profile 标识或任意 RPC。收到 `terminal_outcome_unknown` 时，应重读并人工核对 CLI，不重发原写入。

### 独立分支与复制

`POST /api/{sessions|cli-history|cli-live}/:id/branches` 接受 `{kind:"fork", entryId}` 或 `{kind:"clone"}`，来源只由 URL 对应的 Web 选择键解析，不接受路径或 leaf。成功 `201 {session: Session, editorText?}`；新会话已在 Web 应用原生权限预设，来源仍独立可选。Fork 从选中用户消息之前开始，`editorText` 只用于填充新会话的草稿，不自动发送；Clone 保留所选来源的当前上下文。原生取消为 `200 {cancelled:true}`。
