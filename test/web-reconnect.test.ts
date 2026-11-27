import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const chromium = process.env.OMO_HANDOFF_CHROMIUM;
const transcriptEvidence = process.env.OMO_WEB_TRANSCRIPT_EVIDENCE;
const cwd = "/tmp/omo-synthetic/workspace";
const id = "11111111-1111-4111-8111-111111111111";
const session = { id, cwd, name: "Reconnect fixture", updatedAt: 2, archived: false, active: true, running: false };
const sessions = [session, { ...session, id: "22222222-2222-4222-8222-222222222222", name: "Other session", updatedAt: 1 }];
const draft = "Unsent synthetic draft";
const fromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

async function fixture(holdSnapshot?: (sessionId: string, message: string) => Promise<void>) {
  const build = await Bun.build({ entrypoints: [fromRoot("src/web/app.ts")], target: "browser" });
  const [script] = build.outputs;
  if (!build.success || !script) throw new Error("Unable to bundle the workbench", { cause: build.logs });
  const encoder = new TextEncoder();
  const frame = (value: object) => encoder.encode(`event: omo\ndata: ${JSON.stringify(value)}\n\n`);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const replies: number[] = [];
  const posted: string[] = [];
  const reads: { bootstrap: number; sessions: number; snapshots: number[]; ready: boolean[] } =
    { bootstrap: 0, sessions: 0, snapshots: [], ready: [] };
  const snapshotTimes: number[] = [];
  let engine = { online: true, error: "" };
  let message = "Initial authoritative snapshot";
  let transcript: "truncated" | "unavailable" | undefined;
  let permissionPreset = "ask";
  let rejectNextStream = false;
  let rejectNextSnapshot = false;
  let holdBootstrap: Promise<void> | undefined;
  let onSessionsRead: (() => void) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, listener) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      posted.push(path);
      return new Response(null, { status: 405 });
    }
    if (path === "/api/bootstrap") {
      reads.bootstrap++;
      await holdBootstrap;
      const rows = holdSnapshot ? [{ ...session, name: message }, sessions[1]] : sessions;
      return Response.json({ sessions: rows, engine, token: "synthetic-token", workspaces: [cwd] });
    }
    if (path === "/api/events") {
      if (rejectNextStream) {
        rejectNextStream = false;
        replies.push(503);
        return new Response("Synthetic gateway unavailable", { status: 503 });
      }
      replies.push(200);
      listener.timeout(request, 0);
      let client: ReadableStreamDefaultController<Uint8Array> | undefined;
      return new Response(new ReadableStream({
        start(stream) {
          client = stream;
          streams.add(stream);
          stream.enqueue(encoder.encode("retry: 400\n\n"));
          reads.ready.push(engine.online);
          stream.enqueue(frame({ type: "ready", engine }));
        },
        cancel() { if (client) streams.delete(client); },
      }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (path === "/api/sessions") {
      reads.sessions++;
      onSessionsRead?.();
      onSessionsRead = undefined;
      return Response.json({ sessions });
    }
    const target = sessions.find(row => path === `/api/sessions/${row.id}`);
    if (target) {
      snapshotTimes.push(performance.now());
      if (rejectNextSnapshot) {
        rejectNextSnapshot = false;
        reads.snapshots.push(502);
        return new Response("Synthetic snapshot gateway unavailable", { status: 502 });
      }
      reads.snapshots.push(200);
      const content = target.id === id ? message : target.name;
      const status = target.id === id ? transcript : undefined;
      const selected = holdSnapshot && target.id === id ? { ...target, name: content } : target;
      await holdSnapshot?.(target.id, content);
      return Response.json({
        session: selected, state: { isStreaming: false, permissionPreset },
        messages: status === "unavailable" ? [] : [
          ...Array.from({ length: status === "truncated" ? 52 : 0 }, (_, i) =>
            ({ role: "user", content: `Synthetic recent row ${i + 1}`, timestamp: 100 + i })),
          { role: "assistant", content, timestamp: 2 },
        ],
        ...(status ? { transcript: { status } } : {}),
      });
    }
    if (sessions.some(row => path === `/api/sessions/${row.id}/options`)) return Response.json({ models: [], levels: [], commands: [] });
    if (path === "/api/cli-history" || path === "/api/cli-live") return Response.json({ available: false, sessions: [] });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    const asset = path === "/" ? "index.html" : path.slice(1);
    return /\.(?:html|css|svg)$/u.test(asset) && !asset.includes("/")
      ? new Response(Bun.file(fromRoot(`public/${asset}`))) : new Response(null, { status: 404 });
  } });
  return {
    url: server.url.href, replies, posted, reads, snapshotTimes, close: () => server.stop(true),
    setTranscript(status?: typeof transcript) { transcript = status; },
    setPermission(preset: string) { permissionPreset = preset; },
    emit(event: object) {
      for (const stream of streams) stream.enqueue(frame({ sessionId: id, ...event }));
    },
    nextSessionsRead() {
      const next = Promise.withResolvers<void>();
      onSessionsRead = next.resolve;
      return next.promise;
    },
    failNextSnapshot() { rejectNextSnapshot = true; },
    engineReadyDuringGap() {
      expect(streams.size).toBe(0);
      engine = { online: true, error: "" };
    },
    holdBootstrap(gate: Promise<void>) { holdBootstrap = gate; },
    disconnect(nextMessage: string, gatewayFailure = false) {
      expect(streams.size).toBe(1);
      message = nextMessage;
      rejectNextStream = gatewayFailure;
      for (const stream of streams) stream.close();
      streams.clear();
    },
    engineOffline() {
      engine = { online: false, error: "Synthetic native engine offline" };
      for (const stream of streams) stream.enqueue(frame({ type: "engine", engine }));
    },
  };
}

