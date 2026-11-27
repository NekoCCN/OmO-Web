import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { readWindowsPasswordFile } from "../packaging/npm/windows-password.js";

const node = Bun.which("node");
const supported = process.platform !== "win32" && typeof Bun.Terminal === "function" && Boolean(node);
const evidence = process.env.OMO_TUI_EVIDENCE;
const launcher = new URL("../packaging/npm/tui.js", import.meta.url).href;
const cli = fileURLToPath(new URL("../packaging/npm/omo-web.js", import.meta.url));
const sourceServer = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function terminalFixture(
  cols: number, rows: number, color: boolean,
  verify: (view: {
    readonly workspace: string;
    readonly second: string;
    readonly keys: (text: string) => void;
    readonly restart: () => Promise<void>;
    readonly resize: (cols: number, rows: number) => void;
    readonly mark: () => number;
    readonly after: (pattern: RegExp, mark?: number, raw?: boolean) => Promise<RegExpMatchArray>;
    readonly raw: () => string;
    readonly capture: (name: string) => Promise<void>;
    readonly exited: Promise<number>;
    readonly launchLog: string;
  }) => Promise<void>,
  settings: { readonly env?: NodeJS.ProcessEnv; readonly failure?: string; readonly real?: boolean } = {},
): Promise<void> {
  if (!node) throw new Error("Node is required to run the launcher.");
  const root = await mkdtemp(join(tmpdir(), "omo-web-tui-test-"));
  const workspace = join(root, "alpha");
  const second = join(root, "beta-第二项目");
  const entry = join(root, "server.ts");
  const launchLog = join(root, "launches");
  const decoder = new TextDecoder();
  let stream = "";
  const listeners = new Set<() => void>();
  try {
    await Promise.all([mkdir(workspace), mkdir(second)]);
    await Bun.write(entry, `
      import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(launchLog)}, "launch\\n");
      ${settings.failure ?? ""}
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch: () => Response.json({
          cwd: process.cwd(), directories: process.env.OMO_WEB_WORKSPACES,
          allow: process.env.OMO_WEB_ALLOW_UNAUTHENTICATED,
          host: process.env.OMO_WEB_HOST, passwordFile: process.env.OMO_WEB_PASSWORD_FILE,
        }),
      });
      console.log("OmO Web: " + server.url.href);
      process.once("SIGTERM", () => server.stop(true));
      process.once("SIGINT", () => server.stop(true));
    `);
    await using pty = new Bun.Terminal({ cols, rows, name: "xterm-256color", data(_terminal, bytes) {
      stream += decoder.decode(bytes, { stream: true });
      for (const check of listeners) check();
    } });
    const installedCli = settings.real ? process.env.OMO_TUI_INSTALLED_CLI : undefined;
    const command = installedCli ? [node, installedCli, "tui"] : [node, "--input-type=module", "-e",
      `import { startTui } from ${JSON.stringify(launcher)};
       process.exitCode = await startTui({ entry: ${JSON.stringify(settings.real ? sourceServer : entry)}, version: "test" });`,
    ];
    const spawnLauncher = () => Bun.spawn(command, {
      cwd: workspace, terminal: pty, timeout: 25_000,
      env: {
        PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:${process.env.PATH ?? ""}`,
        HOME: root, TERM: "xterm-256color", OMO_WEB_PORT: "0", LANG: "en_US.UTF-8",
        ...(color ? {} : { NO_COLOR: "1" }),
        ...settings.env,
      },
    });
    let proc = spawnLauncher();
    try {
      await verify({
        workspace, second, launchLog,
        keys: text => { pty.write(text); },
        async restart() {
          if (await proc.exited !== 0) throw new Error("Launcher did not quit normally before restarting.");
          proc = spawnLauncher();
        },
        resize: (width, height) => {
          pty.resize(width, height);
          // Bun.Terminal updates the window size but this fixture has no foreground process group.
          proc.kill("SIGWINCH");
        },
        mark: () => stream.length,
        raw: () => stream,
        async capture(name) { if (evidence) await Bun.write(join(evidence, `${name}.ansi`), stream); },
        get exited() { return proc.exited; },
        after(pattern, mark = 0, raw = false) {
          return new Promise((resolve, reject) => {
            const check = () => {
              const text = stream.slice(mark);
              const match = (raw ? text : stripVTControlCharacters(text)).match(pattern);
              if (match) { clearTimeout(timeout); listeners.delete(check); resolve(match); }
            };
            const timeout = setTimeout(() => {
              listeners.delete(check);
              reject(new Error(`Missing ${pattern} in terminal:\n${stripVTControlCharacters(stream.slice(mark)).slice(-1000)}`));
            }, 2800);
            listeners.add(check);
            check();
          });
        },
      });
    } finally {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!supported)("The terminal launcher edits directories and starts and stops the selected Web service", async () => {
  await terminalFixture(84, 24, true, async view => {
    await view.after(/Start web/i);
    await view.capture("84-idle");
    let mark = view.mark();
    view.keys("\x1b[B\r");
    await view.after(/Edit directories/i, mark);
    await view.capture("84-editor");
    mark = view.mark();
    view.keys(`\x15${join(view.workspace, "missing-directory")}\r`);
    await view.after(/Not a directory/i, mark);
    mark = view.mark();
    view.keys(`\x15${view.second}\r`);
    await view.after(/Start web/i, mark);
    mark = view.mark();
    // Returning from the editor leaves the directory action selected; Up goes to Start.
    view.keys("\x1b[A\r");
    const match = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/i, mark);
    const url = match[1];
    if (!url) throw new Error("No Web listener URL in the terminal.");
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    expect(await response.json()).toEqual({ cwd: view.workspace, directories: view.second });
    await view.after(/Stop web/i, mark);
    await view.capture("84-running");
    mark = view.mark();
    view.keys("\x1b[B\r");
    await view.after(/Start web/i, mark);
    await expect(fetch(url, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    view.keys("q");
    expect(await view.exited).toBe(0);
    await view.after(/\x1b\[\?1049l/u, 0, true);
  });
}, 18000);

test.skipIf(!supported)("A narrow no-color terminal remains usable after resize and restores the screen on Ctrl+C", async () => {
  await terminalFixture(52, 18, false, async view => {
    await view.after(/Start web/i);
    expect(view.raw()).not.toMatch(/\x1b\[[0-9;]*m/u);
    await view.capture("52-idle");
    const mark = view.mark();
    view.resize(44, 14);
    await view.after(/Start web/i, mark);
    await view.capture("44-idle");
    view.keys("\r");
    const [, url] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/i, mark);
    if (!url) throw new Error("No Web listener URL in the narrow terminal.");
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(200);
    view.keys("\x03");
    expect([0, 130]).toContain(await view.exited);
    await expect(fetch(url, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    await view.after(/\x1b\[\?1049l/u, 0, true);
  });
}, 15000);

test.skipIf(!supported)("A Chinese PTY defaults the remote risk confirmation to Back without launching", async () => {
  await terminalFixture(44, 14, false, async view => {
    await view.after(/启动服务/u);
    let mark = view.mark();
    view.keys("\r");
    await view.after(/> 返回/u, mark);
    const prompt = stripVTControlCharacters(view.raw().slice(mark)).replace(/\s+/gu, "");
    expect(prompt).toContain("0.0.0.0");
    expect(prompt).toMatch(/无密码.*工作目录/u);
    mark = view.mark();
    view.keys("\r");
    await view.after(/> 启动服务/u, mark);
    mark = view.mark();
    view.keys("\r");
    await view.after(/> 返回/u, mark);
    mark = view.mark();
    view.keys("\x1b");
    await view.after(/> 启动服务/u, mark);
    view.keys("q");
    expect(await view.exited).toBe(0);
    await expect(stat(view.launchLog)).rejects.toHaveProperty("code", "ENOENT");
  }, { env: { LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "en_US.UTF-8", OMO_WEB_HOST: "0.0.0.0" } });
});

test.skipIf(!supported)("Password changes and its toggle control real HTTP authorization without echoing the secret", async () => {
  const password = "terminal fixture secret 42";
  const replacement = "terminal rotated secret 79";
  await terminalFixture(84, 24, false, async view => {
    await view.after(/> Start web/u);
    let mark = view.mark();
    view.keys("\x1b[B\x1b[B\r");
    await view.after(/> Listen address/u, mark);
    await view.capture("84-settings");
    mark = view.mark();
    view.keys("\x1b[B\x1b[B\r");
    await view.after(/New password/u, mark);
    view.keys(password);
    await view.after(/\*{20}/u, mark);
    await view.capture("84-password");
    mark = view.mark();
    view.keys("\r");
    await view.after(/Password: On/u, mark);
    async function startHttp() {
      const returning = view.mark();
      view.keys("\x1b");
      await view.after(/> Start web/u, returning);
      const starting = view.mark();
      view.keys("\r");
      const [, url] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/u, starting);
      if (!url) throw new Error("Missing HTTP listener.");
      return (secret?: string) => fetch(url, {
        signal: AbortSignal.timeout(2500),
        headers: secret === undefined ? {} : { Authorization: `Basic ${Buffer.from(`omo:${secret}`).toString("base64")}` },
      });
    }
    async function stopHttp() {
      const stopping = view.mark();
      view.keys("\x1b[B\r");
      await view.after(/> Start web/u, stopping);
      view.keys("\x1b[B\x1b[B\r");
      await view.after(/> Listen address/u, stopping);
    }
    const first = await startHttp();
    expect((await first()).status).toBe(401);
    expect((await first(password)).status).toBe(200);
    await stopHttp();

    mark = view.mark();
    view.keys("\x1b[B\x1b[B\r");
    await view.after(/New password/u, mark);
    mark = view.mark();
    view.keys(`${replacement}\r`);
    await view.after(/Password: On/u, mark);
    const rotated = await startHttp();
    expect((await rotated(password)).status).toBe(401);
    expect((await rotated(replacement)).status).toBe(200);
    await stopHttp();

    mark = view.mark();
    view.keys("\x1b[B\r");
    await view.after(/Password: Off/u, mark);
    expect((await (await startHttp())()).status).toBe(200);
    await stopHttp();
    mark = view.mark();
    view.keys("\x1b[B\r");
    await view.after(/Password: On/u, mark);
    const enabled = await startHttp();
    expect((await enabled()).status).toBe(401);
    expect((await enabled(replacement)).status).toBe(200);
    view.keys("q");
    mark = view.mark();
    await view.restart();
    await view.after(/> Start web/u, mark);
    mark = view.mark();
    view.keys("\r");
    const [, restarted] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/u, mark);
    if (!restarted) throw new Error("Missing listener after restarting the launcher.");
    expect((await fetch(restarted, { signal: AbortSignal.timeout(2000) })).status).toBe(401);
    expect((await fetch(restarted, { signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Basic ${Buffer.from(`omo:${replacement}`).toString("base64")}` } })).status).toBe(200);
    expect(view.raw()).not.toContain(password);
    expect(view.raw()).not.toContain(replacement);
    view.keys("q");
    expect(await view.exited).toBe(0);
  }, { real: true });
}, 27_000);

