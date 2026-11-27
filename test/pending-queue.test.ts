import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./queue-engine-fixture.ts", import.meta.url));
const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");

async function queueApp(oversize = false) {
  const directory = await mkdtemp(join(tmpdir(), "omo-web-queue-"));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const wirePath = join(directory, "rpc.jsonl");
  const app = await startApp({ dataDir: join(directory, "store"), workspaces: [cwd],
    engineCommand: [process.execPath, fixture, wirePath, ...(oversize ? ["--oversize"] : [])], port: 0 });
  const get = (path: string) => fetch(new URL(path, app.url));
  const bootstrap = await (await get("/api/bootstrap")).json();
  const post = (path: string, body: unknown) => fetch(new URL(path, app.url), {
    method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": bootstrap.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const open = async () => {
    const response = await post("/api/sessions", { cwd });
    expect(response.status).toBe(201);
    return String((await response.json()).session.id);
  };
  const wire = async () => await Bun.file(wirePath).exists()
    ? (await Bun.file(wirePath).text()).trim().split("\n").map(line => JSON.parse(line)) : [];
  return { app, get, post, open, wire, cwd, directory, async [Symbol.asyncDispose]() {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  } };
}

test("public overview does not read queue text; explicit queue is scoped, sanitized and bounded", async () => {
  await using client = await queueApp(true);
  const base = `/api/sessions/${await client.open()}`;
  const overview = await client.get(`${base}/details`);
  expect({ status: overview.status, wire: await client.wire() }).toEqual({ status: 200, wire: [] });
  expect(await overview.json()).toMatchObject({ stats: { cost: 0.125 }, state: { pendingMessageCount: 35 } });
  const unknown = await (await client.get(`/api/sessions/${await client.open()}/details`)).json();
  expect(unknown.state).not.toHaveProperty("pendingMessageCount");
  expect((await client.get(`${base}/queue?limit=999`)).status).toBe(400);
  expect((await client.get(`/api/sessions/${crypto.randomUUID()}/queue`)).status).toBe(404);
  expect(await client.wire()).toEqual([]);

  for (const code of ["queue_read_failed", "queue_too_large"]) {
    const response = await client.get(`${base}/queue`);
    expect(response.status).toBe(502);
    const failure = await response.text();
    expect(JSON.parse(failure)).toHaveProperty("code", code);
    expect(failure).not.toContain("NATIVE-PRIVATE");
    expect((await client.get(`${base}/details`)).status).toBe(200);
  }
  const response = await client.get(`${base}/queue`);
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(raw).not.toContain("NATIVE-PRIVATE");
  const preview = JSON.parse(raw);
  expect(preview.truncated).toBe(true);
  expect(preview.inputs).toHaveLength(30);
  expect(preview.inputs[0]).toEqual({ state: "queued", requestedMode: "followUp", text: `f${"🎈".repeat(119)}` });
  expect(preview.inputs.at(-1)).toEqual({ state: "queued", text: "queued-29" });
  expect((await client.wire()).map(({ id: _id, ...request }) => request)).toEqual(
    Array.from({ length: 3 }, () => ({ type: "get_pending_inputs", sessionId: "queue-route-1" })),
  );
  expect((await client.post(`${base}/actions`, { action: "clearQueue" })).status).toBe(200);
  expect(await (await client.get(`${base}/queue`)).json()).toEqual({ inputs: [], truncated: false });
  expect(await (await client.get(`${base}/details`)).json()).toHaveProperty("state.pendingMessageCount", 0);
  await rename(client.cwd, join(client.directory, "revoked"));
  const reads = (await client.wire()).length;
  expect((await client.get(`${base}/queue`)).status).toBe(403);
  expect(await client.wire()).toHaveLength(reads);
}, 15_000);

async function observe(browser: Bun.WebView, condition: string) {
  await browser.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(condition)})); }, 3500);
    const observer = new MutationObserver(check);
    function check() {
      if (!(${condition})) return;
      observer.disconnect(); clearTimeout(timeout); resolve(true);
    }
    observer.observe(document.body, { attributes: true, subtree: true, childList: true, characterData: true });
    check();
  })`);
}

browserTest("Chromium keeps a ready overview while the explicit queue is held, fails and can be retried", async () => {
  await using client = await queueApp();
  const id = await client.open();
  const other = await client.open();
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not build queue browser fixture");
  const firstRead = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  using frontend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/app.js") return new Response(script);
    if (url.pathname.startsWith("/api/")) requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/queue") && requests.filter(path => path.endsWith("/queue")).length === 1) {
      firstRead.resolve();
      await release.promise;
    }
    const headers = new Headers(request.headers);
    headers.set("Host", client.app.url.host);
    if (headers.has("Origin")) headers.set("Origin", client.app.url.origin);
    return client.app.fetch(new Request(new URL(url.pathname + url.search, client.app.url), {
      method: request.method, headers, body: request.body, signal: request.signal,
    }));
  } });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width: 1440, height: 900 });
  const capture = async (name: string, selector: string) => {
    const directory = process.env.OMO_QUEUE_EVIDENCE;
    if (!directory) return;
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "start" })`);
    for (const theme of ["light", "dark"]) {
      await browser.evaluate(`(async () => {
        const theme = document.querySelector("#theme");
        theme.value = "${theme}"; theme.dispatchEvent(new Event("change"));
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      })()`);
      await Bun.write(join(directory, `queue-${name}-${theme}.png`), await browser.screenshot());
    }
  };
  try {
    await browser.navigate(frontend.url.href);
    const sessionButton = (id: string) => `#session-list [data-session="${id}"]`;
    await observe(browser, `document.querySelector(${JSON.stringify(sessionButton(id))})`);
    await browser.click(sessionButton(id));
    await observe(browser, `document.querySelector("#messages")?.textContent.includes("Queue fixture conversation")`);
    if (!await browser.evaluate("document.querySelector('#details-dialog').open")) await browser.click("#details-button");
    await observe(browser, `document.querySelector("#runtime-metrics .runtime-metrics") ||
      document.querySelector("#details-error").textContent.includes("NATIVE-PRIVATE")`);
    const readRequests = () => requests.filter(path => path.endsWith("/queue"));
    expect({ metrics: await browser.evaluate(`!!document.querySelector("#runtime-metrics .runtime-metrics")`),
      nativeReads: await client.wire(), queueRequests: readRequests() }).toEqual({ metrics: true, nativeReads: [], queueRequests: [] });
    const queue = 'details[data-overview-disclosure="queue"]';
    const summary = `${queue} summary`;
    const queueSection = "#runtime-metrics section:has(> details[data-overview-disclosure='queue'])";
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(queue)}).open`)).toBe(false);
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(queueSection)}).textContent`)).toContain("35 条");
    await browser.click("#details-refresh");
    await observe(browser, `!document.querySelector("#details-error").textContent`);
    await browser.evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await browser.press("Enter");
    await Promise.race([firstRead.promise, Bun.sleep(3000).then(() => { throw new Error("No explicit queue request"); })]);
    expect(readRequests()).toEqual([`GET /api/sessions/${id}/queue`]);
    expect(await browser.evaluate(`!!document.querySelector("#runtime-metrics .runtime-metrics")`)).toBe(true);
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(queue)}).getAttribute("open")`)).not.toBeNull();
    release.resolve();
    const retry = `${queue} button`;
    await observe(browser, `document.querySelector(${JSON.stringify(retry)})?.getClientRects().length`);
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(queue)}).textContent`)).not.toContain("NATIVE-PRIVATE");
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(summary)})`)).toBe(true);
    await capture("failed", queueSection);
    await browser.click(retry);
    await observe(browser, `document.querySelector(${JSON.stringify(queue)}).textContent.includes("queued-29")`);
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(queue)}).textContent`)).not.toContain("queued-30");
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(summary)})`)).toBe(true);
    await capture("preview", queueSection);
    await browser.click("#details-refresh");
    await observe(browser, `document.querySelector(${JSON.stringify(queue)}).textContent.includes("queued-29")`);
    expect(readRequests()).toHaveLength(3);
    await browser.click(summary);
    await browser.click("#details-refresh");
    await observe(browser, `!document.querySelector(${JSON.stringify(queue)}).open`);
    expect(readRequests()).toHaveLength(3);
    expect(await browser.evaluate(`document.querySelector("[data-overview-focus='queue:clear']").disabled`)).toBe(false);
    await browser.click(sessionButton(other));
    await observe(browser, `document.querySelector(${JSON.stringify(queueSection)})?.textContent.includes("待处理输入数量未知")`);
    expect(await browser.evaluate(`document.querySelector("[data-overview-focus='queue:clear']").disabled`)).toBe(true);
    expect(readRequests()).toHaveLength(3);
    expect(requests.filter(path => path.startsWith("POST "))).toEqual([]);
  } finally {
    release.resolve();
  }
}, 15_000);