function visible(view: Bun.WebView, selector: string, text = "", timeoutMs = 3500) {
  return view.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      watcher.disconnect();
      reject(new Error("Missing visible " + ${JSON.stringify(selector)} + " — " + ${JSON.stringify(text)} +
        "; connection=" + document.querySelector("#connection").dataset.state));
    }, ${timeoutMs});
    function inspect() {
      for (const node of document.querySelectorAll(${JSON.stringify(selector)})) {
        if (node.getClientRects().length && node.textContent.includes(${JSON.stringify(text)})) {
          clearTimeout(timeout); watcher.disconnect(); resolve(node.textContent); return;
        }
      }
    }
    const watcher = new MutationObserver(inspect);
    watcher.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    inspect();
  })`);
}

test.skipIf(!chromium)("an open conversation recovers after one gateway rejection without replaying writes", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440, height: 900 });
    const online = '#connection[data-state="online"]';
    const offline = '#connection[data-state="offline"]';
    await view.navigate(f.url);
    await visible(view, online);
    await view.click(`#session-list button[data-session="${id}"]`);
    await visible(view, "#messages article", "Initial authoritative snapshot");
    await view.click("#prompt");
    await view.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = ${JSON.stringify(draft)};
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await visible(view, "#send:not(:disabled)");

    // A native reconnect can open the transport before application state is reconciled.
    for (const attempt of [1, 2]) {
      const gate = Promise.withResolvers<void>();
      f.holdBootstrap(gate.promise);
      const text = `Authoritative snapshot after EOF ${attempt}`;
      f.disconnect(text);
      try {
        await visible(view, offline);
        await visible(view, '#connection[data-state="connecting"]');
        await visible(view, "#send:disabled");
        expect(f.replies).toEqual(Array.from({ length: attempt + 1 }, () => 200));
      } finally { gate.resolve(); }
      await visible(view, "#messages article", text);
      await visible(view, online);
    }
    console.info(`EOF control: SSE HTTP ${f.replies.join(", ")}; send disabled during reconciliation`);

    const recovered = "Authoritative snapshot after gateway rejection";
    f.disconnect(recovered, true);
    await visible(view, offline);
    try {
      await visible(view, "#messages article", recovered, 6500);
    } finally {
      console.info(`Gateway phase: SSE HTTP ${f.replies.join(", ")}; POST ${f.posted.length}`);
    }
    await visible(view, online);
    expect(f.replies).toEqual([200, 200, 200, 503, 200]);

    f.engineOffline();
    await visible(view, "#banner-text", "Synthetic native engine offline");
    await visible(view, offline);
    await visible(view, "#send:disabled");
    expect(await view.evaluate(`({
      selection: [...document.querySelectorAll("#session-list button[aria-current=true]")].map(row => row.dataset.session),
      draft: document.querySelector("#prompt").value,
    })`)).toEqual({ selection: [id], draft });
    expect(f.posted).toEqual([]);
    console.info(`Engine phase: offline on an open SSE stream; POST ${f.posted.length}`);
  } finally { f.close(); }
}, 25000);