test.skipIf(!supported || process.env.OMO_WEB_TEST_TLS !== "1")(
  "TUI generates trusted HTTPS, binds only the chosen IPv4, and confirms unauthenticated wildcard access", async () => {
    const lan = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
      .find(address => address.family === "IPv4" && !address.internal);
    const address = lan?.address ?? "127.0.0.1";
    const reservation = Bun.serve({ hostname: address, port: 0, fetch: () => new Response() });
    const port = reservation.port;
    await reservation.stop(true);
    if (!port) throw new Error("Missing test listener port.");
    const origin = `https://${address}:${port}`;
    await terminalFixture(90, 25, false, async view => {
      await view.after(/> Start web/u);
      let mark = view.mark();
      view.keys("\x1b[B\x1b[B\r");
      await view.after(/> Listen address/u, mark);
      mark = view.mark();
      view.keys("\r");
      await view.after(/All IPv4 interfaces/u, mark);
      await view.capture("90-listen");
      if (lan) {
        const index = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
          .filter(entry => entry.family === "IPv4" && !entry.internal)
          .findIndex(entry => entry.address === address);
        mark = view.mark();
        view.keys(`${"\x1b[B".repeat(index + 2)}\r`);
        await view.after(new RegExp(`> Listen address: ${address.replaceAll(".", "\\.")}`, "u"), mark);
      } else view.keys("\r");
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\x1b[B\x1b[B\r");
      await view.after(/Certificate host/u, mark);
      await view.capture("90-certificate");
      mark = view.mark();
      view.keys(`\x15${address}\r`);
      await view.after(/HTTPS: On/u, mark);
      const certDir = join(view.workspace, "data", "launcher");
      const pem = await Array.fromAsync(new Bun.Glob("tls-*/cert.pem").scan({ cwd: certDir }));
      expect(pem).toHaveLength(1);
      const [certificate] = pem;
      if (!certificate) throw new Error("Missing generated certificate.");
      const ca = await readFile(join(certDir, certificate));
      const get = (hostname: string) => new Promise<number | undefined>((resolve, reject) => {
        const req = httpsRequest(origin, { hostname, ca, headers: { Host: new URL(origin).host },
          checkServerIdentity: (_name, cert) => checkServerIdentity(address, cert),
          agent: false, signal: AbortSignal.timeout(1800) }, response => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        req.once("error", reject);
        req.end();
      });
      mark = view.mark();
      view.keys("\x1b");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\r");
      if (lan) {
        await view.after(/> Back/u, mark);
        mark = view.mark();
        view.keys("\x1b[B\r");
      }
      await view.after(new RegExp(origin.replaceAll(".", "\\."), "u"), mark);
      expect(await get(address)).toBe(200);
      if (lan) await expect(get("127.0.0.1")).rejects.toHaveProperty("code", "ECONNREFUSED");

      mark = view.mark();
      view.keys("\x1b[B\r");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\r\r");
      await view.after(/All IPv4 interfaces/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\r");
      await view.after(/> Listen address: 0\.0\.0\.0/u, mark);
      mark = view.mark();
      view.keys("\x1b");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\r");
      await view.after(/> Back/u, mark);
      await view.capture("90-confirm");
      await expect(get(address)).rejects.toHaveProperty("code", "ECONNREFUSED");
      mark = view.mark();
      view.keys("\x1b[B\r");
      await view.after(new RegExp(origin.replaceAll(".", "\\."), "u"), mark);
      if (lan) expect(await get(address)).toBe(200);
      // Connect via loopback while preserving the certificate name and exact HTTP authority.
      expect(await get("127.0.0.1")).toBe(200);
      mark = view.mark();
      view.keys("\x1b[B\r");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\r\r");
      await view.after(/All IPv4 interfaces/u, mark);
      mark = view.mark();
      view.keys("\r");
      await view.after(/> Listen address: 127\.0\.0\.1/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\x1b[B\r");
      await view.after(/HTTPS: Off/u, mark);
      mark = view.mark();
      view.keys("\x1b");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\r");
      const [, plain] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/u, mark);
      if (!plain) throw new Error("Missing plaintext listener after disabling HTTPS on loopback.");
      expect((await fetch(plain, { signal: AbortSignal.timeout(2000) })).status).toBe(200);
      await expect(get("127.0.0.1")).rejects.toThrow();
      mark = view.mark();
      view.keys("\x1b[B\r");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\r");
      await view.after(/> Listen address/u, mark);
      mark = view.mark();
      view.keys("\x1b[B\x1b[B\x1b[B\r");
      await view.after(/HTTPS: On/u, mark);
      mark = view.mark();
      view.keys("\x1b");
      await view.after(/> Start web/u, mark);
      mark = view.mark();
      view.keys("\r");
      await view.after(new RegExp(origin.replaceAll(".", "\\."), "u"), mark);
      expect(await get("127.0.0.1")).toBe(200);
      view.keys("q");
      expect(await view.exited).toBe(0);
    }, { real: true, env: { OMO_WEB_PORT: String(port), OMO_WEB_DATA: "data" } });
  }, 28_000);

test.skipIf(!supported)("Confirming starts exactly one unprotected child and asks again after Stop", async () => {
  await terminalFixture(84, 24, false, async view => {
    await view.after(/> Start web/i);
    let mark = view.mark();
    view.keys("\r");
    await view.after(/> Back/i, mark);
    mark = view.mark();
    view.keys("\x1b[B\r");
    const [, url] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/i, mark);
    if (!url) throw new Error("No Web listener URL after confirmation.");
    expect(await (await fetch(url, { signal: AbortSignal.timeout(1500) })).json())
      .toEqual({ cwd: view.workspace, host: "0.0.0.0", allow: "1" });
    const ready = stripVTControlCharacters(view.raw().slice(mark));
    expect(ready).toMatch(/Listening/);
    expect(ready).toMatch(/No password protection/);
    mark = view.mark();
    view.keys("\x1b[B\r");
    await view.after(/Stopped.*> Start web/is, mark);
    mark = view.mark();
    view.keys("\r");
    await view.after(/> Back/i, mark);
    view.keys("q");
    expect(await view.exited).toBe(0);
    expect(await readFile(view.launchLog, "utf8")).toBe("launch\n");
  }, { env: { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ALLOW_UNAUTHENTICATED: "0" } });
});

for (const remote of [
  { label: "an explicit opt-in", allow: "1", passwordFile: undefined, warn: true },
  { label: "a configured password, even with the opt-in", allow: "1", passwordFile: "private-password", warn: false },
  { label: "a configured password without the opt-in", allow: undefined, passwordFile: "private-password", warn: false },
]) {
  test.skipIf(!supported)(`Remote start with ${remote.label} skips confirmation`, async () => {
    await terminalFixture(84, 24, false, async view => {
      await view.after(/> Start web/i);
      const mark = view.mark();
      expect(view.raw().includes("No password protection")).toBe(remote.warn);
      view.keys("\r");
      const [, url] = await view.after(/(http:\/\/127\.0\.0\.1:\d+\/)/i, mark);
      if (!url) throw new Error("No Web listener URL for configured remote start.");
      expect(await (await fetch(url, { signal: AbortSignal.timeout(1500) })).json())
        .toEqual({ cwd: view.workspace, host: "0.0.0.0", allow: remote.allow, passwordFile: remote.passwordFile });
      expect(view.raw().slice(mark).includes("No password protection")).toBe(remote.warn);
      if (remote.warn) {
        const compact = view.mark();
        view.resize(44, 5);
        await view.after(/Listening[\s\S]*No password protection[\s\S]*> Open browser/u, compact);
      }
      view.keys("q");
      expect(await view.exited).toBe(0);
    }, { env: {
      OMO_WEB_HOST: "0.0.0.0",
      ...(remote.allow === undefined ? {} : { OMO_WEB_ALLOW_UNAUTHENTICATED: remote.allow }),
      ...(remote.passwordFile === undefined ? {} : { OMO_WEB_PASSWORD_FILE: remote.passwordFile }),
    } });
  });
}

test.skipIf(!supported)("The PTY displays only the first bounded, sanitized configuration receipt from stderr", async () => {
  await terminalFixture(84, 24, false, async view => {
    await view.after(/> Start web/i);
    const mark = view.mark();
    view.keys("\r");
    await view.after(/TLS setting is invalid/u, mark);
    const raw = view.raw().slice(mark);
    expect(raw).not.toMatch(/RAW_STDERR|FALSE_PREFIX|OVERSIZED|SECOND_RECEIPT|WRONG_STREAM|\x1b\[31m|\u202e/u);
    view.keys("q");
    expect(await view.exited).toBe(0);
  }, { failure: `
    console.log("OmO Web config: WRONG_STREAM");
    console.error("RAW_STDERR\\n OmO Web config: FALSE_PREFIX");
    console.error("OmO Web config: OVERSIZED" + "x".repeat(8192));
    process.stderr.write("OmO Web con");
    console.error("fig: TLS \\u001b[31msetting\\u001b[0m is invalid\\u202e");
    console.error("OmO Web config: SECOND_RECEIPT");
    process.exit(1);
  ` });
});

test.skipIf(!node)("CLI help respects locale precedence without translating commands", async () => {
  if (!node) throw new Error("Node is required to run the launcher.");
  for (const [settings, usage] of [
    [{ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "用法"],
    [{ LC_ALL: "fr_FR.UTF-8", LC_MESSAGES: "zh_CN.UTF-8" }, "Usage"],
  ] as const) {
    const child = Bun.spawn([node, cli, "--help"], {
      env: settings, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(stdout).toMatch(new RegExp(`^${usage}[:：] omo-web`, "u"));
    expect(stdout).toContain("omo-web password-file <path>");
    expect(stdout).toContain("OMO_WEB_ALLOW_UNAUTHENTICATED=1");
    expect(await new Response(child.stderr).text()).toBe("");
  }
});

test.skipIf(!node)("password-file creates private random files exclusively without printing their contents", async () => {
  if (!node) throw new Error("Node is required to run the launcher.");
  const root = await mkdtemp(join(tmpdir(), "omo-web-password-test-"));
  const create = async (path: string) => {
    const child = Bun.spawn([node, cli, "password-file", path], {
      env: { ...process.env, LC_ALL: "en_US.UTF-8" }, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 12_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    const first = await create("first password");
    expect(first.code).toBe(0);
    const one = await readFile(join(root, "first password"), "utf8");
    expect(one).toMatch(/^[!-~]{20,128}\n?$/u);
    if (process.platform === "win32") {
      expect((await readWindowsPasswordFile(join(root, "first password"))).toString("utf8")).toBe(one);
    } else {
      expect((await stat(join(root, "first password"))).mode & 0o777).toBe(0o600);
    }
    const second = await create("second");
    expect(second.code).toBe(0);
    const two = await readFile(join(root, "second"), "utf8");
    expect(two).not.toBe(one);
    const existing = await create("first password");
    expect(existing.code).not.toBe(0);
    expect(await readFile(join(root, "first password"), "utf8")).toBe(one);
    const attempts = [first, second, existing];
    if (process.platform !== "win32") {
      await symlink("not-created", join(root, "symlink"));
      const linked = await create("symlink");
      expect(linked.code).not.toBe(0);
      await expect(stat(join(root, "not-created"))).rejects.toHaveProperty("code", "ENOENT");
      attempts.push(linked);
    }
    for (const result of attempts) {
      expect(result.stdout + result.stderr).not.toContain(one.trim());
      expect(result.stdout + result.stderr).not.toContain(two.trim());
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
