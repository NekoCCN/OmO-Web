# 本机 CLI → Web 对等矩阵（本地开发者审计）

> 受众：本地开发者，想知道本机已安装的 CLI 功能、命令、插件、技能中，哪些在当前 Web 里可用。
> 只回答当前工作树实际代码，不回答计划，不回答远端。
> 秘密、设置值、端点、用户任务内容一律不收录、不推测。

## 工作台对齐增量（`e3a63e1` 之后，OmO 5.1.83／Senpi 2026.11.23）

以下为当前工作台验收口径；下文保留增量前的全量调查，旧命令数与未实现标记以此表为准。

| 从 CLI 到 Web | 当前 Web | 剩余区别 |
| --- | --- | --- |
| 随输入查命令与技能 | 在消息框输入 `/`、`$`（兼容 `/skill:`）按前缀就地查找；方向键选择，Enter/Tab 或点击只填草稿。`/help`、`/hotkeys` 进入 Web 命令与键位帮助 | Web 不改 CLI 键位或冒充插件专属命令 UI |
| 待办、当前运行、用量 | 桌面状态行直接读上下文、最新缓存、当前待办和运行；手机优先运行、排队、待答和待办。`/todo` 或点状态行直达当前分支待办。输入 token 合计与 CLI 同口径，分列未缓存及缓存读写 | 待办管理子命令和 CLI 的缓存重计费诊断未接入 |
| `/tasks`、`/dag` | 原生当前会话只读列表；DAG 用服务端签出的不透明选择键展开波次、节点状态、尝试次数和依赖。两绑定真实原生测试证实拒绝别的绑定；归属变化、过期、不完整有明确结果 | 不展示自由文本任务/运行标题、原生 ID、错误详情；不支持跨会话 `--all` 或原生 task/DAG 写操作 |
| `/tree`、Fork/Clone | `/tree` 直达展开的当前会话树；Web 新建的共享会话也以核实的原生共享日志提供分支选点 | 顺序换端、原生归属及授权门保持不变 |
| `/reasoning`、`/efforts` | 无参读取当前原生档、是否开启和可用档位；现有 Web 模型/思考档控件仍按会话作用域工作 | 带参的原生命令会持久化设备的每模型偏好，且错误也可能只有无请求关联的通知与 `handled` 回执，不作为 Web 可写操作。默认、收藏与作用域清单仍属本机管理 |
| 能力、插件与兼容 | 会话能力目录仍只读；注册的技能与扩展走通用、受校验的入口 | 注册不保证可执行。浏览器完整 TUI 门禁未过，私密交互、全局管理和任意 shell 均不开放，不做单个插件专属界面 |

证据：安装版私有 stdio 的非空 Task/DAG 和归属回归 `test/native-runtime.test.ts`；同原生日志对照用隔离 profile 与真实 Chromium（本地归档 `artifacts/qa/cli-alignment/`）；成功探查分组、失败/运行保留和键盘聚焦详见 `test/transcript.test.ts`、`test/tool-display.test.ts`。三者不证明所有 CLI 命令、第三方插件或不同平台都可执行。

## 覆盖总览（先读这段）

- 版本基线：`omo 5.1.83 (engine: senpi 2026.11.23)`；解析器目录确认为默认 `~/.omo/agent`；在途旧运行时（`2026.11.19-5`）不是当前启动目标。
- Web 直接可用：14 个内置命令中的已验证子集（浏览器收据至少含改名、详情、fork 选择器、TUI-only 不发送）、会话动作全集（发消息、换端、停止、清队列、压缩、导航、改名、归档、结清、模型、档位、极速、自动压缩、审批预设、答复）、同日志换端与私有落盘（双端收据）。
- 只读：当前会话的扩展、MCP 和注册命令清单，目标模型档位预览，用量与上下文、原生任务与 DAG 摘要、会话记忆计数、待答、队列、树、通用工具结果、CLI 历史与实时发现。会话能力清单不是全局安装清单。
- 间接：扩展、prompt 模板、skill 命令经通用命令路径执行；动态注册名若出现在 `get_commands` 则可列出与路由。用当前版隔离引擎验证了一条合成 prompt 模板确实经过原生展开，不代表第三方扩展或 Skill 均可执行。
- 仅 CLI：包、扩展、技能、MCP、模型、账户、调度、守护、线程、诊断的增删改查与全局设置，无 Web 管理面。
- 未验证：`/efforts` 与思考档、`/reasoning` 与思考档的语义差，条件化库存，连接后 RPC 广告，跨设备与 provider 可达性。

## 0. 证据绑定（报告自包含）

### 0.1 三份证据输入

- 原生安装态盘点（`5.1.83 / Senpi 2026.11.23`）：实测 `~/.bun/bin/omo`、`omo --version` 为 `omo 5.1.83 (engine: senpi 2026.11.23)`；三份 `package.json` 确认 `omo-ai@5.1.83` 固定依赖 `@code-yeongyu/senpi@2026.11.23`、`@code-yeongyu/omo-senpi@5.1.83`、`@code-yeongyu/senpi@2026.11.23`；并存旧运行时 manifest 实为 `2026.11.19-5`，不算当前版本证据；任何 `5.1.81` 旧证据不算当前版本证据。口径为 `--help` 实测加源码注册声明；`candidate.json`（`schema parity-recovery.inventory.candidate/1`，`evidence_class=static-readonly-inventory`，158 项，自报同版本对）只作 parity 键对照，不继承其 runtime 与 Web 标记。
- 当前版 Web 见证（5 行）：`omo --version` 仍为 `omo 5.1.83 (engine: senpi 2026.11.23)`；`omo config agent-dir --json` 已成功执行，值比对确认目录为默认 `~/.omo/agent`，在途任务提示中显示的较旧运行时不是当前已安装启动目标；`bun <current-runtime>/dist/cli-main.js --version` 独立报告 `2026.11.23`；`bun --no-orphans scripts/verify-session-handoff.ts "$cli" --browser --slash` 通过并输出 `NATIVE_SESSION_HANDOFF_OK`、`BROWSER_SESSION_HANDOFF_OK`、`BROWSER_BUILTIN_PARITY_OK`，后者收据至少含 `native-rename details fork-selector tui-only-not-sent`，其余断言以脚本原文为准；`OMO_WEB_BIN="$HOME/.bun/bin/omo" bun --no-orphans scripts/verify-shared-store.ts` 经实际包装器退出 0，私有原生日志落盘、同日志、交接与拒绝均为当前版已测属性，以该脚本内断言为界；两验证器均用隔离数据与回环合成模型，既不验证实际第三方插件，也不验证真实账户 provider。
- 本机自定义资源只读盘点（2026-11-25）：原生用户配置声明 9 个包、7 个全局 MCP server；用户扩展目录 15 个顶层项中 13 个可发现（含 4 个运行时默认 shim）；工作区 28 项锁定且在盘 skill，盘点会话目录展示其中 24 项；`prismantis@prismantis` 是 Claude Code 用户配置启用且缓存存在的插件，不是 OmO 原生包。口径为只投影白名单字段、标识符、版本和资源路径；“可见不等于调用过，配置不等于加载成功，安装不等于启用”。该盘点记录的提示运行时 skill 路径对应 `2026.11.19-5`，与当前启动目标 `2026.11.23` 是不同层与不同代；在途计数不等同新启动加载结果。