async function openWithDraft(view: Bun.WebView, url: string) {
  await view.navigate(url);
  await visible(view, '#connection[data-state="online"]');
  await view.click(`#session-list button[data-session="${id}"]`);
  await visible(view, "#messages article", "Initial authoritative snapshot");
  await view.click("#prompt");
  await view.evaluate(`(() => {
    const prompt = document.querySelector("#prompt");
    prompt.value = ${JSON.stringify(draft)};
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await visible(view, "#send:not(:disabled)");
}

async function expectUnsentDraft(view: Bun.WebView) {
  expect(await view.evaluate(`({
    selection: document.querySelector("#session-list button[aria-current=true]")?.dataset.session,
    draft: document.querySelector("#prompt").value,
  })`)).toEqual({ selection: id, draft });
}

async function expectReadArrival(arrived: Promise<void>, message: string) {
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(() => deadline.reject(new Error(message)), 4500);
  try { await Promise.race([arrived, deadline.promise]); }
  finally { clearTimeout(timer); }
}

test.skipIf(!chromium)("scopes incomplete transcript to the current binding without losing live content or draft", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const f = await fixture();
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440, height: 900 });
    f.setTranscript("unavailable");
    await view.navigate(f.url);
    await visible(view, '#connection[data-state="online"]');
    await view.click(`#session-list button[data-session="${id}"]`);
    await visible(view, '#transcript-status[data-status="unavailable"]');
    await visible(view, "#prompt:not(:disabled)");
    await view.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    expect(await view.evaluate('document.querySelector("#no-messages").getClientRects().length')).toBe(0);
    if (transcriptEvidence) {
      if (await view.evaluate('document.querySelector("#details-dialog").open')) await view.click("#details-button");
      await Bun.write(`${transcriptEvidence}/web-unavailable.png`, await view.screenshot());
    }
    await view.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = ${JSON.stringify(draft)};
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const liveText = "First live message after unreadable history";
    f.emit({ type: "message_end", message: { role: "assistant", timestamp: 3, content: liveText } });
    await visible(view, "#messages article", liveText);
    // A settled refresh still has no history; an event observed on this binding survives it.
    f.setPermission("full-access");
    f.emit({ type: "agent_settled" });
    await visible(view, '#approval[data-preset="full-access"]');
    await visible(view, "#messages article", liveText);
    f.emit({ type: "session_replaced" });
    await view.evaluate(`new Promise(resolve => {
      const read = () => {
        if (document.querySelector("#messages").textContent.includes(${JSON.stringify(liveText)})) return;
        observer.disconnect(); resolve(true);
      };
      const observer = new MutationObserver(read);
      observer.observe(document.querySelector("#messages"), { childList: true, subtree: true, characterData: true }); read();
    })`);
    await visible(view, '#transcript-status[data-status="unavailable"]');
    await expectUnsentDraft(view);
    f.setTranscript("truncated");
    f.emit({ type: "agent_idle" });
    await visible(view, '#transcript-status[data-status="truncated"]');
    await visible(view, "#messages article", "Initial authoritative snapshot");
    expect(await view.evaluate(`(() => {
      const scroller = document.querySelector("#transcript");
      scroller.scrollTop = scroller.scrollHeight;
      const rect = document.querySelector("#transcript-status").getBoundingClientRect();
      return scroller.scrollTop > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
    })()`)).toBe(true);
    if (transcriptEvidence) await Bun.write(`${transcriptEvidence}/web-truncated.png`, await view.screenshot());
    f.setTranscript(undefined);
    f.emit({ type: "agent_idle" });
    await view.evaluate(`new Promise(resolve => {
      const notice = document.querySelector("#transcript-status");
      const read = () => { if (notice.hidden) { observer.disconnect(); resolve(true); } };
      const observer = new MutationObserver(read);
      observer.observe(notice, { attributes: true }); read();
    })`);
    await expectUnsentDraft(view);
    expect(f.posted).toEqual([]);
  } finally { f.close(); }
}, 15000);

