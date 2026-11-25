# OmO Web · CLI 同义能力覆盖

> §1–§8 记录实施前的覆盖基线；不要用这些行判断本轮新功能是否已交付。当前验收增量见下方。
> 方法：读本工作树实际源码 + 随附运行时文档 + 两版历史静态盘点；不打开用户 profile、
> 不碰账户、不产生外部副作用。凡未实际运行验证的，一律标为推断或不可用，不声称完成。

## 本轮验收增量（Linux，5.1.81 / 2026.11.19-5）

| 能力 | 当前证据 | 结论边界 |
| --- | --- | --- |
| 启动主工作台的私有原生宿主 | 隔离 `HOME` 与 profile、实际 `src/main.ts`、真实 OmO；浏览器 API 能创建会话；关服务后私有 socket 目录消失（`PRODUCTION_ENTRY_NATIVE_OK`、`PRODUCTION_ENTRY_CLEAN_EXIT_OK`） | 不是共享宿主、多端并发或新版本兼容证明。 |
| 在 Web 主输入框使用内建 slash | 隔离的真实 Chromium → Web → OmO。`/name` 改名；`/session` 打开详情；`/fork` 呈现实际可选用户消息；`/copy` 将原生最后一条助手回复写入并读回 Chromium 剪贴板；`/thinking` 改变当前档位且未改写 profile；`/settings` 拒绝，整个场景只有一条普通消息进入回环模型 | 确认这些行为；其余命令形式不能套用此浏览器结果。 |
| 同一对话顺序换端 | `scripts/verify-session-handoff.ts --browser --slash` 实际点击两个 Web 入口，和真实 CLI 来回换端。验证同 ID 和日志、活跃持有者拒绝、忙时交接拒绝、服务重启、原生改名、选中分支、每条用户输入仅一次；执行返回的终端命令时，即使有不同的继承配置也能进入原 profile | Web 创建时默认仍用 Web 存储目录；用 Web 提供的 `omo --session` 命令进入该会话。不是 `/resume` 暂停引擎回合的等价，也不把 CLI 手动操作算成 Web 能力。 |
| 从续聊中的 CLI 原会话 Fork / Clone | 同一脚本实际使用 CLI 来源的原生选点，得到两个独立 Web 会话；Fork 只回填草稿，Clone 含当前上下文，源文件字节未变、没有额外模型请求 | 分支与复制会产生新会话；与复用原会话是两种不同操作。 |

现有 Web 仍不是全量 TUI 替代：原生登录/凭据、共享与发布、全局设置和扩展安装、任意 TUI 组件、后台调度与整套管理命令等并没有作为普通 Web 能力交付。本机终端路径不计作 Web 覆盖。

当前同名入口还包括 `/new`、`/resume` / `/sessions`、`/rename`、`/tree`、`/clone`、`/compact`、`/model` 和 `/fast`；解析与原有工作台调用分别有回归，未逐个在真实浏览器重演。`/resume` / `/sessions` 打开 CLI 历史选择，已加入 Web 的会话在侧栏；`/tree` 经运行详情打开原生树；`/model` 仅切换本会话，不支持 `--default`；`/fast` 仍受原生模型资格和按模型记忆约束。`/export` / `/import` / `/reload` 当前没有同义 Web 路径，不计为覆盖。完整当前验证入口见 `README.md`。

## 1. 版本与证据绑定（本文件与源码一致的证明）

| 项 | 取值与路径 |
| --- | --- |
| 目标版本对（第一批可证明结果） | `omo-ai@5.1.81` + `@code-yeongyu/senpi@2026.11.19-5`（计划正文指定；与本机全局安装一致，见下） |
| 本机全局安装（只读读取 `package.json`，未执行用户会话） | OmO 包的 `"version": "5.1.81"` 及对 `"@code-yeongyu/senpi": "2026.11.19-5"` 的依赖；Senpi 运行时的 `"version": "2026.11.19-5"` |
| 运行时文档（随附，不代表已运行） | 该 Senpi 发行包的 `docs/`：`usage.md`（约 21 KB）、`rpc.md`（649989 字节 / 8569 行）、`settings.md`、`extensions.md`、`keybindings.md`、`sessions.md`、`compaction.md` 等；`docs.json` 为导航索引（无版本号字段） |
| 历史静态盘点（本地资料，未随仓库发布） | 基线（168 项，`omo-ai@5.1.81 + senpi@2026.11.19-5`）、候选（158 项，`5.1.83 + 2026.11.23`）及两版静态差异（326 项均未在该盘点中验证运行时或 Web 行为） |
| 本工作树实际源码（本文件判定的唯一行为依据） | `src/server.ts`（路由与鉴权）、`src/sessions.ts`（Web 会话 → 原生 RPC 映射）、`src/protocol.ts`（`actions` 联合类型即 Web 写操作全集）、`src/commands.ts`（`get_commands` 投影与组装）、`src/engine.ts`（stdio `--mode rpc --multi-session` 对等体）、`src/cli-history.ts`（只读 CLI 历史）、`src/terminal-sessions.ts` + `src/web/cli-live.ts`（实时附着 CLI）、`src/session-branches.ts`（fork/clone）、`docs/web-api.md`（内部接口文档）、`docs/parity/ui-brief.md`（Task 3 before 基线说明） |
| H/S/W 交接状态（本文件的 pending 标记，见 §7） | H（`src/engine-socket.ts` 私有 Unix socket + 原生认证）未在本树出现；S（`POST /api/cli-history/:id/resume`、`POST /api/sessions/:id/handoff` + 原生 `release_session`）未在本树出现；W（handoff UI）未在本树出现。以下凡涉交接的均为**缺口**，不是能力。 |

