import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const chromium = process.env.OMO_HANDOFF_CHROMIUM;
const evidence = process.env.OMO_HANDOFF_EVIDENCE;
const historyId = "a".repeat(64);
const bookmarkId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const cwd = "/tmp/omo-synthetic/workspace";
const command = `cd '${cwd}' && omo --session '/tmp/omo-synthetic/<session-with-a-long-path-${"a".repeat(90)}>.jsonl'`;
const row = { id: bookmarkId, name: "合成同一会话", cwd, updatedAt: 2, archived: false, settled: false, active: true, running: false };
const other = { ...row, id: otherId, name: "另一个 Web 会话", updatedAt: 1 };
const record = { id: historyId, name: row.name, cwd, updatedAt: 2, adopted: true };
const historyMessage = { role: "user", content: "CLI 历史中的合成消息", timestamp: 2 };
const held = { code: "session_held", error: "会话正在另一端打开，请关闭 CLI 后再试。" };
const busy = { code: "session_busy", error: "会话正在运行，请等待当前回合结束后再交接。" };
const unsupported = { supported: false, reason: "shared_transport" };
const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

async function fixture(supported = true) {
  const build = await Bun.build({ entrypoints: [fromRoot("src/web/app.ts")], target: "browser" });
  const [script] = build.outputs;
  if (!build.success || !script) throw new Error("Unable to bundle the workbench", { cause: build.logs });
  const assets = new Map([["/", "index.html"], ["/styles.css", "styles.css"], ["/workbench.css", "workbench.css"], ["/favicon.svg", "favicon.svg"]]);
  const posted: Array<{ path: string; body: unknown }> = [];
  const events = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const frame = (value: object) => new TextEncoder().encode(`event: omo\ndata: ${JSON.stringify(value)}\n\n`);
  const publish = () => { for (const stream of events) stream.enqueue(frame({ type: "sessions" })); };
  let active = false;
  let published = false;
  let resumed = false;
  const support = supported ? { supported: true } : unsupported;
  const gates: { history?: () => Promise<void>; release?: () => Promise<void>; held: boolean; busy: boolean;
    unadopted: boolean } = { held: false, busy: false, unadopted: false };
  const sessions = () => ({ sessions: published ? [{ ...row, active }, other] : [other] });
  const snapshot = (session: typeof row) => Response.json({ session, state: { isStreaming: false, pendingDialogs: [], pendingQuestions: [] },
    messages: session.id === row.id ? [historyMessage, ...(resumed ? [{ ...historyMessage, content: "CLI 退出后保存的新消息" }] : [])] : [],
    handoff: supported ? { eligible: true } : { eligible: false, reason: unsupported.reason } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, listener) {
    listener.timeout(request, 0);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      if (request.headers.get("X-OmO-Token") !== "synthetic-token") return Response.json({ code: "token_refused", error: "令牌错误" }, { status: 403 });
      const body: unknown = await request.json();
      posted.push({ path, body });
      if (path === `/api/cli-history/${historyId}/resume`) {
        if (gates.held) return Response.json(held, { status: 409 });
        await gates.history?.();
        active = published = true;
        publish();
        return Response.json({ session: row });
      }
      if (path === `/api/sessions/${bookmarkId}/handoff`) {
        if (gates.busy) return Response.json(busy, { status: 409 });
        const reply = gates.release?.();
        active = false;
        publish(); // S can report the inactive bookmark before the HTTP receipt arrives.
        await reply;
        return Response.json({ session: { ...row, active: false }, command });
      }
      if (path === `/api/sessions/${bookmarkId}/actions` && JSON.stringify(body) === '{"action":"resume"}') {
        if (gates.held) return Response.json(held, { status: 409 });
        active = resumed = true;
        publish();
        return Response.json({ result: {}, session: row });
      }
    }
    if (path === "/api/bootstrap") return Response.json({ ...sessions(), engine: { online: true }, token: "synthetic-token", workspaces: [cwd], handoff: support });
    if (path === "/api/events") {
      let client: ReadableStreamDefaultController<Uint8Array> | undefined;
      return new Response(new ReadableStream({
        start(stream) { client = stream; events.add(stream); stream.enqueue(frame({ type: "ready", engine: { online: true } })); },
        cancel() { if (client) events.delete(client); },
      }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    }
    if (path === "/api/sessions") return Response.json(sessions());
    if (path === `/api/sessions/${bookmarkId}`) return active ? snapshot(row) : Response.json({
      code: "session_not_open", error: "会话未接入引擎，请先恢复会话。",
    }, { status: 409 });
    if (path === `/api/sessions/${otherId}`) return snapshot(other);
    if (path.startsWith("/api/sessions/") && path.endsWith("/options")) return Response.json({ models: [], levels: [], commands: [] });
    if (path === "/api/cli-history") return Response.json({ available: true, sessions: [{ ...record, adopted: !gates.unadopted }] });
    if (path === `/api/cli-history/${historyId}`) return Response.json({ session: { ...record, adopted: !gates.unadopted }, messages: [historyMessage] });
    if (path === `/api/cli-history/${historyId}/activity`) return Response.json({ status: "unavailable", reason: "no-agent-dir" });
    if (path === "/api/cli-live") return Response.json({ available: false, sessions: [] });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    const asset = assets.get(path);
    return asset ? new Response(Bun.file(fromRoot(`public/${asset}`))) : new Response(null, { status: 404 });
  } });
  return { url: server.url.href, gates, posted, close: () => server.stop(true) };
}