### 0.2 文件指纹（`sha256sum` 实测，均为 64 位十六进制）

| 文件 | SHA-256 |
|---|---|
| `$O/bin/omo.js` | `bd7fe2c52a18c7f21f627e256d7a723aba49b54090222373025844f2d225de3b` |
| `$P/extensions/omo.js` | `8c65a40a8850a63d145ecc41fd76bd963b8772b5ee96daf7d01d195fbff22b1e` |
| `$P/extensions/omo-task.js` | `e1fcd39e2e51ce87e9dc9084f438061ce38e67e558896748e6da7c0ca4b3a47c` |
| `$S/package.json` | `1a79651ec3f61111b65655121621e8d662a8197a6b16581ec5026e421ff374cf` |
| `$S/dist/core/slash-commands.js` | `e60fa8f3ad5823cecdeb0c0b34be46b641b8b4a9029e404836fc6402aff6e016` |

其中 `$O` 指 `~/.bun/install/global/node_modules/omo-ai`，`$P` 指其 `plugin` 子目录，`$S` 指解析器目录下当前启动目标运行时。

### 0.3 本地状态显式（解析器目录与运行时新旧）

- 解析器目录：`omo config agent-dir --json` 值比对确认为默认 `~/.omo/agent`。Web 服务端 pinned 的 profile 即此目录，浏览器不改 agent dir。
- 运行时新旧：新启动目标为 `5.1.83 + 2026.11.23`；在途会话提示中可见的旧运行时（`2026.11.19-5`）不是当前已安装启动目标。凡本矩阵判 `直接` 且涉 holder、store、交接，均以新启动验证器为准，不将在途旧运行时的可见 skill 与工具数套用到新启动行为。
- 验证边界：两当前版验证器均为隔离临时目录与 profile 加回环合成模型，`--offline --no-approve`，不连外部，不验证第三方插件与真实 provider。

### 0.4 Web 侧实际读证（本工作树）

- 路由与鉴权见 [server.ts](../../src/server.ts)；写操作全集见 [protocol.ts](../../src/protocol.ts)（`actions` 联合类型）；会话到 RPC 映射见 [sessions.ts](../../src/sessions.ts)；命令投影与组装见 [commands.ts](../../src/commands.ts)；Web 内置解析见 [builtin-commands.ts](../../src/web/builtin-commands.ts)；引擎对等体见 [engine.ts](../../src/engine.ts) 与 [engine-socket.ts](../../src/engine-socket.ts)；内部接口文档见 [web-api.md](../../docs/web-api.md)。
- 只读面：[cli-history.ts](../../src/cli-history.ts)（CLI 历史只读）、[terminal-wire.ts](../../src/terminal-wire.ts) 加 [terminal-sessions.ts](../../src/terminal-sessions.ts) 加 [cli-live.ts](../../src/web/cli-live.ts)（实时附着 CLI）、[session-branches.ts](../../src/session-branches.ts)（fork 与 clone）、[native-activity.ts](../../src/native-activity.ts) 加 [native-activity.ts（Web）](../../src/web/native-activity.ts) 加 [details.ts](../../src/web/details.ts)（运行检查器）、[runtime-branch.ts](../../src/runtime-branch.ts)（Todo 与记忆召回投影）、[runtime-metrics.ts](../../src/runtime-metrics.ts)（用量、缓存、内存投影）、[tool-display.ts](../../src/web/tool-display.ts)（通用工具输出）、[api.ts](../../src/web/api.ts) 加 [app.ts](../../src/web/app.ts)（浏览器分发）。
- 当前版验证脚本（已读断言）：[verify-session-handoff.ts](../../scripts/verify-session-handoff.ts)（`--browser --slash`，`NATIVE/BROWSER_SESSION_HANDOFF_OK` 加 `BROWSER_BUILTIN_PARITY_OK`）、[verify-shared-store.ts](../../scripts/verify-shared-store.ts)（生产入口 `startApp` 加真实 `omo` 加隔离 profile 加回环模型：私有 host、原生 profile 桶落盘、同日志、持有期拒绝、安静释放引文命令、二次打开与 Web resume 互斥、自定义 `sessionDir` 不搬迁 pathless 落盘）。
- 测试只证逻辑不证原生语义：[commands.test.ts](../../test/commands.test.ts)、[builtin-commands.test.ts](../../test/builtin-commands.test.ts)、[app.test.ts](../../test/app.test.ts)、[workbench.test.ts](../../test/workbench.test.ts)、[tool-display.test.ts](../../test/tool-display.test.ts)、[cli-history.test.ts](../../test/cli-history.test.ts)、[session-branches.test.ts](../../test/session-branches.test.ts)、[terminal-sessions.test.ts](../../test/terminal-sessions.test.ts)、[cli-live-web.test.ts](../../test/cli-live-web.test.ts) 等；另有 [verify-native.ts](../../scripts/verify-native.ts)、[verify-cli-live.ts](../../scripts/verify-cli-live.ts)、[verify-session-branches.ts](../../scripts/verify-session-branches.ts)，需真实引擎。
- 历史基线对照：[sequential-coverage.md](../../docs/parity/sequential-coverage.md)（第一批可证明结果绑定 `5.1.81 + 2026.11.19-5`，与当前对不同）、[ui-brief.md](../../docs/parity/ui-brief.md)（Task 3 before，固定构建加隔离 RPC fixture，不证真实副作用）。

### 0.5 状态定义

- `直接`：Web 有同语义写路径且守卫一致，走 `POST /api/.../actions` 到原生 RPC。其中 holder、store、交接与内置子集另有当前版验证器收据时，会在依据中点名收据名。
- `只读`：Web 只能看投影，不能改原生，或仅返回筛选字段。
- `间接`：必须经由 agent 或模型执行，或经由本机终端手动执行，Web 自身不直接执行该 CLI 或 RPC。
- `仅CLI`：Web 无管理路径，或设计边界禁止（不采集秘密，不执行任意 argv 与 shell）。
- `未验证`：源码可读到调用关系，但既无当前版验证器收据，也未运行真实引擎证明回执语义；一律不声称完成。

### 0.6 版本分层