版本一致性说明：`comparison.json` 的 `pairCheck` 明确 baseline 对 = `5.1.81 + 2026.11.19-5`，
candidate 对 = `5.1.83 + 2026.11.23`，两对按设计不同。本文件只认 baseline 对，
因为它与计划第一批销项和本机全局安装一致；凡引用 candidate（5.1.83 系）差异的，
一律按 `comparison.json → genuineStaticDeltas` 原文转述为**静态差异**（rpc.md +67 行、
`token-budget-reminder` 移除与 predecessor/host-occupancy 模块增补等），不视为本树能力。

## 2. 先前实际验证 vs 推断 vs 不可用（三列分开）

### 2.1 实际验证过的（本工作树内，可重跑）

- `bun test` 覆盖的 fixture 级行为：`test/commands.test.ts`（`get_commands` 投影/解析/组装规则）、
  `test/cli-history.test.ts`（历史扫描与消息投影预算）、`test/session-branches.test.ts`、
  `test/terminal-sessions.test.ts`、`test/cli-live-web.test.ts`、`test/app.test.ts`、
  `test/workbench.test.ts` 等。证明的是**投影与约束逻辑**（如坏调用不发送、忙时不排队），
  不是真实原生会话语义。
- `docs/parity/ui-brief.md` 的 B0/B1/B2 是固定构建 `056ec7b` + `bun start` + 真 Chromium +
  隔离 RPC fixture 的 **before 观察**，文件自述"不证明真实浏览器→原生副作用"。
  引用时只能作布局祖先，不能作能力证据。
- `comparison.json` 的 artifact 校验（4 个 tarball 的 bytes/sha1/sha512/package identity（含
  baseline `omo-ai-5.1.81.tgz` bytes 8247174、tarMembers 988）验证通过）只证明**静态取材可信**，
  其 `verdict` 字段明示"No approval … Runtime, real-TUI and Web proof still required"。

### 2.2 实现推断（源码可读到，但未经本轮运行证明）

- `src/sessions.ts#action` 的每个分支与其调用的原生方法名（`prompt/steer/follow_up/abort/
  clear_queue/compact/navigate_tree/get_tree/get_state/get_commands/extension_ui_response/
  set_model/set_thinking_level/set_fast_mode/set_auto_compaction/set_session_*`）：
  调用关系是源码事实，真实原生回执语义仍需 V 阶段证明。
- `src/engine.ts` 的握手要求（`get_protocol_info` 须 `mode=="multi"` 且 `protocolVersion==1`，
  `set_client_info {width:96, capabilities:["interactive_user","question"]}`）是源码事实；
  与真实 5.1.81 后端的握手尚未在本轮执行。
- `usage.md`/`rpc.md` 的行号引用（如 usage 表格行、`rpc.md` 8569 行）是文档事实；
  对应行为在 Web 是否同义，需 §4–§6 的逐项验收。

### 2.3 不可用 / 未实现（源码或文档明确缺口）

- H/S/W 三个端点与模块（§1 表格末行）。
- §4 中标 Missing 的 slash 命令、§5 中标 Missing 的 CLI 子命令、§6 中标 Missing 的 RPC。
- 通用 TUI/插件渲染（`@earendil-works/pi-tui` 自定义组件、扩展 UI 任意 JS）：Web 明确不支持，
  只做文本投影（见 §5.2）。

## 3. 分组原则：同名不同义不合并

下表是本文件的高层分组键。同名在此处**分行**，因为触发面、身份模型或副作用不同，
用户要的是同等 affordance 与覆盖，不是并发操作。

