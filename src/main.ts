import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { cliTr } from "../packaging/npm/locale.js";
import { startApp } from "./server.ts";
import { WebAccessConfigError } from "./web-access.ts";
import { missingWebAssets } from "./web-assets.ts";

const port = Number(process.env.OMO_WEB_PORT ?? "4317");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`OmO Web config: OMO_WEB_PORT: ${cliTr("端口必须是 0–65535 的整数。", "Expected an integer from 0 to 65535.")}`);
  process.exit(1);
}
const missing = await missingWebAssets();
if (missing.length) {
  console.error(cliTr(
    `OmO Web 无法启动：缺少静态资源 ${missing.join("、")}。源码运行 bun run build；发行包重新校验并解压。`,
    `OmO Web cannot start: missing assets ${missing.join(", ")}. Run bun run build in a source checkout, or verify and re-extract the release.`,
  ));
  process.exit(1);
}
const configured = process.env.OMO_WEB_WORKSPACES;
const workspaces = configured ? configured.split(delimiter).filter(Boolean).map(path => resolve(path)) : [process.cwd()];
const cliProfile = process.env.OMO_WEB_CLI_AGENT_DIR ?? (process.env.OMO_CODING_AGENT_DIR
  || process.env.SENPI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omo", "agent"));
const app = await startApp({
  port,
  webEnv: process.env,
  dataDir: resolve(process.env.OMO_WEB_DATA ?? join(homedir(), ".omo-web")),
  workspaces,
  ...(cliProfile.trim() ? { cliAgentDir: resolve(cliProfile) } : {}),
  // Private non-listening stdio host with the in-process runtime: the only
  // host shape whose holder guard refuses a second opener in both directions.
  // Verified on omo 5.1.81 (engine 2026.11.19-5); keep flags minimal so a stock
  // CLI can still open the same journal after a deliberate handoff release.
  engineCommand: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session",
    "--offline", "--no-approve", "--session-runtime", "in-process"],
}).catch(error => {
  if (!(error instanceof WebAccessConfigError)) throw error;
  console.error(`OmO Web config: ${error.message}`);
  process.exit(1);
});
if (app.unprotected) console.warn(cliTr(
  "警告：非本机入口未设密码。能访问此地址的人都能读取会话并通过 OmO 操作本机。仅在受限私网或 VPN 内使用。",
  "Warning: remote access without a password. Anyone who can reach this address can read sessions and run tools through OmO. Use only on a restricted private network or VPN.",
));
if (app.weakPassword) console.warn(cliTr(
  "OmO Web warning: 密码较短，建议使用至少 20 个字符。",
  "OmO Web warning: short password. Use at least 20 characters for better protection.",
));
console.log(`OmO Web: ${app.url.href}`);
if (app.proxyOrigin) console.log(`${cliTr("代理入口", "Proxy origin")}: ${app.proxyOrigin}`);
console.log(`${cliTr("工作目录", "Working directories")}: ${workspaces.join(", ")}`);
const halt = () => { void app.stop().catch(error => { console.error(error); process.exitCode = 1; }); };
process.once("SIGINT", halt);
process.once("SIGTERM", halt);
