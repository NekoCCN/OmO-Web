import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const chromium = process.env.OMO_HANDOFF_CHROMIUM;
const id = "11111111-1111-4111-8111-111111111111";
const session = { id, cwd: "/synthetic/workspace", name: "Paged fixture", updatedAt: 2, archived: false, active: true };
const path = `/api/sessions/${id}`;
const fromRoot = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const row = (id: string, text: string, cursor?: string) => ({
  id, role: "assistant", content: [{ type: "text", text }], ...(cursor ? { historyContent: { cursor } } : {}),
});
const initial = () => [row("first", "Current preview", "part + /?"), row("latest", "Latest record")];
const approval = { id: "approval", method: "confirm", title: "Synthetic approval", message: "Proceed?", toolCallId: "tool" };

async function fixture() {
  const build = await Bun.build({ entrypoints: [fromRoot("src/web/app.ts")], target: "browser" });
  const [script] = build.outputs;
  if (!build.success || !script) throw new Error("Couldn't bundle browser fixture");
  const enc = new TextEncoder();
  const ready = Promise.withResolvers<void>();
  let client: ReadableStreamDefaultController<Uint8Array> | undefined;
  const reads: string[] = [];
  const posts: string[] = [];
  const data = {
    page: { id: "generation-one", olderCursor: "older + /?" }, messages: initial(),
    state: { isStreaming: false, pendingDialogs: [approval], pendingQuestions: [] } as Record<string, unknown>,
  };
  const emit = (type: string, fields = {}) =>
    client?.enqueue(enc.encode(`event: omo\ndata: ${JSON.stringify({ type, sessionId: id, ...fields })}\n\n`));
  const held = Promise.withResolvers<void>();
  const heldRequested = Promise.withResolvers<void>();
  let oldReply: "normal" | "hold" | "foreign" | "expired" = "normal";
  let refuseState = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, listener) {
    const url = new URL(request.url);
    const target = url.pathname;
    if (request.method !== "GET") { posts.push(target); return new Response(null, { status: 405 }); }
    if (target === "/api/bootstrap") return Response.json({ token: "synthetic", sessions: [session],
      engine: { online: true }, workspaces: [session.cwd] });
    if (target === "/api/sessions") return Response.json({ sessions: [session] });
    if (target === "/api/events") {
      listener.timeout(request, 0);
      return new Response(new ReadableStream({ start(stream) {
        client = stream;
        stream.enqueue(enc.encode(": ready\n\n"));
        ready.resolve();
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (target === path) {
      reads.push("snapshot");
      return refuseState ? Response.json({ code: "snapshot_state_too_large", error: "Synthetic state refused" }, { status: 502 })
        : Response.json({ session, ...data });
    }
    if (target === `${path}/transcript`) {
      const cursor = url.searchParams.get("cursor");
      reads.push(`page:${cursor}`);
      if (oldReply === "hold") {
        heldRequested.resolve();
        await held.promise;
        return Response.json({ page: { id: "generation-one" }, messages: [row("stale", "DO NOT SHOW STALE")] });
      }
      if (oldReply === "foreign") return Response.json({ page: { id: "foreign" }, messages: [row("foreign", "DO NOT SHOW FOREIGN")] });
      if (oldReply === "expired") return Response.json({ code: "transcript_cursor_stale" }, { status: 409 });
      if (cursor === "older + /?") return Response.json({ page: { id: "generation-one", olderCursor: "earliest" },
        messages: [row("middle", "Middle record")] });
      if (cursor === "earliest") return Response.json({ page: { id: "generation-one" },
        messages: [row("earliest", "Earliest record")], transcript: { status: "truncated" } });
    }
    if (target === `${path}/transcript/content`) {
      const cursor = url.searchParams.get("cursor");
      reads.push(`content:${cursor}`);
      if (cursor === "part + /?") return Response.json({ text: "Current preview · First chunk α", nextCursor: "part-2" });
      if (cursor === "part-2") return Response.json({ text: " second chunk 🧪" });
    }
    if (target === `${path}/options`) return Response.json({ models: [], levels: [], commands: [] });
    if (target === `${path}/workbench-status`) return Response.json({ status: "unavailable" });
    if (target === "/api/cli-history" || target === "/api/cli-live") return Response.json({ available: false, sessions: [] });
    if (target === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    const asset = target === "/" ? "index.html" : target.slice(1);
    return /^[\w-]+\.(?:html|css|svg)$/u.test(asset)
      ? new Response(Bun.file(fromRoot(`public/${asset}`))) : new Response(null, { status: 404 });
  } });
  return {
    url: server.url.href, data, reads, posts, emit, ready: ready.promise, held, heldRequested: heldRequested.promise,
    older(value: typeof oldReply) { oldReply = value; },
    refuse(value: boolean) { refuseState = value; },
    close: () => server.stop(true),
  };
}

function visible(view: Bun.WebView, selector: string, text = "") {
  return view.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Missing visible " + ${JSON.stringify(selector)} + " — " + ${JSON.stringify(text)}));
    }, 2600);
    function check() {
      const match = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node =>
        node.getClientRects().length && node.textContent.includes(${JSON.stringify(text)}));
      if (match) { clearTimeout(timeout); observer.disconnect(); resolve(true); }
    }
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  })`);
}

const frames = (view: Bun.WebView) => view.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const older = "#messages > .transcript-load:not([hidden])";
const chunk = ".transcript-content button:not([hidden])";
const draft = "An unsent synthetic draft";

async function scrollClick(view: Bun.WebView, selector: string) {
  await view.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  await frames(view);
  expect(await view.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const box = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })()`)).toBe(true);
  await view.click(selector);
}

