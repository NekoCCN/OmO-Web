# 分发选型

**公开 npm 与 GitHub 发行独立更新。** 有仓库访问权限时，可从 GitHub [v0.1.7](https://github.com/NekoCCN/OmO-Web/releases/tag/v0.1.7) 下载 `0.1.7`，或从源码构建。本项目采用 [MIT 许可证](../LICENSE)，主 `package.json` 仍标记 `private: true`，避免误发源码目录。

## 首发：GitHub Releases + SHA-256

- 不是包管理器：用户从 Releases 页或 `gh release download` 取两个文件，自行 `sha256sum -c` 校验后解压运行。
- 发行资产遵循仓库访问权限。未上传资产的版本可从源码安装。
- 校验可确认下载文件匹配发布的校验值，不证明发布者身份或其他平台可用；当前版本的验证范围见 [0.1.7 发行说明](releases/0.1.7.md#verification--验证范围)。

安装与发版命令见 [安装与发版](install-release.md)。

## 下一步：GitHub Packages 私有 npm 兼容 registry

- 无需公开源码仓库。关联仓库的 Actions 可用具备包权限的 `GITHUB_TOKEN` 发布；开发机需要包访问权限、classic PAT（安装用 `read:packages`）和 scope 到 registry 的映射。
- 先为打包产物生成独立的小写作用域包，例如 `@nekoccn/omo-web`（示例名，不代表已注册）；不要直接解除源码根目录的 `private: true`。打包需包含启动入口、资源和许可，并用 `bin` 提供命令。全局安装和 `PATH` 上的 Bun／`omo` 检查应在干净环境中验证。
- 适合团队希望一条命令安装或更新 CLI 的情况。若只是偶尔下载，Releases 更省事。

参考：[GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

## npm 安装格式

- 公开作用域包的发布流程见 [npm 官方文档](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)；私有 npm 包是付费套餐，见 [npm 官方文档](https://docs.npmjs.com/creating-and-publishing-private-packages)。
- `bun run npm:pack` 将运行文件组装为 `dist/npm/omo-web-<version>.tgz`。`npm install -g omo-web` 安装 [npm](https://www.npmjs.com/package/omo-web) 的 `latest`；不使用 registry 时，从 [GitHub v0.1.7](https://github.com/NekoCCN/OmO-Web/releases/tag/v0.1.7) 下载并校验 `.tgz`，再运行 `npm install -g ./omo-web-0.1.7.tgz`。启动器需要 Node.js 18+ 和 Bun，运行会话还需要 OmO Native。
- 独立 npm 包包含 MIT 与第三方许可；源码根目录保持私有标记，不直接向 registry 发布。维护者正式发布时应核对 SHA-256、登录的账号及 npm 的 2FA 要求，发布验证过的 `.tgz`。

## Homebrew：tap 与 core 是两回事

- 进入 core 仍需满足平台、稳定版等准入要求（见 [Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae)）；本项目暂无此计划。
- 自建 tap 是维护者自己的事（见 [How to Create and Maintain a Tap](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)，tap 由所有者维护）。不要默认「私有 tap 就能自动拿到带认证的资产」——tap 公式仍要解决私有下载的凭据问题。
- 有明确 macOS／Linux 用户需求、实机验证和稳定的下载渠道后，再做自建 tap；当前不申请 core。

## Docker / GHCR：有项目需要才考虑

- 只有出现「需要固定、可复现的运行环境」这类项目需求时才评估；不是首选。
- 本项目依赖外部本机 OmO Native 与用户 profile（工作区、CLI 配置目录挂载），容器化首先要解决这些本机绑定，得不偿失时就不做。

## 小结

| 路线 | 状态 |
| --- | --- |
| GitHub Releases + SHA-256 | 有仓库访问权限可下载 |
| GitHub Packages 私有 registry | 下一步候选，接受认证负担时 |
| npm 安装 | `npm install -g omo-web` 安装 registry 的 `latest`；[GitHub Release](https://github.com/NekoCCN/OmO-Web/releases/tag/v0.1.7) 提供 `0.1.7` 的本地安装包 |
| Homebrew tap | 维护者自建 tap，不进 core；暂不做 |
| Docker / GHCR | 有项目需要才评估 |