function page(view: Bun.WebView, width: number) {
  const visible = (selector: string, text = "") => view.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      watcher.disconnect();
      const shown = [...document.querySelectorAll("[role=alert]:not([hidden])")].filter(node => node.getClientRects().length);
      reject(new Error("Missing visible " + ${JSON.stringify(selector)} + " — " +
        [document.querySelector("#session-title").textContent, ...shown.map(node => node.textContent)].join(" / ")));
    }, 3500);
    function inspect() {
      for (const node of document.querySelectorAll(${JSON.stringify(selector)})) {
        if (node.getClientRects().length && node.textContent.includes(${JSON.stringify(text)})) {
          clearTimeout(timeout); watcher.disconnect(); resolve(node.textContent); return;
        }
      }
    }
    const watcher = new MutationObserver(inspect);
    watcher.observe(document, { childList: true, subtree: true, attributes: true, characterData: true }); inspect();
  })`);
  const click = async (selector: string) => { await visible(selector); await view.click(selector); };
  const nav = async () => { if (width < 761) await click("#open-navigation"); };
  return {
    visible, click,
    async history() { await nav(); await click("#cli-history-button"); await visible("#cli-history-list button", "已在 Web 打开"); await click("#cli-history-list button"); await visible("#cli-history-messages article", historyMessage.content); },
    async select(id: string) { await nav(); await click(`#session-list button[data-session="${id}"]`); },
    async check(name: string) {
      expect(await view.evaluate("innerWidth")).toBe(width);
      expect(await view.evaluate(`(() => {
        const modal = document.querySelector("dialog[open]");
        return [document.documentElement.scrollWidth - innerWidth, modal ? modal.scrollWidth - modal.clientWidth : 0];
      })()`)).toEqual([0, 0]);
      if (!evidence) return;
      await mkdir(evidence, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await view.evaluate(`(async () => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
        })()`);
        await Bun.write(`${evidence}/${name}-${width}-${theme}.png`, await view.screenshot());
      }
    },
  };
}

