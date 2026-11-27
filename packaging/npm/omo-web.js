#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliTr } from "./locale.js";
import { startTui, stopWindowsServer } from "./tui.js";
import { createWindowsPasswordFile } from "./windows-password.js";

const args = process.argv.slice(2);
const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const entry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const terminal = process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb";

if (args.length === 1 && args[0] === "--version") {
  console.log(version());
} else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(`${cliTr("用法：", "Usage:")} omo-web [tui | serve | password-file <path>]

  omo-web                       ${cliTr("在交互终端打开启动器，否则直接启动服务。", "Open the launcher in a terminal; start directly otherwise.")}
  omo-web tui                   ${cliTr("打开交互式启动器。", "Open the interactive launcher.")}
  omo-web serve                 ${cliTr("直接启动 Web 服务。", "Start the Web service directly.")}
  omo-web password-file <path>  ${cliTr("创建私密随机密码文件，不覆盖。", "Create a private random password file without overwriting.")}

${cliTr("需要 Bun 和 OmO Native (omo)。默认使用当前目录。", "Requires Bun and OmO Native (omo). Defaults to the current directory.")}
${cliTr("用 OMO_WEB_WORKSPACES 和 OMO_WEB_PORT 设置目录和端口。", "Set directories and port with OMO_WEB_WORKSPACES and OMO_WEB_PORT.")}
${cliTr("监听 0.0.0.0 必须使用 HTTPS。建议设置 OMO_WEB_PASSWORD_FILE。",
    "Listening on 0.0.0.0 requires HTTPS. Set OMO_WEB_PASSWORD_FILE for protection.")}
${cliTr("仅在受限私网或 VPN 使用无密码模式；脚本需显式设置 OMO_WEB_ALLOW_UNAUTHENTICATED=1。",
    "Use password-free access only on a restricted private network or VPN. Scripts must set OMO_WEB_ALLOW_UNAUTHENTICATED=1.")}
https://github.com/NekoCCN/OmO-Web/blob/main/docs/usage.md`);
} else if (args.length === 2 && args[0] === "password-file" && args[1]) {
  process.exitCode = await createPasswordFile(args[1]);
} else if (args.length > 1 || (args.length === 1 && args[0] !== "tui" && args[0] !== "serve")) {
  console.error(cliTr("omo-web: 参数不受支持。请查看 omo-web --help。",
    "omo-web: unsupported arguments. See omo-web --help."));
  process.exitCode = 2;
} else if (args[0] === "tui" && !terminal) {
  console.error(cliTr("omo-web: 启动器需要交互终端。请改用 omo-web serve。",
    "omo-web: the launcher needs an interactive terminal. Use omo-web serve instead."));
  process.exitCode = 2;
} else if (args[0] !== "serve" && terminal) {
  process.exitCode = await startTui({ entry, version: version() });
} else {
  const child = spawn("bun", ["--no-env-file", entry], { stdio: "inherit" });
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    if (process.platform === "win32") stopWindowsServer(child);
    else child.kill(signal);
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  child.once("error", error => {
    console.error(error.code === "ENOENT"
      ? cliTr("omo-web: PATH 中找不到 Bun。请从 https://bun.sh 安装。",
        "omo-web: Bun was not found on PATH. Install Bun from https://bun.sh.")
      : cliTr(`omo-web: 无法运行 Bun (${error.code ?? "?"})。`, `omo-web: Could not run Bun (${error.code ?? "?"}).`));
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.exitCode ??= code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

async function createPasswordFile(path) {
  try {
    const password = randomBytes(32).toString("base64url");
    if (process.platform === "win32") {
      await createWindowsPasswordFile(path, password);
    } else {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${password}\n`);
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.code === "EEXIST"
      ? cliTr("omo-web: 目标已存在，未覆盖。", "omo-web: destination already exists; not overwritten.")
      : cliTr("omo-web: 无法创建私密密码文件。请检查目标路径和权限。",
        "omo-web: could not create a private password file. Check the destination and permissions."));
    return 1;
  }
  console.log(cliTr("密码文件已创建。请将 OMO_WEB_PASSWORD_FILE 设为该路径。",
    "Password file created. Set OMO_WEB_PASSWORD_FILE to its path."));
  return 0;
}
