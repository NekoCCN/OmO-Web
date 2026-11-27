# 安装与发版

面向本地使用者与项目维护者。安全边界与完整环境变量表以 [README](../README.md) 为准，本页只讲“怎么装、怎么起、怎么发”。

## 前提

- **Bun**：`package.json` 要求 `>=1.3.0`；本机实测 `1.4.5`；安装见 https://bun.sh。Bun 负责跑 Web 服务。
- **OmO CLI**：运行会话需要已安装并配置模型凭据的 [OmO Native](https://github.com/code-yeongyu/oh-my-openagent)（默认 `OMO_WEB_BIN=omo`）。本机实测 `omo 5.1.83`（Senpi 2026.11.23）。这里的 `omo` 是 Native CLI，不是旧版 OpenCode 插件。
- **平台**：完整链路在 Linux 实测；Windows 单独验证了文件浏览与目录授权，不代表完整 CLI 会话可用；macOS 尚未验证。密码文件与 `0.0.0.0` 监听仅 POSIX 实现。

## 三个位置不要混淆

| 概念 | 是什么 | 示例 |
| --- | --- | --- |
| 程序 | 源码 checkout，或解压后的 `omo-web-$VERSION/` | 本仓库，或发行包目录 |
| 工作目录 `OMO_WEB_WORKSPACES` | 允许新建和恢复会话的项目位置，默认启动目录 | `"$HOME/path/to/your-project"`（换成真实存在的项目） |
| 数据目录 `OMO_WEB_DATA` | Web 会话索引和私有日志，默认 `~/.omo-web`；一个目录只开一个实例 | 重装、换包时保留 |
| OmO profile | 原生 CLI 配置和默认共享的会话日志；路径及默认值见 `OMO_WEB_CLI_AGENT_DIR` | 使用同一个 profile 重启 |

Web 启动一个私有的本机 stdio 引擎子进程（`omo --mode rpc --multi-session --offline --no-approve --session-runtime in-process`），浏览器不接触 API 密钥与控制 socket。

## 用户：源码安装

私有仓库的 HTTPS 克隆需要已配置 Git 凭据，且对应 GitHub 账户有仓库访问权限。

```sh
git clone https://github.com/NekoCCN/OmO-Web.git
cd OmO-Web
omo --version
bun install --frozen-lockfile
OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun start
```

- `bun start` = `bun run build`（产出 `dist/app.js`）+ 跑 `src/main.ts`。
- 重复启动可用 `bun run serve` 跳过重构建；`dist/app.js` 等静态资源缺失时直接报错退出，先补一次 `bun run build`。
- 浏览器打开终端打印的地址，默认 **http://127.0.0.1:4317**；多目录在 Linux/macOS 用 `:` 分隔绝对路径，Windows 用 `;`。
- `Ctrl+C` 停止服务及其 OmO 子进程；关页面不停止生成，停服务会结束本引擎上的运行任务。

## 用户：发行包安装

把 `VERSION` 和 `TAG` 换成实际发布的版本和标签。可在已登录的 [GitHub Releases](https://github.com/NekoCCN/OmO-Web/releases) 页面下载两个文件，也可在有仓库访问权限的账户上登录 `gh` 后执行下例。若该版本尚未上传发行资产，可用源码安装。

```sh
VERSION="0.1.0"
TAG="v0.1.0"
ARCHIVE="omo-web-$VERSION.tar.gz"
gh release download "$TAG" --repo NekoCCN/OmO-Web --pattern "$ARCHIVE" --pattern "$ARCHIVE.sha256" &&
  sha256sum -c "$ARCHIVE.sha256" &&
  tar xzf "$ARCHIVE" &&
  OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun --no-env-file "$PWD/omo-web-$VERSION/dist/server.js"
```

macOS 可用 `shasum -a 256 -c "$ARCHIVE.sha256"` 等效校验。

- 包根为解压出的 `omo-web-$VERSION/` 目录，内含 `dist/server.js`、`dist/app.js`、`public/` 运行资产与 `public/licenses/` 第三方许可证（含 Zod MIT 原文）；不含源码、`node_modules`、`.env`、本机数据。
- 解包后**不装 npm 依赖**，但 Bun 与 `omo` 仍是先决条件；可从任意工作目录启动。
- 报缺静态资源时重校验重解，不要对发行包跑 `bun run build`。
- 升级：先停止旧服务，保留 `OMO_WEB_DATA` 与已配置的 CLI profile，解压到新版目录再启动；不需要迁移数据。

## 环境与访问（摘要）

完整表与禁区见 [README](../README.md)，这里只记安装相关的默认值：

- 默认本机免密（`127.0.0.1`）；仅本机加密码时设置 `OMO_WEB_PASSWORD_FILE`（`0600` 独立文件，用户名固定 `omo`，20–128 个可打印 ASCII，允许一个末尾换行）。
- 对外访问必须同时配密码与 HTTPS（`OMO_WEB_HOST=0.0.0.0` + `OMO_WEB_ORIGIN` + `OMO_WEB_TLS_CERT/KEY`），服务直接终止 TLS，不支持反向代理代终止；配置不完整拒绝启动，不回退明文。
- 单操作者工作台：拿到密码即全部控制面，无登录限流，不建议直挂互联网。

## 维护者：发版

使用 Linux 上实测的 Bun 1.4.5，从干净的源码检出打包。先提交版本变更，另行创建并推送对应标签（例如 `0.1.0` 对应 `v0.1.0`）。以下步骤只在远端标签指向当前检出的提交时继续：

```sh
(
  set -eu
  test -z "$(git status --porcelain)" || { echo "请从干净的检出打包。" >&2; exit 1; }
  VERSION="$(bun -p 'require("./package.json").version')"
  TAG="v$VERSION"
  ARCHIVE="omo-web-$VERSION.tar.gz"
  TAG_SHA="$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)"
  if [ -z "$TAG_SHA" ]; then
    TAG_SHA="$(git ls-remote origin "refs/tags/$TAG" | cut -f1)"
  fi
  test "$TAG_SHA" = "$(git rev-parse HEAD)" || { echo "远端标签 $TAG 未指向当前提交。" >&2; exit 1; }
  bun install --frozen-lockfile
  bun run check
  bun test
  bun run release:pack
  tar tzf "dist/$ARCHIVE"
  (cd dist && sha256sum -c "$ARCHIVE.sha256")
  gh release create "$TAG" "dist/$ARCHIVE" "dist/$ARCHIVE.sha256" --repo NekoCCN/OmO-Web --draft --verify-tag
)
```

macOS 校验可用 `(cd dist && shasum -a 256 -c "$ARCHIVE.sha256")` 等效。

约定与检查：

`release:pack` 构建浏览器与服务端并生成两个文件。校验文件记录包的文件名，不含目录前缀，所以要在 `dist/` 内执行校验。`--verify-tag` 不创建标签；上传后先在 GitHub 审查草稿，再明确发布。

## 剩余缺口

- `docs/rpc.md` 随运行时发放，不在版本控制内。
- Windows/macOS 的完整会话链与非 Linux 平台的包运行尚未验证；反向代理部署模式明确不支持。