| 组 | CLI 面 | 原生 RPC 面 | TUI 面 | Web 面（本树实际） |
| --- | --- | --- | --- | --- |
| 会话进入 | `senpi -c/-r/--session/--fork/--rebind`（新进程拥有会话） | `open_session`（路由句柄 + durable 身份 + `permissionPreset`） | `/resume`、`/new`、`/fork`、`/clone`（同一 TUI 进程内） | `POST /api/sessions`（新建 Web 会话）、`actions resume`（重连同 Web ID）、`branches`（fork/clone 成**新 Web 会话**）、`GET /api/cli-history…`（只读打开历史，不拥有 CLI 进程） |
| 交接 | 手动 `omo --session`（计划指定唯一方式） | `release_session` / `unload_session` / `attach_session{takeover}`（不同守卫，见 §6） | 无（TUI 退出即释放） | **缺口**：S 的两个端点未实现；`cli-live disconnect` 只释 Web 附着，不释放原生 |
| 模型 | `--provider/--model/--thinking/--models`（启动参数） | `set_model{scope}`（需 `session_model_scope` capability） | `/model`（可附 `--default` 改默认）、Ctrl+P 轮换 | `actions model`（仅 `scope:"session"`， capability 缺失则 409；无"设为默认"） |
| 思考档 | `--thinking`（启动） | `set_thinking_level` /  graded `/efforts` 阶梯 | `/thinking`、`/reasoning`、`/efforts`、`/fast`（三者语义不同，见 §4） | `actions thinking`（level 全档直通）、`actions fast`（boolean 直通）；`/reasoning`、`/efforts` 阶梯**无独立映射** |
| 命令分发 | `--prompt-template`、skill 路径参数 | `get_commands` + `prompt{message:"/name args"}`（单行组装） | 两条路径两种顺序（见 §8 来源要求）：TUI 提交是 builtins 精确匹配优先（`interactive-mode.js:4028..4167`，之后 4178 `isExtensionCommand` 回退）；RPC/`session.prompt` 才是扩展优先（`extensions.md:335`、`rpc.md:4595`） | `actions command`（`resolveCommand` 校验 + 空闲检查 + `composeMessage` 组装；未知不降级、忙时 409）——对应 RPC 侧 `unknown_command`/`interactive_only`（`rpc.md:4601`），不套用 TUI 顺序 |
| 历史/树 | `--export/--session` 文件 | `get_messages/get_tree/navigate_tree/get_fork_messages` | `/tree`（Ctrl+E 改写继续）、`/export`、`/import`、`/share` | `snapshot/details`（`get_state/get_messages/get_session_stats/get_pending_inputs/get_tree` 投影）；`navigate`（带 `expectedLeafId`）；**无 export/import/share 对外端点**（`export_jsonl` 仅分支内部 staging 用，不对外暴露） |

## 4. `usage.md` TUI 内建命令全量枚举（表格 27 行 + skill/扩展 2 行 = 29 行判定）

以运行时 `docs/usage.md` "Slash Commands" 表格 27 行为全集（顺序同原文），另加表格外但同文件定义的 `/skill:name` 与扩展注册命令，共 29 行判定。判定标准：
**等价** = Web 有同语义写路径且守卫一致；**部分** = 只读/投影/子集；**缺失** = 无路径
或边界禁止。括号内为本树源码锚点。