test.skipIf(!chromium)("parent audit: retries a failed catchup snapshot on the same open stream", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const fresh = "Fresh snapshot on the unchanged stream";
  const arrived = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const f = await fixture((_id, text) => {
    if (text !== fresh) return Promise.resolve();
    arrived.resolve();
    return respond.promise;
  });
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440, height: 900 });
    await openWithDraft(view, f.url);
    f.failNextSnapshot();
    f.disconnect(fresh);
    await visible(view, '#connection[data-state="offline"]');
    await visible(view, "#send:disabled");
    await expectReadArrival(arrived.promise, "No second catchup GET on the open stream after HTTP 502");
    await visible(view, "#send:disabled");
    await visible(view, "#messages article", "Initial authoritative snapshot");
    await expectUnsentDraft(view);
    expect(f.reads.snapshots).toEqual([200, 502, 200]);
    const [, failedAt, retriedAt] = f.snapshotTimes;
    if (failedAt === undefined || retriedAt === undefined) throw new Error("Missing catchup GET timestamps");
    expect(retriedAt - failedAt).toBeGreaterThanOrEqual(1000);

    respond.resolve();
    await visible(view, "#messages article", fresh);
    await visible(view, "#send:not(:disabled)");
    await expectUnsentDraft(view);
    const settledReads = structuredClone(f.reads);
    // An idle stream must not leave the recovery timer polling.
    await Bun.sleep(2200);
    expect(f.reads).toEqual(settledReads);
    expect(f.replies).toEqual([200, 200]);
    expect(f.posted).toEqual([]);
  } finally {
    console.info(`Parent audit snapshot: SSE HTTP ${f.replies.join(", ")}; ready/GET trace ${JSON.stringify(f.reads)}; POST ${f.posted.length}`);
    respond.resolve();
    f.close();
  }
}, 25000);

test.skipIf(!chromium)("parent audit: reconciles engine readiness missed during a transport gap", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const fresh = "Fresh snapshot after engine became ready in the gap";
  const arrived = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const f = await fixture((_id, text) => {
    if (text !== fresh) return Promise.resolve();
    arrived.resolve();
    return respond.promise;
  });
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440, height: 900 });
    await openWithDraft(view, f.url);
    const offline = '#connection[data-state="offline"]';
    const engineOfflineRead = f.nextSessionsRead();
    f.engineOffline();
    await visible(view, "#banner-text", "Synthetic native engine offline");
    await expectReadArrival(engineOfflineRead, "No session-list GET after the offline engine event");
    const offlineReopenRead = f.nextSessionsRead();
    f.disconnect("Engine remains offline across the first gap");
    await expectReadArrival(offlineReopenRead, "No session-list GET after reopening with the engine still offline");
    await visible(view, offline);
    await visible(view, "#send:disabled");
    await visible(view, "#banner-text", "Synthetic native engine offline");
    expect(f.reads.ready).toEqual([true, false]);
    expect(f.reads.snapshots).toEqual([200]);

    f.disconnect(fresh);
    f.engineReadyDuringGap();
    await expectReadArrival(arrived.promise, "ready announced online after the gap, but no authoritative snapshot GET arrived");
    await visible(view, '#connection[data-state="connecting"]');
    await visible(view, "#send:disabled");
    await visible(view, "#messages article", "Initial authoritative snapshot");
    await expectUnsentDraft(view);
    respond.resolve();
    await visible(view, "#messages article", fresh);
    await visible(view, "#send:not(:disabled)");
    await expectUnsentDraft(view);
    expect(f.replies).toEqual([200, 200, 200]);
    expect(f.reads.ready).toEqual([true, false, true]);
    expect(f.reads.snapshots).toEqual([200, 200]);
    expect(f.posted).toEqual([]);
  } finally {
    console.info(`Parent audit engine: SSE HTTP ${f.replies.join(", ")}; ready/GET trace ${JSON.stringify(f.reads)}; POST ${f.posted.length}`);
    respond.resolve();
    f.close();
  }
}, 25000);

