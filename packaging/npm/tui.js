// allow: SIZE_OK — The npm package ships this indivisible terminal session as one module.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { cliTr } from "./locale.js";

const CSI = "\x1b[";
const HOME_CLEAR = `${CSI}H${CSI}2J`;
const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;
const MAX_RECEIPT = 4096;
const CONFIG_PREFIX = "OmO Web config: ";
const START_MS = 30_000;
const STOP_MS = 4_000;
const REMOTE_WARNING = cliTr("警告：无密码保护", "Warning: No password protection");
const REMOTE_RISK = [
  cliTr("0.0.0.0 无密码访问", "0.0.0.0 without a password"),
  cliTr("能连上的人可访问 OmO 和工作目录。", "Anyone who connects can access OmO and your working directories."),
];
const windows = process.platform === "win32";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const safeText = value => value.replace(controls, " ");
const glyphs = text => Array.from(segmenter.segment(text), ({ segment }) => segment);
// Reserve two cells for non-ASCII graphemes so wide paths cannot wrap at the edge.
const cells = glyph => /^[\x20-\x7e]+$/.test(glyph) ? glyph.length : 2;
const textWidth = text => glyphs(text).reduce((sum, glyph) => sum + cells(glyph), 0);

function fold(text, width) {
  const lines = [""];
  let remaining = width;
  for (const glyph of glyphs(safeText(text))) {
    const size = cells(glyph);
    if (size > remaining) {
      lines.push("");
      remaining = width;
    }
    lines[lines.length - 1] += glyph;
    remaining -= size;
  }
  return lines;
}

function pathLabel(path, width) {
  const chars = glyphs(safeText(path));
  const size = chars.reduce((sum, glyph) => sum + cells(glyph), 0);
  if (size <= width) return chars.join("");
  const head = fold(path, Math.min(10, Math.floor(width / 3)))[0];
  let tail = "";
  let room = width - [...head].reduce((sum, glyph) => sum + cells(glyph), 0) - 3;
  for (const glyph of chars.reverse()) {
    room -= cells(glyph);
    if (room < 0) break;
    tail = glyph + tail;
  }
  return `${head}...${tail}`;
}

function editorLine(draft, width) {
  let left = "", right = "";
  let column = 0;
  for (const glyph of glyphs(safeText(draft.text.slice(0, draft.cursor))).reverse()) {
    if (column + cells(glyph) >= width) break;
    left = glyph + left;
    column += cells(glyph);
  }
  let room = width - column;
  for (const glyph of glyphs(safeText(draft.text.slice(draft.cursor)))) {
    if (cells(glyph) > room) break;
    right += glyph;
    room -= cells(glyph);
  }
  // Let the terminal measure the cursor position, including ambiguous-width glyphs.
  return `${left}${CSI}s${right}`;
}

function receiveLines(stream, onLine) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    const pieces = chunk.split("\n");
    for (const [index, piece] of pieces.entries()) {
      if (pending !== null) {
        pending = pending.length + piece.length > MAX_RECEIPT ? null : pending + piece;
      }
      if (index === pieces.length - 1) break;
      const line = pending?.replace(/\r$/, "");
      pending = "";
      if (line !== undefined) onLine(line);
    }
  });
}

function receiveListener(stream, onUrl) {
  receiveLines(stream, line => {
    // Match the actual stdout receipt as a whole line, not its sanitized display.
    const receipt = line.match(/^OmO Web: (https?:\/\/[^\s\\\p{Cc}\p{Cf}]+)$/u);
    if (!receipt || receipt[0] !== line) return;
    try {
      const parsed = new URL(receipt[1]);
      if (!parsed.username && !parsed.password) onUrl(receipt[1]);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  });
}

// Windows signals sent through Node terminate only the direct child.
// Stop the owned server process tree so a native engine cannot outlive it.
export function stopWindowsServer(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore", windowsHide: true,
  });
  const fallback = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  killer.once("error", fallback);
  killer.once("exit", code => { if (code !== 0) fallback(); });
}

