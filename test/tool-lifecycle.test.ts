import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./tool-lifecycle-engine-fixture.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function readUntil(reader: ReadableStreamDefaultReader<string>, marker: string, wire: { value: string }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!wire.value.includes(marker)) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`Timed out waiting for ${marker}:\n${wire.value}`);
    const tick = new Promise<"tick">(resolve => setTimeout(() => resolve("tick"), Math.min(remain, 500)));
    const chunk = await Promise.race([reader.read(), tick]);
    if (chunk === "tick") continue;
    if (chunk.done) throw new Error(`Stream closed before ${marker}:\n${wire.value}`);
    wire.value += chunk.value;
  }
}

describe("tool lifecycle bridge", () => {
  test("streams settle and input events the browser uses to stop spinning tools", { timeout: 20000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "omo-tool-lifecycle-"));
    const settings = {
      dataDir: join(directory, "data"),
      workspaces: [directory],
      engineCommand: [process.execPath, fixture] as const,
      port: 0,
    };
    const app = await startApp(settings);
    cleanups.push(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
    const origin = app.url.origin;
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
    const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token };
    const created = await fetch(`${origin}/api/sessions`, {
      method: "POST", headers, body: JSON.stringify({ cwd: directory, name: "Tool lifecycle" }),
    });
    expect(created.status).toBe(201);
    const id = String((await created.json()).session.id);
    const stream = await fetch(`${origin}/api/events`, { signal: AbortSignal.timeout(20_000) });
    const reader = stream.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new TypeError("SSE response has no body");
    const wire = { value: "" };
    try {
      const prompted = await fetch(`${origin}/api/sessions/${id}/actions`, {
        method: "POST", headers, body: JSON.stringify({ action: "prompt", message: "tool-lifecycle-approval please" }),
      });
      expect(prompted.status).toBe(200);
      await readUntil(reader, '"type":"extension_ui_request"', wire);
      const pending = await (await fetch(`${origin}/api/sessions/${id}`)).json();
      expect(pending.state.pendingDialogs.map((entry: { id: string }) => entry.id)).toEqual(["approval-1"]);
      const answered = await fetch(`${origin}/api/sessions/${id}/actions`, {
        method: "POST", headers,
        body: JSON.stringify({ action: "answer", requestId: "approval-1", value: "Deny" }),
      });
      expect(answered.status).toBe(200);
      await readUntil(reader, '"type":"agent_idle"', wire);
      await readUntil(reader, '"type":"pending_input_update"', wire);
      const frames = wire.value.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      const types = frames.map(frame => frame.type);
      for (const expected of ["tool_execution_start", "extension_ui_request", "extension_ui_resolved",
        "tool_execution_end", "agent_end", "agent_settled", "agent_idle", "pending_input_update"]) {
        expect(types).toContain(expected);
      }
      const end = frames.find(frame => frame.type === "tool_execution_end");
      expect(end).toMatchObject({ toolCallId: "call-approval-1", toolName: "write", isError: false });
      const settled = await (await fetch(`${origin}/api/sessions/${id}`)).json();
      expect(settled.state.pendingDialogs).toEqual([]);
      expect(settled.messages.some((message: { role: string; toolCallId?: string }) =>
        message.role === "toolResult" && message.toolCallId === "call-approval-1")).toBe(true);
    } finally {
      await reader.cancel();
    }
  });
});

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");

async function waitForView(browser: Bun.WebView, expression: string): Promise<void> {
  await browser.evaluate(`new Promise((resolve, reject) => {
    const check = () => {
      if (!(${expression})) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(${JSON.stringify("Browser condition not reached: ")} + ${JSON.stringify(expression)}));
    }, 5000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  })`);
}

browserTest("a snapshot racing live events still retires the settled approval", { timeout: 30000 }, async () => {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not bundle the workbench browser fixture");
  const session = { id: "tool-lifecycle-race", name: "Raced snapshot", cwd: "/fixture/workbench", active: true };
  let snapshots = 0;
  let release: (() => void) | undefined;
  const gated = () => new Promise<Response>(resolve => {
    release = () => resolve(Response.json({ session,
      messages: [{ role: "assistant", content: "Settled while racing." }], state: {} }));
  });
  let events: ReadableStreamDefaultController<string> | undefined;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true } }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { events = controller; controller.enqueue(": fixture\n\n"); },
        cancel() { events = undefined; },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`/api/sessions/${session.id}`]: () => {
        snapshots++;
        if (snapshots === 1) return Response.json({ session, messages: [], state: {} });
        return gated();
      },
      [`/api/sessions/${session.id}/options`]: Response.json({}),
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width: 1440, height: 900 });
  await browser.navigate(server.url.href);
  await waitForView(browser, `document.querySelector("#connection")?.dataset.state === "online"`);
  await browser.click(".session-link");
  await waitForView(browser, `!!document.querySelector("#active-session:not([hidden])")`);
  const emit = (event: unknown) => {
    if (!events) throw new Error("Synthetic event stream is not connected");
    events.enqueue(`event: omo\ndata: ${JSON.stringify({ ...(event as Record<string, unknown>), sessionId: session.id })}\n\n`);
  };
  emit({ type: "extension_ui_request", id: "approval-1", method: "select", title: "Synthetic approval",
    options: ["Allow once", "Deny"], toolCallId: "call-1" });
  await waitForView(browser, `!!document.querySelector(".request-form")`);
  emit({ type: "agent_end" });
  await new Promise(resolve => setTimeout(resolve, 350));
  emit({ type: "queue_update", steering: [], followUp: [] });
  await new Promise(resolve => setTimeout(resolve, 50));
  release?.();
  await waitForView(browser, `!document.querySelector(".request-form")`);
  const activity = await browser.evaluate(`document.querySelector("#activity")?.textContent ?? ""`);
  expect(activity).not.toContain("等待你的决定");
});
