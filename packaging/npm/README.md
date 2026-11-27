# OmO Web

A local browser workbench for OmO Native. Open sessions from different project folders, handle approvals, and inspect tool output or DAGs from the browser. OmO Native keeps your model settings and credentials.

## Try the local npm package

Install [Bun](https://bun.sh/docs/installation) and [OmO Native](https://github.com/code-yeongyu/oh-my-openagent). Configure your model in `omo` first. This tarball is a local preview, not a package published to npm.

```sh
npm install --global ./omo-web-0.1.0.tgz
cd /path/to/your/project
omo-web
```

Open the printed URL (normally `http://127.0.0.1:4317`). `omo-web --help` lists the startup settings. Stop the service with Ctrl+C.

In an interactive terminal, `omo-web` opens a keyboard-driven launcher. Use ↑/↓ and Enter to choose working directories and start the service. Once it is running, you can open the browser or stop the server from the same screen. For scripts or logging, run `omo-web serve` instead.

OmO Web is licensed under MIT. The package includes the original notices for its third-party assets.

[GitHub Release](https://github.com/NekoCCN/OmO-Web/releases) · [使用与安全指南](https://github.com/NekoCCN/OmO-Web/blob/main/docs/usage.md) · [Report an issue](https://github.com/NekoCCN/OmO-Web/issues)
