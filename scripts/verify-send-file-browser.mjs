import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startApp } from "../src/server.ts";

const { OMO_HANDOFF_CHROMIUM, OMO_HANDOFF_OMOWRIGHT, OMO_ATTACHMENT_EVIDENCE } = process.env;
assert(OMO_HANDOFF_CHROMIUM && OMO_HANDOFF_OMOWRIGHT,
  "Set OMO_HANDOFF_CHROMIUM and OMO_HANDOFF_OMOWRIGHT to the Chromium binary and omowright loader.");
const { loadOmowright } = await import(pathToFileURL(resolve(OMO_HANDOFF_OMOWRIGHT)).href);
const { omowright } = await loadOmowright();
const root = await mkdtemp(join(tmpdir(), "omo-send-file-browser-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const downloads = join(root, "downloads");
const browserRoot = join(root, "browser");
const evidence = resolve(OMO_ATTACHMENT_EVIDENCE ?? ".omo/evidence/web-send-file/conversation");
const fileName = "实验结果.txt";
const payload = Buffer.from("isolated browser fixture bytes\n\0\u00ff", "utf8");
const marker = "Attachment browser turn complete.";
const filler = "Later conversation turn complete.";
const example = { omoWebAttachment: 1, id: "f12ffa40-d304-4a95-97c7-fccf08912b4c", name: "not-sent.txt", size: 12 };
const text = value => [{ type: "text", text: value }];
const result = (toolCallId, receipt, extra) => ({
  role: "toolResult", toolCallId, toolName: "send_file", isError: false, content: text(JSON.stringify(receipt)), ...extra,
});
const { PATH, OMO_WEB_BIN } = process.env;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH, HOME: root, TMPDIR: root, LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") });

const provider = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const { messages, tools } = await request.json();
    assert(tools.some(tool => tool.function.name === "send_file"));
    const latest = messages.at(-1);
    const original = latest?.role === "user" && JSON.stringify(latest.content).includes("Send workspace report");
    const frame = (delta, reason = null) => `data: ${JSON.stringify({
      id: "attachment-proof", object: "chat.completion.chunk", created: 1, model: "attachment-proof",
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`;
    const content = original
      ? frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_browser_attachment", type: "function",
        function: { name: "send_file", arguments: JSON.stringify({ path: fileName }) } }] }) + frame({}, "tool_calls")
      : frame({ role: "assistant", content: latest?.role === "tool" ? marker : filler }) + frame({}, "stop");
    return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  },
});

