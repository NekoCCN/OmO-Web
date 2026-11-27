import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const node = Bun.which("node");
const supported = process.platform !== "win32" && typeof Bun.Terminal === "function" && Boolean(node);
const evidence = process.env.OMO_TUI_EVIDENCE;
const launcher = new URL("../packaging/npm/tui.js", import.meta.url).href;

async function terminalFixture(
  cols: number, rows: number, color: boolean,
  verify: (view: {
    readonly workspace: string;
    readonly second: string;
    readonly keys: (text: string) => void;
    readonly resize: (cols: number, rows: number) => void;
    readonly mark: () => number;
    readonly after: (pattern: RegExp, mark?: number, raw?: boolean) => Promise<RegExpMatchArray>;
    readonly raw: () => string;
    readonly capture: (name: string) => Promise<void>;
    readonly exited: Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  if (!node) throw new Error("Node is required to run the launcher.");
  const root = await mkdtemp(join(tmpdir(), "omo-web-tui-test-"));
  const workspace = join(root, "alpha");
  const second = join(root, "beta-第二项目");
  const entry = join(root, "server.ts");
  const decoder = new TextDecoder();
  let stream = "";
  const listeners = new Set<() => void>();
  try {
    await Promise.all([mkdir(workspace), mkdir(second)]);
    await Bun.write(entry, `
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch: () => Response.json({ cwd: process.cwd(), directories: process.env.OMO_WEB_WORKSPACES }),
      });
      console.log("OmO Web: " + server.url.href);
      process.once("SIGTERM", () => server.stop(true));
      process.once("SIGINT", () => server.stop(true));
    `);
    await using pty = new Bun.Terminal({ cols, rows, name: "xterm-256color", data(_terminal, bytes) {
      stream += decoder.decode(bytes, { stream: true });
      for (const check of listeners) check();
    } });
    const proc = Bun.spawn([node, "--input-type=module", "-e",
      `import { startTui } from ${JSON.stringify(launcher)};
       process.exitCode = await startTui({ entry: ${JSON.stringify(entry)}, version: "0.1.0" });`,
    ], {
      cwd: workspace, terminal: pty, timeout: 15_000,
      env: {
        PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:${process.env.PATH ?? ""}`,
        HOME: root, TERM: "xterm-256color", OMO_WEB_PORT: "0",
        ...(color ? {} : { NO_COLOR: "1" }),
      },
    });
    try {
      await verify({
        workspace, second,
        keys: text => { pty.write(text); },
        resize: (width, height) => {
          pty.resize(width, height);
          // Bun.Terminal updates the window size but this fixture has no foreground process group.
          proc.kill("SIGWINCH");
        },
        mark: () => stream.length,
        raw: () => stream,
        async capture(name) { if (evidence) await Bun.write(join(evidence, `${name}.ansi`), stream); },
        exited: proc.exited,
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
