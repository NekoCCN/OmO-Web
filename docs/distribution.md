# 分发选型

**首发推荐私有 GitHub Releases + SHA-256。** 源码安装已可用，发行包可在本地构建，远端资产要等维护者实际发布。主 `package.json` 保持 `private: true`、没有 `bin`，仓库没有项目级开源许可证。

## 首发：私有 GitHub Releases + SHA-256

- 不是包管理器：用户从 Releases 页或 `gh release download` 取两个文件，自行 `sha256sum -c` 校验后解压运行。
- 下载需要授权：私有仓库的 Releases 资产只对有访问权限的账户可见——已登录的 Releases 页面，或 `gh` 登录后下载。未上传资产的版本回退到源码安装。
- 校验可确认下载文件匹配发布的校验值，不证明发布者身份或其他平台可用；验证范围见 [0.1.0 发行说明](releases/0.1.0.md#验证范围)。

安装与发版命令见 [安装与发版](install-release.md)。

## 下一步：GitHub Packages 私有 npm 兼容 registry

- 无需公开源码仓库。关联仓库的 Actions 可用具备包权限的 `GITHUB_TOKEN` 发布；开发机需要包访问权限、classic PAT（安装用 `read:packages`）和 scope 到 registry 的映射。
- 先为打包产物生成独立的小写作用域包，例如 `@nekoccn/omo-web`（示例名，不代表已注册）；不要直接解除源码根目录的 `private: true`。打包需包含启动入口、资源和许可，并用 `bin` 提供命令。全局安装和 `PATH` 上的 Bun／`omo` 检查应在干净环境中验证。
- 适合团队希望一条命令安装或更新 CLI 的情况。若只是偶尔下载，Releases 更省事。

参考：[GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

## 公开 npm：仅在许可与授权决定后才考虑

- 公开作用域包的发布流程见 [npm 官方文档](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)；私有 npm 包是付费套餐，见 [npm 官方文档](https://docs.npmjs.com/creating-and-publishing-private-packages)。
- 公开发布需要项目所有者授权并明确分发许可；仓库当前没有项目级开源许可证。需核对包名与 scope、`bin` 启动器和发布文件白名单，再以 npm registry 的安装方式实测。公开 npm 包会分发包内容，不因源码仓库私有而变成私有包。

## Homebrew：tap 与 core 是两回事

- 进入 core 需要满足公开源码、许可、平台与稳定版准入（见 [Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae)）；当前私有、无许可的状态不符合。
- 自建 tap 是维护者自己的事（见 [How to Create and Maintain a Tap](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)，tap 由所有者维护）。不要默认「私有 tap 就能自动拿到带认证的资产」——tap 公式仍要解决私有下载的凭据问题。
- 有明确 macOS／Linux 用户需求、实机验证和稳定的下载渠道后，再做自建 tap；当前不申请 core。

## Docker / GHCR：有项目需要才考虑

- 只有出现「需要固定、可复现的运行环境」这类项目需求时才评估；不是首选。
- 本项目依赖外部本机 OmO Native 与用户 profile（工作区、CLI 配置目录挂载），容器化首先要解决这些本机绑定，得不偿失时就不做。

## 小结

| 路线 | 状态 |
| --- | --- |
| 私有 GitHub Releases + SHA-256 | 首发推荐；本地包已构建，尚未上架 |
| GitHub Packages 私有 registry | 下一步候选，接受认证负担时 |
| 公开 npm | 许可＋授权决定后 |
| Homebrew tap | 维护者自建 tap，不进 core；暂不做 |
| Docker / GHCR | 有项目需要才评估 |