- 当前范围版本、已安装与静态：`5.1.83 + 2026.11.23` 的已安装包声明、`--help` 实测、源码注册、在盘计数。
- 当前范围父浏览器、holder 与 store 已验证：两脚本收据（隔离数据加回环合成模型为界，不含第三方插件与真实 provider）。
- 先前版本端到端与夹具：`5.1.81 + 2026.11.19-5` 的浏览器实测、隔离 fixture、历史静态盘点（baseline 168 项、candidate 158 项、差异 326 项均未验证运行时与 Web 行为），只作边界说明，不计入当前覆盖。

---

## 1. CLI 入口与参数：Web 无原生管理界面

Web 不提供以下任何一项的原生管理界面；浏览器不能安装、删除、更新、登录、改全局设置。唯一例外是会话内的 `ask/auto/full-access` 切换（见 §7），且每次恢复或重开都回到 `ask`，不改全局 profile 与项目信任。

| 本机 CLI 穷举 | Web 判定 | 依据 |
|---|---|---|
| `install`、`remove`、`uninstall`（`remove` 别名）、`list`、`config`（`-l/--local`，`--approve/--no-approve`；`config agent-dir --json` 只解析 agent dir；`config import-pi [auth.json/keybindings.json/models.json/settings.json ...]` 为迁移写入路径，未执行） | `仅CLI` | 无对应路由与动作；[protocol.ts](../../src/protocol.ts) 与 [web-api.md](../../docs/web-api.md) 的写操作全集无包管理。`config agent-dir --json` 的值比对只定目录，不开 Web 写。 |
| `update`（`--dry-run/--print`；另有 `--self` 与目标 `self/senpi/omo`、`--extensions`、`--models` 走引擎分发） | `仅CLI` | 同上。 |
| `models discover`、`auth`（`print-api-key/print-bearer-token/check`，`--provider/--model/--min-expiry/--json/--credentials/--no-refresh`；仅用法，未执行子命令） | `仅CLI` | Web 模型表只读（`get_available_models` 投影，见 §7）；无登录与凭据动作。两当前版验证器均用回环合成模型，不验证真实 provider。 |
| `host ensure/status/stop/handoff/shard-path/gc` 加 `host session open/prompt/steer/abort/model/list/state/read/wait/unload/close` | `仅CLI` | Web 引擎是 [engine.ts](../../src/engine.ts) 拥有的私有非监听 stdio host（`--mode rpc --multi-session`，`set_client_info {width:96,capabilities:["interactive_user","question"]}`），不暴露 host 管理。 |
| `schedule list/cancel/run/help` | `仅CLI` | 无调度路由；[native-activity.ts](../../src/native-activity.ts) 只读 DAG 快照，不提供创建与投递。 |
| `daemon run/adopt/status/stop/handoff/gc/rollback-prepare`（`--foreground` 与旧 `daemon attach` 被拒绝） | `仅CLI` | 同上。 |
| `thread list/send/read/close/bind/unbind/rebind/bindings/report/answer/outbox/ack` | `仅CLI` | Web 无 thread 管理；`thread_*` 工具名只在 OmO 扩展源码层存在（见 §4），未投影为 Web 动作。 |
| `setup`、`doctor`、`session-of-pid` | `仅CLI` | 无对应路由。 |
| 服务账户与设备路由（`login/logout/whoami/sync/account/remote`；`sync enable/disable/status/approve/recover`；`account show/adopt/token/export/forget/devices/sign-in/retire-sync/store`；`remote status/devices/sessions/enable/disable/control/wake/bootstrap/open/send/model/interrupt/close/attach/help`） | `仅CLI`（边界禁止） | 账号、设备、同步、密钥属独立 auth 路由；Web 不采集秘密、不暴露 socket 与凭据（见 [sessions.ts](../../src/sessions.ts) 与 [protocol.ts](../../src/protocol.ts) 的 `secret/private` 过滤）。 |
| 已移除或不可用：`app-server`（改用 `--mode rpc`）；`omo ulw-loop`（Native 包装器不可用；同名 TUI skill 或 eval SDK 仍在包中） | `仅CLI`（不存在即不可用） | Web 不复活已移除命令。 |
| 主帮助选项组（模型与 prompt、输出与会话、权限及可见工具、资源与规则、运行拓扑与呈现、OmO 扩展开关全量、`--grok-neo/--mcp-presenter-fd/--mcp-presenter-enforcement`、`--listen` 受 RPC、hand 与 headless 约束） | `仅CLI`（启动参数） | Web 启动时由运维配置决定（见 [server.ts](../../src/server.ts)），浏览器无 argv 面。`--no-approve` 只是启动期项目信任，不是用户审批（见 [web-api.md](../../docs/web-api.md)）。 |

命令来源与可执行：上表“来源”是 CLI 分发声明；“可执行”指能否在浏览器点一下就产生同等原生副作用。Web 对 CLI 管理命令的可执行答案全部是“不能”。

---

## 2. TUI slash：14 个 Web 内置、19 个明确拒绝、动态注册表

### 2.1 Web 内置允许表（`直接`，精确匹配优先；其中子集有当前版浏览器收据）

来源为 [builtin-commands.ts](../../src/web/builtin-commands.ts)（`BUILTIN_COMMANDS` 14 项，长度断言见 [builtin-commands.test.ts](../../test/builtin-commands.test.ts)）。

`new`、`resume`、`sessions`、`rename`、`name`（`rename` 别名）、`session`、`tree`、`fork`、`clone`、`compact`、`model`、`thinking`、`fast`、`copy`。

分发规则：

- 仅 `/头` 精确命中才进入内置；` /model`、`/Model`、`/modelx`、`/tmp/foo`、`/nope`、`/` 全部回普通文本路径，走普通文本流程。
- 无参内置带参即拒绝，不转发：`/new extra`、`/resume yesterday`、`/sessions all`、`/session verbose`、`/tree abc`、`/fork entry-1`、`/clone here`、`/copy all`。
- `rename/name` 最长 120 字；`compact` 最长 6000 字；`model` 只接受单个精确引用（`--default` 等统统拒绝）；`thinking` 只接受单个档位（大小写归一）；`fast` 只接受 `on/off/无参切换`。
- 浏览器先跑该解析，命中内置才走工作台调用（如 `/session` 开详情、`/copy` 读最后一条助手文本），不直接拼原生文本。
- 当前版浏览器收据：`BROWSER_BUILTIN_PARITY_OK` 至少含 `native-rename details fork-selector tui-only-not-sent`。即当前版已在真实浏览器中验证改名、详情同义、fork 选择器、TUI-only 不发送。其余 14 项的解析与工作台调用仍以回归测试为准，不把该收据外推为 14 项逐项浏览器重演。

### 2.2 Web 明确拒绝的 TUI 名（只提示不转发；拒绝行为有当前版浏览器收据）

来源为同一文件的 `TUI_ONLY_NAMES`，共 19 项：

