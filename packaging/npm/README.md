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

In an interactive terminal, `omo-web` opens a keyboard-driven launcher. Use ↑/↓ and Enter to choose working directories or open **Access settings**. There you can change or disable the password, toggle HTTPS, generate a self-signed certificate (requires OpenSSL 1.1.1+ on `PATH`), and bind to loopback, a specific IPv4 interface, or all IPv4 interfaces (`0.0.0.0`). Access settings are saved and apply on the next start. Non-loopback listeners require HTTPS; passwordless startup needs confirmation. The browser username is `omo`.

Once running, open the browser or stop the service from the same screen. For scripts or logging, `omo-web serve` uses environment variables only.

OmO Web is licensed under MIT. The package includes the original notices for its third-party assets.

[Installation](https://github.com/NekoCCN/OmO-Web#install) · [简体中文](https://github.com/NekoCCN/OmO-Web/blob/main/README.zh-CN.md) · [GitHub Releases](https://github.com/NekoCCN/OmO-Web/releases) · [Remote access](https://github.com/NekoCCN/OmO-Web/blob/main/docs/usage.md#密码与远程访问)
