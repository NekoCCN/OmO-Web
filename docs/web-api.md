# OmO Web 内部接口

默认仅接受本机回环请求；显式启用全接口时，`Host` 和可选 `Origin` 必须匹配配置的 HTTPS 访问地址。不接受跨站或不同源的同站请求，也不信任代理转发头。配置密码后，静态资源、API 和 SSE 都先校验 HTTP Basic 凭据，缺少或凭据不正确时返回空正文的 `401` 和 `WWW-Authenticate`。

API 成功返回 JSON（SSE 除外），其余错误为非 2xx `{error: string, code: string}`。POST 还要求 `Content-Type: application/json`、同源 `Origin` 和 `X-OmO-Token`（从 `/api/bootstrap` 获取）。密码鉴权不替代同源校验或 POST token。部署见[密码与远程访问](usage.md#密码与远程访问)。

## 读取

- `GET /api/bootstrap` → `{ token, engine: {online,version?,error?}, workspaces: string[], sessions: Session[], handoff: {supported,reason?}, fileBrowser: {platform:"win32"|"posix"} }`。旧服务没有 `fileBrowser` 时不显示浏览入口。`handoff.supported` 表示当前配置有私有认证宿主、同一 CLI profile 和必需的原生能力；不是具体会话的释放承诺。
- `GET /api/sessions` → `{sessions: Session[]}`。与 bootstrap 一样，只列当前目录身份仍获授权的记录。`Session = { id, name, cwd, updatedAt, archived, settled, active, running }`；`id` 是 Web 端 UUID，与临时路由句柄无关。`updatedAt` 为毫秒。
- `GET /api/sessions/:id` → `{ session: Session, state, messages, handoff: {eligible,reason?} }`，原生状态经字段筛选后返回：`model`, `thinkingLevel`, `fastMode`, `isStreaming`, `isCompacting`, `currentTurnId`, `pendingDialogs`, `pendingQuestions`, `pendingMessageCount`, `permissionPreset`, `effectivePermissionPreset`, `autoCompactionEnabled`, `contextUsage`, `usageTotals`。审批选择器显示 `effectivePermissionPreset || permissionPreset`；每次恢复/重开会话都回到 `ask`，不会自动沿用上次的 `auto`/`full-access`。``model` 至多包含 `{id,provider,name,contextWindow,maxTokens,reasoning,input,supportedThinkingLevels}`。`messages` 保持原生 `role/content/timestamp/toolName/toolCallId/isError/stopReason/errorMessage` 形状。未加载的历史会话先显式执行 `resume`，然后读取。`handoff.eligible` 是当前状态提示；实际释放时原生引擎会再次判断。
  - 历史完整时省略 `transcript`。`transcript: {status:"truncated"}` 表示 `messages` 是当前原生上下文的有界近期窗口，不支持从此接口分页取回被省略的历史。窗口最多保留 240 条可见消息及 5 MiB 的行预算，单条超过 2 MiB 或结构预算时也可省略。
  - `transcript: {status:"unavailable"}` 表示本地读取器达到上限（物理帧最多 64 MiB，另有深度和解析工作量上限），`messages: []` 不代表没有历史。只有同一会话绑定的原生状态仍可核验时才返回此状态；原生拒绝、无效回复和连接丢失仍按错误返回。读取不提交或重发任何操作。
- `GET /api/sessions/:id/last-assistant` → `{text: string | null}`，只读取当前已加载会话的原生最后一条可复制助手文本。
- `GET /api/sessions/:id/options` → `{models, levels, commands}`，模型按上面的投影，命令含 `{name,description,source,invocation}`，其中 `source` 是 `extension`、`prompt` 或 `skill`，`invocation` 是规范的 `/命令` 或 `$技能`。不返回原生 `sourceInfo`。
- `GET /api/sessions/:id/details` → `{stats, state?, sessionMemory, generationSpeed?}`。概览不读取输入队列原文、树或分支运行详情。`state` 提供所需的模型、运行模式与用量；只有原生状态返回有效非负整数时，才提供 `pendingMessageCount`（缺失表示数量未知，不是零）。`usageTotals.latestCacheHitRate` 是原生百分比；累计命中率按 `cacheRead / (input + cacheWrite + cacheRead)` 计算。`sessionMemory` 只匹配当前路由，区分 OmO 宿主主堆与该会话的内核统计。
- `GET /api/sessions/:id/queue` → `{inputs: [{text, state?, requestedMode?}], truncated}`。只读，限当前已打开且工作目录仍获授权的会话，不接受查询参数。最多预览 30 条待处理输入，每条文本最多 240 个 UTF-16 码元，不切断代理对；超出预览预算标记为截断。不返回原生标识、路径、游标、处理结果或其他元数据。原生读取不分页，仍受现有 RPC 响应上限约束：超限返回 `502 queue_too_large`，其他原生读取失败返回 `502 queue_read_failed`，不透传原生错误。失败不影响概览，清空队列仍需通过显式 `clearQueue` 操作。
- `GET /api/sessions/:id/tree`（可选 `?cursor=…`）→ `{nodes: [{id, parentId, type, role?, label?, summary?}], leafId: string|null, nextCursor?}`。按追加顺序返回一页，最多 40 项；`leafId` 是当前选择，不一定是最新追加条目。原生条目字节软上限为 256 KiB，允许单条超过；Web 仅返回结构和允许展示的类型、角色，不返回正文、原始标签、工具或隐藏上下文。游标为进程内不透明值，绑定当前宿主、会话实例及叶节点；有效期至多 10 分钟，也会因有界缓存淘汰而失效。失效、外来游标或选中叶节点变化返回 `409 tree_stale`，应显式重新加载；无效参数返回 `400`。不得从稀疏页推断未知祖先或完整树。
- `GET /api/sessions/:id/branch-runtime` → `{status:"ok", leafId, todo, memory}` 或 `{status:"unavailable", reason}`。只在验证完整历史索引和活动祖先后，投影 Todo 与长期记忆召回统计；不返回原始扩展数据、记忆提示或路径。最多读 4 页，每页 40 项、256 KiB。超过预算（包括单条超出软上限）或投影截断时返回 `unavailable/incomplete`；不回退读取整棵树。
- `GET /api/sessions/:id/model-preview?provider=…&modelId=…` → `{status:"ok", level, source, availableLevels}` 或 `{status:"unavailable"}`。必须恰好带 `provider` 与 `modelId` 各一个，只读预览当前会话目标模型的生效档位与来源，不切换、不写入、不缓存。模型不在当前可用列表时返回 `404`；模型待切换、Web 正在更改模型设置，或读取期间会话绑定或模型状态变化时返回 `409`。写入仍走 `actions` 的 `model`（`set_model scope:session`）与 `thinking`（`set_thinking_level scope:turn`），要求会话空闲且未归档。
- `GET /api/sessions/:id/capabilities` → `{extensions, mcpServers, commands}`，三组独立 `ok / unavailable`。`ok` 为 `{rows, incomplete}`，每组至多取原生顺序前 128 条；`incomplete:true` 表示有过滤或截断，不作“无条目”。扩展含名称、启用与可选来源（`package/top-level`，缺省不推断）；MCP 为原生报告的状态与工具数，不代表可调用；命令沿用 `options` 的名称、来源与调用形式。只读清单，不提供安装、启用与连接管理。
- `GET /api/sessions/:id/workbench-status` → `{status:"ok", currentTodo?, pendingTodo}`、`{status:"empty"}` 或 `{status:"unavailable", reason}`。仅用一页（40 项、256 KiB）证明当前分支的待办。无记录、截断、身份变化和明确零项分开。不会打开或恢复会话。
- `GET /api/sessions/:id/native-runtime` → `{tasks, dag, memory}`。每区可为 `ok / unavailable / malformed / ownership_changed`，`tasks` 与 `dag` 另有 `empty`。非空时投影原生顺序最多 256 行的状态和时间，任务可含允许展示的内建角色、类别和执行模式，DAG 另含节点数、可用状态计数和不透明 `key`；`memory` 仅返回本会话原生日志的两项步数计数。合法空列表不拿旧快照补位；不返回自由文本标题、原生路由、持久身份、任务与运行标识、路径、提示、输出或错误细节。
- `GET /api/sessions/:id/native-runtime/dag/:key` → 成功 `{status:"ok",runStatus,waves:[{index,nodes}],nodes:[{id,state,attempt,upstream,agent?,category?}]}`；波次、节点及依赖均用从 `0` 开始的本地编号。`key` 只能由同一 Web 会话、当前宿主绑定与当前列表取得；对于未知、过期或不属于当前绑定的键，返回 `not_found` 状态，不请求任意原生运行。最多 64 节点；不完整或无效拓扑返回 `malformed`，不回传部分图。读取中归属变化返回 `ownership_changed`。

树、分支、待办与原生运行详情读取只用于已授权且绑定可核验的会话；未知 Web 会话返回 `404`，已替换或不再授权的目录被拒绝。树、分支和待办读取不支持监听宿主；除树的单个 `cursor` 外，概览、树、分支和待办读取不接受查询参数。这些读取不开新会话，也不接纳用户提供的原生会话标识或方法；任务写入和 DAG 控制均未开放。
- `GET /api/sessions/:id/activity` → `Activity`。只接受已加载的 Web 会话 ID；服务端用内部 durable session ID 和该会话已授权的工作目录查找原生快照。没有加载的 Web 会话不会由该接口打开。
- `GET /api/cli-history` → `{available, sessions: CliSession[]}`。`CliSession = {id, name, cwd, updatedAt, adopted}`；`cwd` 为服务器授权的工作目录，`updatedAt` 为毫秒。`adopted:true` 表示该原生会话已有 Web 别名（按原生 ID 与工作目录合并），普通侧栏不再重复列出；进入仍走 `resume` 并受持有者接纳。`available:false` 表示读取已关闭或找不到可读的本地历史目录；`available:true` 且 `sessions:[]` 表示没有可显示的记录。
- `GET /api/cli-history/:id` → `{session: CliSession, messages}`。ID 是本进程最近一次 CLI 列表返回的选择键，不是原生 ID、Web ID 或路径；过期需重新读取列表。仅返回最新分支上可显示的对话投影，不返回原始 journal。
- `GET /api/cli-history/:id/activity` → `Activity`。先校验所选历史记录仍属于授权工作目录，再查找它的原生快照；列表、记录和快照都不接入 CLI 进程，不依赖 RPC 在线。
- `GET /api/cli-follow` → `{status:"ok", session:{id, name, cwd, running}, messages: TerminalMessage[]}` 或 `{status:"none"|"ambiguous"|"unavailable"}`。只观察能前后核验为唯一来源的终端登记，`cwd` 必须精确匹配授权的规范路径。空登记为 `none`；多个登记名称为 `ambiguous`，不剔除无法认证或未经授权的候选来选取唯一终端；禁用、身份或目录变化、超时及其他无法核验的情况为 `unavailable`。非 `ok` 不返回候选元数据。消息仅含现有终端文字投影；不透明 `id` 不能用于 `cli-live` 附着。不附着、不发送、不读磁盘历史。
- `GET /api/cli-live` → `{available, sessions: CliLiveSession[]}`。`CliLiveSession = {id, name, cwd, attached, running}`。`id` 是此 Web 服务在发现时分配的稳定不透明键，不是原生会话、宿主、文件或 socket 标识；服务重启或原生身份变化后需重新发现。`attached` 是本 Web 服务的附着状态。`available:false` 表示实时发现不可用或已禁用；可用的空列表表示没有匹配候选。只读发现不会附着。
- `GET /api/cli-live/:id` → `{session: CliLiveSession, state: {running, compacting, turnId}, messages}`，需要先 `connect`。`turnId` 为当前回合字符串或 `null`；消息只投影可显示的文字、角色及可选时间戳、流式标记或可见会话投递类型。没有凭据、原生路由、transcript 路径、工具参数或交互表单。
- `GET /api/{sessions|cli-history|cli-live}/:id/branch-options` → `{canClone, forkMessages: [{entryId, text}]}`。仅预览，不启动分支写操作。三种 ID 不能混用：Web 用所选 Web 会话，CLI 历史用列表返回的授权记录（最后保存的上下文），实时 CLI 必须已连接、空闲、且能把当前 native leaf 与同 profile 的授权记录匹配。匹配失败不退回历史。
- `GET /api/events` → SSE。事件名为 `omo`，数据 `{type, sessionId?, ...}`。全局 `ready` / `engine` / `sessions` 通知重读状态；会话增量包括 `agent_start`, `agent_end`, `agent_settled`, `message_start`, `message_update`, `message_end`（`message` 是到目前为止的完整消息，不是单个 token），以及工具、问题、压缩、队列等原生事件。`agent_end` 只结束内部运行；`agent_settled` 才表示回合与自动重试、队列后续都已结束。`sessionId` 是 Web ID。断线重连先重读会话快照，事件不保证重放。

CLI 实时的事件仅为 `{type:"cli-live", id}`；客户端只刷新当前已连接且 ID 匹配的实时快照。连接成功及 SSE 重连读取基线，可重试快照读取，不自动重做任何动作。

`Activity` 是 `{status:"ok", updatedAt, connected?, language?, runs, tasks}` 或 `{status:"unavailable", reason}`。`updatedAt` 是快照时间（毫秒），`connected` 若有值，是快照写入时的状态；两者不代表当前活动。运行包括 DAG 节点、状态、尝试次数和依赖，任务包括子代理的摘要元数据；不返回 durable session ID、原始日志或快照文件路径。运行详情仅在原生明确返回 `unsupported` 时才回退读旧快照；普通 `500`、归属变化、超时与 HTTP 拒绝均不触发对 `/activity` 的读取，不把不可用当作空。

## 工作区浏览与授权

- `POST /api/workspaces/browse` `{path}` → `{path, parent: string|null, entries: [{name, path, kind:"directory"|"file"}], truncated: boolean}`。只列已授权根及其规范子目录；没有可浏览的上级时 `parent:null`。每次从目录迭代器至多处理 256 项（另取一项判断是否截断），跳过符号链接、目录联接等非普通条目。不打开所列文件，不返回文件内容，不提供下载或执行。
- `POST /api/workspaces/prepare` `{path}` → `{status:"authorized", path, workspaces: string[]}`（已授权的精确根）或 `{status:"confirmation_required", path, confirmation: string, expiresAt: number}`（`expiresAt` 为毫秒时间戳）。只校验目录，不枚举内容、不授权。路径使用宿主绝对路径；Windows 仅接受本机盘符绝对路径，不接受 UNC、设备、盘符相对路径或备用数据流。路径及浏览条目不接受控制字符、Unicode 格式控制（含双向格式字符）和行／段分隔符。不展开 `~` 或环境变量。
- `POST /api/workspaces/confirm` `{confirmation, allow: boolean}` → 同意返回 `{path, workspaces: string[]}`；拒绝返回 `{status:"cancelled"}`。确认编号两分钟内有效，两种决定都只可提交一次；过期、重放或目录身份已变化返回 `409`。不接受路径。

Bun 1.4.5 的 `opendir().read()` 可在首次读取时将整个目录的条目载入内存。256 项限制的是应用处理和响应大小，不是运行时枚举或内存的硬上限。

会话新建、恢复、CLI 发现及跟随要求精确根；浏览某个子目录不会授权在其中运行。没有记录目录身份的旧 Web 会话，只能在仍与本次启动配置相符的原目录下列出和恢复，不能借临时授权重新绑定。新增授权只在当前 Web 服务运行期有效，不改配置、既有会话的工作目录或原生工具权限，也不是原生运行时沙箱。服务重启只加载配置的根。

## 写入

- `POST /api/sessions` `{cwd, name?}` → `{session: Session}`，目录须为可选根之一。
- `POST /api/sessions/:id/actions`，body 为 `{action, ...}`，成功返回 `{result, session: Session}`。`result` 是筛选后的 RPC 结果；界面正常情况下只需以此为完成信号。

| `action` | 字段 |
| --- | --- |
| `resume` | — |
| `prompt` | `message`, `mode?: "prompt" \| "steer" \| "follow_up"`, `clientMessageId?`, `expectedTurnId?`, `images?: {type:"image",data:string,mimeType:string}[]` |
| `command` | `invocation`, `arguments?`（单行文本）, `clientMessageId?`；在当前 Web 会话重新校验命令注册表和空闲状态。未知命令不降级为模型提示，忙碌时不排队。`/todo`、`/tasks`、`/dag`、`/task-kill`、`/reasoning`、`/efforts`、`/scoped-models`、`/favorite-models` 不走原生转发，直接作为 `prompt` 命令开头提交也会被拒绝。 |
| `abort` | — |
| `rename` | `name` |
| `archive`, `settle`, `fast`, `autoCompaction` | `enabled: boolean` |
| `model` | `provider`, `modelId` |
| `thinking` | `level` |
| `compact` | `instructions?` |
| `clearQueue` | — |
| `navigate` | `targetId`，`expectedLeafId?: string \| null`；把树页的叶节点（包括 `null`）交给原生比较后切换。省略时先用有界 `get_entries` 读取权威叶节点，不用最后追加条目的 ID。只操作当前 Web 会话，忙碌或存在待处理输入/问题时拒绝；叶节点过期返回 `409`。切换不发送消息；原生返回的编辑草稿至多 200,000 UTF-8 字节，超出则省略而不截断。 |
| `answer` | `requestId` 和 `value` / `confirmed` / `cancelled` / `answers` 中的一种；按照原生问题约定回传 |
| `preset` | `preset: "ask" \| "auto" \| "full-access"`；按会话调用原生 `set_permission_preset`，须回执 `applied` 且 `get_state.effectivePermissionPreset` 一致才算成功。`auto` 要求原生能力 `permission_preset_auto`，否则 `409`；`full-access` 须用户显式选择（界面有风险确认），不改全局 profile 与项目信任（`--no-approve` 只是启动期项目信任，不是用户审批）。结构化问题（`method: question`）在任何预设下仍需显式 `answers`，私密/secret 输入永不投射到浏览器 |

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
