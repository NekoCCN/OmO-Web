# OmO Web

OmO Native 的本机浏览器工作台。后端直接使用 OmO 的多会话 RPC；模型、上下文、工具和权限判定都由原生引擎处理。浏览器不接触 API 密钥、OmO 控制 socket 或通用 RPC 接口。

## 启动

需要 Linux 或 macOS、Bun 1.3+，以及已安装并配置模型凭据的 [OmO Native](https://github.com/code-yeongyu/oh-my-openagent)。已实测 OmO **5.1.81**（Senpi **2026.11.19-5**）。这里的 `omo` 是 Native CLI，不是旧版 OpenCode 插件。

```sh
omo --version
bun install --frozen-lockfile
OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun start
```

把示例目录换成真实存在的项目。用浏览器打开终端打印的地址，默认是 **http://127.0.0.1:4317**。不设置工作目录时使用启动目录。打开多个项目时，在 Linux/macOS 用 `:` 分隔绝对路径。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMO_WEB_WORKSPACES` | 启动目录 | 允许新建和恢复会话的工作目录 |
| `OMO_WEB_PORT` | `4317` | 仅在 `127.0.0.1` 上监听；`0` 分配随机端口 |
| `OMO_WEB_BIN` | `omo` | 对应的 Native CLI 可执行文件 |
| `OMO_WEB_DATA` | `~/.omo-web` | Web 会话索引和原生 JSONL 记录；一个目录只开一个服务实例 |
| `OMO_WEB_CLI_AGENT_DIR` | `OMO_CODING_AGENT_DIR` → `SENPI_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR` → `~/.omo/agent` | 选择 Web 原生引擎、本机 CLI 历史、实时发现及快照使用的同一个 OmO 配置目录；设为 `""` 关闭 CLI 数据入口，Web 引擎仍使用继承的 OmO profile。 |

`Ctrl+C` 停止服务及其 OmO 子进程。关闭页面或刷新不会停止生成；停止 Web 服务会结束这个 Web 引擎上的运行任务。保留 `OMO_WEB_DATA` 即可在重启后恢复会话。

## 能力与边界

| 领域 | Web 支持 |
| --- | --- |
| 会话 | 新建、搜索、重命名、归档/取消归档、完成标记、保存及恢复 Web 会话 |
| 执行 | 流式回复、停止、运行中修正/后续输入、队列查看和清空、PNG/JPEG/GIF/WebP 图片输入（每张约 2 MiB，最多 4 张） |
| 模型 | 原生模型列表、仅切换当前会话、思考档、快速模式、上下文用量、手动与自动压缩 |
| 可观测性 | 工作台直达子代理、DAG 快照和当前分支待办；待办视图附长期记忆召回计数，不含原文。运行详情显示会话树、原生 CTX、最新与累计缓存命中率、宿主主堆与会话内核内存 |
| CLI 历史 | 普通侧栏默认发现未被 Web 打开的本机 CLI 会话（约 30 秒刷新，进页面即读一次）；点选只读预览，显式「在 Web 继续」才受持有者接纳；已打开的会话合并到 Web 别名，不重复列出 |
| CLI 实时 | 显式连接已开启原生控制的本机 CLI；查看实时文字对话、发送普通消息、停止可核验的当前回合 |
| 分支 / 复制 | 从所选 Web 会话、CLI 历史或已连接 CLI 创建独立 Web 会话；分支只回填草稿，复制保留来源上下文 |
| 命令 | 在主工作台直接输入支持的 `/命令` 或 `$技能`；命令选择器只填草稿，显式执行才产生作用 |
| 人工交互 | 支持确认、选择、文本输入和结构化问题；工具审批可选「询问」「Auto」「无审批」 |

长对话先渲染最近 80 条，可分批向前加载。CLI 历史只读最后保存分支，单条记录最多展示最近 1,000 条可见消息；过大的日志不会被加载。工具调用默认展示简短的对象和状态，展开后才查看参数与输出。

**Web 专用会话宿主。** Web 启动一个独立的 `omo --mode rpc --multi-session --offline --no-approve --session-runtime in-process` 子进程：私有、非监听的本机 stdio 宿主，不发布可被其他 stock TUI 附着的端点；同一份日志的第二个打开者会被原生持有者检查拒绝。浏览器不接触 socket、凭据或通用 RPC。`--offline` 只关闭启动阶段的联网操作，不阻止模型请求；`--no-approve` 忽略未经信任的项目本地配置，不等于工具沙箱。会话默认采用原生 `ask` 预设，原生允许规则和已保存的批准仍可能生效。

**工具审批模式。** 在输入框旁选择「询问」「Auto」或「无审批」。Auto 由原生判断能否自动放行，并非沙箱；无审批为显式确认的 `full-access`，默认允许工具操作，原生权限规则仍有效。用户问题仍要回答，私密输入不转发到 Web。当前 Web 会话重开时回到询问，不修改全局设置或 CLI 默认值。

**继续同一段对话。** 默认共享同一套原生日志：Web 新建的会话直接落在所配置 profile 的原生目录，原生 CLI 选择器可直接列出、恢复；本机 CLI 新建的会话会出现在 Web 普通侧栏，点选只读预览，显式「在 Web 继续」才打开同一份日志（已有进程持有时被拒绝，不关闭它）。要从 Web 回到终端，点「会话管理 → 转到 CLI」释放会话，复制显示的本机命令到终端运行。不要提前启动第二个写入者：Web 在原生回合、待答交互、真实附着或其他未结束工作时不会强制交接；仅当原生把调用者自身的单连接误报为附着时，才用一次不带打断的受控 `force` 重试，并核验释放回执与零丢弃。CLI 退出后，可从同一个 Web 会话恢复。需要当前 OmO 支持原生持有者检查和安静释放，且 Web 引擎与 CLI 历史使用同一 profile。自定义 `sessionDir`（`settings.json` 绝对路径或单次 `--session-dir`）不受支持：无路径 RPC 仍走默认按工作目录分桶，Web 只发现该布局，位置不符会明确失败而不静默迁移。

**CLI 实时与分支。** 在侧栏选择「CLI 实时」，挑选会话后点击「连接」。这里只发现所配置 profile、所授权工作目录下已开启原生控制的本机 TUI，不会替你启动控制服务。断开或关闭弹窗仅释放 Web 的连接，不会关闭 CLI 或停止生成；停止当前回合是单独的操作。消息结果未知时请先在 CLI 核对，页面不会自动重发；如显示「暂存」，由 CLI 处理。工具审批、权限弹窗和私密交互仍由 CLI 上的人处理。实时、历史或 Web 会话选定后可点「分支 / 复制」：实时模式必须能核验当前分支位置，历史使用最后保存的分支；两者都不会切换、接管或修改来源。

分支 / 复制基于原生 v3 会话日志；不复制日志之外的媒体附件文件。实时视图只同步近期可显示文字，过大的原生响应会拒绝读取。

**不是完整 TUI 替代品。** Web 在会话空闲时执行已支持的内建命令，或当前会话注册且经 RPC 支持的扩展命令、提示模板和技能。未知或未支持的命令不会当作普通提示发送。不提供任意 shell；普通消息仍支持 `/tmp/foo` 等路径，若要把命令名当文字发给模型，在开头加一个空格。原生 DAG 与子代理快照、分支待办与记忆只读，不代表实时状态；打开运行详情即读一次，「刷新详情」或页面可见时重读。依赖任意 TUI 组件的交互、私密凭据、跨设备迁移、后台调度和全局配置管理仍没有同等的 Web 界面。逐项见 [CLI 能力覆盖](docs/parity/sequential-coverage.md)。不要把它直接放到公网、共享主机或反向代理后；同一操作系统账户内能够发起本机请求的进程不是此设计要隔离的对象。

### 排查

- **OmO 未连接**：在同一个终端确认 `omo --version` 能运行；必要时设置 `OMO_WEB_BIN`，再刷新页面。
- **模型不存在或认证失败**：先用 Native CLI 配置模型和登录。Web 端不会收集或转存密钥。
- **会话无法恢复**：确认保存的工作目录仍存在，并且依旧在 `OMO_WEB_WORKSPACES` 中；已经保存的记录不会被自动挪到其他目录。

## 开发与验证

```sh
bun run check           # TypeScript
bun test                # HTTP、RPC、SSE、持久化及权限边界回归
bun run build           # 构建浏览器资源
bun run verify:native   # 真实 OmO，经本地模拟模型验证，无外部模型请求
```

验证本机安装的原生 CLI 联动时，把 `SENPI_CLI_MAIN` 设为该安装里的 `dist/cli-main.js` 的绝对路径：

```sh
bun --no-orphans scripts/verify-cli-live.ts "$SENPI_CLI_MAIN"
bun --no-orphans scripts/verify-session-branches.ts "$SENPI_CLI_MAIN"
bun --no-orphans scripts/verify-session-handoff.ts "$SENPI_CLI_MAIN"
```

默认共享存储的端到端验收直接使用已安装的 `omo`（或 `OMO_WEB_BIN`），经生产入口、隔离 profile 与回环模型验证持有者双向拒绝、原生落盘、安静释放与自定义目录行为：

```sh
bun scripts/verify-shared-store.ts
```

原生验证覆盖真实模型流、工具审批拒绝、重启恢复、原生提示模板执行，以及独立 CLI 进程生成的历史。Linux 上还用真实 Chromium、真实 OmO 终端和本地模拟模型验收了同一会话的顺序换端、流式同步、精确中断和独立 Fork / Clone。见 [CLI 能力覆盖](docs/parity/sequential-coverage.md)；本地截图位于 `artifacts/qa/`，不纳入版本控制。覆盖范围不等同于对所有 OmO 版本、操作系统、模型供应商、浏览器或辅助技术的认证。

接口见 [docs/web-api.md](docs/web-api.md)，布局见 [DESIGN.md](DESIGN.md)。RPC 来源见 [Senpi 上游 RPC 文档](https://github.com/code-yeongyu/senpi/blob/main/packages/coding-agent/docs/rpc.md)；版本差异以本机随运行时发放的 `docs/rpc.md` 和真实协议探针为准。