| usage.md 命令 | Web 判定 | 分类 | 依据与缺口 |
| --- | --- | --- | --- |
| `/login`, `/logout` | 缺失（边界禁止） | 账户/凭据 | Web 不采集秘密是设计约束（ui-brief、私有提示约定）；无对应 action。 |
| `/model` | 部分 | 会话/模型 | `actions model` 仅改本会话（`protocol.ts`、`sessions.ts#action→set_model scope:session`）；无 Ctrl+P 轮换、无 `--default` 改默认。`GET …/options` 只读模型表。 |
| `/thinking [level]` | 部分（scope 缺省为基线分歧） | 会话/模型 | `actions thinking` 只发 `set_thinking_level{level}`，无 scope（`sessions.ts#action`）；CLI 同义路径是会话级的 `setSessionThinkingLevel`（`interactive-mode.js:6861 handleThinkingCommand` → `6900 selectThinkingLevel(level,false)`，persist 另走 `setThinkingLevel` + 记住默认），而 `rpc.md:5245+` 的 `"scope":"turn"` 才是文档化的当会话机制——Web 缺省 scope 即基线分歧，服务端缺省行为待 V 实测，不得假设等同。`options.levels` 来自 `get_available_thinking_levels`；Ctrl+S 记住默认无对应。 |
| `/scoped-models` | 缺失 | 会话/模型 | 无 action、无 options 字段。 |
| `/reasoning [on\|off]` | 缺失（不与 thinking 合并） | 会话/模型 | usage 明示三态语义（无推理/常开/on-off/graded 各不同）；Web 只有 thinking 档位，无 reasoning 开关映射。 |
| `/efforts [level]` | 缺失（不与 thinking 合并） | 会话/模型 | graded 阶梯（minimal…max，xhigh/max 按模型出现）无独立映射；与 thinking 档位是不同原生概念。 |
| `/fast [on\|off]` | 等价（显式控件，限合规模型） | 会话/模型 | `actions fast` → `set_fast_mode{enabled}`，与原生同为 persist-per-model（`rpc.md:5335+`：remembered per model，off 记 `"auto"` 覆盖 catalog 继承 tier），不是 session-only——前版"仅本会话"误写，特此纠正。合规模型（ChatGPT Subscription 且未被 `:priority` 锁定）下等价；不合规时原生按该节错误表报错，Web 透传错误即可。 |
| `/settings` | 部分 | 权限/偏好 | 仅主题等本地偏好 + `autoCompaction/fast/thinking/model` 有映射；transport、project trust、tui-mode 等无 Web 映射。 |
| `/resume`, `/sessions` | 部分 | 工作流/会话 | `actions resume` 重连**同 Web ID**；`GET /api/cli-history` 是只读历史游览（不透明键，非原生 ID）。CLI 式跨进程 resume 是 S 缺口。 |
| `/new` | 等价 | 工作流/会话 | `POST /api/sessions {cwd,name?}`（`server.ts`，目录须为授权根之一）。 |
| `/rename [name]`（`usage.md` 注明 `/name` 为别名） | 等价 | 工作流/会话 | `actions rename` 一个动作同时覆盖 `/rename` 与 `/name`（`protocol.ts` 无独立 name 动作）；→ `set_session_name` + Web 索引持久化。 |
| `/session` | 部分 | 工作流/会话 | `GET …/details`（stats/queue/tree）+ snapshot state 为只读投影；文件路径/全量 token-cost 细节被 `pick` 裁剪。 |
| `/tree` | 部分 | 工作流/会话 | `actions navigate{targetId}` + `details.tree` 可遍历/跳转；Ctrl+E 改写继续、废弃分支总结语义无对应。 |
| `/trust` | 缺失（边界：需 TUI 交互） | 权限 | TUI 信任 gate 写 `trust.json`；Web 无映射，非交互面（`usage.md` 非交互段：`--approve/--no-approve` 单次覆盖）亦无映射，`#open` 固定 `permissionPreset:"ask"`。 |
| `/fork` | 部分 | 工作流/会话 | `POST …/branches{kind:fork,entryId}` 实际发送原生 `fork{entryId,position:"before"}`（`session-branches.ts#prepare`，非历史拷贝）：在 `mkdtemp(<store>/.omo-web-branch-)` 私有 staging 内起 scratch 原生会话执行，再经 `export_jsonl` 落新 transcript、`sessions.ts#publishBranch` 发布为新 Web 会话。命令 affordance 仍为部分：新分支身份 vs TUI 原地切换当前会话，且 `editorText` 只填草稿不自动发送；`--spawned-by` 血缘头、`--rebind` 迁目录无对应。 |
| `/clone` | 部分 | 工作流/会话 | 同上 `{kind:clone}`，实际发送原生 `clone`（staging 流程同 fork，`session-branches.ts#prepare/#scratch`）；"当前分支复制成新文件"的 CLI 文件语义代之以新 Web UUID + 新原生 id + `export_jsonl` transcript；同样只选中新会话，不切换既有"当前会话"。 |
| `/compact [prompt]` | 等价（调用面） | 工作流/会话 | `actions compact{instructions?}` → `compact`（180s 超时）。压缩后语义以原生回执为准，待 V 验证。 |
| `/copy` | 缺失 | 键盘/剪贴 | Web 无复制路径：`src/web/*.ts` 全目录无 `writeText`/`execCommand`/`navigator.clipboard` 调用；`app.ts:1210` paste 只收图片文件。原生语义已定：TUI `handleCopyCommand`（`interactive-mode.js:8399`）调 `getLastAssistantText()`（`agent-session.js:12337`：跳过 aborted 空消息、拼接 text 段、`trim()`、空为 undefined → "No agent messages to copy yet."），RPC 有同义 `get_last_assistant_text`（`rpc.md:6118`，无消息时 `{"text": null}`）。P 补齐路径见 §8：调原生取文本（空/aborted/trim 语义完整保留），剪贴板写仍在浏览器端。 |
| `/export [file]` | 缺失 | 工作流/输出 | 原生 `export_jsonl` 仅被 `session-branches.ts` 在分支前内部调用（导出源分支），Web 无对外端点；`cli-history read` 只投影最新分支可见消息。 |
| `/import <file>` | 缺失 | 工作流/输出 | 无端点；且接受任意路径违背授权根约束。 |
| `/share` | 缺失（边界：外部副作用） | 工作流/输出 | 上传 gist 是外部副作用，计划范围外明确不做。 |
| `/reload` | 部分 | 扩展/配置 | 无 reload 端点；`options` 每次重读 `get_commands/get_available_models/get_available_thinking_levels`，相当于读侧刷新，无"重载 keybindings/skills/prompts/themes/context"语义。 |
| `/hotkeys` | 缺失（TUI 铬） | 键盘 | 快捷总览浮层无 Web 面；对应键盘能力见 §5.4。 |
| `/help` | 缺失（TUI 铬） | 键盘 | 同上；Web 以 `docs/web-api.md` + 工作台 UI 代之，无等价命令。 |
| `/keybindings` | 缺失（TUI 铬） | 键盘 | 打开 `$EDITOR` 改 `keybindings.json` 无 Web 等价；浏览器不得写用户配置。 |
| `/changelog` | 缺失 | 显示 | 无端点；`engine.status.version` 仅握手版本字符串。 |
| `/quit`, `/exit` | 缺失（语义不同） | TUI 铬 | TUI 退出进程；Web `disconnect`/关闭标签只释附着。`cli-live disconnect→{detached}` 与 `sessions disconnected()` 清路由，不停原生。 |
| `/skill`（`/skill:name` + `$name` 形态） | 部分 | 扩展 | `command` action 支持 `source:"skill"` 的 `invocation`（`$name` 规范、`legacySkillInvocation /skill:name` 兼容，`commands.ts`）；skill 发现/安装/参数表单无映射。 |
| 扩展注册命令（表格外，`extensions.md:335` 优先规则） | 部分 | 扩展 | `get_commands→projectCommands` 仅保留可信行（name/source/description/invocation，`sourceInfo` 必丢）；分发顺序"扩展优先"在 Web 体现为注册表校验（未知命令 400，不降级为 prompt）。 |