`settings`、`scoped-models`、`reasoning`、`efforts`、`login`、`logout`、`trust`、`export`、`import`、`share`、`reload`、`hotkeys`、`help`、`keybindings`、`changelog`、`quit`、`exit`、`bug`、`debug`。

其中 `quit/exit`、`name/sessions/exit` 的别名关系以原生盘点为准（`name/sessions/exit` 分别是 `rename/resume/quit` 别名），Web 只认上表字面名。`tui-only-not-sent` 即此拒绝行为的当前版浏览器收据，不由 fixture 推断。

### 2.3 原生 TUI 全集对照（命名条目，不分组模糊）

- Senpi 固定表 27 项：`settings`、`model`、`tree`、`thinking`、`scoped-models`、`favorite-models`、`export`、`import`、`share`、`copy`、`rename`、`name`、`session`、`changelog`、`hotkeys`、`fork`、`clone`、`trust`、`login`、`logout`、`new`、`compact`、`resume`、`sessions`、`reload`、`quit`、`exit`。
- TUI 输入分派特殊：`/skill`、`/skill:<name>`（实际资源名走 `/skill:<name>`），另有非承诺内部 `/debug` 与两个内部名（不作公开承诺）。
- Senpi builtin 注册 29 项：`account`、`answer`、`btw`、`claude-account`、`cursor-account`、`diff`、`efforts`、`fallback`、`fast`、`files`、`goal`、`gpt-account`、`handoff`、`help`、`history`、`hooks`、`ir`、`keybindings`、`lookat`、`loop`、`mcp`、`nested-agents`、`reasoning`、`reload-rules`、`rules`、`todo`、`ttsr`、`tui`、`websearch`。受扩展开关、会话、模型、provider 与客户端约束；例如 `/efforts` 需分级推理，`/share` 可被关闭。
- OmO 注册：`computer`、`feedback`、`bug`、`remote`、`side-panel-diff`；内存组件 15 项：`memory`、`memfs`、`remember`、`init`、`doctor`、`recompile`、`memory-repository`、`sleeptime`、`reflect`、`dream`、`search`、`people`、`facts`、`agreements`、`palace`。
- OmO task：`tasks`、`task-kill`、`dag`。
- 动态注册：`/skill:<name>`、已加载 prompt 模板的 `/<template>`、MCP prompt 产生的命令、已安装扩展的命令。OmO 的 `skill-commands` 另为已装载 bundled skill 提供 `/<name>` 输入转换与补全，已有命令优先；disabled 或 missing 不可用。

Web 判定：

- `直接`：§2.1 的 14 项（其中改名、详情、fork 选择器另有当前版浏览器收据）。
- 明确拒绝：§2.2 的 19 项（有 `tui-only-not-sent` 收据）。
- 无专用语义 UI 但可能经通用路径处理：上述 builtin 注册、OmO 注册、内存组件、task 三项中的未知或动态名。Web 对它们没有专用语义界面，但若其名出现在当前会话 `get_commands` 目录中，则可经通用命令路径列出与路由（见 §3）；不能仅因无专用界面就断言不可转发。原生 TUI 侧对这些名的处理本身未验证，不得把 Web 通用路由等同于原生 TUI 语义。
- `未验证`：`/efforts` 与思考档、`/reasoning` 与思考档的语义差，Web 未设独立映射，不得把档位切换当等同。两当前版验证器不覆盖这些语义差。

---

## 3. 命令来源与可执行（动态注册表，不把“能列出”当“能管理”）

来源为 [commands.ts](../../src/commands.ts)（`COMMAND_SOURCES=extension/prompt/skill`）、[sessions.ts](../../src/sessions.ts) 的 `options` 与 `action`、[commands.test.ts](../../test/commands.test.ts) 的 fixture 行为。

| 维度 | 原生事实 | Web 事实 |
|---|---|---|
| 目录来源 | `get_commands` 合并当前注册的扩展命令、prompt 模板、skill（`skill:<name>`）；不返回固定 TUI 表。刷新事件为 `commands_changed` 与 `loaded_surfaces_changed`；`get_loaded_surfaces` 与 `get_protocol_info` 不同层。 | `GET /api/sessions/:id/options` 返回 `commands: {name,description,source,invocation}[]`，`source` 仅 `extension/prompt/skill` 三值；`sourceInfo`（路径与发现元数据）恒丢弃。测试断言原始路径不外泄。 |
| 规范调用 | OmO `skill-commands` 为已装载 bundled skill 提供 `/<name>` 转换与补全；RPC 侧以 `$名` 为规范 skill 形。 | skill 形为 `$名`，扩展与 prompt 形为 `/名`；非法名无调用形式，直接丢弃。另接受 legacy `/skill:名` 回退到 `$名`。浏览器输入另有调用 token 校验（见 [app.ts](../../src/web/app.ts)）。 |
| 执行语义 | 原生 `session.prompt` 对扩展优先；TUI 提交是内置精确匹配优先，之后回退扩展。两者顺序不同，不可套用。 | `POST actions {action:"command", invocation, arguments?}` 先重读 `get_commands`，再校验注册，再查空闲（忙时 `409` 不排队），最后拼单行消息走 `prompt` RPC。未知命令不降级为模型提示；多行、控制字符、超长拒绝；TUI-only 名拒绝且无模型输入，且该拒绝有当前版 `tui-only-not-sent` 浏览器收据。 |
| 插件目录管理 | CLI 管理包与扩展 | `仅CLI`：Web 无安装、启用与禁用面；命令列表是执行入口，不是管理入口。两当前版验证器不验证第三方插件。 |
| 通用工具输出 | 原生工具执行流 `tool_execution_start/update/end`（见 §7） | `只读`：[tool-display.ts](../../src/web/tool-display.ts) 按中文标签展示（读取、编辑、写入、搜索、查找、列目录、运行命令、工具调用），超长、前导 `-` 与疑似密钥段恒脱敏，未知名仅原文回显。不是工具管理。 |
| 经由 agent 的 skill | 包内 28 项加 1 条件项在原生侧由 agent 按需调用 | `间接`：Web 不直接列 skill 文件、不读正文；skill 只以 `source:"skill"` 行出现在目录，或以 Todo、记忆与工具轨迹的只读投影出现。 |
| 无原生管理界面 | — | Web 无扩展、技能、MCP、包、设置、账户与分享管理页（见 [app.ts](../../src/web/app.ts) 与 [web-api.md](../../docs/web-api.md)）。 |

---

## 4. 随包能力与工具：Web 只投影结果，不开放管理

来源为 [protocol.ts](../../src/protocol.ts) 的事件、状态与消息筛选加 [details.ts](../../src/web/details.ts)。

