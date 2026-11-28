# OmO Web

English · [简体中文](README.zh-CN.md)

![OmO Web cover: terminal mark, project wordmark, and browser workbench](docs/images/readme-cover.webp)

**Start in the terminal, continue in the browser.**

OmO Web is a local browser workbench for [OmO Native](https://github.com/code-yeongyu/oh-my-openagent). Keep sessions across projects in one window, resume a CLI conversation, approve tools, and watch running tasks while you keep coding. Models, credentials, and tool execution stay with your local OmO.

[Install](#install) · [Workbench](#workbench-at-a-glance) · [Everyday use](#everyday-use) · [Shortcuts](#shortcuts) · [Remote access](#access-and-safety) · [Develop](#develop)

## Install

Install **[Bun 1.3+](https://bun.sh/docs/installation)** and **[OmO Native](https://github.com/code-yeongyu/oh-my-openagent)**. Configure a model in `omo`. For the npm launcher, also install **Node.js 18+**.

Install the launcher from [npm](https://www.npmjs.com/package/omo-web):

```sh
npm install -g omo-web
cd /path/to/your/project
omo-web
```

The npm command installs the registry's `latest`. To install `0.1.8` without the registry, [download the `.tgz` and its checksum from GitHub](https://github.com/NekoCCN/OmO-Web/releases/tag/v0.1.8), verify it, and run `npm install -g ./omo-web-0.1.8.tgz`.

In an interactive terminal, `omo-web` opens a launcher. Use the arrow keys and Enter to pick a working directory, edit **Access settings**, or start the service. Open the printed address (default `http://127.0.0.1:4317`). Stop the service from the launcher before changing settings. Access settings persist; directory edits apply only to the current launcher session. For scripts use `omo-web serve`. The launcher follows the system language (English / 简体中文, English fallback).

Prefer source? Clone and run with Bun:

```sh
git clone https://github.com/NekoCCN/OmO-Web.git
cd OmO-Web
omo --version
bun install --frozen-lockfile
OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun start
```

Replace the example path with a directory that exists. `bun start` builds first and then starts; repeat runs can use `bun run serve` to skip the rebuild.

Prefer the Bun-only archive? Download `omo-web-0.1.8.tar.gz` plus its `.sha256` from [GitHub Releases](https://github.com/NekoCCN/OmO-Web/releases), verify, and run the bundled server. No npm dependencies to install, but Bun and `omo` are still required:

```sh
VERSION="0.1.8"
ARCHIVE="omo-web-$VERSION.tar.gz"
sha256sum -c "$ARCHIVE.sha256" &&
  tar xzf "$ARCHIVE" &&
  OMO_WEB_WORKSPACES="$HOME/path/to/your-project" bun --no-env-file "$PWD/omo-web-$VERSION/dist/server.js"
```

On macOS verify with `shasum -a 256 -c "$ARCHIVE.sha256"`. Keep `OMO_WEB_DATA` and your OmO profile when you upgrade.

## Workbench at a glance

![OmO Web workbench: browse Web and CLI sessions across directories on the left, follow the conversation, tool output, and todos in the center, and inspect run dependencies on the right](docs/images/workbench-showcase.webp)

The left column finds projects and sessions, the center follows the conversation and tool output, and the right column shows run details. Sidebars open on demand; on phones they tuck behind the top buttons so the conversation keeps the space. The UI follows the system theme, with light and dark overrides.

## Everyday use

### Projects and sessions

The sidebar groups sessions already opened in Web by their working directory. Filtering narrows the list without leaving the current conversation. To find another session, choose **Open session** (or run `/resume` or `/sessions`), select an authorized directory, then pick a session. Selecting a directory only lists its sessions; it does not open one. New sessions pick their own working directory. Use **Browse directories** to browse authorized locations or enter an absolute path to authorize a directory for this run. Put favorites in the launch configuration so they survive restarts. Switch the UI language (English / 简体中文) at the bottom of the left column.

Sessions can be searched, renamed, marked done, archived, and restored. In a Web conversation, choose **Load older messages** to fetch an earlier page. Long text loads in chunks only when requested. To try another direction, fork from a selected user message or clone with the current context kept. Web sessions, CLI history, and an attached CLI all offer this entry.

### Send messages and handle approvals

Replies stream in. To change direction mid-run, steer the current turn; to queue the next thing, send after this turn. Watch or clear the queue in the right column, or press Stop to end the turn. Attach up to 4 PNG, JPEG, GIF, or WebP images per message (about 2 MiB each) when the agent needs to see a UI or an error.

Assistant replies render Markdown with TeX math, highlighted code, tables, and clickable links. Ask the assistant to send a workspace file and it can post a downloadable attachment. Downloads support resuming; there's no fixed per-file limit. The optional server storage quota is separate from the input-image limit above.

Model, thinking level, and fast mode sit next to the input. Options come from native OmO and switch only the current session. On long tasks, watch context usage and compact manually, or turn on auto-compaction.

Approvals default to Ask. Confirm, choose, type, or answer structured questions in the browser; Auto follows native rules, and no-approval mode needs an explicit confirmation. Private input stays in the local CLI.

### Follow execution

- **Jump to**: go straight to the latest input, reply, tool call, or pending question.
- **Tool ledger**: expand a probe group to read receipts in order. File edits, shell commands, code runs, page reads, and subagents each get their own summary and details; parameters open on demand.
- **Todos and subagents**: the status line shows the current todo and each tool card keeps its changes; the right column covers this session's todos, subagents, and DAG. DAGs render by wave with arrows for dependencies.
- **Session sidebar**: context, cache hit rates, tokens and cost, session tree, project rules, and memory counts. The Capabilities tab lists commands, extensions, and MCP.

## Continue between CLI and Web

When Web and CLI use the same OmO profile, you can continue from the same session log:

1. **Terminal to Web**: choose **Open session**, select the session’s working directory, choose its CLI record, then select **Continue in Web**. A preview is optional. If the original terminal still holds the session, quit it there first.
2. **Web to terminal**: finish the turn and pending items, choose Session management → Go to CLI, and run the printed command in your terminal.

Handoff waits until the session is idle and any pending questions are answered. CLI history shows the last saved branch; the live view follows recent text.

Just watching? Follow CLI mirrors the verifiable terminal conversation without taking over. To send a plain message or stop the turn on a terminal that already runs native control, connect over CLI live; approvals and private prompts on that session stay in the terminal. Forking or cloning from any of the three leaves the source alone.

## Shortcuts

Type `/` or `$` in the input, pick with the arrow keys, and press Enter, Tab, or click to fill the draft before sending.

| I want to | Command |
| --- | --- |
| Start, resume, or tidy sessions | `/new`, `/resume`, `/rename` |
| Inspect a session or branch it | `/session`, `/tree` |
| Try another line from here | `/fork`, `/clone` |
| Switch models or free context | `/model`, `/thinking`, `/compact` |
| Open this session's settings | `/settings` (also `/setting`) |
| See todos, subagents, dependencies | `/todo`, `/tasks`, `/dag` |
| Find commands and keys | `/help`, `/hotkeys` |

## Access and safety

The default is loopback with no password. In **Access settings**, you can set or change the password, toggle password protection and HTTPS, generate a self-signed SSL certificate, and bind to loopback, a specific IPv4 interface or `0.0.0.0`. Certificate generation requires OpenSSL 1.1.1+ on `PATH`; use the printed HTTPS address and verify the certificate on the client. The browser username is `omo`. Short passwords are accepted with a warning; use at least 20 characters for remote access.

For direct server startup (`omo-web serve`), use environment variables:

| Variable | Notes |
| --- | --- |
| `OMO_WEB_WORKSPACES` | Project directories allowed to host sessions; defaults to the launch directory |
| `OMO_WEB_PORT` | Listen port, default `4317` |
| `OMO_WEB_PASSWORD_FILE` | Password file (`0600` on POSIX, user-private ACL on Windows), login name `omo` |
| `OMO_WEB_PROXY_ORIGIN` | Exact external HTTPS origin for a tunnel or reverse proxy; the proxy must preserve `Host` |
| `OMO_WEB_ALLOW_UNAUTHENTICATED` | Explicit opt-in to passwordless remote access; HTTPS still required at the browser |
| `OMO_WEB_DATA` | Web session index and private logs, default `~/.omo-web` |
| `OMO_WEB_ATTACHMENT_QUOTA_BYTES` | Optional total storage quota for sent attachments, in bytes; unset by default |
| `OMO_WEB_CLI_AGENT_DIR` | Shared OmO profile directory for the engine, CLI history, and snapshots |
| `OMO_WEB_BIN` | Native CLI binary, default `omo` |

On Linux, separate multiple workspaces with `:` (Windows uses `;`):

```sh
dirs="$HOME/code/api:$HOME/code/ui"
OMO_WEB_WORKSPACES="$dirs" bun start
```

Non-loopback listeners require HTTPS. Binding to an interface does not configure a firewall or restrict which source addresses can connect. Use a VPN where possible and set a password. Passwordless mode is an explicit opt-in for restricted networks: anyone who can connect can read sessions and run tools through OmO. See [Linux and Windows remote setup](docs/usage.md#密码与远程访问).

For a tunnel or reverse proxy that terminates HTTPS, keep OmO Web on `127.0.0.1`, configure **Access settings → Proxy origin** (or `OMO_WEB_PROXY_ORIGIN`), and use the [proxy setup checklist](docs/usage.md#内网穿透与反向代理).

## Platform limits

- Linux: verified with Bun 1.4.5 and OmO Native 5.1.83; the launcher was also tested in a real terminal.
- Windows: CI covers local and remote Web access, private password files, and launching the service from the installed npm command. Interactive launcher menus and native CLI handoff were not verified on Windows.
- macOS is not in the current test matrix.

## Develop

`bun run release:pack` builds the Bun-only archive and SHA-256 file. `bun run npm:pack` builds an installable `.tgz` under `dist/npm/`. Keep your data directory and OmO profile when upgrading.

```sh
bun run check     # TypeScript
bun test          # regression tests
bun run build     # browser assets
bun run serve     # start without rebuilding
```

[Usage details](docs/usage.md) · [Install, upgrade, and release](docs/install-release.md) · [0.1.8 notes](docs/releases/0.1.8.md) · [Distribution options](docs/distribution.md)

[Web API](docs/web-api.md) · [CLI parity matrix](docs/parity/local-cli-web-matrix.md) · [Interface conventions](DESIGN.md)

## License

OmO Web is [MIT](LICENSE). Bundled archives keep the license texts of their third-party components.
