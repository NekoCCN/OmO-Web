import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startApp } from "./server.ts";

const port = Number(process.env.OMO_WEB_PORT ?? "4317");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError("OMO_WEB_PORT 必须是 0–65535 的整数。");
}
const configured = process.env.OMO_WEB_WORKSPACES;
const workspaces = configured ? configured.split(delimiter).filter(Boolean).map(path => resolve(path)) : [process.cwd()];
const app = await startApp({
  port,
  dataDir: resolve(process.env.OMO_WEB_DATA ?? join(homedir(), ".omo-web")),
  workspaces,
  engineCommand: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve"],
});
console.log(`OmO Web: ${app.url.href}`);
console.log(`工作目录: ${workspaces.join(", ")}`);
const halt = () => { void app.stop().catch(error => { console.error(error); process.exitCode = 1; }); };
process.once("SIGINT", halt);
process.once("SIGTERM", halt);