- 引擎基础工具（`omo --help` 实测名）：`read`、`bash`、`powershell`（Windows）、`grep`、`find`、`ls`（后三者默认关闭）。Web 判定为 `间接`执行加 `只读`投影，无开关面。
- Senpi builtin 注册 ID（含 `loop-guard`、`moved-path-guard`、`kill-guard`、`credential-proxy`、`hooks`、`permission-system`、`gpt-apply-patch`、`ask-user`、`herdr`、`imagegen`、`prompt-preset`、`todowrite`、`websearch`、`webfetch`、`look_at`、`rules`、`goal`、`loop`、`schedule`、`mcp` 等，加全局默认 `diff/files/prompt-url-widget/tps`，能力组不等于当前工具名单）。Web 判定为 `间接`与 `只读`；凭据代理相关秘密永不投影（`dialog()` 过滤 `secret/private`）。
- 工具名与工具族：终端组、问题组、`apply_patch`、`todo`、`tool_search`、目标与唤醒组、重定位组、搜索与抓取组、图片组、媒体组等；Provider-hosted、媒体、工具搜索、MCP 即时与按需、eval-only 分层，不能用单轮 tool list 代替。Web 判定为 `间接`执行加 `只读`显示；eval 相关路由未向浏览器开放。
- OmO 组：Task、DAG、workpool 与 team；thread、device、daemon 与 wake；记忆与历史；Onboarding 与 feedback；LSP、AST、质量与配置；Browser、desktop 与 search。Web 判定：除运行检查器只读投影外，其余无专用语义界面；若其能力以工具或 `get_commands` 行出现，可经通用路径执行或列出，原生侧处理未验证；不把文件存在当已绑定或已运行。

---

## 5. 插件、主题、技能、MCP 与角色：点名对照

来源为资源盘点全量点名；Web 侧无管理端点（见 [web-api.md](../../docs/web-api.md)）。在途计数与新启动行为按 §0.3 区分。

### 5.1 已配置包（9 个配置入口，均在盘可定位；不是 9 次加载证明）

`npm:context-mode@2.1.5`、`npm:@narumitw/pi-sync@0.58.0`、`npm:awesome-pi-themes@1.2.19`、`git:github.com/obra/superpowers`（包清单 `7.0.2`，15 个在盘 skill，配置 4 选：`test-driven-development/systematic-debugging/verification-before-completion/receiving-code-review`）、`npm:pi-interactive-shell@0.18.0`、`npm:pi-notify@1.4.0`、`npm:pi-autoresearch@1.9.0`（当前仅 `create/hooks` 可见）、`npm:pi-powerline-footer@0.22.0`、`git:github.com/NekoCCN/pi-cc-extensions`（包清单 `1.0.22`，4 个 `cc-*` 主题）。

另有已安装非配置：`npm pi-cc-extensions@1.0.21`（同名主题重复，不计有效）、`@plannotator/pi-extension@0.28.50`（不计配置加载）。

Web 判定全部 `仅CLI`（无包安装与启用面）。两当前版验证器不验证实际第三方插件。

### 5.2 用户扩展入口（13 可发现，含 4 shim；未逐项加载确认）

- 运行时默认 shim 4：`diff.js`、`files.js`、`prompt-url-widget.js`、`tps.js`。
- 用户直接入口 2：`omo-herdr-dag.js`、`powerline-live-speed.ts`。
- 用户子目录 7：`agent-detail-style/index.js`、`auto-compact/index.js`、`editor-rounded/index.js`、`herdr-status/index.js`、`planning-guide/index.js`、`sidebar-density/index.js`、`subagent-model/index.js`。
- 非扩展 2：`goal/`（无入口）、`powerline-footer/`（仅 `theme.json`）。

Web 判定为 `仅CLI`或 `未验证`；静态可见注册声明不等于本会话调用；`goal/` 目录不等于插件加载。

### 5.3 Skill（工作区锁 28 项加用户根加包与运行时注入；在途计数不是新启动保证）

- 工作区锁 v2 共 28 项（12 个 GitHub 来源，双向对应在盘 `SKILL.md`）：5 项、1 项、1 项、4 项、3 项、5 项、1 项、1 项、1 项、1 项、1 项与 4 项，具体名称为 `3d-falling-leaves/3d-underwater-god-rays/build-wireframe-scan-reveal/paper-cinder-transition/scroll-world-storytelling/agent-browser/anatomy/animation-performance/choreograph/learn-taste/review-animations/better-typography/state-machine/variant/gsap-core/gsap-performance/gsap-react/gsap-scrolltrigger/gsap-timeline/hallmark/impeccable/interface-design/pixijs/shader-dev/threejs-fundamentals/threejs-performance/threejs-postprocessing/threejs-react-three-fiber`。
- 用户侧在盘：`~/.omo/agent/skills` 23 项、`~/.agents/skills` 32 项、`~/.claude/skills` 33 项（旁路，加 `graphify`，不计 OmO）。23 项名称为 `ai4s-agent/cua-driver/experiment-suite/find-skills/gstack/humanizer/impeccable/integrity-auditor/literature-survey/manim-composer/manimce-best-practices/manimgl-best-practices/matplotlib/mindmap-render/officecli/openalex/paper-writer/ppt-master/repomix-explorer/research-explorer/scientific-visualization/seaborn/statistical-analysis`；另 9 项为 `a11y-debugging/better-writing/chrome-devtools/chrome-devtools-cli/cookie-debugging/debug-optimize-lcp/memory-leak-debugging/shuorenhua/troubleshooting`。
- 盘点会话提示公开 95 项按来源：工作区 24、用户根 22、共享根 9、包根 7、运行时 2、发行包 28、会话附加 3。具体 28 项发行包 skill 为 `ast-grep/browser/coding-agent-sessions/dag-library/data-scientist/debugging/eval-integrity/frontend/git-master/give-me-tips/hyperplan/init-deep/lsp-setup/mass-ulw/omo-relay/onboarding/programming/refactor/remove-ai-slops/review-work/ultimate-browsing/ultrawork/ulw-execute/ulw-loop/ulw-plan/ulw-research/visual-qa/visualize`。
- 条件目录仅 `x-search`；发行包 persona 4 项不计用户模板；用户模板 0。

Web 判定为 `间接`，无 skill 文件浏览、安装与正文阅读面。

### 5.4 MCP（7 配置声明；在途提示工具不等于 Web 面）

- OmO 用户配置 7：`magpie-artifacts`、`tinyfish`、`chrome-devtools`、`firecrawl`、`codegraph`、`officecli`、`context7`（无显式禁用）。工作区与兼容入口均为 0；不自动读 Claude 配置。
- 在途提示所见（非 Web）：盘点会话提示中可见的直接工具与服务器说明属于在途 CLI agent 提示层，不属于 OmO Web；不得把它们记为 Web 的直接 MCP 面板或工具清单。`magpie-artifacts/chrome-devtools` 仅配置声明，不排除延迟暴露。
- 旁路不计 OmO：Claude 用户配置 8、插件缓存 5 名、旧 profile 9 加 1。
- 随包 bundled MCP：`context7`、`grep_app`（惰性连接，同名用户或项目设置优先，可关闭）。