注：`usage.md` 另有非 slash 但同文件定义的 TUI 行为，一并归类（不计入上表 29 行）：
`@` 文件引用、Tab 补全、Shift+Enter 多行、Ctrl+X 复制、Ctrl+E 改写、粘贴图片、
`!`/`!!` shell、`.` 手动继续、Ctrl+G 外部编辑器、`?` 快捷浮层、消息队列
（TUI 语义：Enter=steer、Alt+Enter=follow-up、Escape 中止、Alt+Up 取回）——其中只有
**steer/follow_up（经 `prompt.mode` 的独立 `steer`/`follow_up` 原生请求）、abort
（经工作台 #stop 按钮 → `actions abort`，`app.ts:1226-1228`）、图片附件（4 张、
PNG/JPEG/GIF/WebP，`protocol.ts`）**有 Web 等价；且 Web 输入框提交是
**Ctrl/⌘+Enter（`app.ts:1203`，含 `isComposing` 保护），plain Enter 不发送**，
不可简称为"Enter 发送"；**Escape 在 Web 只关闭导航抽屉
（`app.ts:1132` `toggleNav`），不中止轮次**，与 TUI 的 Escape 中止不同义，
特此分行。`!`/`!!` shell、外部编辑器、`@`/Tab 补全、`?` 浮层、Ctrl+X/Ctrl+E
无 Web 映射（shell 系为有意缺失）。

## 5. 分类：工作流 / 扩展 / 权限 / 键盘 / CLI 子命令

### 5.1 工作流（Web 实际写路径 = `protocol.ts actions` 联合类型，全集）

等价或部分：`prompt{prompt,steer,follow_up}`（含 `clientMessageId/expectedTurnId` 去重语义）、
`command`（注册表命令单行组装）、`abort`、`rename/archive/settle`、`model/thinking/fast/
autoCompaction/compact/clearQueue`、`navigate{targetId+expectedLeafId}`、`answer{select/
confirm/input/editor/question 五式}`（`sessions.ts#action` 逐分支校验：answer 须匹配
`pendingQuestions/pendingDialogs` 条目，方法不匹配 400/409）。`answer` 的私密/secret
对话框被 `protocol.ts#dialog` 过滤不下发——这是**有意部分**，不是缺口。
缺失：`/import//share`、队列的手动排序、`navigate` 跨 Web/CLI 混合源（三种 ID 不可混用，
`server.ts` 显式拒绝回退）、`resume_session` 式 engine 侧 hold 释放（§6）。

### 5.2 扩展（`ext.*` 基线类；插件渲染明确不支持）

- 支持（投影子集）：`get_commands` 注册表 → `{name,description,source,invocation}`
 （`commands.ts#projectCommands`，`source∈{extension,prompt,skill}`，非法名丢弃）；
  `extension_ui_response` 问答回传（`answer` action）；`get_pending_inputs` 队列只读。
- 不支持（通用 TUI/插件渲染）：`@earendil-works/pi-tui` 自定义组件体系
  （`docs/tui.md` 全篇是组件 `Component/Focusable` 接口说明，与 slash 表无关——
  易误读，特此区分）、扩展自带交互组件、工具进度富渲染、Markdown/图片/推理的
  TUI 原生排版。Web 只做 `transcriptMessage/transcriptTree/browserEvent` 文本投影
  （`protocol.ts`），未知内容仅文字，无 raw HTML/远程请求/动态插件 JS
 （`ui-brief.md` 呈现约定亦如此要求）。
- 可移植 vs profile 依赖：`$skill`/`/extension` 调用是可移植的（随 `get_commands`
  注册表走）；`sourceInfo` 路径、发现位置（用户/项目/包管理）是 profile 依赖，
  Web 有意丢弃（`commands.ts` 注释），故"某命令在我机器 TUI 可见但 Web 不可见"
  是预期行为，不是 bug。

### 5.3 权限（approval 基线类；Web 取最小 ask 闭包）