function killServerGroup(child) {
  if (!windows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

/** Run the launcher until the user quits (0), Ctrl+C interrupts (130), or a signal ends it. */
export async function startTui({ entry, version }) {
  const input = process.stdin;
  const output = process.stdout;
  const color = process.env.NO_COLOR === undefined;
  const ink = (sgr, text) => color ? `${CSI}${sgr}m${text}${CSI}0m` : text;
  const cwd = process.cwd();
  const unprotected = process.env.OMO_WEB_HOST === "0.0.0.0" && !process.env.OMO_WEB_PASSWORD_FILE;
  const optedIn = process.env.OMO_WEB_ALLOW_UNAUTHENTICATED === "1";
  let workspaces;
  let draft;
  let pasting = false;
  let selected = 0;
  let server;
  let url;
  let phase = "idle";
  let stopped = false;
  let notice = "";
  let exitCode;
  let settle;
  let paint;
  const finished = new Promise(resolve => { settle = resolve; });

  const directoriesLabel = cliTr("工作目录", "Working directories");
  const quitAction = [cliTr("退出", "Quit"), () => quit(0)];
  const stopAction = [cliTr("停止服务", "Stop web"), stopWeb];
  const menus = {
    idle: [[cliTr("启动服务", "Start web"), requestStart], [directoriesLabel, editWorkspaces], quitAction],
    confirming: [
      [cliTr("返回", "Back"), backFromConfirmation],
      [cliTr("仅本次无密码启动", "Start once without a password"), () => startWeb(true)],
    ],
    starting: [stopAction, quitAction],
    ready: [[cliTr("打开浏览器", "Open browser"), openBrowser], stopAction, quitAction],
    stopping: [quitAction],
  };
  const status = {
    idle: [() => notice ? cliTr("待机 / 见提示", "Idle / see notice")
      : stopped ? cliTr("已停止", "Stopped") : cliTr("待机", "Idle"), "36"],
    confirming: [() => cliTr("确认远程访问", "Confirm remote access"), "33;1"],
    starting: [() => cliTr("启动中", "Starting"), "33;1"],
    ready: [() => cliTr("监听中", "Listening"), "32;1"],
    stopping: [() => cliTr("停止中", "Stopping"), "33;1"],
  };
  const configured = () => workspaces ?? process.env.OMO_WEB_WORKSPACES;
  const activePaths = () => configured()
    ? configured().split(delimiter).filter(Boolean).map(path => resolve(cwd, path))
    : [cwd];
  const viewport = () => ({
    width: Math.min(72, (output.columns || 80) - 4),
    height: Math.max(1, (output.rows || 24) - 1),
  });
  const riskLines = width => REMOTE_RISK.flatMap(line => fold(line, width));
  const confirmationFits = ({ width, height }) => width >= 32 && riskLines(width).length + 2 <= height;
  const activeMenu = dimensions => phase === "confirming" && !confirmationFits(dimensions)
    ? menus.confirming.slice(0, 1) : menus[phase];

  function render() {
    paint = undefined;
    const dimensions = viewport();
    const { width, height } = dimensions;
    if (width < 2) {
      output.write(HIDE_CURSOR + HOME_CLEAR);
      return;
    }
    const [state, tone] = status[phase];
    const label = state();
    const build = fold(`v${version}`, 20)[0];
    const title = cliTr(" Web 监听  ", " WEB LISTENER  ");
    const brand = "-- OmO Web ";
    const gap = width - textWidth(title) - textWidth(label) - textWidth(build) - 1;
    const boxed = width >= 44 && gap >= 2;
    const header = boxed ? [
      ink("36;1", `+${brand}${"-".repeat(width - brand.length)}+`),
      `|${title}${ink(tone, label)}${" ".repeat(gap)}${build} |`,
      ink("36", `+${"-".repeat(width)}+`),
    ] : fold(`OmO Web / ${label}`, width).map(line => ink(tone, line));
    const short = text => fold(text, width)[0];
    const editorTitle = ink("1", short(cliTr("编辑目录", "Edit directories")));
    const menu = activeMenu(dimensions);
    const focus = Math.min(selected, menu.length - 1);
    const actions = menu.map(([action], index) => index === focus
      ? ink("7;1", short(`> ${action} `)) : short(`  ${action}`));
    const message = notice ? fold(notice, width).slice(0, 2).map(line => ink("33;1", line)) : [];
    const warning = unprotected && (optedIn || server) && phase !== "confirming"
      ? fold(REMOTE_WARNING, width).map(line => ink("33;1", line)) : [];
    const risk = phase === "confirming" && menu.length > 1
      ? riskLines(width).map(line => ink("33;1", line)) : [];
    let editor;
    let lines;
    if (draft) {
      editor = editorLine(draft, Math.max(2, width - 2));
      lines = [...header, "", editorTitle, `> ${editor}`, "",
        ...fold(cliTr(`用 "${delimiter}" 分隔路径，留空使用启动目录。`,
          `Separate paths with "${delimiter}". Empty uses the launch directory.`), width),
        ...message, "", ...fold(cliTr("Enter 确认 / Esc 取消 / Ctrl+U 清空", "Enter confirm / Esc cancel / Ctrl+U clear"), width)];
    } else if (phase === "confirming") {
      lines = [...header, "", ...risk, "", ...actions, "",
        ...fold(menu.length > 1
          ? cliTr("↑/↓ 移动 / Enter 选择 / Esc 返回", "Up/Down move / Enter select / Esc back")
          : cliTr("请放大终端以查看风险提示。", "Enlarge the terminal to review the risk."), width)];
    } else {
      const paths = activePaths();
      const urlRows = url ? fold(url, Math.max(2, width - 2)) : [];
      const pathCount = height >= 23 ? 4 : 2;
      const details = url ? [ink("1", short(cliTr("浏览器地址", "Browser URL"))), ...urlRows.slice(0, 2).map(line => `  ${line}`),
        ...(urlRows.length > 2 ? ["  ..."] : []), ""] : [];
      const directories = paths.length ? paths.slice(0, pathCount).map(path => `  ${pathLabel(path, width - 2)}`)
        : [short(cliTr("  （未配置）", "  (none configured)"))];
      if (paths.length > pathCount) directories.push(short(cliTr(`  另有 ${paths.length - pathCount} 个`, `  +${paths.length - pathCount} more`)));
      lines = [...header, ...warning, "", ...details, ink("1", short(directoriesLabel)), ...directories,
        "", ...actions, ...message, "", ...fold(cliTr("↑/↓ 移动 / Enter 选择 / Q 退出", "Up/Down move / Enter select / Q quit"), width)];
    }
    for (let blank = lines.lastIndexOf(""); lines.length > height && blank >= 0; blank = lines.lastIndexOf("")) {
      lines.splice(blank, 1);
    }
    // On very short terminals, prioritize the active control (or the draft).
    if (lines.length > height) {
      if (draft) {
        lines = [...(height > 1 ? [editorTitle] : []), "> " + editor, ...message,
          short(cliTr("Enter 确认 / Esc 取消", "Enter confirm / Esc cancel"))];
      } else if (phase === "confirming") {
        lines = [...risk, ...actions];
      } else {
        const compactStatus = ink(tone, short(`OmO Web / ${label}`));
        lines = warning.length && height > 1
          ? [compactStatus, ...warning.slice(0, Math.max(1, height - 2)), actions[focus]]
          : [...actions, ...message, compactStatus];
      }
    }
    output.write(HIDE_CURSOR + HOME_CLEAR + lines.slice(0, height).map(line => ` ${line}`).join("\r\n")
      + (editor ? `${CSI}u${SHOW_CURSOR}` : ""));
  }

  function redraw() {
    paint ??= setImmediate(render);
  }

  function editWorkspaces() {
    const text = configured() || cwd;
    draft = { text, cursor: text.length };
    notice = "";
  }

  function editKey(text, key) {
    if (!pasting && key.name === "escape") {
      draft = undefined;
      notice = "";
    } else if (!pasting && (key.name === "return" || key.name === "enter")) {
      const paths = draft.text.split(delimiter).filter(Boolean).map(path => resolve(cwd, path));
      for (const path of paths) {
        try {
          if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
          notice = cliTr(`不是目录：${path}`, `Not a directory: ${path}`);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          notice = cliTr(`无法使用目录 (${error.code ?? "?"})：${path}`,
            `Cannot use directory (${error.code ?? "?"}): ${path}`);
        }
        return;
      }
      workspaces = paths.join(delimiter);
      draft = undefined;
      notice = "";
    } else {
      const { text: value, cursor } = draft;
      const left = value.slice(0, cursor), right = value.slice(cursor);
      const previous = () => cursor - (glyphs(left).at(-1)?.length ?? 0);
      const next = () => cursor + (glyphs(right)[0]?.length ?? 0);
      if (!pasting && key.ctrl && key.name === "u") draft = { text: "", cursor: 0 };
      else if (!pasting && key.name === "left") draft.cursor = previous();
      else if (!pasting && key.name === "right") draft.cursor = next();
      else if (!pasting && key.name === "home") draft.cursor = 0;
      else if (!pasting && key.name === "end") draft.cursor = value.length;
      else if (!pasting && key.name === "backspace") {
        draft = { text: value.slice(0, previous()) + right, cursor: previous() };
      } else if (!pasting && key.name === "delete") draft.text = left + value.slice(next());
      else if (!key.ctrl && !key.meta && text && text === safeText(text) && value.length + text.length <= 8192) {
        draft = { text: left + text + right, cursor: cursor + text.length };
      } else return;
      notice = "";
    }
  }

  function requestStart() {
    if (unprotected && !optedIn) {
      phase = "confirming";
      selected = 0;
    } else startWeb();
  }

  function backFromConfirmation() {
    phase = "idle";
    selected = 0;
  }

  function startWeb(confirmed = false) {
    phase = "starting";
    selected = 0;
    notice = "";
    redraw();
    const env = {
      ...process.env,
      ...(workspaces === undefined ? {} : { OMO_WEB_WORKSPACES: workspaces }),
      ...(confirmed ? { OMO_WEB_ALLOW_UNAUTHENTICATED: "1" } : {}),
    };
    const child = spawn("bun", ["--no-env-file", entry], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
    });
    let errorMessage;
    let configMessage;
    const startup = setTimeout(() => {
      errorMessage = cliTr("未收到监听地址。请重试或运行 omo-web serve 查看详情。",
        "No listener receipt. Retry or run omo-web serve for details.");
      stopWeb();
    }, START_MS);
    server = { child, startup, killTimer: undefined };
    receiveListener(child.stdout, href => {
      if (phase !== "starting" || child.exitCode !== null || child.signalCode !== null) return;
      clearTimeout(startup);
      url = href;
      phase = "ready";
      selected = 0;
      redraw();
    });
    receiveLines(child.stderr, line => {
      if (phase !== "starting" || configMessage || !line.startsWith(CONFIG_PREFIX)) return;
      configMessage = safeText(stripVTControlCharacters(line.slice(CONFIG_PREFIX.length))).trim();
    });
    child.once("error", error => {
      errorMessage = error.code === "ENOENT"
        ? cliTr("PATH 中找不到 Bun。请从 bun.sh 安装。", "Bun was not found on PATH. Install it from bun.sh.")
        : cliTr(`无法运行 Bun (${error.code ?? "?"})。`, `Could not run Bun (${error.code ?? "?"}).`);
    });
    child.once("exit", () => {
      clearTimeout(server.killTimer);
      // The main server closes its resources on SIGTERM; reap the group if
      // anything survived that cleanup or the server exited unexpectedly.
      if (!windows) killServerGroup(child);
    });
    child.once("close", (code, signal) => {
      clearTimeout(startup);
      clearTimeout(server.killTimer);
      if (exitCode !== undefined) {
        settle(exitCode);
        return;
      }
      stopped = phase === "stopping" && !errorMessage;
      notice = stopped ? "" : (configMessage || errorMessage || cliTr(`Web 服务已退出 (${signal ?? code})。请重试或运行 omo-web serve。`,
        `Web exited (${signal ?? code}). Retry or run omo-web serve.`));
      server = undefined;
      phase = "idle";
      url = undefined;
      selected = 0;
      redraw();
    });
  }

  function stopWeb() {
    if (!server || phase === "stopping") return;
    phase = "stopping";
    url = undefined;
    selected = 0;
    notice = "";
    const { child, startup } = server;
    clearTimeout(startup);
    if (windows) {
      stopWindowsServer(child);
      server.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, STOP_MS);
    } else {
      child.kill("SIGTERM");
      server.killTimer = setTimeout(() => killServerGroup(child), STOP_MS);
    }
    redraw();
  }

  function openBrowser() {
    const current = server;
    const commands = {
      darwin: ["open", url],
      win32: ["rundll32.exe", "url.dll,FileProtocolHandler", url],
    };
    const [command, ...args] = commands[process.platform] ?? ["xdg-open", url];
    const browser = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: !windows });
    const failed = () => {
      if (server !== current || phase !== "ready" || exitCode !== undefined) return;
      notice = cliTr("无法打开浏览器。请手动打开上方地址。", "Could not open a browser. Open the URL above.");
      redraw();
    };
    browser.once("error", failed);
    browser.once("exit", code => { if (code !== 0) failed(); });
    browser.unref();
    notice = "";
    redraw();
  }

  function quit(code) {
    if (exitCode !== undefined) return;
    exitCode = code;
    if (server) stopWeb();
    else settle(code);
  }

  function onKey(text, key) {
    if (exitCode !== undefined || !key) return;
    if (key.ctrl && key.name === "c") return quit(130);
    if (key.name === "paste-start" || key.name === "paste-end") {
      pasting = key.name === "paste-start";
      return;
    }
    if (draft) editKey(text, key);
    else if (pasting) return;
    else if (key.name === "escape" && phase === "confirming") backFromConfirmation();
    else if (key.name === "q" || key.name === "escape") return quit(0);
    else {
      const menu = activeMenu(viewport());
      selected = Math.min(selected, menu.length - 1);
      if (key.name === "return" || key.name === "enter") menu[selected][1]();
      else if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? -1 : 1) + menu.length) % menu.length;
      }
    }
    redraw();
  }

  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const onInt = () => quit(130);
  const onTerm = () => quit(143);
  const onHangup = () => quit(129);
  try {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHangup);
    input.on("end", onHangup);
    input.setRawMode(true);
    output.write(`${CSI}?1049h${CSI}?2004h`);
    emitKeypressEvents(input);
    input.on("keypress", onKey);
    input.resume();
    output.on("resize", redraw);
    render();
    return await finished;
  } finally {
    clearImmediate(paint);
    output.off("resize", redraw);
    input.off("keypress", onKey);
    input.off("end", onHangup);
    if (!wasFlowing) input.pause();
    try {
      input.setRawMode(wasRaw);
    } finally {
      output.write(`${CSI}?2004l${CSI}?1049l${SHOW_CURSOR}`);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHangup);
    }
  }
}