async function open(view: Bun.WebView, f: Awaited<ReturnType<typeof fixture>>, mobile = false) {
  await view.navigate(f.url);
  await f.ready;
  if (mobile) await view.click("#open-navigation");
  await visible(view, "#session-list button", session.name);
  await view.click(`#session-list button[data-session="${id}"]`);
  await visible(view, "#messages article", "Latest record");
  await view.evaluate(`(() => {
    const prompt = document.querySelector("#prompt");
    prompt.value = ${JSON.stringify(draft)};
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

test.skipIf(!chromium)("mobile transcript reads two older pages and two chunks only on explicit activation", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  try {
    f.data.messages = [...initial(), ...Array.from({ length: 10 }, (_, i) => row(`filler-${i}`, `Filler record ${i}`))];
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 390, height: 844 });
    await open(view, f, true);
    expect(f.reads).toEqual(["snapshot"]);
    expect(await view.evaluate('document.querySelector("#transcript-status").hidden')).toBe(true);
    await visible(view, older);
    await view.evaluate(`document.querySelector(${JSON.stringify(older)}).focus()`);
    const anchor = () => view.evaluate<number>(`[...document.querySelectorAll("#messages article")]
      .find(node => node.textContent.includes("Current preview")).getBoundingClientRect().top`);
    const before = await anchor();
    await view.press("Enter");
    await visible(view, "#messages article", "Middle record");
    await frames(view);
    expect(await view.evaluate(`document.activeElement.textContent.includes("Current preview")`)).toBe(true);
    expect(Math.abs(await anchor() - before)).toBeLessThanOrEqual(2);
    expect(f.reads).toEqual(["snapshot", "page:older + /?"]);
    await scrollClick(view, older);
    await visible(view, "#messages article", "Earliest record");
    await visible(view, "#transcript-status[data-status=truncated]");
    expect(await view.evaluate(`[...document.querySelectorAll("#messages .message-body")].map(node =>
      ["Earliest record", "Middle record", "Current preview", "Latest record"].find(text => node.textContent.includes(text))).filter(Boolean)`))
      .toEqual(["Earliest record", "Middle record", "Current preview", "Latest record"]);
    await scrollClick(view, chunk);
    await visible(view, ".transcript-content", "First chunk α");
    expect(f.reads).toEqual(["snapshot", "page:older + /?", "page:earliest", "content:part + /?"]);
    await scrollClick(view, chunk);
    await visible(view, ".transcript-content", "First chunk α second chunk 🧪");
    expect(await view.evaluate(`({
      focused: Boolean(document.activeElement.closest(".transcript-content")),
      width: document.documentElement.scrollWidth, viewport: innerWidth, draft: document.querySelector("#prompt").value,
      previewCopies: document.querySelector("#messages").innerText.split("Current preview").length - 1
    })`)).toEqual({ focused: true, width: 390, viewport: 390, draft, previewCopies: 1 });
    expect(f.reads).toEqual(["snapshot", "page:older + /?", "page:earliest", "content:part + /?", "content:part-2"]);
    expect(f.posts).toEqual([]);
  } finally { f.close(); }
});

test.skipIf(!chromium)("foreign and stale read receipts do not cross the current transcript authority", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1200, height: 840 });
    await open(view, f);
    await view.click(chunk);
    await visible(view, ".transcript-content", "First chunk α");
    f.older("foreign");
    await visible(view, older);
    await view.click(older);
    await visible(view, "#messages > .transcript-load[data-reload]");
    expect(f.reads).toEqual(["snapshot", "content:part + /?", "page:older + /?"]);
    expect(await view.evaluate('document.querySelector("#messages").textContent.includes("DO NOT SHOW FOREIGN")')).toBe(false);
    f.older("expired");
    await view.click("#messages > .transcript-load[data-reload]");
    await visible(view, `${older}:not([data-reload])`);
    expect(await view.evaluate('document.querySelector("#messages").textContent.includes("First chunk")')).toBe(false);
    await view.click(older);
    await visible(view, "#messages > .transcript-load[data-reload]");
    expect(f.reads).toEqual(["snapshot", "content:part + /?", "page:older + /?", "snapshot", "page:older + /?"]);
    f.older("hold");
    await view.click("#messages > .transcript-load[data-reload]");
    await visible(view, `${older}:not([data-reload])`);
    await view.click(older);
    await f.heldRequested;
    f.data.page = { id: "generation-two", olderCursor: "" };
    f.data.messages = [row("replacement", "Replacement record")];
    f.emit("session_replaced");
    await visible(view, "#messages article", "Replacement record");
    f.held.resolve();
    await frames(view);
    expect(await view.evaluate(`({
      stale: document.querySelector("#messages").textContent.includes("DO NOT SHOW STALE"),
      old: document.querySelector("#messages").textContent.includes("Current preview"),
      draft: document.querySelector("#prompt").value
    })`)).toEqual({ stale: false, old: false, draft });
    expect(f.posts).toEqual([]);
  } finally { f.held.resolve(); f.close(); }
});

test.skipIf(!chromium)("overflow defers transcript correction until settlement, but reads actionable state without replay", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1200, height: 840 });
    await open(view, f);
    await visible(view, "#interactions form", approval.title);
    f.emit("agent_start");
    f.emit("message_update", { message: row("live", "Stream text") });
    await visible(view, "#messages article", "Stream text");
    f.data.state = { isStreaming: true, permissionPreset: "auto" };
    f.data.messages = [row("premature", "DO NOT APPLY UNTIL SETTLED")];
    f.emit("transcript_refresh_required");
    f.emit("transcript_refresh_required");
    f.emit("state_refresh_required");
    await visible(view, '#approval[data-preset=auto]');
    expect(f.reads).toEqual(["snapshot", "snapshot"]);
    expect(await view.evaluate(`({
      stream: document.querySelector("#messages").textContent.includes("Stream text"),
      approval: document.querySelector("#interactions form").textContent.includes("Synthetic approval")
    })`)).toEqual({ stream: true, approval: true });
    f.refuse(true);
    f.emit("state_refresh_required");
    await visible(view, "#compose-error", "Synthetic state refused");
    await visible(view, "#interactions form", approval.title);
    f.refuse(false);
    f.data.state = { isStreaming: false, pendingDialogs: [], pendingQuestions: [] };
    f.data.messages = [...initial(), row("live", "Settled authoritative stream")];
    f.emit("agent_settled");
    await visible(view, "#messages article", "Settled authoritative stream");
    expect(await view.evaluate(`({
      count: [...document.querySelectorAll("#messages article")].filter(node => node.textContent.includes("Settled authoritative stream")).length,
      draft: document.querySelector("#prompt").value, pending: document.querySelectorAll("#interactions form").length
    })`)).toEqual({ count: 1, draft, pending: 0 });
    expect(f.reads).toEqual(["snapshot", "snapshot", "snapshot", "snapshot"]);
    expect(f.posts).toEqual([]);
  } finally { f.close(); }
});