- 实际：`open_session{permissionPreset:"ask"}` 且要求回执 `permissionPresetStatus=="applied"`，
  否则关闭会话并 409（`sessions.ts##open`）；`--approve/--no-approve` 单次信任覆盖、
  `allow-always` 持久授权、`trust.json` 写入、sandbox 键、MCP/包来源启停均无 Web 路径。
- `set_model` 额外要求 `engine.capabilities∋session_model_scope`，否则 409 `unsupported`。
- 结论：Web 权限面 = "ask 或不可用"，没有"在浏览器点一次永久放行"的形态；
  任何要求持久授权的操作必须回 TUI/CLI（这正是 H/S 的存在理由）。

### 5.4 键盘（`tui.keys.*` 基线 12 类；浏览器只承接语义子集）

基线 12 类：application、display-and-message-queue、favorite-models-selector、
models-and-thinking、sessions、tree-navigation、tui-clipboard-and-selection、
tui-editor-cursor-movement、tui-editor-deletion、tui-fullscreen-viewport、
tui-input、kill-ring。Web 判定：

- 可移植语义（已承接）：**Ctrl/⌘+Enter 发送**（`app.ts:1203`；plain Enter 不发送）、
  #stop 按钮中止（→ `actions abort`，`app.ts:1226-1228`）、队列投递语义
  （`prompt.mode` → 独立 `steer`/`follow_up` 原生请求）。**Escape 在 Web 仅关闭导航
  （`app.ts:1132`），不承接 TUI 的 Escape 中止语义**，这是有意分行：中止必须走
  已确认的停止按钮，不可用全局按键冒充。
- TUI 专属（不支持：全屏视口滚动、kill-ring、editor 光标/删除键、clipboard 选择、
  Ctrl+P/S/Shift+Tab 档位循环、`?` 浮层）。这不是缺口，是不同宿主的输入体系；
  后续若补，只补"语义"（如"循环下一个模型"按钮调已有 `options`+`model`），
  不仿真按键。

### 5.5 CLI 子命令（`cli.*` 基线 30 项；Web 只承接会话子集）

- 会话生命周期（部分）：`-c/--continue/-r/--resume/--session/--session-dir/--name` →
  `cli-history list/read`（只读）+ Web 会话 CRUD；`--fork/--rebind/--no-session` →
  `branches fork/clone`（新 Web 会话，无血缘头/迁目录）；`--spawned-by` 血缘无映射。
- 模式（有意不承接）：`-p/--print`、`--mode json`、`--mode rpc` 是 CLI 自身形态，
  Web 就是另一种形态，不存在"Web 里跑 print 模式"。
- 包管理（缺失：有意）：`install/remove/update/list/config`（含 `config import-pi`、
  `update --self/--extensions/--models`）无 Web 路径；浏览器不得改全局安装。
- `omo` 系（缺失：S/H 范围）：`omo daemon/host/thread/auth/doctor/setup/sync-account-remote`、
  `host-status-all`、设备迁移（`device.*`）、`thread` 附着、`ulw-loop`（明确 unavailable）、
  退役 `app-server`、自更新。`omo --session` 手动启动仍是计划指定的交接方式，
  Web 不得代启动 shell。
- 工具/资源/引擎（缺失：有意）：`--tools/--exclude-tools/--no-builtin-tools`、
  `-e/--skill/--prompt-template/--theme` 资源装载、`engine-passthrough`、
  `export.html`、`@file` 参数、model cycling（`--models`）、`tool.scope` grep 契约。
  其中 grep/glob 契约（`usage.md` Tool Options 节）是 eval 宿主工具约定，
  与 Web 无关，列此仅防误判为缺口。

## 6. 原生 RPC 面：Web 已用 31 请求类型（29 具名 + steer/follow_up）vs 关键未用

本树实际调用（`src/*.ts` 对 `request(Existing)?("…")` 去重提取，共 29 个具名 +
2 个动态，共 31 个原生请求类型；括号内为调用方）：

> `abort`（sessions）、`clear_queue`（sessions）、`clone`（session-branches）、
> `close_session`（sessions、session-branches）、`compact`（sessions）、
> `export_jsonl`（session-branches：分支前导出源分支）、`extension_ui_response`（sessions）、
> `fork`（session-branches）、`get_available_models`、`get_available_thinking_levels`、
> `get_commands`、`get_fork_messages`（session-branches）、`get_messages`、
> `get_pending_inputs`、`get_protocol_info`（engine 握手）、`get_session_stats`、`get_state`、
> `get_tree`、`navigate_tree`、`open_session`、`prompt`、`set_auto_compaction`、
> `set_client_info`（engine 握手）、`set_fast_mode`、`set_model`、`set_session_archived`、
> `set_session_name`、`set_session_settled`、`set_thinking_level`；
> 外加 `steer`、`follow_up`——`sessions.ts#action` 以 `request(action.mode, …)` 动态发送
> `prompt|steer|follow_up` 三者（`protocol.ts` 的 `mode` 字段），是独立原生请求类型，
> 不是同一 `prompt` 请求的变体（此前草稿误写，特此纠正）。
> 握手 2 个之外 29 个为业务请求；其中 `export_jsonl/fork/clone/get_fork_messages`
> 只走分支路径（`session-branches.ts`），不在 `actions` 写操作全集内。

