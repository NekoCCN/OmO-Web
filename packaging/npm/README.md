# OmO Web

A local browser workbench for OmO Native. Open sessions from different project folders, handle approvals, and inspect tool output or DAGs from the browser. OmO Native keeps your model settings and credentials.

## Get started

Install Node.js 18+, [Bun](https://bun.sh/docs/installation), and [OmO Native](https://github.com/code-yeongyu/oh-my-openagent). Configure your model in `omo` first.

If the CLI is already installed, run it from a project directory:

```sh
cd /path/to/your/project
omo-web
```

Open the printed URL (normally `http://127.0.0.1:4317`). The local browser connects to OmO on the host. `omo-web --help` lists startup commands.

In an interactive terminal, `omo-web` opens a keyboard-driven launcher. Use ↑/↓ and Enter to choose working directories and start the service. Once it is running, you can open the browser or stop the server from the same screen. For scripts or logging, run `omo-web serve` instead.

OmO Web is licensed under MIT. The package includes the original notices for its third-party assets.

[Installation](https://github.com/NekoCCN/OmO-Web#install) · [简体中文](https://github.com/NekoCCN/OmO-Web/blob/main/README.zh-CN.md) · [GitHub Releases](https://github.com/NekoCCN/OmO-Web/releases) · [Remote access](https://github.com/NekoCCN/OmO-Web/blob/main/docs/usage.md#密码与远程访问)