for (const width of [1440, 390]) {
  test.skipIf(!chromium)(`handoff UI uses the same bookmark and preserves an image draft at ${width}px`, async () => {
    if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
    const f = await fixture();
    try {
      using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width, height: 900 });
      const p = page(view, width);
      await view.navigate(f.url);
      await p.history();
      await p.visible("#cli-history-resume:not(:disabled)", "在 Web 继续");
      await p.visible("#cli-history-branch:not(:disabled)", "分支 / 复制");
      await p.check("history");
      f.gates.held = true;
      await p.click("#cli-history-resume");
      await p.visible("#cli-history-resume-error", held.error);
      f.gates.held = false;
      const slowHistory = Promise.withResolvers<void>();
      const historyStarted = Promise.withResolvers<void>();
      f.gates.history = () => { historyStarted.resolve(); return slowHistory.promise; };
      await p.click("#cli-history-resume:not(:disabled)");
      await p.visible("#cli-history-resume:disabled");
      await historyStarted.promise;
      await p.click("#cli-history-dialog [data-close]");
      await p.select(otherId);
      slowHistory.resolve();
      await p.visible("#session-title", other.name);
      await p.select(bookmarkId);
      await p.visible("#messages article", historyMessage.content);
      await p.history();
      await p.click("#cli-history-resume:not(:disabled)");
      await p.visible("#composer-shell #prompt:focus");
      expect(await view.evaluate('document.querySelector("#session-list button[aria-current=true]").dataset.session')).toBe(bookmarkId);
      expect(await view.evaluate("document.activeElement.id")).toBe("prompt");
      await view.evaluate(`(() => {
        const prompt = document.querySelector("#prompt");
        prompt.value = "未发送的合成草稿";
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        const files = new DataTransfer();
        files.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII="), c => c.charCodeAt(0))], "draft.png", { type: "image/png" }));
        prompt.dispatchEvent(new ClipboardEvent("paste", { clipboardData: files }));
      })()`);
      await p.visible('#attachments img[alt="draft.png"]');
      await p.click("#manage-button");
      await p.check("manage");
      f.gates.busy = true;
      await p.click("#manage-handoff");
      await p.visible("#manage-handoff-error", busy.error);
      f.gates.busy = false;
      const slowRelease = Promise.withResolvers<void>();
      f.gates.release = () => slowRelease.promise;
      await p.click("#manage-handoff:not(:disabled)");
      await p.visible("#manage-handoff:disabled");
      await p.visible("#manage-handoff-status", "正在");
      expect(await view.evaluate('document.querySelector("#send").disabled')).toBe(true);
      await p.check("pending");
      if (width === 1440) {
        await p.click("#manage-dialog [data-close]");
        await p.select(otherId);
        await p.click("#cli-live-button");
        await p.visible("#cli-live-title", "CLI 实时");
        slowRelease.resolve();
        await p.visible(`#session-list button[data-session="${bookmarkId}"] small`, "已释放");
        expect(await view.evaluate(`({
          title: document.querySelector("#session-title").textContent,
          modal: [...document.querySelectorAll("dialog[open]")].map(item => item.id),
          receiptHidden: document.querySelector("#handoff-receipt").hidden,
        })`)).toEqual({ title: other.name, modal: ["cli-live-dialog"], receiptHidden: true });
        await p.click("#cli-live-close");
        await p.select(bookmarkId);
      } else {
        slowRelease.resolve();
      }
      await p.visible("#handoff-command code", command);
      expect(await view.evaluate(`({
        focus: document.activeElement.id, modals: document.querySelectorAll("dialog[open]").length,
        hidden: document.querySelector("#composer-shell").hidden, markup: document.querySelector("#handoff-command code").children.length,
      })`)).toEqual({ focus: "handoff-title", modals: 0, hidden: true, markup: 0 });
      await p.check("receipt");
      await view.evaluate(`Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async text => { window.copiedText = text; } })`);
      await p.click("#handoff-copy");
      await p.visible("#handoff-copy-status", "已复制");
      expect(await view.evaluate("window.copiedText")).toBe(command);
      await p.select(otherId);
      await p.visible("#session-title", other.name);
      await p.select(bookmarkId);
      await p.visible("#handoff-command code", command);
      f.gates.held = true;
      await p.click("#resume:not(:disabled)");
      await p.visible("#session-error", held.error);
      f.gates.held = false;
      await p.click("#resume:not(:disabled)");
      await p.visible("#messages article", "CLI 退出后保存的新消息");
      expect(await view.evaluate('document.querySelector("#prompt").value')).toBe("未发送的合成草稿");
      await p.visible('#attachments img[alt="draft.png"]');
      await p.check("restored");
      expect(f.posted.map(({ path, body }) => [path, body])).toEqual([
        ...Array.from({ length: 3 }, () => [`/api/cli-history/${historyId}/resume`, {}]),
        ...Array.from({ length: 2 }, () => [`/api/sessions/${bookmarkId}/handoff`, {}]),
        ...Array.from({ length: 2 }, () => [`/api/sessions/${bookmarkId}/actions`, { action: "resume" }]),
      ]);
    } finally { f.close(); }
  }, 25000);
}

test.skipIf(!chromium)("an older host leaves history readable and handoff unavailable", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture(false);
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440 });
    const p = page(view, 1440);
    await view.navigate(f.url);
    await p.history();
    await p.visible("#cli-history-resume:disabled", "在 Web 继续");
    await p.visible("#cli-history-resume-status", "私有本机传输");
    await p.click("#cli-history-dialog [data-close]");
    await p.select(otherId);
    await p.click("#manage-button");
    await p.visible("#manage-handoff:disabled", "转到 CLI");
    await p.visible("#manage-handoff-status", "私有本机传输");
    expect(f.posted).toEqual([]);
  } finally { f.close(); }
});

test.skipIf(!chromium)("fresh page discovers unadopted CLI sessions in the sidebar", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  f.gates.unadopted = true;
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440 });
    const p = page(view, 1440);
    await view.navigate(f.url);
    // No dialog is opened: the ordinary sidebar itself lists the CLI journal.
    await p.visible("#cli-sessions:not([hidden])");
    await p.visible("#cli-session-list button", record.name);
    // Previewing from the sidebar reads the record without seizing the holder.
    await p.click("#cli-session-list button");
    await p.visible("#cli-history-messages article", historyMessage.content);
    await p.visible("#cli-history-activity section h3");
    expect(await view.evaluate(`Array.from(document.querySelectorAll("#runtime-shortcuts [role=tab]"), tab => {
      const id = tab.getAttribute("aria-controls");
      return Array.from(document.querySelectorAll("#" + CSS.escape(id))).map(panel => panel.getAttribute("role"));
    })`)).toEqual([["tabpanel"], ["tabpanel"], ["tabpanel"], ["tabpanel"]]);
    expect(f.posted).toEqual([]);
  } finally { f.close(); }
}, 25000);
