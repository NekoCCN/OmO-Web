// Build source assets with `bun run build` first. Use a real Native binary and disposable Chromium.
// allow: SIZE_OK — one standalone acceptance script owns the disposable fixture and both transport replays.
// OMO_HANDOFF_CHROMIUM=/path/to/chrome OMO_HANDOFF_OMOWRIGHT=/path/to/omowright.mjs \
//   bun --no-env-file scripts/verify-send-file-resume.mjs [--entry dist/server.js | --launcher /path/to/omo-web]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get as httpGet, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && ["--entry", "--launcher"].includes(args[0]) && args[1]),
  "Usage: bun --no-env-file scripts/verify-send-file-resume.mjs [--entry <server entry> | --launcher <installed executable>]");
const entry = args.length ? resolve(args[1]) : fileURLToPath(new URL("../src/main.ts", import.meta.url));
const command = args[0] === "--launcher" ? [entry, "serve"] : [process.execPath, "--no-env-file", entry];
const { OMO_HANDOFF_CHROMIUM, OMO_HANDOFF_OMOWRIGHT, OMO_WEB_BIN = "omo", PATH = "/usr/bin:/bin" } = process.env;
assert(OMO_HANDOFF_CHROMIUM && OMO_HANDOFF_OMOWRIGHT, "Set OMO_HANDOFF_CHROMIUM and OMO_HANDOFF_OMOWRIGHT.");
const browserPath = resolve(OMO_HANDOFF_CHROMIUM);
const { loadOmowright } = await import(pathToFileURL(resolve(OMO_HANDOFF_OMOWRIGHT)).href);
const { omowright } = await loadOmowright();
const root = await mkdtemp(join(tmpdir(), "omo-web-resume-"));
const [home, workspace, profile, browserRoot, downloads] = ["home", "workspace", "profile", "browser", "downloads"]
  .map(name => join(root, name));
const isolated = { PATH, HOME: home, TMPDIR: root, LANG: "C.UTF-8", XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") };
const fileName = "resume-proof.bin";
const size = 32 * 1024 * 1024 + 12345;
const prefix = 1024 * 1024 + 123;
const marker = "Native large attachment turn complete.";
const model = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
  messages: z.array(z.object({ role: z.string() })).min(1) });
const bootSchema = z.object({ token: z.string(), engine: z.object({ online: z.boolean() }) });
const receiptSchema = z.strictObject({ omoWebAttachment: z.literal(1), id: z.uuid(),
  name: z.literal(fileName), size: z.literal(size) });
const resultSchema = z.object({ role: z.literal("toolResult"), toolName: z.literal("send_file"),
  isError: z.literal(false), content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]) });

async function startup(app) {
  const output = app.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const stderr = new Response(app.stderr).text();
  const ready = Promise.withResolvers();
  let pending = "";
  void (async () => {
    while (true) {
      const { value, done } = await output.read();
      if (done) break;
      pending += value;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("OmO Web: ")) ready.resolve(new URL(line.slice("OmO Web: ".length).trim()));
      }
    }
    ready.reject(new Error(`Production entry exited (${await app.exited}): ${await stderr}`));
  })().catch(ready.reject);
  const deadline = AbortSignal.timeout(30_000);
  deadline.addEventListener("abort", () => ready.reject(new Error("Production entry did not announce a loopback URL")), { once: true });
  return ready.promise;
}

async function settled(response, session, post) {
  assert(response.ok && response.body, "Native event stream unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      assert(!done, "Native event stream ended before settlement");
      pending += value;
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.sessionId !== session) continue;
        if (event.type === "extension_ui_request" && event.method === "select") {
          assert(event.id && event.options.includes("Allow once"));
          await post(`/api/sessions/${session}/actions`, { action: "answer", requestId: event.id, value: "Allow once" });
        }
        if (event.type === "agent_settled") return;
      }
    }
  } finally { await reader.cancel(); }
}

async function relay(upstream, downstream, cut) {
  downstream.writeHead(upstream.statusCode, upstream.headers);
  if (!cut || upstream.statusCode !== 200) return pipeline(upstream, downstream);
  let remaining = prefix;
  for await (const chunk of upstream) {
    const part = chunk.subarray(0, remaining);
    remaining -= part.length;
    await new Promise((done, fail) => downstream.write(part, error => error ? fail(error) : done()));
    if (!remaining) {
      // Finish the TCP stream, not the HTTP response. Its original Content-Length remains intact.
      downstream.socket.end();
      return;
    }
  }
  throw new Error("Origin did not supply the expected fault prefix");
}