test.skipIf(!chromium)("retryable EOFs let the opening snapshot render before reconciling the latest gap", async () => {
  if (!chromium) throw new Error("Set OMO_HANDOFF_CHROMIUM to an isolated Chromium executable.");
  const requests: string[] = [];
  const gates = Array.from({ length: 6 }, () => ({
    arrived: Promise.withResolvers<void>(),
    respond: Promise.withResolvers<void>(),
  }));
  const [opening, catchup, latest, oldSelection, otherOpening, otherCatchup] = gates;
  if (!opening || !catchup || !latest || !oldSelection || !otherOpening || !otherCatchup) throw new Error("Missing snapshot gates");
  const original = "Initial authoritative snapshot";
  const first = "Snapshot epoch 1";
  const second = "Snapshot epoch 2";
  const third = "Snapshot epoch 3";
  const fourth = "Snapshot epoch 4";
  const f = await fixture((_sessionId, text) => {
    const gate = gates[requests.length];
    requests.push(text);
    if (!gate) throw new Error(`Unexpected snapshot: ${text}`);
    gate.arrived.resolve();
    return gate.respond.promise;
  });
  try {
    using view = new Bun.WebView({ backend: { type: "chrome", url: false, path: chromium }, width: 1440, height: 900 });
    const row = `#session-list button[data-session="${id}"]`;
    const online = '#connection[data-state="online"]';
    const connecting = '#connection[data-state="connecting"]';
    const article = "#messages article";
    const reopen = async (text: string) => {
      f.disconnect(text);
      await visible(view, '#connection[data-state="offline"]');
      await visible(view, connecting);
      // The bootstrap payload names its authority epoch; the row proves the app processed it.
      await visible(view, row, text);
    };
    const editDraft = () => view.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = ${JSON.stringify(draft)};
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const checkDraft = async (text: string) => {
      expect(await view.evaluate('document.querySelector("#prompt").value')).toBe(text);
      expect(f.posted).toEqual([]);
    };

    await view.navigate(f.url);
    await visible(view, online);
    await view.click(row);
    await opening.arrived.promise;
    await reopen(first);
    await reopen(second);
    expect(f.replies).toEqual([200, 200, 200]);

    opening.respond.resolve();
    try {
      await visible(view, article, original);
    } finally {
      console.info(`Slow open after two EOFs: SSE HTTP ${f.replies.join(", ")}; snapshot GETs ${JSON.stringify(requests)}; POST ${f.posted.length}`);
    }
    await catchup.arrived.promise;
    expect(requests).toEqual([original, second]);
    await editDraft();
    await visible(view, "#send:disabled");
    await checkDraft(draft);

    // A gap during the catchup GET requires another read after that GET has settled.
    await reopen(third);
    catchup.respond.resolve();
    await visible(view, article, second);
    await latest.arrived.promise;
    expect(requests).toEqual([original, second, third]);
    await visible(view, connecting);
    await visible(view, "#send:disabled");
    await checkDraft(draft);
    latest.respond.resolve();
    await visible(view, "#send:not(:disabled)");
    await visible(view, article, third);
    await checkDraft(draft);

    // A held read from the abandoned view must neither overwrite the new view nor unblock it.
    await reopen(fourth);
    await oldSelection.arrived.promise;
    const other = "#session-list button[data-session]:not([data-session=" + JSON.stringify(id) + "])";
    await view.click(other);
    await otherOpening.arrived.promise;
    otherOpening.respond.resolve();
    await visible(view, article, "Other session");
    await otherCatchup.arrived.promise;
    oldSelection.respond.resolve();
    await editDraft();
    await visible(view, connecting);
    await visible(view, "#send:disabled");
    await visible(view, `${other}[aria-current=true]`);
    await checkDraft(draft);
    otherCatchup.respond.resolve();
    await visible(view, "#send:not(:disabled)");
    await visible(view, article, "Other session");
    await checkDraft(draft);
    expect(requests).toEqual([original, second, third, fourth, "Other session", "Other session"]);
    console.info(`Latest gap and selection: ${JSON.stringify(requests)}; POST ${f.posted.length}`);
  } finally {
    for (const { respond } of gates) respond.resolve();
    f.close();
  }
}, 25000);