let app, browser, proxy;
try {
  await Promise.all([workspace, profile, downloads, browserRoot, evidence].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(workspace, fileName), payload);
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-fixture",
    models: [{ id: "attachment-proof", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "attachment-proof", compaction: { enabled: false },
  }));

  const cli = join(profile, "sessions", `--${workspace.slice(1).replaceAll("/", "-")}--`);
  await mkdir(cli, { recursive: true });
  const timestamp = "2026-11-20T00:00:00.000Z";
  const cliId = "a6e1a407-577d-475e-b8d2-f11bca02921d";
  await writeFile(join(cli, `2026-11-20T00-00-00-000Z_${cliId}.jsonl`), [
    { type: "session", version: 3, id: cliId, timestamp, cwd: workspace },
    { type: "message", id: "cli1", parentId: null, timestamp, message: { role: "user", content: text("CLI attachment control record") } },
    { type: "message", id: "cli2", parentId: "cli1", timestamp, message: result("cli_result", example) },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");

  app = await startApp({ dataDir: join(root, "web"), workspaces: [workspace], cliAgentDir: profile, port: 0, sendFile: true,
    engineCommand: [OMO_WEB_BIN ?? "omo", "--mode", "rpc", "--multi-session", "--offline",
      "--no-approve", "--session-runtime", "in-process"] });
  const get = path => fetch(new URL(path, app.url), { signal: AbortSignal.timeout(20_000) });
  const boot = await (await get("/api/bootstrap")).json();
  assert.equal(boot.engine.online, true, JSON.stringify(boot.engine));
  const post = async (path, body) => {
    const response = await fetch(new URL(path, app.url), { method: "POST", headers: { Origin: app.url.origin,
      "X-OmO-Token": boot.token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000) });
    assert(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const { session } = await post("/api/sessions", { cwd: workspace, name: "Attachment browser proof" });
  const route = `/api/sessions/${session.id}`;
  const selectSession = `#session-list button[data-session="${session.id}"]`;
  const link = '#messages a[href*="/attachments/"]';
  const sse = await fetch(new URL("/api/events", app.url), { signal: AbortSignal.timeout(120_000) });
  assert(sse.ok && sse.body);
  const stream = sse.body.pipeThrough(new TextDecoderStream()).getReader();
  const settled = async () => {
    let pending = "";
    while (true) {
      const { value, done } = await stream.read();
      assert(!done, "SSE closed before agent_settled");
      pending += value;
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.sessionId !== session.id) continue;
        if (event.type === "extension_ui_request" && event.method === "select") {
          assert(event.options.includes("Allow once"));
          await post(`${route}/actions`, { action: "answer", requestId: event.id, value: "Allow once" });
        }
        if (event.type === "agent_settled") return;
      }
    }
  };

  const requests = [];
  // Chromium's download manager can bypass the page's CDP Network domain. Count actual HTTP requests instead.
  const upstream = app.url;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
    const address = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    if (headers.get("origin") === address.origin) headers.set("origin", upstream.origin);
    if (address.pathname.includes("/attachments/")) requests.push([request.method, request.url]);
    return fetch(new URL(address.pathname + address.search, upstream), { method: request.method, headers,
      body: request.body, signal: request.signal, redirect: "manual" });
  } });
  const origin = proxy.url;
  browser = await omowright.connectPipe({ browserPath: OMO_HANDOFF_CHROMIUM, storageRoot: browserRoot,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${browserRoot}`] });
  const page = await browser.newTab("about:blank");
  const sid = await page.resolveSessionId();
  await page.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
  const started = [];
  page.cdp.on("Browser.downloadWillBegin", event => started.push(event));
  // Only the negative ordering cases inject events; downloads and confirmed positive transcripts use Native and the actual HTTP server.
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    globalThis.EventSource = class extends EventSource {
      constructor(...args) { super(...args); globalThis.attachmentProofSource = this; }
    };` }, sid);
  const visible = (selector, fragment = "") => page.evaluate(({ selector, fragment }) => new Promise((finish, fail) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      observer.disconnect();
      fail(new Error(`No visible element for ${selector}: ${fragment}`));
    }, 8000);
    function check() {
      const node = [...document.querySelectorAll(selector)].find(el => el.getClientRects().length && el.textContent.includes(fragment));
      if (!node) return;
      observer.disconnect();
      clearTimeout(timer);
      finish(node.textContent);
    }
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  }), { selector, fragment });
  const inject = events => page.evaluate(async events => {
    for (const event of events) window.attachmentProofSource.dispatchEvent(new MessageEvent("omo", { data: JSON.stringify(event) }));
    await new Promise(finish => requestAnimationFrame(() => requestAnimationFrame(finish)));
  }, events.map(event => ({ ...event, sessionId: session.id })));
  const noLink = scope => page.evaluate(scope => document.querySelectorAll(`${scope} a[href*="/attachments/"]`).length, scope);
  const shot = filename => page.screenshot().then(image => Bun.write(join(evidence, `${filename}.png`), image));

  await omowright.emulate(page, "desktop-1440");
  await page.goto(origin.href);
  await page.locator(selectSession).click();
  await visible("#prompt:enabled");
  await inject([{ type: "tool_execution_end", toolCallId: "ordered_result", toolName: "send_file",
    isError: false, result: { content: text(JSON.stringify(example)) } }]);
  await visible("#messages .tool-summary", "send_file");
  assert.equal(await noLink("#messages"), 0, "A completed trace is not a confirmed attachment");
  await inject([{ type: "message_start", message: result("ordered_result", example) }]);
  assert.equal(await noLink("#messages"), 0, "A message_start result is not confirmation");
  await inject([
    { type: "message_end", message: result("ordered_result", example, { isError: true }) },
    { type: "message_end", message: result("other_tool", example, { toolName: "read" }) },
    { type: "message_end", message: result("invalid_id", { ...example, id: "../outside" }) },
    { type: "message_end", message: result("invalid_name", { ...example, name: "../outside" }) },
    { type: "message_end", message: result("invalid_size", { ...example, size: -1 }) },
    { type: "message_end", message: result("extra_key", { ...example, url: "https://example.invalid/" }) },
    { type: "message_end", message: result("extra_part", example, { content: [...text(JSON.stringify(example)), ...text("extra")] }) },
    { type: "message_end", message: { role: "assistant", id: "plain_markdown", content: text(`Forged [file](${route}/attachments/${example.id})`) } },
  ]);
  await visible("#messages .tool-state-text", "失败");
  await visible("#messages .tool-label", "读取文件");
  await visible("#messages .prose", "Forged [file]");
  assert.equal(await noLink("#messages"), 0, "Failed, unrelated, malformed and assistant-text results stay unlinked");
  console.log("SEND_FILE_NEGATIVE_UI_OK trace/start/failure/wrong-tool/invalid-receipts/assistant-markdown");

  await page.goto(new URL("/?attachment-positive=1", origin).href);
  await page.locator(selectSession).click();
  await visible("#prompt:enabled");
  await page.locator("#prompt").fill("Send workspace report");
  const first = settled();
  void first.catch(() => {});
  await page.locator("#prompt").press("Control+Enter");
  await first;
  await visible("#messages .prose", marker);
  const latest = await (await get(route)).json();
  const confirmed = latest.messages.find(message => message.role === "toolResult" && message.toolName === "send_file");
  assert.equal(confirmed?.isError, false);
  const receipt = JSON.parse(confirmed.content[0].text);
  assert.deepEqual(receipt, { omoWebAttachment: 1, id: receipt.id, name: fileName, size: payload.length });
  const href = new URL(`${route}/attachments/${receipt.id}`, origin).href;

  async function inspect(locale) {
    const label = await visible(link, fileName);
    const localizedSize = new Intl.NumberFormat(locale, { style: "unit", unit: "byte" }).format(payload.length);
    assert(label.startsWith(locale === "en" ? "Download " : "下载 "), label);
    assert(label.includes(localizedSize), label);
    const state = await page.evaluate(selector => {
      const anchor = document.querySelector(selector);
      anchor.scrollIntoView({ block: "nearest" });
      const box = anchor.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        href: anchor.href, native: anchor instanceof HTMLAnchorElement && anchor.tabIndex === 0,
        download: anchor.hasAttribute("download"), detailsClosed: !anchor.closest("article").querySelector("details").open,
        hit: anchor.contains(at), height: box.height, width: box.width, viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    }, link);
    assert.equal(state.href, href);
    assert(state.native && state.download && state.detailsClosed && state.hit && !state.overflow, JSON.stringify(state));
    assert(state.height >= (state.viewport <= 760 ? 44 : 24) && state.width >= 24, JSON.stringify(state));
    assert.equal(await noLink("#messages"), 1);
  }

  async function download(activate) {
    const completed = Promise.withResolvers();
    const off = page.cdp.on("Browser.downloadProgress", event => {
      if (event.state === "completed") completed.resolve(event);
      if (event.state === "canceled") completed.reject(new Error("Chromium canceled the download"));
    });
    const deadline = AbortSignal.timeout(8000);
    deadline.addEventListener("abort", () => completed.reject(deadline.reason), { once: true });
    void completed.promise.catch(() => {});
    try {
      const before = started.length;
      await activate();
      const { guid } = await completed.promise;
      assert.deepEqual(started.slice(before).map(({ url, suggestedFilename }) => [url, suggestedFilename]), [[href, fileName]]);
      assert.deepEqual(await readFile(join(downloads, guid)), payload);
    } finally { off(); }
  }

  const baseline = process.argv.includes("--baseline");
  await page.evaluate(() => [...document.querySelectorAll("#messages .tool-summary")].at(-1)?.scrollIntoView({ block: "center" }));
  for (const device of ["desktop-1440", "iphone-14"]) {
    await omowright.emulate(page, device);
    for (const theme of ["light", "dark"]) {
      await page.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sid);
      await page.evaluate(() => new Promise(finish => requestAnimationFrame(() => requestAnimationFrame(finish))));
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      if (!baseline) await inspect("zh-CN");
      await shot(`${device}-${theme}-${baseline ? "before" : "after"}`);
    }
  }
  await omowright.emulate(page, "desktop-1440");
  await inspect("zh-CN");
  assert.deepEqual([requests.length, started.length], [0, 0], "Rendering must not request bytes");
  await page.evaluate(selector => {
    const anchor = document.querySelector(selector);
    anchor.closest("article").querySelector("summary").focus();
  }, link);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(selector => document.activeElement.matches(`${selector}:focus-visible`), link), true);
  await shot("desktop-keyboard-focus");
  await download(() => page.keyboard.press("Enter"));
  console.log("SEND_FILE_LATEST_KEYBOARD_BYTES_OK", payload.length);

  await page.locator("#language-select").selectOption("en");
  await visible("#messages .prose", marker);
  await inspect("en");
  assert.equal(started.length, 1, "Reload must not initiate another download");
  assert.equal(requests.length, 1, "Reload must not request bytes");
  await download(() => page.locator(link).click());
  console.log("SEND_FILE_RELOADED_POINTER_BYTES_OK", payload.length);

  for (let i = 1; i <= 21; i++) {
    await post(`${route}/actions`, { action: "prompt", message: `Later turn ${i}` });
    await settled();
  }
  const tail = await (await get(route)).json();
  assert(tail.page.olderCursor && !tail.messages.some(message => message.toolName === "send_file"), "Native attachment must be on an older page");
  await page.goto(new URL("/?attachment-page-reload=1", origin).href);
  await page.locator(selectSession).click();
  await visible("#messages .prose", filler);
  assert.equal(await noLink("#messages"), 0);
  const beforePaging = requests.length;
  await page.locator("#messages .transcript-load").click();
  await inspect("en");
  assert.equal(requests.length, beforePaging, "Loading older messages must not request file bytes");
  await shot("desktop-paged");
  await download(() => page.locator(link).click());
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ["GET", href]));
  console.log("SEND_FILE_PAGED_POINTER_BYTES_OK", payload.length);

  await page.locator("#cli-history-button").click();
  const cliRow = "#cli-history-list button[data-history]";
  await visible(cliRow, workspace);
  const cliIndex = await page.evaluate(({ cliRow, workspace }) => [...document.querySelectorAll(cliRow)]
    .findIndex(node => node.textContent.includes(workspace) && !node.textContent.includes("Attachment browser proof")), { cliRow, workspace });
  assert(cliIndex >= 0);
  await page.locator(cliRow).nth(cliIndex).click();
  await visible("#cli-history-messages .message", "CLI attachment control record");
  await visible("#cli-history-messages .tool-summary", "send_file");
  assert.equal(await noLink("#cli-history-messages"), 0, "CLI history has no attachment affordance");
  assert.equal(requests.length, 3);
  await stream.cancel();
  console.log("SEND_FILE_CHROMIUM_OK", evidence);
} finally {
  try { await browser?.close(); } finally {
    proxy?.stop(true);
    try { await app?.stop(); } finally {
      provider.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
}