Web 判定为无直接 MCP 面板、无工具清单；只有通用工具输出，以及按条件注册的 MCP prompt（若出现在 `get_commands` 则经 §2.3 通用命令路径列出与路由）。无 MCP 安装、握手、鉴权与连接管理面。

### 5.5 主题、Hook 与角色（点名，不计加载）

- 主题候选 77 个具名文件：用户目录 2 个（`sakura-dusk`、`sakura-nocturne`），Git `pi-cc-extensions` 4 个（`cc-dark`、`cc-light`、`cc-dark-hc`、`cc-light-hc`），再加 `awesome-pi-themes` 的 71 个。Web 都没有导入或切换这些 CLI 主题的入口；Claude 的 48 个主题另计。
- `awesome-pi-themes` 的 71 个：`alien-candy`, `amethyst-drift`, `arctic-aurora`, `auric-cascade`, `aurora-circuit`, `azurite-vespers`, `basalt-bloom`, `bramble-current`, `breezy-ocean`, `celadon-codex`, `chrome-orchid`, `cinder-grove`, `cobalt-sanctum`, `codex-slate`, `copper-comet`, `cosmic-lagoon`, `crimson-noir`, `cyber-mint`, `dragon-lulu`, `eclipse-tide`, `ember-sunset`, `emberglass-harbor`, `enchanted-forest`, `glitch-carnival`, `golden-dusk`, `graphite-seaglass`, `halcyon-rivet`, `inkfire-bay`, `iron-lotus`, `laser-swamp`, `lavender-mist`, `lunar-alchemy`, `meomeo-mang`, `mercury-lantern`, `midnight-basilica`, `midnight-orchid`, `moonlit-terrace`, `moonstone-koi`, `moss-mirage`, `nebula-scriptorium`, `neon-sakura`, `nocturne-garden`, `noodle-nebula`, `obsidian-harbor`, `obsidian-tidepool`, `opal-matrix`, `opal-vespers`, `paper-moon`, `petrol-peony`, `plasma-pomegranate`, `polar-lantern`, `princess-nam-rom`, `quantum-pickle`, `quartz-fjord`, `radioactive-lullaby`, `rainbow-prism`, `sable-citadel`, `saffron-cavern`, `sapphire-ember`, `signal-cloister`, `starry-night`, `static-dragonfruit`, `stormglass-forge`, `tuscan-sun`, `varigotti-sea`, `velvet-meteor`, `verdigris-nocturne`, `violet-breakwater`, `volcanic-bubblegum`, `willow-wraith`, `winter-wisp`。
- Hook：原生用户与工作区均未找到，配置包无显式声明；另有物理目录不等于原生注册。
- 角色：盘点会话 16 常规加 2 计划专用加 12 category，具体为 `astra-reviewer/complex-image-reader/delivery-worker/escalation/explore/image-aesthetic-reviewer/librarian/omo-native-code-reviewer/omo-native-gate-reviewer/omo-native-qa-executor/playrole/quick-scan/story-creator/technical-lead/technical-writing/terra-coding` 加 `plan-consultant/plan-reviewer` 加 `architect/artistry/deep-high/deep-low/memory-recall/memory-reflection/quick/ultrabrain/unspecified-high/unspecified-low/visual-engineering/writing`。

Web 判定为 `仅CLI`或 `未验证`；Web 只做主题浅暗呈现，不提供主题、角色与 Hook 管理。

---

## 6. 设置路由：Web 只做会话级，其余仅 CLI

| 原生路由 | Web 判定 |
|---|---|
| `omo config agent-dir --json`、全局与项目设置、覆盖变量与品牌路径 | `仅CLI`；Web 启动 profile 由服务端 pinned，浏览器不改 agent dir。当前版已用该命令值比对确认解析器目录为默认 `~/.omo/agent`，该确认只定目录，不开 Web 写。 |
| TUI 首选项与独立选择器（含模型默认、思考档默认、收藏模型、作用域模型、键位、信任、MCP） | `仅CLI`，除下述会话级子集为 `直接`。 |
| OmO 组件与角色配置（用户加项目层，持久开关与本次强制，禁用 skill，兼容与监听路由） | `仅CLI`；Web 不编辑组件配置。 |
| MCP、文件、权限与迁移，凭据与账户独立路由 | `仅CLI`；Web 每次 open 固定 `permissionPreset:"ask"`，换端或重开即回 `ask`（见 [sessions.ts](../../src/sessions.ts)），浏览器只切会话预设（见 §7）。 |

---

## 7. 运行形态、会话与 RPC：Web 实际投影与未开放（含当前版 holder 与 store 收据）

### 7.1 Web 引擎形态（源码事实加当前版验证器收据）

- [engine.ts](../../src/engine.ts)：Web 拥有的私有非监听 stdio host（`--mode rpc --multi-session`，`--session-runtime in-process` 可配）；握手要求 `get_protocol_info {mode:"multi",protocolVersion:1}` 加 `set_client_info {width:96,capabilities:["interactive_user","question"]}`；受控客户端能力为非用户配置；发行模板为多会话、进程内、主包加成员、瞬态冷启动，不是运行实例数值。
- 当前版 holder 与 store 收据：[verify-shared-store.ts](../../scripts/verify-shared-store.ts) 经生产入口 `startApp` 加真实 `omo` 加隔离 profile 加回环模型证明 Web host 为私有、新建落入原生 profile 桶并绑定 durable id、持有期裸 `omo --session` 被拒绝、安静释放后返回引文 Shell 命令、二次打开与 Web resume 互斥、自定义 `sessionDir` 不搬迁 pathless 落盘（记为不支持）。原生 `attach/park/claim` 等仍存在于分派，但 Web 不提供监听 socket host。
- 新启动版本确认：`bun <current-runtime>/dist/cli-main.js --version` 独立报告 `2026.11.23`；在途旧运行时不作为启动目标。
- 终端实时：[terminal-wire.ts](../../src/terminal-wire.ts) 仅 12 白名单（`get_protocol_info/list_sessions/get_state/get_messages/get_entries/set_client_info/attach_session/release_attachment/prompt/steer/follow_up/interrupt`）；`set_client_info` 能力恒空数组，`get_entries` 限字节；拒绝码只投射结构化码，不透传原生原因与动作。

### 7.2 Web 会话动作全集（`直接`，见 [protocol.ts](../../src/protocol.ts) 与 [sessions.ts](../../src/sessions.ts)）

`resume`、`prompt`（含 `steer/follow_up`）、`command`、`abort`、`rename`、`archive`、`settle`、`model`、`thinking`、`preset`（`ask/auto/full-access`）、`fast`、`autoCompaction`、`compact`、`clearQueue`、`navigate`、`answer`。