关键未用（按计划"顺序换端"相关性排序，全部是 P 的候选、不是 C 的交付）：

1. `release_session`（S 的核心；stdio worker 明确拒绝 `unload_session`，in-process
   `release_session` 才是安静交接原语——计划 H/S 已验证，待 S 落地）。
2. `resume_session` + `unattended` hold 账本（`rpc.md` "Unattended opens and Resume" 整节；
   Web 的 `resume` action 只是重连同 Web ID，不触 engine hold）。
3. `attach_session / takeover / session_released`、`open_session_header_cwd`、
   `park_claim`、`subscribe_sessions/unsubscribe_sessions`、`set_session_context`
   （含 `context.task_status`）、`select_hand/list_hands`（headless engine 手选）。
4. `unload_session`（共享 socket 宿主回收语义；与 `release_session` 不同原语，不合并）、
   `close_session` 的"检查后中断"误用（计划已明令禁止冒充安静交接）。
5. `eval_cells.*`、`set_session_context` 任务/DAG 面、`account_*/test_provider_account/
   grant_select` 账户面、`declare_delegation/delegation_roles_v1`、`warm`、
   daemon/host 生成管理（`handoffHost/probeHost/stopHost` 等）。
6. 事件面：Web 转发的 `agent_start/agent_settled/message_*/tool/question/compaction/queue`
   是投影子集；`session_lifecycle/session_paused/session_resumed/session-notices`
   等 hold/生命周期事件未承接（待 S/W）。

## 7. Handoff pending（本文件作者名下的待办，非能力声明）

- H：`src/engine-socket.ts` + 私有 0700 socket 目录 + 强制原生认证 + fixtures 下 stdio
  构造保留——不在本树，待 H 落地后本文件 §6.1/§6.4 需修订。
- S：`POST /api/cli-history/:id/resume {}`（不透明键 → 复用 durable ID 建 Web 书签，
  不建新 native 会话）与 `POST /api/sessions/:id/handoff {}`（仅无 interrupt/force 的
  原生 `release_session`，未释放不给命令、不重放）——端点缺失，§3"交接"行与 §6
  前两项待 S 落地后复验。
- W：handoff UI（历史→"在 Web 继续"、活动会话→"转到 CLI"，草稿保护与状态说明）——
  待 W 落地后 §4 `/resume` 行可从"部分"升级为"等价（书签面）"，但仍不改变原生 hold 语义。
- V：受控临时 profile + 独立 TUI + 浏览器 + 回环模型下的"同一 durable ID、同一文件、
  无副本、每次输入一次"证明——本文件不声称，待 V 交付。
- 本文件为快照基线，release pending：在 V 对本快照复验并签字前，本文件不作为放行依据；
  任何超出本快照的源码变更都须重核 §4–§6 后再谈 release。

## 8. 给 P 的下一个具体实现目标（无通用 shell、无 raw RPC 透传、不编造原生端点）

**目标：类型化内建子集——只接已有执行控件的精确 slash 名，不开新权限，不新增通用路由。**

子集（§4 中 13 名已有 Web 执行控件 + `/copy` 单用途原生调用）：`/new`、`/resume`、`/sessions`、`/name`、
`/rename`、`/session`、`/tree`、`/fork`、`/clone`、`/compact`、`/model`、`/thinking`、
`/fast`、`/copy`。路由形态服从当前 P 计划（defer），本文件不定新端点，只定名单与映射语义。`reasoning/efforts/scoped-models` 不在子集内：三者与
thinking/model 是不同原生语义（§4），不得映射到 thinking/model 上冒充同义，
也不得编造 `reasoning/status`、`efforts/list` 之类 CLI 并不存在的语法；其余
TUI-only（settings/trust/login/reload/export/import/share/help/hotkeys/keybindings/
changelog/quit 等）按原生 `unknown_command{reason:"interactive_only"}`
（`rpc.md:4601` 起 Unknown commands 整节，`/model` 为其点名示例）语义拒绝，
永不以 prompt 文本发给模型——Web 现有 `command` 未知 400 行为与之同义
（`sessions.ts#action` command 分支），保持即可。

原生解析优先级（来源要求，P 实现时必须遵守，均有文档出处）：
1. 两条路径、两种顺序，不得混用——TUI 提交路径：builtins 精确匹配优先
   （`interactive-mode.js:4028..4167`：`/model` 4028、`/thinking` 4034（`handleThinkingCommand` 4037/6861）、
   `/copy` 4055、`/rename`+`/name`、`/session`、`/fork` 4097、`/clone` 4102、`/tree` 4107、
   `/new` 4128、`/compact` 4133、`/resume` 4159/4164），之后才 `isExtensionCommand` 回退（4178）、
   `!` shell；RPC/`session.prompt` 路径：扩展优先（`extensions.md:335`；`rpc.md:4595`）。
   Web `command` 的未知-400 对应后者。前版"扩展优先一句话"未分路径，特此纠正。