async function download(page, activate, timeout = 30_000) {
  const started = [];
  const completed = Promise.withResolvers();
  const offStart = page.cdp.on("Browser.downloadWillBegin", event => started.push(event));
  const offProgress = page.cdp.on("Browser.downloadProgress", event => {
    if (event.state === "completed" || event.state === "canceled") completed.resolve(event);
  });
  const deadline = AbortSignal.timeout(timeout);
  deadline.addEventListener("abort", () => completed.resolve(undefined), { once: true });
  try {
    await activate();
    return { started, terminal: await completed.promise };
  } finally { offStart(); offProgress(); }
}

async function hashStream(stream, hash) {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return bytes;
}
async function checkDownloaded(path, expected) {
  const hash = createHash("sha256");
  assert.equal(await hashStream(createReadStream(path), hash), size);
  assert.equal(hash.digest("hex"), expected);
}
function transfer(url, headers = {}) {
  return new Promise((done, fail) => {
    httpGet(url, { headers, agent: false, signal: AbortSignal.timeout(30_000) }, done).once("error", fail);
  });
}

let provider, app, proxy, browser;
try {
  await Promise.all([home, workspace, profile, browserRoot, downloads].map(path => mkdir(path)));
  // A deterministic, nonrepeating fixture makes the resumed offset byte-sensitive.
  const file = join(workspace, fileName);
  const payload = createHash("shake256", { outputLength: size }).update("OmO Web resume proof v1").digest();
  await writeFile(file, payload);
  const expected = createHash("sha256").update(payload).digest("hex");
  provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const { tools, messages } = model.parse(await request.json());
    assert(tools.some(tool => tool.function.name === "send_file"), "Native did not expose send_file");
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({
      id: "resume-proof", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    const content = messages.at(-1).role === "tool"
      ? frame({ role: "assistant", content: marker }) + frame({}, "stop")
      : frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_resume_proof", type: "function",
        function: { name: "send_file", arguments: JSON.stringify({ path: fileName }) } }] }) + frame({}, "tool_calls");
    return new Response(`${content}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-fixture",
    models: [{ id: "fixture", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture",
    compaction: { enabled: false } }));
  app = Bun.spawn(command, { cwd: workspace, env: { ...isolated, OMO_WEB_WORKSPACES: workspace,
    OMO_WEB_DATA: join(root, "web"), OMO_WEB_CLI_AGENT_DIR: profile, OMO_WEB_PORT: "0",
    OMO_WEB_HOST: "127.0.0.1", OMO_WEB_BIN }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const upstream = await startup(app);
  assert(upstream.protocol === "http:" && upstream.hostname === "127.0.0.1" && Number(upstream.port) > 0);
  const get = path => fetch(new URL(path, upstream), { signal: AbortSignal.timeout(90_000), redirect: "error" });
  const bootResponse = await get("/api/bootstrap");
  assert.equal(bootResponse.status, 200);
  const boot = bootSchema.parse(await bootResponse.json());
  assert(boot.engine.online, "Native engine failed to start");
  const post = async (path, body) => {
    const response = await fetch(new URL(path, upstream), { method: "POST", headers: { Origin: upstream.origin,
      "X-OmO-Token": boot.token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), redirect: "error" });
    assert(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const { session: { id } } = z.object({ session: z.object({ id: z.uuid() }) })
    .parse(await post("/api/sessions", { cwd: workspace, name: "Large attachment resume proof" }));
  const route = `/api/sessions/${id}`;
  const requests = [];
  const replies = [];
  let cutNext = false;
  proxy = createServer((request, response) => {
    const headers = { ...request.headers, host: upstream.host };
    if (headers.origin === `http://${request.headers.host}`) headers.origin = upstream.origin;
    const attachment = request.url.includes("/attachments/");
    const cut = attachment && request.method === "GET" && cutNext;
    if (attachment) {
      requests.push({ method: request.method, path: request.url, range: headers.range, ifRange: headers["if-range"], cut });
      if (cut) cutNext = false;
    }
    const forward = httpRequest(upstream, { path: request.url, method: request.method, headers }, incoming => {
      if (attachment) replies.push({ status: incoming.statusCode, headers: incoming.headers });
      void relay(incoming, response, cut).catch(error => response.destroy(error));
    });
    response.once("close", () => forward.destroy());
    forward.once("error", error => response.destroy(error));
    request.pipe(forward);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const origin = new URL(`http://127.0.0.1:${proxy.address().port}`);

  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  browser = await omowright.connectPipe({ browserPath, storageRoot: browserRoot,
    browserArgs: ["--headless", "--no-first-run", "--disable-background-networking", "--disable-component-update",
      `--user-data-dir=${browserRoot}`] });
  const page = await browser.newTab("about:blank");
  await page.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
  await page.goto(origin.href);
  await page.locator(`#session-list button[data-session="${id}"]`).click();
  const link = page.locator('#messages a[href*="/attachments/"]');
  const settlement = settled(await get("/api/events"), id, post);
  void settlement.catch(() => {});
  await post(`${route}/actions`, { action: "prompt", message: `Send ${fileName}` });
  await settlement;
  const { messages } = await (await get(route)).json();
  const result = resultSchema.parse(messages.find(message => message.role === "toolResult" && message.toolName === "send_file"));
  const receipt = receiptSchema.parse(JSON.parse(result.content[0].text));
  const path = `${route}/attachments/${receipt.id}`;
  const href = new URL(path, origin);
  await link.waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#messages a[href*="/attachments/"]'),
    a => [a.href, a.hasAttribute("download")])), [[href.href, true]]);
  assert.deepEqual(requests, [], "Rendering the confirmed attachment must not fetch bytes");
  const clean = await download(page, () => link.click());
  assert.equal(clean.terminal?.state, "completed", "Chromium did not complete the clean download");
  assert.deepEqual(clean.started.map(event => [event.guid, event.url, event.suggestedFilename]),
    [[clean.terminal.guid, href.href, fileName]]);
  await checkDownloaded(join(downloads, clean.terminal.guid), expected);
  const initial = { method: "GET", path, range: undefined, ifRange: undefined, cut: false };
  assert.deepEqual(requests, [initial], "Expected only one download request after clicking");
  console.log("CHROMIUM_LARGE_DOWNLOAD_OK", JSON.stringify({ size, sha256: expected, prefetchRequests: 0 }));

  cutNext = true;
  const first = await transfer(href);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-length"], String(size), "Origin must announce the complete length on the interrupted GET");
  const etag = first.headers.etag;
  assert.match(etag, /^"[^"]+"$/u, "Origin must supply a strong ETag");
  const resumedHash = createHash("sha256");
  let received = 0;
  await assert.rejects(async () => {
    for await (const chunk of first) {
      received += chunk.length;
      resumedHash.update(chunk);
    }
  }, { code: "ECONNRESET" });
  assert.equal(first.complete, false, "The first HTTP response must be incomplete");
  assert.equal(received, prefix, "Client must retain exactly the injected fault prefix");
  const range = `bytes=${received}-`;
  const retry = await transfer(href, { Range: range, "If-Range": etag });
  assert.equal(retry.statusCode, 206);
  assert.equal(retry.headers.etag, etag);
  assert.equal(retry.headers["content-range"], `bytes ${received}-${size - 1}/${size}`);
  assert.equal(retry.headers["content-length"], String(size - received));
  assert.equal(await hashStream(retry, resumedHash), size - received);
  assert.equal(resumedHash.digest("hex"), expected);
  assert.deepEqual(requests, [initial, { ...initial, cut: true }, { ...initial, range, ifRange: etag }]);
  console.log("HTTP_INTERRUPTION_RESUME_OK", JSON.stringify({ client: "explicit HTTP stream client", received,
    range, ifRange: etag, status: retry.statusCode, sha256: expected, entry }));

  cutNext = true;
  const chromium = await download(page, () => link.click(), 8_000);
  const chromiumRequests = requests.slice(3);
  assert.deepEqual(chromiumRequests[0], { ...initial, cut: true }, "Chromium must attempt the fault-injected GET");
  const chromiumRetried = chromiumRequests.some(attempt => attempt.range === range && attempt.ifRange === etag);
  if (chromium.terminal?.state === "completed" && chromiumRetried) {
    assert.deepEqual(chromiumRequests, [{ ...initial, cut: true }, { ...initial, range, ifRange: etag }]);
    assert.deepEqual(replies.slice(3).map(reply => [reply.status, reply.headers["content-range"]]), [
      [200, undefined], [206, `bytes ${prefix}-${size - 1}/${size}`],
    ]);
    assert.deepEqual(chromium.started.map(event => [event.guid, event.url, event.suggestedFilename]),
      [[chromium.terminal.guid, href.href, fileName]]);
    await checkDownloaded(join(downloads, chromium.terminal.guid), expected);
    console.log("CHROMIUM_INTERRUPTION_RESUME_OK", JSON.stringify({ received: prefix, range, ifRange: etag, sha256: expected }));
  } else {
    console.log("CHROMIUM_INTERRUPTION_RESUME_NOT_PROVEN", JSON.stringify({
      state: chromium.terminal?.state ?? "deadline", requests: chromiumRequests,
    }));
  }
} finally {
  try { await browser?.close(); } finally {
    proxy?.close();
    proxy?.closeAllConnections();
    provider?.stop(true);
    try {
      if (app && app.exitCode === null) {
        app.kill("SIGTERM");
        if (!await Promise.race([app.exited.then(() => true), Bun.sleep(5_000).then(() => false)])) {
          app.kill("SIGKILL");
          await app.exited;
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}