- 空消息加无图拒绝；客户端消息 ID、轮次期待、图片直通并回筛选字段。
- `command` 见 §3（重校验加空闲加单行组装后走 `prompt`）。
- `model` 仅会话作用域，缺能力即 `409`；无“设为默认”。
- `thinking` 全档直通，作用域为当轮；`/reasoning` 与 `/efforts` 无独立映射。
- `preset` 按会话调用，须回执与生效一致才算成功；`auto` 需能力否则 `409`；任何预设下结构化问题仍需显式答案；秘密永不投影。
- `answer` 仅四法且非秘密；不匹配即 `400/409`；回扩展 UI 响应并广播解决事件。
- `navigate` 带叶期待值，过期叶不改历史。
- 其余为改名、归档、结清、极速、自动压缩、压缩、清队列的标准映射。
- 显式不支持的原生 classic、账户、项目与工具方法均未向浏览器开放为动作。

### 7.3 Web 只读投影（`只读`，字段筛选，缺数即不可用，不造零）

- 快照为状态加消息筛选；选项为模型、档位与命令三并发（模型至多 7 个投影字段）。
- 详情为统计、队列、树、状态与 listing 五并发；返回统计、队列、树、运行分支、状态子集与会话内存。百分比按原生值换算，分母 0 或缺分量即不可用。该详情同义有当前版浏览器收据。
- 本轮新增只读面（三路由，见 [web-api.md](../../docs/web-api.md)）：`GET /api/sessions/:id/native-runtime` 返回任务、DAG 与记忆三区（`ok / empty / unavailable / malformed / ownership_changed`），未知 Web 会话 `404` 其余按区 `200`，1–256 行投影，不返回原生路由、持久身份、标识、路径与文本，合法空列表不拿旧快照补位；`GET /api/sessions/:id/capabilities` 返回扩展、MCP 与命令三组（`ok {rows, incomplete} / unavailable`，各至多前 128 条），只读清单不做安装与连接管理；`GET /api/sessions/:id/model-preview?provider=…&modelId=…` 只读预览目标模型生效档位与来源，不切换不缓存。真实 `5.1.83 / 2026.11.23` 私有 stdio 下验证为空数据基线（任务 `empty`、DAG `empty`、记忆 `ok` 零计数）与档位来源投影；非空渲染、截断、降级与竞态由合成夹具覆盖，不把夹具当真实副作用证据。任务消息、取消与 DAG 控制均未开放为浏览器动作。
- 浏览器事件白名单含消息、工具、扩展 UI、问题、模型、服务层级、队列、agent、轮次、压缩、重试、目录变化、待输入、会话关闭、停放、释放、替换、扩展错误与写失败；其余原生事件不进浏览器。
- 原生 activity：只读扫描解析器目录下 `herdr-dag` 的定长十六进制 JSON（文件数与字节均限预算），剥离 prompt、transcript、路径与原始错误；运行与任务均限预算；sidecar 恒跳过。此处解析器目录指确认的默认 `~/.omo/agent`，不是在途旧运行时目录。
- CLI 历史：只读扫描原生 journal（文件、字节、会话与消息均限预算）；无目录表关闭，有目录无记录表空；按原生 ID 与目录合并 Web 别名；详情仅最新分支可显示投影，不返原始 journal；恢复走来源重验后开同一日志，不复制。
- CLI 实时：只读发现（稳定不透明 ID，非原生、宿主、文件与 socket 标识，重启即失效）加连接、断开、输入与停止四动作；断开幂等只释 Web 附着，不释原生；暂存不等于已执行；结果不明只重读人工核对，不重发。
- 分支：三源各自的分支出选项与分支，来源只由 URL 选择键解析，不接受路径与叶；Fork 只回填草稿不自动发送，Clone 保留上下文；新会话已施原生 `ask` 预设；取消为成功但无会话。fork 选择器有当前版浏览器收据。
- 交接：历史恢复（同一日志开 Web 书签，不建新会话，不复制，持有者拒绝即不关闭对方）加会话交接（安静释放后返回手动 Shell 文本，不含 socket 与凭据，不接受目标路径与打断选项；仅 sole-holder 私有 stdio 才允许 force 重试，监听传输恒不 force；传输不明即丢路由不重放）。当前版收据为 `NATIVE_SESSION_HANDOFF_OK` 加 `BROWSER_SESSION_HANDOFF_OK`（隔离数据加回环合成模型为界）；[verify-shared-store.ts](../../scripts/verify-shared-store.ts) 另证同日志、持有期拒绝、私有落盘与互斥语义，自定义 `sessionDir` 不支持。

### 7.4 原生 RPC 与事件全集对照（命名条目）

- Host 与会话入口分派：协议信息、会话列表、启动证明、委托声明、客户端信息、打开、附着、停放、认领、预热、移动、选择、开始交接、断开订阅等，加回收、释放附件、释放会话、卸载、关闭、上下文、流重置、恢复页、释放恢复、presenter 分配、获取与撤销，加机器操作五项。Web 仅用其中子集，其余无专用界面或未验证。
- 扩展方法示例（独立命名空间，源码辨认）：task 四项、DAG 五项、模型路由一项、browser 两项、feedback 两项、memory 三项、onboarding 十项、toolkit 两项；发布侧线索不当请求路由。Web 仅经由运行检查器读 DAG 与任务快照，不开放这些 RPC 为浏览器动作。

---

## 8. 覆盖矩阵（按用户任务归纳，分组内每成员已在上文点名）

