#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTui } from "./tui.js";

const args = process.argv.slice(2);
const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const entry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const terminal = process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb";

if (args.length === 1 && args[0] === "--version") {
  console.log(version());
} else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(`Usage: omo-web [tui | serve]

  omo-web        Open the launcher in a terminal; start directly otherwise.
  omo-web tui    Open the interactive launcher.
  omo-web serve  Start the Web service without the launcher.

Requires Bun and OmO Native (omo). The default is your current directory.
Use OMO_WEB_WORKSPACES or OMO_WEB_PORT to set directories or the listen port.
https://github.com/NekoCCN/OmO-Web/blob/main/docs/usage.md`);
} else if (args.length > 1 || (args.length === 1 && args[0] !== "tui" && args[0] !== "serve")) {
  console.error("omo-web: unsupported arguments. See omo-web --help.");
  process.exitCode = 2;
} else if (args[0] === "tui" && !terminal) {
  console.error("omo-web: the launcher needs an interactive terminal. Use omo-web serve instead.");
  process.exitCode = 2;
} else if (args[0] !== "serve" && terminal) {
  process.exitCode = await startTui({ entry, version: version() });
} else {
  const child = spawn("bun", ["--no-env-file", entry], { stdio: "inherit" });
  const onInterrupt = () => child.kill("SIGINT");
  const onTerminate = () => child.kill("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  child.once("error", error => {
    console.error(error.code === "ENOENT"
      ? "omo-web: Bun was not found on PATH. Install Bun from https://bun.sh."
      : `omo-web: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.exitCode ??= code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}