2. 其次 skill/template 展开（`rpc.md:4599` Input expansion）。
3. 未注册名拒绝（`rpc.md:4601` Unknown commands，`interactive_only` 如 `/model`）；
   首 token 前有空白则按文本发送——Web 侧对应：未知 400、不降级、不排队（已有行为，保持）。

**落点（P 的写入面建议）：**

- 已有端点直接覆盖（P 只需文档/测试确认，不新增服务端路由）：`/new`→`POST /api/sessions`；
  `/resume`→`actions resume`；`/sessions`→`GET /api/sessions` + `GET /api/cli-history`；
  `/name`+`/rename`→`actions rename`；`/session`→`snapshot`/`details`；
  `/tree`→`details.tree` + `actions navigate`；`/fork`+`/clone`→`branches`
 （原生 fork/clone 在 staging 内执行，见 §4）；`/compact`→`actions compact`；
  `/model`→`actions model`（仅 session scope，不承诺 `--default`/Ctrl+S 默认持久化）；
  `/thinking`→`actions thinking`；`/fast`→`actions fast`；
  `/copy`→服务端单用途调原生 `get_last_assistant_text`（语义见 §4 行，空/aborted/trim 完整保留），
  剪贴板写在浏览器端（Web 现无该控件，§4 判缺失；补齐后升级为等价）。
- `/copy` 单用途调用：服务端调原生 `get_last_assistant_text`（`rpc.md:6118`）取文本，
  空/aborted/trim 语义与 `getLastAssistantText`（`agent-session.js:12337`）完全一致
  （TUI `handleCopyCommand`，`interactive-mode.js:8399`，空时 "No agent messages to copy yet."）；
  剪贴板写仍在浏览器端。这是 typed 单用途调用，不是通用透传。
- 不新增通用 `/builtins` 路由：端点与路由形态服从当前 P 计划；注册表同名碰撞按各路径
  原生顺序各自处理（TUI 侧 builtins 优先、RPC 侧扩展优先），surfacing 由 P 计划定，
  本文件不自创 `command_shadowed` 之类新语义（前版该码随通用路由一并撤回）。
- **验收契约（测试与交付绑定，未实现不是支持）：**
  - P 计划配套测试：13 名逐一走到 §6 清单内的已有原生方法（fixture 断言方法名与参数形状
    一致；thinking 断言无 scope 并记录 §4 分歧）；`/copy` 调 `get_last_assistant_text`，
    空/aborted/trim 语义与 `agent-session.js:12337` 一致，空时客户端提示且不发 prompt；
    TUI-only 名（如 `/trust`、`/settings`、`/reasoning`）400 `interactive_only` 且 fixture
    零原生调用；忙时 409 不排队。
  - `bun run check` + `bun test` 全绿；`git diff --check` 干净（由实现者执行，
    本文件不代执行）。
  - V 复用：回环模型下 TUI `/thinking high`（会话级 `setSessionThinkingLevel`）与 Web
    等价路由在同一 durable ID 上先后执行，`get_state.thinkingLevel` 读回一致
    （含 §4 scope 缺省分歧在 V 的裁决）；`/rename` 与 `/name` 同效；`/copy` 与 TUI
    同文本同 trim 语义。

## 附：文档-源码一致性自检（本文件发布门）

- [x] 版本对与安装一致：`omo-ai 5.1.81`（`~/.bun/install/global/.../omo-ai/package.json`）、
      `senpi 2026.11.19-5`（同上 + 运行时 `package.json`），与计划第一批销项一致；
      candidate 对差异按 `comparison.json pairCheck/genuineStaticDeltas` 转述，未冒充能力。
- [x] `usage.md` 全量：slash 表 27 行 + skill/扩展 2 行共 29 行判定（§4 表格），
      非 slash TUI 行为段另列；易混的 `tui.md`（组件接口）已正名，非 slash 能力。
      行数口径：27（表格）/ 28（旧草稿误写，已废）/ 29（本文件判定行），以 29 为准。
- [x] Web 全量：`protocol.ts actions` 联合类型即 §5.1 全集；`server.ts` 路由表
      （bootstrap/sessions/sessions-actions/cli-history/cli-live/branches/branch-options/
      activity/options/details/events）与 `docs/web-api.md` 对过；§6 的 29 具名 +
      `steer`/`follow_up` 动态共 31 个原生请求类型来自源码正则提取（已按调用文件标注）。
- [x] 三列分离：§2.1/§2.2/§2.3 + §7 pending；无"用户声称完成"的转述——本文件是 C 的
      交付物，不是 V 的通过证明。