| 用户任务 | Web 状态 | 覆盖或缺口一句话 |
|---|---|---|
| 新会话、继续、列表、重命名、归档、结清、看信息、看树、分支与副本 | `直接`（其中改名、详情、fork 选择器有当前版浏览器收据） | 全有；树经详情开原生树，fork 与 clone 成新 Web 会话。 |
| 发消息、换端续写、停止、清队列、压缩与导航 | `直接`（换端有当前版双端收据） | 忙时命令不排队，掉线不补发；同日志换端以双端收据为界，不含真实 provider。 |
| 换模型、换档位、极速、自动压缩与审批预设 | `直接`（子集） | 仅本会话或本轮；无默认、轮换与记住默认；推理开关与分级阶梯无映射。 |
| 回答审批与结构化问题 | `直接` | 强校验加私密过滤；任何预设下结构化问题仍需显式答案。 |
| 看用量、缓存、内存、待答、队列、树与统计 | `只读`（其中详情有浏览器收据） | 缺数即不可用，不造零。 |
| 看原生 DAG 与子代理快照 | `只读` | 文件投影运行与任务；长期记忆仅当前分支召回状态，非全面板。旧快照回退仅在原生明确 `unsupported` 时发生，其余不可用、归属变化、超时与 HTTP 拒绝均不回退。 |
| 看实时子代理 / DAG / 记忆读数 | `只读` | 经 `native-runtime` 按区投影状态、时间、行数与节点数；真实宿主为空数据基线，非空只由合成夹具验证。任务与 DAG 写操作未开放。 |
| 看能力清单与模型档位预览 | `只读` | 经 `capabilities` 看扩展、MCP 与命令目录（只读，不做安装与连接管理），经 `model-preview` 看目标模型生效档位与来源（不切换）。 |
| 用扩展、prompt 模板与 skill 命令 | `间接`执行加 `只读`目录 | 可列可调，不可管理；单行组装加空闲检查加未知拒绝；TUI-only 不发送有当前版浏览器收据；动态名适用 §2.3 通用路径说明。 |
| 看通用工具执行 | `只读` | 中文标签加脱敏目标；未知工具仅原文。 |
| 发现 CLI 历史、实时 CLI、同日志换端与分支 CLI | `只读`加 `直接`（受限换端与分支，有当前版收据） | 断开不释原生；交接命令需本机手动运行；私有落盘、同日志、持有期拒绝与互斥以共享 store 脚本断言为界，自定义目录不支持。 |
| 安装、更新、登录、同步、设备、远端、调度、守护、线程、诊断与导入迁移 | `仅CLI` | 无 Web 管理面；终端输入路径不计 Web 覆盖。 |
| 全局设置、项目信任、MCP、skill 文件、账户、分享、导出与导入 | `仅CLI`（边界禁止或未实现） | 19 项明确拒绝（拒绝行为有收据）；分支内部导出仅 staging，不对外。 |

---

## 9. 优先缺口

1. 当前会话的能力清单已上线；全局已配置或已安装但未加载的资源仍没有可靠的 Web 目录。包、扩展、技能、MCP、全局模型、账户、调度、守护与线程的管理仍需 CLI。
2. 推理开关与分级阶梯语义缺口：档位不等于推理开关与分级阶梯。建议先立不支持牌，再实测补映射或明确拒绝。
3. 交接仍需手动 Shell：命令不自动执行，断开不释原生，释放失败即丢路由。当前版已证同日志、持有期拒绝与互斥语义，但手动语义不变。建议保留手动语义，补释放后只读提示与复制按钮回执。
4. skill 与工具能调不能管：目录行可执行，但来源包、版本与启用条件不可见。建议追加只读标注（不返路径）与错误码分组。
5. 版本与证据易混：当前静态盘点与先前浏览器实测是两对版本；在途旧运行时与新启动目标是两代。建议在引擎版本旁常驻已验证版本对加解析器目录提示；新增收据只在脚本断言内有效，不外推到插件与真实 provider。

---

## 10. 可复现的安全探针（不碰秘密、不写用户配置、不产生外部副作用）

以下均只读或仅写隔离临时目录；不要在真实 profile 或真实会话上执行写动作。

- 版本、解析器目录与运行时（只读 CLI）：
  `command -v omo && readlink -f "$(command -v omo)" && omo --version`
  `omo config agent-dir --json`（只做值比对确认默认 `~/.omo/agent`，不改配置）
  `bun <current-runtime>/dist/cli-main.js --version`（应独立报告 `2026.11.23`，区分在途旧运行时）
  `omo <install|remove|update|auth|host|schedule|daemon|thread|setup|doctor> --help`（逐个看帮助，不执行子命令）。
- Web 启动与只读面（本机同源，token 经 bootstrap 获取）：
  `GET /api/bootstrap`、`GET /api/sessions`、`GET /api/sessions/<webId>/options`（核对命令名、来源与调用形式无路径）、`GET /api/sessions/<webId>/details`（核对运行与内存为可用或不可用，而非伪零）。
- 写路径拒绝探针（仅隔离会话）：
  未注册的名称通过 `POST /api/sessions/<id>/actions` 提交为 `command` 时返回 `unknown_command`，不产生模型调用；
  在浏览器命令界面提交 `/settings` 会被标记为终端专用、不转发；`tui-only-not-sent` 是浏览器收据，不等同 API 中存在另一份 TUI 命令拒绝表；
  `{"action":"command","invocation":"/echo","arguments":"one\n/two"}` 应拒绝。
- 逻辑回归（fixture，不连真实引擎）：
  `bun test test/commands.test.ts test/builtin-commands.test.ts test/cli-history.test.ts test/session-branches.test.ts`
  构建启动后按 [ui-brief.md](../../docs/parity/ui-brief.md) 核对布局（仅布局祖先，不作能力证据）。
- 当前版 holder、store 与内置验证（隔离 profile 与临时目录加回环合成模型，`--offline --no-approve`，不连外部，不验证第三方插件与真实 provider；断言以脚本原文为准）：
  `bun --no-orphans scripts/verify-session-handoff.ts "$cli" --browser --slash`（应含三收据，后者至少四子项）
  `OMO_WEB_BIN="$HOME/.bun/bin/omo" bun --no-orphans scripts/verify-shared-store.ts`（经实际包装器退出 0；覆盖私有落盘、同日志、持有期拒绝、安静释放引文命令与互斥，自定义目录不支持）。
- 原生模板的独立验证复用 [verify-native.ts](../../scripts/verify-native.ts) 的隔离 profile、Web 入口和回环模型设置，只运行模板路径：`options` 枚举 `source: "prompt"` 和 `/web-workbench-smoke`，Web 提交该 `command` 后，回环模型实际收到模板展开内容。
- 同一脚本的当前版完整补跑未通过：隔离模型桩在工具审批段遇到只声明了 `record_fact`、`record_agreement` 的请求，而脚本预期该请求一定声明 `write`（错误 `The real engine must publish its write tool`）。未据此宣称新版完整原生审批冒烟通过，也未修改原测试绕过失败；前述独立模板验证和 240 项套件是不同的证据。

---

## 11. 边界与不主张

- 未读凭证值、真实会话与模板正文，未输出秘密、设置值、端点与命令参数。
- “注册”指源码可注册，不代表所有项目、模型、终端与客户端可用；“配置、安装与可见”按资源盘点口径区分加载成功与否；在途计数按 §0.3 区分新启动行为。
- 未验证活动 profile 的条件化库存、连接后 RPC 广告、交互显示与快捷键、跨设备或 provider 与 MCP 可达性，也未评估 Web 之外的面。
- 先前浏览器与脚本实测不转作当前版证据；历史静态盘点不视为能力。新增当前版验证仅覆盖其实际断言，均用隔离数据与回环合成模型，不验证实际第三方插件和真实账户 provider。终轮含真实宿主与浏览器选项的全量为 269 过、0 失败；非空渲染来自合成夹具，任务归属写入与终态语义只在断网真实原生探针里验证，未随版本交付浏览器写操作。浏览器兼容发布仍关闭（含显式 opt-in），手动交接命令不计入 Web 对等；此前批准的补充冒烟只在其已证断言内有效，不扩大为发布或运行时证据。
