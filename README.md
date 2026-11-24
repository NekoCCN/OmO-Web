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

`Ctrl+C` 停止服务及其 OmO 子进程。关闭页面或刷新不会停止生成；停止 Web 服务会结束这个 Web 引擎上的运行任务。保留 `OMO_WEB_DATA` 即可在重启后恢复会话。

## 能力与边界

| 领域 | Web 支持 |
| --- | --- |
| 会话 | 新建、搜索、重命名、归档/取消归档、完成标记、保存及恢复 Web 会话 |
| 执行 | 流式回复、停止、运行中修正/后续输入、队列查看和清空、PNG/JPEG/GIF/WebP 图片输入（每张约 2 MiB，最多 4 张） |
| 模型 | 原生模型列表、仅切换当前会话、思考档、快速模式、上下文用量、手动与自动压缩 |
| 可观测性 | 工具调用与结果、思考折叠、会话统计、会话树和历史节点导航、可用命令列表 |
| 人工交互 | 支持普通确认、选择、文本输入和结构化问题；Web 不自动批准 |

**Web 专用会话宿主。** Web 启动一个独立的 `omo --mode rpc --multi-session --offline --no-approve` 子进程，通过 stdio JSONL 通信。它读取本账户正常的 OmO 配置，但不控制已经在其他终端、Desktop 或共享宿主里运行的会话。`--offline` 只关闭启动阶段的联网操作，不阻止模型请求；`--no-approve` 忽略未经信任的项目本地配置，不等于工具沙箱。会话默认采用原生 `ask` 预设，原生允许规则和已保存的批准仍可能生效。

**不是完整 TUI 替代品。** 支持常规 RPC 问答、审批和可在 RPC 使用的 slash 命令。依赖 TUI 组件的交互、私密凭据表单、已有原生会话接管、DAG/团队面板、跨设备迁移、后台调度和全局配置管理没有提供 Web 等价界面。在原生端执行登录、安装扩展、管理账号和修改全局设置。不要把它直接放到公网、共享主机或反向代理后；同一操作系统账户内能够发起本机请求的进程不是此设计要隔离的对象。

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

原生验证覆盖真实模型流、工具审批拒绝和重启恢复。Chromium 验收覆盖新建、发送、详情、归档/取消归档、断线提示，以及桌面和手机布局；本地验收截图在 `artifacts/qa/`（不纳入版本控制）。覆盖范围不等同于对所有模型供应商、浏览器或辅助技术的认证。

接口见 [docs/web-api.md](docs/web-api.md)，布局见 [DESIGN.md](DESIGN.md)。RPC 来源见 [Senpi 上游 RPC 文档](https://github.com/code-yeongyu/senpi/blob/main/packages/coding-agent/docs/rpc.md)；版本差异以本机随运行时发放的 `docs/rpc.md` 和真实协议探针为准。
