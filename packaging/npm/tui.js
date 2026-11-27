// allow: SIZE_OK — The npm package ships this indivisible terminal session as one module.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";

const CSI = "\x1b[";
const HOME_CLEAR = `${CSI}H${CSI}2J`;
const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;
const MAX_RECEIPT = 4096;
const START_MS = 30_000;
const STOP_MS = 4_000;
const windows = process.platform === "win32";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const safeText = value => value.replace(controls, " ");
const glyphs = text => Array.from(segmenter.segment(text), ({ segment }) => segment);
// Reserve two cells for non-ASCII graphemes so wide paths cannot wrap at the edge.
const cells = glyph => /^[\x20-\x7e]+$/.test(glyph) ? glyph.length : 2;

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

function receiveListener(stream, onUrl) {
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
      // Match the actual stdout receipt as a whole line, not its sanitized display.
      const receipt = line?.match(/^OmO Web: (https?:\/\/[^\s\\\p{Cc}\p{Cf}]+)$/u);
      if (!receipt || receipt[0] !== line) continue;
      try {
        const parsed = new URL(receipt[1]);
        if (!parsed.username && !parsed.password) onUrl(receipt[1]);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
  });
}

function killServerGroup(child) {
  if (windows) {
    child.kill("SIGKILL");
  } else if (child.pid !== undefined) {
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

  const menus = {
    idle: [["Start web", startWeb], ["Working directories", editWorkspaces], ["Quit", () => quit(0)]],
    starting: [["Stop web", stopWeb], ["Quit", () => quit(0)]],
    ready: [["Open browser", openBrowser], ["Stop web", stopWeb], ["Quit", () => quit(0)]],
    stopping: [["Quit", () => quit(0)]],
  };
  const status = {
    idle: [() => notice ? "Idle / see notice" : stopped ? "Stopped" : "Idle", "36"],
    starting: [() => "Starting", "33;1"],
    ready: [() => "Listening", "32;1"],
    stopping: [() => "Stopping", "33;1"],
  };
  const configured = () => workspaces ?? process.env.OMO_WEB_WORKSPACES;
  const activePaths = () => configured()
    ? configured().split(delimiter).filter(Boolean).map(path => resolve(cwd, path))
    : [cwd];

  function render() {
    paint = undefined;
    const columns = output.columns || 80;
    const width = Math.min(72, columns - 4);
    const height = Math.max(1, (output.rows || 24) - 1);
    if (width < 2) {
      output.write(HIDE_CURSOR + HOME_CLEAR);
      return;
    }
    const [state, tone] = status[phase];
    const label = state();
    const build = fold(`v${version}`, 20)[0];
    const title = " WEB LISTENER  ";
    const brand = "-- OmO Web ";
    const gap = width - title.length - label.length - build.length - 1;
    const boxed = width >= 44 && gap >= 2;
    const header = boxed ? [
      ink("36;1", `+${brand}${"-".repeat(width - brand.length)}+`),
      `|${title}${ink(tone, label)}${" ".repeat(gap)}${build} |`,
      ink("36", `+${"-".repeat(width)}+`),
    ] : fold(`OmO Web / ${label}`, width).map(line => ink(tone, line));
    const short = text => fold(text, width)[0];
    const editorTitle = ink("1", short("Edit directories"));
    const actions = menus[phase].map(([action], index) => index === selected
      ? ink("7;1", short(`> ${action} `)) : short(`  ${action}`));
    const message = notice ? fold(notice, width).slice(0, 2).map(line => ink("33;1", line)) : [];
    let editor;
    let lines;
    if (draft) {
      editor = editorLine(draft, Math.max(2, width - 2));
      lines = [...header, "", editorTitle, `> ${editor}`, "",
        ...fold(`Separate paths with "${delimiter}". Empty uses the launch directory.`, width),
        ...message, "", ...fold("Enter confirm / Esc cancel / Ctrl+U clear", width)];
    } else {
      const paths = activePaths();
      const urlRows = url ? fold(url, Math.max(2, width - 2)) : [];
      const pathCount = height >= 23 ? 4 : 2;
      const details = url ? [ink("1", short("Browser URL")), ...urlRows.slice(0, 2).map(line => `  ${line}`),
        ...(urlRows.length > 2 ? ["  ..."] : []), ""] : [];
      const directories = paths.length ? paths.slice(0, pathCount).map(path => `  ${pathLabel(path, width - 2)}`)
        : [short("  (none configured)")];
      if (paths.length > pathCount) directories.push(short(`  +${paths.length - pathCount} more`));
      lines = [...header, "", ...details, ink("1", short("Working directories")), ...directories,
        "", ...actions, ...message, "", ...fold("Up/Down move / Enter select / Q quit", width)];
    }
    for (let blank = lines.lastIndexOf(""); lines.length > height && blank >= 0; blank = lines.lastIndexOf("")) {
      lines.splice(blank, 1);
    }
    // On very short terminals, prioritize the active control (or the draft).
    if (lines.length > height) lines = draft ? [
      ...(height > 1 ? [editorTitle] : []),
      "> " + editor, ...message, short("Enter confirm / Esc cancel"),
    ]
      : [...actions, ...message, ...header];
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
          notice = `Not a directory: ${path}`;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          notice = `Cannot use directory (${error.code ?? "error"}): ${path}`;
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

  function startWeb() {
    phase = "starting";
    selected = 0;
    notice = "";
    redraw();
    const env = workspaces === undefined ? process.env : { ...process.env, OMO_WEB_WORKSPACES: workspaces };
    const child = spawn("bun", ["--no-env-file", entry], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
    });
    let errorMessage;
    const startup = setTimeout(() => {
      errorMessage = "No listener receipt. Retry or run omo-web serve for details.";
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
    child.stderr.resume();
    child.once("error", error => {
      errorMessage = error.code === "ENOENT" ? "Bun was not found on PATH. Install it from bun.sh."
        : `Could not run Bun (${error.code ?? "error"}).`;
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
      notice = errorMessage ?? (stopped ? "" :
        `Web exited (${signal ?? code}). Retry or run omo-web serve.`);
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
    child.kill("SIGTERM");
    server.killTimer = setTimeout(() => killServerGroup(child), STOP_MS);
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
      notice = "Could not open a browser. Open the URL above.";
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
    else if (key.name === "q" || key.name === "escape") return quit(0);
    else if (key.name === "return" || key.name === "enter") menus[phase][selected][1]();
    else if (key.name === "up" || key.name === "down") {
      const size = menus[phase].length;
      selected = (selected + (key.name === "up" ? -1 : 1) + size) % size;
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
