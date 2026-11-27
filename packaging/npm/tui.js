// allow: SIZE_OK — The npm package ships this indivisible terminal session as one module.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { parseProxyOrigin, passwordPattern, recommendedPasswordLength } from "./access-policy.js";
import { loadLauncherSettings } from "./launcher-settings.js";
import { generateCertificate } from "./launcher-tls.js";
import { interfaceAddresses, isRemoteAddress, loopbackAddress, wildcardAddress } from "./listen-address.js";
import { cliTr } from "./locale.js";

const CSI = "\x1b[";
const HOME_CLEAR = `${CSI}H${CSI}2J`;
const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;
const MAX_RECEIPT = 4096;
const CONFIG_PREFIX = "OmO Web config: ";
const WARNING_PREFIX = "OmO Web warning: ";
const START_MS = 30_000;
const STOP_MS = 4_000;
const REMOTE_WARNING = cliTr("警告：无密码保护", "Warning: No password protection");
const REMOTE_RISK = cliTr("能连上的人可访问 OmO 和工作目录。",
  "Anyone who connects can access OmO and your working directories.");
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
  const settings = await loadLauncherSettings(process.env);
  let env = settings.effectiveEnv();
  const address = () => env.OMO_WEB_HOST ?? loopbackAddress;
  const proxyOrigin = () => env.OMO_WEB_PROXY_ORIGIN;
  const unprotected = () => (isRemoteAddress(address()) || Boolean(proxyOrigin())) && !env.OMO_WEB_PASSWORD_FILE;
  const optedIn = () => env.OMO_WEB_ALLOW_UNAUTHENTICATED === "1";
  const hasPassword = () => Boolean(env.OMO_WEB_PASSWORD_FILE);
  const hasHttps = () => Boolean(env.OMO_WEB_TLS_CERT && env.OMO_WEB_TLS_KEY && env.OMO_WEB_ORIGIN);
  const switchLabel = on => on ? cliTr("开", "On") : cliTr("关", "Off");
  let workspaces;
  let draft;
  let saving;
  let networks = [];
  let pasting = false;
  let selected = 0;
  let server;
  let url;
  let startupWarning = "";
  let phase = "idle";
  let stopped = false;
  let notice = settings.warning;
  let exitCode;
  let settle;
  let paint;
  const finished = new Promise(resolve => { settle = resolve; });

  const directoriesLabel = cliTr("工作目录", "Working directories");
  const quitAction = [cliTr("退出", "Quit"), () => quit(0)];
  const stopAction = [cliTr("停止服务", "Stop web"), stopWeb];
  const backAction = [cliTr("返回", "Back"), () => go("idle")];
  const menus = {
    idle: [[cliTr("启动服务", "Start web"), requestStart], [directoriesLabel, editWorkspaces],
      [cliTr("访问设置", "Access settings"), () => go("settings")], quitAction],
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
    settings: [() => cliTr("访问设置", "Access settings"), "36;1"],
    networks: [() => cliTr("监听地址", "Listen address"), "36;1"],
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
  const riskLines = width => [cliTr(`${proxyOrigin() || address()} 无密码访问`, `${proxyOrigin() || address()} without a password`), REMOTE_RISK]
    .flatMap(line => fold(line, width));
  const confirmationFits = ({ width, height }) => width >= 32 && riskLines(width).length + 2 <= height;
  function activeMenu(dimensions) {
    if (phase === "settings") return [
      [cliTr(`监听地址：${address()}`, `Listen address: ${address()}`), () => {
        networks = interfaceAddresses();
        go("networks");
      }],
      [cliTr(`密码：${switchLabel(hasPassword())}`, `Password: ${switchLabel(hasPassword())}`), togglePassword],
      [cliTr("设置 / 修改密码", "Set / change password"), editPassword],
      [cliTr(`HTTPS：${switchLabel(hasHttps())}`, `HTTPS: ${switchLabel(hasHttps())}`), toggleHttps],
      [cliTr("生成 SSL 自签证书", "Generate self-signed SSL certificate"), editCertificate],
      [cliTr(`代理入口：${proxyOrigin() || "关"}`, `Proxy origin: ${proxyOrigin() || "Off"}`), editProxyOrigin],
      backAction,
    ];
    if (phase === "networks") return [
      [cliTr(`仅本机 (${loopbackAddress})`, `Loopback only (${loopbackAddress})`), () => chooseAddress(loopbackAddress)],
      [cliTr(`全部 IPv4 网卡 (${wildcardAddress})`, `All IPv4 interfaces (${wildcardAddress})`), () => chooseAddress(wildcardAddress)],
      ...networks.map(({ name, address: ip, cidr }) =>
        [`${cidr ?? ip} — ${name}`, () => chooseAddress(ip)]),
      [cliTr("返回", "Back"), () => go("settings")],
    ];
    return phase === "confirming" && !confirmationFits(dimensions) ? menus.confirming.slice(0, 1) : menus[phase];
  }

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
    const editorTitle = draft && ink("1", short(draft.title));
    const menu = activeMenu(dimensions);
    const focus = Math.min(selected, menu.length - 1);
    const actions = menu.map(([action], index) => index === focus
      ? ink("7;1", short(`> ${action} `)) : short(`  ${action}`));
    const message = notice ? fold(notice, width).slice(0, 2).map(line => ink("33;1", line)) : [];
    const warning = unprotected() && (optedIn() || server) && phase !== "confirming"
      ? fold(REMOTE_WARNING, width).map(line => ink("33;1", line)) : [];
    if (phase === "ready" && startupWarning) warning.push(...fold(startupWarning, width).map(line => ink("33;1", line)));
    const risk = phase === "confirming" && menu.length > 1
      ? riskLines(width).map(line => ink("33;1", line)) : [];
    let editor;
    let lines;
    if (draft) {
      editor = editorLine(draft.masked ? { ...draft, text: "*".repeat(draft.text.length) } : draft, Math.max(2, width - 2));
      lines = [...header, "", editorTitle, `> ${editor}`, "",
        ...fold(draft.hint, width),
        ...message, "", ...fold(cliTr("Enter 确认 / Esc 取消 / Ctrl+U 清空", "Enter confirm / Esc cancel / Ctrl+U clear"), width)];
    } else if (phase === "confirming") {
      lines = [...header, "", ...risk, "", ...actions, "",
        ...fold(menu.length > 1
          ? cliTr("↑/↓ 移动 / Enter 选择 / Esc 返回", "Up/Down move / Enter select / Esc back")
          : cliTr("请放大终端以查看风险提示。", "Enlarge the terminal to review the risk."), width)];
    } else if (phase === "settings" || phase === "networks") {
      const hint = phase === "networks" ? cliTr("选择监听网卡，不会修改防火墙规则。", "Select a listen interface; firewall rules are unchanged.")
        : cliTr("Enter 修改 · 保存后下次启动生效 · Esc 返回", "Enter to edit · Applies on the next start · Esc back");
      const origin = phase === "settings" && hasHttps() ? fold(cliTr(`HTTPS 地址：${env.OMO_WEB_ORIGIN}`,
        `HTTPS URL: ${env.OMO_WEB_ORIGIN}`), width) : [];
      lines = [...header, "", ...actions, "", ...message, ...origin, ...fold(hint, width)];
    } else {
      const paths = activePaths();
      const urlRows = url ? fold(url, Math.max(2, width - 2)) : [];
      const pathCount = height >= 23 ? 4 : 2;
      const details = url ? [ink("1", short(cliTr("浏览器地址", "Browser URL"))), ...urlRows.slice(0, 2).map(line => `  ${line}`),
        ...(urlRows.length > 2 ? ["  ..."] : []), ""] : [];
      const directories = paths.length ? paths.slice(0, pathCount).map(path => `  ${pathLabel(path, width - 2)}`)
        : [short(cliTr("  （未配置）", "  (none configured)"))];
      if (paths.length > pathCount) directories.push(short(cliTr(`  另有 ${paths.length - pathCount} 个`, `  +${paths.length - pathCount} more`)));
      const connection = phase === "idle" ? [
        short(cliTr(`  ${address()} · ${hasHttps() ? "HTTPS" : "HTTP"} · 密码${switchLabel(hasPassword())}`,
          `  ${address()} · ${hasHttps() ? "HTTPS" : "HTTP"} · Password ${switchLabel(hasPassword())}`)),
      ] : [];
      lines = [...header, ...warning, "", ...details, ...connection, ink("1", short(directoriesLabel)), ...directories,
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
        if (phase === "settings" || phase === "networks") {
          const slots = Math.max(1, height - 1 - message.length);
          const first = Math.max(0, Math.min(focus - Math.floor(slots / 2), actions.length - slots));
          lines = height > 1 ? [compactStatus, ...actions.slice(first, first + slots), ...message] : [actions[focus]];
        } else lines = actions.length > height ? [actions[focus]] : warning.length && height > 1
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

  function go(next) {
    phase = next;
    selected = 0;
    notice = "";
  }

  function runSetting(action) {
    notice = cliTr("正在保存…", "Saving…");
    saving = Promise.resolve().then(action).then(message => {
      env = settings.effectiveEnv();
      notice = message ?? cliTr("已保存，下次启动生效。", "Saved. Applies on the next start.");
    }).catch(error => {
      if (!(error instanceof Error)) throw error;
      notice = error.message;
    }).finally(() => {
      saving = undefined;
      if (exitCode !== undefined) settle(exitCode);
      else redraw();
    });
    redraw();
  }

  function chooseAddress(host) {
    runSetting(async () => {
      await settings.save({ OMO_WEB_HOST: host, OMO_WEB_ALLOW_UNAUTHENTICATED: null });
      go("settings");
    });
  }

  function togglePassword() {
    runSetting(async () => {
      if (!await settings.setPasswordEnabled(!hasPassword())) {
        editPassword();
        return "";
      }
    });
  }

  function editPassword() {
    draft = {
      masked: true, text: "", cursor: 0, title: cliTr("新密码", "New password"),
      hint: cliTr("1–128 个可打印 ASCII 字符，建议至少 20 个。输入仅显示星号。",
        "1–128 printable ASCII characters. Aim for at least 20; input is masked."),
      submit(password) {
        if (!passwordPattern.test(password)) {
          notice = cliTr("请使用 1–128 个可打印 ASCII 字符。", "Use 1–128 printable ASCII characters.");
          return;
        }
        runSetting(async () => {
          await settings.changePassword(password);
          draft = undefined;
          if (password.length < recommendedPasswordLength) return cliTr(
            "已保存。密码较短，建议使用至少 20 个字符。",
            "Saved. Short password; use at least 20 characters for better protection.");
        });
      },
    };
    notice = "";
  }

  function editProxyOrigin() {
    const text = proxyOrigin() ?? "";
    draft = {
      text, cursor: text.length, title: cliTr("外部 HTTPS 入口", "External HTTPS origin"),
      hint: cliTr("例如 https://web.example.com；代理保留 Host。清空可关闭。",
        "E.g. https://web.example.com. Preserve Host. Empty disables."),
      submit(value) {
        const origin = value === "" ? null : parseProxyOrigin(value);
        if (origin === undefined) {
          notice = cliTr("请输入不含路径或尾部斜杠的 HTTPS origin。",
            "Enter an HTTPS origin without a path or trailing slash.");
          return;
        }
        runSetting(async () => {
          await settings.save({ OMO_WEB_PROXY_ORIGIN: origin?.origin ?? null, OMO_WEB_ALLOW_UNAUTHENTICATED: null });
          draft = undefined;
        });
      },
    };
    notice = "";
  }

  function toggleHttps() {
    runSetting(async () => {
      if (!await settings.setHttpsEnabled(!hasHttps())) {
        editCertificate();
        return "";
      }
    });
  }

  function editCertificate() {
    let current;
    try {
      if (env.OMO_WEB_ORIGIN) current = new URL(env.OMO_WEB_ORIGIN).hostname;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    const text = current ?? (address() === wildcardAddress ? interfaceAddresses()[0]?.address ?? loopbackAddress : address());
    draft = {
      text, cursor: text.length, title: cliTr("证书主机名", "Certificate host"),
      hint: cliTr("浏览器使用的 IP 或 DNS 名。需 OpenSSL；请核验证书。",
        "Browser IP or DNS name. Requires OpenSSL. Verify the certificate."),
      submit(host) {
        runSetting(async () => {
          const path = await generateCertificate(settings, host, Number(env.OMO_WEB_PORT ?? "4317"));
          draft = undefined;
          return cliTr(`证书已生成：${path}`, `Certificate generated: ${path}`);
        });
      },
    };
    notice = "";
  }

  function editWorkspaces() {
    const text = configured() || cwd;
    draft = {
      text, cursor: text.length, title: cliTr("编辑目录", "Edit directories"),
      hint: cliTr(`用 "${delimiter}" 分隔路径，留空使用启动目录。`,
        `Separate paths with "${delimiter}". Empty uses the launch directory.`),
      submit: applyWorkspaces,
    };
    notice = "";
  }

  function applyWorkspaces(text) {
    const paths = text.split(delimiter).filter(Boolean).map(path => resolve(cwd, path));
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
  }

  function editKey(text, key) {
    if (!pasting && key.name === "escape") {
      draft = undefined;
      notice = "";
    } else if (!pasting && (key.name === "return" || key.name === "enter")) {
      draft.submit(draft.text);
    } else {
      const { text: value, cursor } = draft;
      const left = value.slice(0, cursor), right = value.slice(cursor);
      const previous = () => cursor - (glyphs(left).at(-1)?.length ?? 0);
      const next = () => cursor + (glyphs(right)[0]?.length ?? 0);
      if (!pasting && key.ctrl && key.name === "u") Object.assign(draft, { text: "", cursor: 0 });
      else if (!pasting && key.name === "left") draft.cursor = previous();
      else if (!pasting && key.name === "right") draft.cursor = next();
      else if (!pasting && key.name === "home") draft.cursor = 0;
      else if (!pasting && key.name === "end") draft.cursor = value.length;
      else if (!pasting && key.name === "backspace") {
        Object.assign(draft, { text: value.slice(0, previous()) + right, cursor: previous() });
      } else if (!pasting && key.name === "delete") draft.text = left + value.slice(next());
      else if (!key.ctrl && !key.meta && text && text === safeText(text) && value.length + text.length <= 8192) {
        Object.assign(draft, { text: left + text + right, cursor: cursor + text.length });
      } else return;
      notice = "";
    }
  }

  function requestStart() {
    if (settings.warning) {
      notice = settings.warning;
    } else if (settings.hasListenerOverride && isRemoteAddress(address()) && !hasHttps()) {
      notice = cliTr("非本机监听必须启用 HTTPS。请在访问设置中启用或生成证书。",
        "Remote listening requires HTTPS. Enable it or generate a certificate in Access settings.");
    } else if (unprotected() && !optedIn()) {
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
    startupWarning = "";
    redraw();
    const serverEnv = {
      ...env,
      ...(workspaces === undefined ? {} : { OMO_WEB_WORKSPACES: workspaces }),
      ...(confirmed ? { OMO_WEB_ALLOW_UNAUTHENTICATED: "1" } : {}),
    };
    const child = spawn("bun", ["--no-env-file", entry], {
      env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
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
      if ((phase === "starting" || phase === "ready") && line.startsWith(WARNING_PREFIX)) {
        startupWarning = safeText(stripVTControlCharacters(line.slice(WARNING_PREFIX.length))).trim();
        redraw();
      }
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
    else if (!saving) settle(code);
  }

  function onKey(text, key) {
    if (exitCode !== undefined || !key) return;
    if (key.ctrl && key.name === "c") return quit(130);
    if (saving) return;
    if (key.name === "paste-start" || key.name === "paste-end") {
      pasting = key.name === "paste-start";
      return;
    }
    if (draft) editKey(text, key);
    else if (pasting) return;
    else if (key.name === "escape" && phase === "confirming") backFromConfirmation();
    else if (key.name === "escape" && (phase === "settings" || phase === "networks")) go(phase === "settings" ? "idle" : "settings");
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
