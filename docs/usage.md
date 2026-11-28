# 使用详解

本文收录 OmO Web 的完整使用与参考信息，首页 [README](../README.md) 只保留摘要。安装与发版步骤见 [install-release.md](install-release.md)。

- [工作区与文件浏览](#工作区与文件浏览) · [环境变量](#环境变量) · [密码与远程访问](#密码与远程访问) · [会话、执行与模型](#会话执行与模型) · [引擎与审批](#引擎与审批) · [CLI 互操作](#cli-互操作) · [命令](#命令) · [排查](#排查) · [开发与验证](#开发与验证)

## 启动方式

需要 Bun 1.3+（安装见 https://bun.sh）。运行会话还需要已安装并配置模型凭据的 [OmO Native](https://github.com/code-yeongyu/oh-my-openagent)。Linux 上已实测 OmO **5.1.83**（Senpi **2026.11.23**）。这里的 `omo` 是 Native CLI，不是旧版 OpenCode 插件。Windows 的文件浏览与目录授权单独验证，不代表完整 CLI 功能可用。

Bun 运行 Web 服务；OmO CLI（默认 `OMO_WEB_BIN=omo`）负责模型、工具与权限。程序目录可以替换，`OMO_WEB_WORKSPACES` 指定可用的项目目录。升级时保留 `OMO_WEB_DATA` 和 OmO profile。

### 方式 A：源码 checkout

```sh
git clone https://github.com/NekoCCN/OmO-Web.git
cd OmO-Web
omo --version
bun install --frozen-lockfile
OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun start
```

把示例目录换成真实存在的项目。`bun start` 等于先 `bun run build` 再跑 `src/main.ts`；重复启动可用 `bun run serve` 跳过重构建（`dist/app.js` 缺失时会直接报错退出，先补一次 `bun run build`）。用浏览器打开终端打印的地址，默认是 **http://127.0.0.1:4317**。不设置工作目录时使用启动目录。打开多个项目时，在 Linux/macOS 用 `:` 分隔绝对路径。

### 方式 B：发行包解压运行

有仓库访问权限时，可以从 [GitHub Releases](https://github.com/NekoCCN/OmO-Web/releases) 下载对应版本的 tar.gz 与同名 `.sha256`。校验后解压，用 Bun 直接跑包内入口，不装 npm 依赖：

```sh
VERSION="0.1.7"
ARCHIVE="omo-web-$VERSION.tar.gz"
sha256sum -c "$ARCHIVE.sha256" &&
  tar xzf "$ARCHIVE" &&
  OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun --no-env-file "$PWD/omo-web-$VERSION/dist/server.js"
```

macOS 可用 `shasum -a 256 -c "$ARCHIVE.sha256"` 等效校验。

发行包根为解压出的 `omo-web-$VERSION/` 目录，内含 `dist/server.js`、`dist/app.js`、`public/` 运行资产与第三方许可证，不含源码、`node_modules`、`.env` 与本机数据。可从任意工作目录启动，工作目录与数据目录仍由环境变量决定；缺静态资源时同样拒绝启动（重新校验并解压，而非 `bun run build`）。升级时保留 `OMO_WEB_DATA`（Web 会话索引与私有日志）和已配置的 CLI profile（原生配置与默认共享的会话日志）。

`Ctrl+C` 停止服务及其 OmO 子进程。关闭页面或刷新不会停止生成；停止 Web 服务会结束这个 Web 引擎上的运行任务。重启后可使用原来的数据目录和 OmO profile 恢复会话。

## 工作区与文件浏览

配置多个目录后，左栏默认显示所有目录的会话。目录筛选只改变左栏列表，不切走当前对话，不改变已有会话的工作目录，也不会恢复或停止任何会话。新建会话时单独选择工作目录，默认使用当前会话目录。

左栏的「目录」可查看已授权目录下的文件名和子目录，不读取文件内容。选中的目录可用于下一次新会话，不切走当前对话。要加入未授权的位置，输入绝对目录路径，核对路径后确认；取消不授权。浏览过的子目录不会自动加入。新增授权只在当前 Web 服务运行期间有效；要长期保留，请把目录写入启动时的 `OMO_WEB_WORKSPACES`。

文件浏览器按 **Web 服务所在机器** 的路径规则工作：Linux 用 `/home/you/project`；Windows 用本机盘符绝对路径，如 `C:\Users\you\project`，多目录环境变量用 `;` 分隔。不接受 UNC、设备路径或将目标指向外部的符号链接／junction。文件浏览和目录授权不依赖 CLI 的实时控制；Windows 若还要运行会话，需要一个可由服务启动、支持多会话 RPC 的原生 OmO 可执行文件，当前版本不在 Windows 开放基于 TUI socket 的 CLI 实时／跟随。

## 环境变量

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMO_WEB_WORKSPACES` | 启动目录 | 允许新建和恢复会话的工作目录 |
| `OMO_WEB_PORT` | `4317` | 非 TLS 模式可用 `0` 分配随机端口 |
| `OMO_WEB_HOST` | `127.0.0.1` | `0.0.0.0` 监听所有 IPv4 接口；也可绑定本机网卡已分配的 IPv4。非本机监听需要 HTTPS，并要求密码或显式选择无密码 |
| `OMO_WEB_PASSWORD_FILE` | 未设置 | 私有密码文件，用户名固定为 `omo`；推荐用 `omo-web password-file` 创建 |
| `OMO_WEB_ALLOW_UNAUTHENTICATED` | 未设置 | 只有 `1` 允许在无密码时使用非本机监听或外部代理入口；有密码时不会禁用认证 |
| `OMO_WEB_ORIGIN` | 未设置 | 启用 TLS 时必填；无路径、尾部斜杠或凭据的 HTTPS 访问地址，端口与监听端口一致 |
| `OMO_WEB_PROXY_ORIGIN` | 未设置 | 代理对浏览器提供的 HTTPS origin；不含路径、尾部斜杠或凭据，可使用不同于后端监听的端口 |
| `OMO_WEB_TLS_CERT` / `OMO_WEB_TLS_KEY` | 未设置 | 与访问地址匹配且被浏览器信任的 PEM 证书，以及对应的未加密 PEM 私钥 |
| `OMO_WEB_BIN` | `omo` | 对应的 Native CLI 可执行文件 |
| `OMO_WEB_DATA` | `~/.omo-web` | Web 会话索引和私有日志；默认共享的原生会话日志位于 OmO profile。一个数据目录只开一个服务实例 |
| `OMO_WEB_ATTACHMENT_QUOTA_BYTES` | 不限 | 附件存储总配额，单位为字节；设为正整数（例如 `10737418240` 为 10 GiB）。超过已配置配额时拒绝新附件，不删除或阻断旧附件 |
| `OMO_WEB_CLI_AGENT_DIR` | `OMO_CODING_AGENT_DIR` → `SENPI_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR` → `~/.omo/agent` | 选择 Web 原生引擎、本机 CLI 历史、实时发现及快照使用的同一个 OmO 配置目录；设为 `""` 关闭 CLI 数据入口，Web 引擎仍使用继承的 OmO profile。 |

## 密码与远程访问

默认只监听本机，不要求密码。可以在 npm 版启动器中配置，也可以给 `omo-web serve` 或 Bun 入口传环境变量。

### 通过 TUI 配置

1. 在交互终端运行 `omo-web`，进入「访问设置」。用「监听地址」选择 `127.0.0.1`、一张网卡上已分配的 IPv4，或 `0.0.0.0`。网卡旁的 CIDR 用于辨认网段，不是入站白名单。
2. 用「设置 / 修改密码」输入 1–128 个可打印 ASCII 字符，输入不会回显；不足 20 字符会提醒，但仍可保存并开启认证。独立的「密码」开关可以关闭认证，再打开时复用已保存的密码。浏览器用户名固定为 `omo`。
3. 用「生成 SSL 自签证书」输入浏览器要使用的主机名或 IP，不能填 `0.0.0.0`。生成需要 `PATH` 上的 OpenSSL 1.1.1+，完成后自动开启 HTTPS。证书有效期为 90 天；在客户端核对并信任公开的 `cert.pem`（不要传输 `key.pem`），或改用客户端已经信任的证书。只监听 `127.0.0.1` 时可关闭 HTTPS；重新开启可复用证书。
4. 若使用内网穿透或反代，在「代理入口」填写对外 HTTPS origin；清空关闭。代理不需要 OmO Web 自签证书时，可保留回环监听、关闭本机 HTTPS。见下方代理配置说明。
5. 返回主菜单启动服务，打开本机地址或访问配置的对外代理入口。如果改了网卡或直连 HTTPS 地址，检查 URL 和证书是否仍匹配。远程入口没有密码时，启动器会要求确认风险。

设置保存在 `OMO_WEB_DATA/launcher/`（默认 `~/.omo-web/launcher/`）；已在 TUI 修改的选项覆盖继承的同名环境配置。请把数据目录放在私有位置，不要放入共享工作区。运行中先停止服务才能改设置，修改会在下次启动生效。`omo-web serve` 不读取启动器设置。

### 生成密码文件

安装 npm 版启动器后，运行 `omo-web password-file <路径>`。例如 Linux/macOS 用 `omo-web password-file "$HOME/.omo-web-password"`，Windows PowerShell 用 `omo-web password-file "$HOME\.omo-web-password"`。命令不显示密码，也不覆盖已有文件。先在本机打开文件，把该密码存进密码管理器，不要把文件放进要给 OmO 操作的项目，也不要把密码写进启动命令或 URL。

自己准备文件也可以。密码为 1–128 个可打印 ASCII 字符，可带一个末尾换行；低于 20 字符时服务会提醒。POSIX 文件应是 `0600`；Windows 使用仅当前用户可访问的 ACL，校验同时允许 Windows 系统和管理员账户。不要用 `chmod` 模拟 Windows ACL。

### 从外地用 HTTPS 访问

先确保两台设备之间有网络路径。推荐通过 VPN 或私有网络放行所选 TCP 端口；如果通过公网访问，应设置密码，并用防火墙限制能连接的地址。`0.0.0.0` 只改变监听地址，不会帮你配置公网 DNS、防火墙、NAT 或端口转发。

准备浏览器信任、且覆盖最终访问域名或 IP 的 PEM 证书和对应私钥。用 Tailscale 时，可以按[官方说明签发 HTTPS 证书](https://tailscale.com/docs/how-to/set-up-https-certificates)，用完整的 `.ts.net` 名称访问，而不是裸主机名或 Tailscale IP；证书文件更新后要重启 OmO Web。

**Linux / macOS：**

```sh
OMO_WEB_HOST=0.0.0.0 \
OMO_WEB_PORT=8443 \
OMO_WEB_ORIGIN=https://omo.example.net:8443 \
OMO_WEB_PASSWORD_FILE="$HOME/.omo-web-password" \
OMO_WEB_TLS_CERT="$HOME/.omo-web-cert.pem" \
OMO_WEB_TLS_KEY="$HOME/.omo-web-key.pem" \
OMO_WEB_WORKSPACES="$HOME/path/to/your-project" \
bun start
```

**Windows PowerShell：**

```powershell
$env:OMO_WEB_HOST = '0.0.0.0'
$env:OMO_WEB_PORT = '8443'
$env:OMO_WEB_ORIGIN = 'https://omo.example.net:8443'
$env:OMO_WEB_PASSWORD_FILE = "$HOME\.omo-web-password"
$env:OMO_WEB_TLS_CERT = "$HOME\.omo-web-cert.pem"
$env:OMO_WEB_TLS_KEY = "$HOME\.omo-web-key.pem"
$env:OMO_WEB_WORKSPACES = "$HOME\Projects\your-project"
omo-web serve
```

两组命令都需替换域名和文件路径。用 npm 包可把 `bun start` 换成 `omo-web serve`；源码检出可把 PowerShell 里的 `omo-web serve` 换成 `bun start`。浏览器打开 `OMO_WEB_ORIGIN`，**不要打开 `0.0.0.0`**。出现登录框时使用用户名 `omo`。确认能在本机用同一个 HTTPS 地址访问后，再到另一台设备验网络路径。

启用密码时，网页、静态资源、API 和 SSE 都需要凭据；远程入口会暂时限制同一连接地址的连续错误密码请求。上面的直连模式由服务直接终止 TLS；配置不完整会拒绝启动，不会回退明文。修改密码或证书需重启；Basic 登录由浏览器缓存，无应用内登出。

### 内网穿透与反向代理

适用于由代理提供对外 HTTPS、代理进程与 OmO Web 在同一台机器的部署。以下以公网入口 `https://web.example.com` 为例：

1. OmO Web 保持默认本机监听 `127.0.0.1:4317`，设置密码。启动器中把「代理入口」设为 `https://web.example.com`。用 `omo-web serve` 时，设置 `OMO_WEB_PROXY_ORIGIN=https://web.example.com` 与 `OMO_WEB_PASSWORD_FILE` 即可；不要把公网 URL 填进直连 TLS 用的 `OMO_WEB_ORIGIN`。
2. 代理将 **整个站点根路径** 转到 `http://127.0.0.1:4317`，保留浏览器请求的 `Host`、`Origin`、`Authorization` 及 `X-OmO-Token`。代理若改写 `Host` 为 `localhost` 或上游地址，仍会收到同源拒绝。`Forwarded` / `X-Forwarded-*` 不用于推断来源。
3. 不缓存或缓冲 `/api/events`，并允许 SSE 长连接。这种模式不是 CORS 白名单：浏览器从配置的外部 HTTPS 地址加载页面、API 和事件流，写入仍需该 origin 与页面 token。

本机 URL 仍可访问。认证失败限速按 OmO Web 所见的连接地址计算；同一个代理后的客户端可能共用一次冷却。不要把回环上游明文端口另外对公网开放。公网访问建议同时启用密码及代理侧访问限制；临时域名变更后要更新配置并重启。

### 私网内不设密码

省略 `OMO_WEB_PASSWORD_FILE`。在 TUI 选择启动后，确认无密码警告；脚本启动时用 `OMO_WEB_ALLOW_UNAUTHENTICATED=1` 表示同样的确认（PowerShell 用 `$env:OMO_WEB_ALLOW_UNAUTHENTICATED = '1'`）。如果环境变量里已有旧的 `OMO_WEB_PASSWORD_FILE`，先取消设置：这个开关不会关闭已经配置的密码。HTTPS、同源检查与写入 token 仍然有效，**但不能替代密码**。

**这是单操作者工作台。** 无密码时，任何能访问端口的人都能读取会话，并通过 OmO 操作该机器。仅在客户端范围可控的私网或 VPN 内使用；不能做到就配置密码和入站限制。无论哪种模式，都建议使用专用 OS 账户和最小工作目录权限。

## 会话、执行与模型

| 领域 | Web 支持 |
| --- | --- |
| 会话 | 新建、搜索、重命名、归档/取消归档、完成标记、保存及恢复 Web 会话 |
| 文件浏览 | 已授权范围内看文件名和子目录；明确确认后可把新目录加入本次服务的工作区 |
| 执行 | 流式回复、停止、运行中修正/后续输入、队列查看和清空、PNG/JPEG/GIF/WebP 图片输入（每张约 2 MiB，最多 4 张） |
| 助手回复 | CommonMark、表格、任务列表、脚注、链接、TeX 公式和代码高亮；代码块可复制。远程图片只提供点击打开的入口，不自动请求，原始 HTML 不执行 |
| 下载助手产物 | 在 Web 会话中说「把这个文件发给我」；助手可用 `send_file` 把当前工作区内的文件发成附件。不设固定单文件上限；点击才下载，支持 HTTP 断点续传，普通 CLI 不加载这个工具 |
| 模型 | 原生模型列表、仅切换当前会话、思考档、快速模式、上下文用量、手动与自动压缩 |
| 可观测性 | 工作台状态行显示运行、排队、待答与当前待办；桌面还显示原生上下文与最新缓存命中率。运行详情可查看只读子代理、DAG 波次与依赖、会话树、长期记忆计数和完整用量 |
| CLI 历史 | 点「打开会话」，先选授权目录，再列出该目录的会话。点选只读预览，显式「在 Web 继续」才尝试打开原会话。侧栏只列已在 Web 打开的会话，按会话的工作目录分组，不重复列出原生记录 |
| CLI 实时 | 显式连接已开启原生控制的本机 CLI；查看实时文字对话、发送普通消息、停止可核验的当前回合 |
| 跟随 CLI | 显式开启后，只读查看唯一可核验的本机 CLI 对话；CLI 切换对话时，Web 跟随其所在的已授权工作区。不接管、不发送；多个终端时不猜前台焦点 |
| 分支 / 复制 | 从所选 Web 会话、CLI 历史或已连接 CLI 创建独立 Web 会话；分支只回填草稿，复制保留来源上下文 |
| 命令 | 输入 `/` 或 `$` 在对话原处查看候选；用方向键再按 Enter/Tab，或点候选，只填草稿。`/todo`、`/tasks`、`/dag`、`/help` 和 `/hotkeys` 打开本地查看界面；`/reasoning` 和 `/efforts` 的无参数形式只读当前模型读数 |
| 人工交互 | 支持确认、选择、文本输入和结构化问题；工具审批可选「询问」「Auto」「无审批」 |

长对话先渲染最近 80 条，可分批向前加载。CLI 历史只读最后保存分支，单条记录最多展示最近 1,000 条可见消息。超过 8 MiB 的日志仍可列出，但不提供对话预览；标题从日志首尾的有限范围内读取，未找到标题时显示工作目录。引擎支持换端且会话未被另一进程持有时，仍可尝试「在 Web 继续」。同一轮中连续且已确认成功的探查可合成一条工具摘要，展开仍可逐个查看参数与结果。运行中、失败和待答仍各自显示。

## 引擎与审批

**Web 专用会话宿主。** Web 启动一个独立的 `omo --mode rpc --multi-session --offline --no-approve --session-runtime in-process` 子进程：私有、非监听的本机 stdio 宿主，不发布可被其他 stock TUI 附着的端点；同一份日志的第二个打开者会被原生持有者检查拒绝。浏览器不接触 socket、凭据或通用 RPC。`--offline` 只关闭启动阶段的联网操作，不阻止模型请求；`--no-approve` 忽略未经信任的项目本地配置，不等于工具沙箱。会话默认采用原生 `ask` 预设，原生允许规则和已保存的批准仍可能生效。

**工具审批模式。** 在输入框旁选择「询问」「Auto」或「无审批」。Auto 由原生判断能否自动放行，并非沙箱；无审批为显式确认的 `full-access`，默认允许工具操作，原生权限规则仍有效。用户问题仍要回答，私密输入不转发到 Web。当前 Web 会话重开时回到询问，不修改全局设置或 CLI 默认值。

## CLI 互操作

**继续同一段对话。** 默认共享同一套原生日志：Web 新建的会话直接落在所配置 profile 的原生目录，原生 CLI 选择器可直接列出、恢复；profile 是配置和日志存储位置，不是会话的工作目录。终端转 Web 时，选「打开会话 → 工作目录 → 会话 → 在 Web 继续」才尝试打开同一份日志（已有进程持有时被拒绝，不关闭它）。要从 Web 回到终端，点「会话管理 → 转到 CLI」释放会话，复制显示的本机命令到终端运行。不要提前启动第二个写入者：Web 在原生回合、待答交互、真实附着或其他未结束工作时不会强制交接；仅当原生把调用者自身的单连接误报为附着时，才用一次不带打断的受控 `force` 重试，并核验释放回执与零丢弃。CLI 退出后，可从同一个 Web 会话恢复。需要当前 OmO 支持原生持有者检查和安静释放，且 Web 引擎与 CLI 历史使用同一 profile。自定义 `sessionDir`（`settings.json` 绝对路径或单次 `--session-dir`）不受支持：无路径 RPC 仍走默认按工作目录分桶，Web 只发现该布局，位置不符会明确失败而不静默迁移。

**CLI 实时与分支。** 在侧栏选择「CLI 实时」，挑选会话后点击「连接」。这里只发现所配置 profile、所授权工作目录下已开启原生控制的本机 TUI，不会替你启动控制服务。断开或关闭弹窗仅释放 Web 的连接，不会关闭 CLI 或停止生成；停止当前回合是单独的操作。消息结果未知时请先在 CLI 核对，页面不会自动重发；如显示「暂存」，由 CLI 处理。工具审批、权限弹窗和私密交互仍由 CLI 上的人处理。实时、历史或 Web 会话选定后可点「分支 / 复制」：实时模式必须能核验当前分支位置，历史使用最后保存的分支；两者都不会切换、接管或修改来源。

分支 / 复制基于原生 v3 会话日志；不复制日志之外的媒体附件文件。实时视图只同步近期可显示文字，过大的原生响应会拒绝读取。

**不是完整 TUI 替代品。** Web 的直接查看命令不发送给模型，任务与 DAG 页面没有写操作。待办和 DAG 默认显示当前执行，展开「历史」才读取只读记录。旧宿主明确不支持 DAG 查询时，历史区可显示标为非实时的磁盘快照，不用它替代当前。节点和子代理详情会显示宿主报告的名称、描述和模型；配置模型不等于实际生效的模型，不显示原始提示词、原始错误、私密字段或原生 ID。原生 `/reasoning on|off` 与 `/efforts <档位>` 的持久设置、默认/收藏模型、私密凭据、任意 TUI 组件、跨设备、调度和全局管理留在本机。Web 的会话级模型与思考档仍可调。同一操作系统账户内的其他进程不属于安全隔离边界。

## 命令

输入 `/` 或 `$` 在对话原处查看候选；用方向键再按 Enter/Tab，或点候选，只填草稿，不直接发送。

- `/compact [压缩指示]` 在会话空闲时调用原生压缩；它不会把斜杠文本发给模型。压缩本身使用当前模型；原生拒绝（例如会话太短）会显示错误。
- `/settings` 或 `/setting` 打开当前会话管理面板，可调整可用的运行选项。全局配置、账户和凭据仍在本机终端管理。
- `/todo`、`/tasks`、`/dag`、`/help` 和 `/hotkeys` 打开本地查看界面；`/reasoning` 和 `/efforts` 的无参数形式只读当前模型读数。`/login`、`/trust`、`/reload` 等只在终端执行的命令会给出提示，不会作为命令转发。
- 当前会话已注册的扩展命令、模板和 `$技能` 交给 Native 宿主处理；未知命令不作为聊天发送，会话忙时命令不排队。候选列表不保证自定义 TUI 能在 Web 显示。聊天里的技能说明默认折叠，附带的任务文字单独显示。逐项见 [CLI 对齐矩阵](parity/local-cli-web-matrix.md)。

普通消息仍支持 `/tmp/foo` 等路径，若要把命令名当文字发给模型，在开头加一个空格。

## 排查

- **OmO 未连接**：在同一个终端确认 `omo --version` 能运行；必要时设置 `OMO_WEB_BIN`，再刷新页面。
- **模型不存在或认证失败**：先用 Native CLI 配置模型和登录。Web 端不会收集或转存密钥。
- **会话无法恢复**：确认保存的工作目录仍存在，并且依旧在 `OMO_WEB_WORKSPACES` 中；已经保存的记录不会被自动挪到其他目录。

## 开发与验证

```sh
bun run check           # TypeScript
bun test                # HTTP、RPC、SSE、持久化及权限边界回归
bun run build           # 构建浏览器资源（dist/app.js）
bun run serve           # 不重构建，直接跑 src/main.ts
bun run release:pack    # 构建浏览器与服务端包，产出 dist/omo-web-$VERSION.tar.gz + .sha256
bun run verify:native   # 真实 OmO，经本地模拟模型验证，无外部模型请求
```

发版流程（打 tag、draft 发布）见 [install-release.md](install-release.md)；若 Release 尚无对应资产，用源码安装。

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

原生验证覆盖真实模型流、工具审批拒绝、重启恢复、原生提示模板执行，以及独立 CLI 进程生成的历史。Linux 上还用真实 Chromium、真实 OmO 终端和本地模拟模型验收了同一会话的顺序换端、流式同步、精确中断和独立 Fork / Clone。见 [CLI 能力覆盖](parity/sequential-coverage.md)；本地截图位于 `artifacts/qa/`，不纳入版本控制。覆盖范围不等同于对所有 OmO 版本、操作系统、模型供应商、浏览器或辅助技术的认证。

接口见 [web-api.md](web-api.md)，布局见 [../DESIGN.md](../DESIGN.md)。RPC 来源见 [Senpi 上游 RPC 文档](https://github.com/code-yeongyu/senpi/blob/main/packages/coding-agent/docs/rpc.md)；版本差异以本机随运行时发放的 `docs/rpc.md` 和真实协议探针为准。
