import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Usage: bun scripts/verify-send-file-native.ts [--entry /absolute/path/to/dist/server.js]
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--entry" && args[1]),
  "Usage: verify-send-file-native.ts [--entry <app entrypoint>]");
const entry = args.length === 0 ? fileURLToPath(new URL("../src/main.ts", import.meta.url)) : resolve(args[1]);
assert(await Bun.file(entry).exists(), `App entrypoint does not exist: ${entry}`);

const root = await mkdtemp(join(tmpdir(), "omo-web-native-acceptance-"));
const cwd = join(root, "workspace");
const home = join(root, "home");
const profile = join(root, "profile");
const contents = "isolated Native attachment bytes\n";
const receiptSchema = z.strictObject({
  omoWebAttachment: z.literal(1), id: z.uuid().regex(/^[a-f0-9-]+$/u),
  name: z.literal("example.txt"), size: z.literal(Buffer.byteLength(contents)),
});
const snapshotSchema = z.object({ messages: z.array(z.object({
  role: z.string(), toolName: z.string().optional(), isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string().optional() })).optional(),
})) });
const modelSchema = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  messages: z.array(z.object({ role: z.string() })) });
const eventSchema = z.object({ type: z.string(), method: z.string().optional(), id: z.string().optional(),
  options: z.array(z.string()).optional(), toolName: z.string().optional(), result: z.unknown().optional() });

let target = "example.txt";
let calls = 0;
const modelBodies: string[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const raw: unknown = await request.json();
    modelBodies.push(JSON.stringify(raw));
    const model = modelSchema.parse(raw);
    calls++;
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "send-file-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    if (model.tools?.some(tool => tool.function.name === "send_file") && model.messages.at(-1)?.role !== "tool") {
      return new Response(chunk({ role: "assistant", tool_calls: [{
        index: 0, id: `call_send_file_${calls}`, type: "function",
        function: { name: "send_file", arguments: JSON.stringify({ path: target }) },
      }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(chunk({ role: "assistant", content: "fixture complete" }, null) +
      chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  },
});

const childEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: root, LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
  OMO_WEB_WORKSPACES: cwd, OMO_WEB_DATA: join(root, "web"),
  OMO_WEB_CLI_AGENT_DIR: profile, OMO_WEB_PORT: "0", OMO_WEB_HOST: "127.0.0.1",
  OMO_WEB_ATTACHMENT_QUOTA_BYTES: "1024",
  OMO_WEB_BIN: process.env.OMO_WEB_BIN || "omo",
};
const launch = () => Bun.spawn([process.execPath, "--no-env-file", entry], {
  cwd, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
let app: ReturnType<typeof launch> | undefined;

async function connect() {
  const child = app = launch();
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const timeout = AbortSignal.timeout(30_000);
  let output = "";
  while (true) {
    const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) =>
      timeout.addEventListener("abort", () => reject(new Error("App startup timed out")), { once: true }))]);
    if (chunk.done) throw new Error(`App exited before startup (${await child.exited}): ${await stderr}`);
    output += chunk.value;
    const match = /OmO Web: (http:\/\/[^\s]+)/u.exec(output);
    if (!match?.[1]) continue;
    const url = new URL(match[1]);
    assert.equal(url.hostname, "127.0.0.1");
    const get = (path: string) => fetch(new URL(path, url), { signal: AbortSignal.timeout(30_000) });
    const bootResponse = await get("/api/bootstrap");
    assert.equal(bootResponse.status, 200);
    const boot = z.object({ token: z.string(), engine: z.object({ online: z.boolean() }) }).parse(await bootResponse.json());
    assert(boot.engine.online, "Native engine failed to start");
    const post = (path: string, body: object) => fetch(new URL(path, url), {
      method: "POST", headers: { Origin: url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    return { get, post };
  }
}

async function stop() {
  if (!app) return;
  const child = app;
  app = undefined;
  child.kill("SIGTERM");
  const timeout = AbortSignal.timeout(10_000);
  const stopped = await Promise.race([child.exited.then(() => true), new Promise<false>(resolve =>
    timeout.addEventListener("abort", () => resolve(false), { once: true }))]);
  if (!stopped) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

try {
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(profile)]);
  await writeFile(join(cwd, "example.txt"), contents);
  await writeFile(join(root, "outside.txt"), "outside fixture");
  const large = await open(join(cwd, "large.txt"), "w");
  try { await large.truncate(1025); } finally { await large.close(); }
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-fixture",
    models: [{ id: "fixture", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false },
  }));
  const server = await connect();
  const created = await server.post("/api/sessions", { cwd });
  assert.equal(created.status, 201);
  const session = z.object({ session: z.object({ id: z.uuid() }) }).parse(await created.json()).session.id;
  const route = `/api/sessions/${session}`;
  async function turn(path: string) {
    target = path;
    const events = await server.get("/api/events");
    assert(events.body);
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
    let wire = "", pending = "";
    try {
      assert.equal((await server.post(`${route}/actions`, { action: "prompt", message: `Send ${path}` })).status, 200);
      while (!wire.includes('"type":"agent_settled"')) {
        const chunk = await reader.read();
        assert(!chunk.done, "Event stream closed before Native settled");
        wire += chunk.value;
        pending += chunk.value;
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find(value => value.startsWith("data: "));
          if (!line) continue;
          const event = eventSchema.parse(JSON.parse(line.slice(6)));
          if (event.type === "extension_ui_request" && event.method === "select") {
            assert(event.id && event.options?.includes("Allow once"));
            assert.equal((await server.post(`${route}/actions`,
              { action: "answer", requestId: event.id, value: "Allow once" })).status, 200);
          }
        }
      }
    } finally {
      await reader.cancel();
    }
    const snapshot = snapshotSchema.parse(await (await server.get(route)).json());
    const result = snapshot.messages.filter(message => message.role === "toolResult" && message.toolName === "send_file").at(-1);
    assert(result, "Native transcript has no send_file result");
    return { wire, snapshot, result };
  }
  const sent = await turn("example.txt");
  assert.equal(sent.result.isError, false);
  const text = sent.result.content?.[0]?.text;
  assert(text);
  const receipt = receiptSchema.parse(JSON.parse(text));
  const live = sent.wire.split("\n").filter(line => line.startsWith("data: ")).map(line => eventSchema.parse(JSON.parse(line.slice(6))))
    .find(event => event.type === "tool_execution_end" && event.toolName === "send_file");
  const liveText = z.object({ content: z.array(z.object({ text: z.string() })).min(1) }).parse(live?.result).content[0]?.text;
  assert(liveText);
  assert.deepEqual(receiptSchema.parse(JSON.parse(liveText)), receipt);
  assert(!sent.wire.includes(contents) && !JSON.stringify(sent.snapshot).includes(contents) && !modelBodies.join("\n").includes(contents));
  for (const path of ["../outside.txt", "missing.txt"]) assert.equal((await turn(path)).result.isError, true);
  const overQuota = await turn("large.txt");
  assert.equal(overQuota.result.isError, true);
  assert(overQuota.result.content?.some(part => part.text?.includes("attachment storage quota")));
  assert(!modelBodies.join("\n").includes(contents));
  const another = await server.post("/api/sessions", { cwd });
  assert.equal(another.status, 201);
  const other = z.object({ session: z.object({ id: z.uuid() }) }).parse(await another.json()).session.id;
  assert.equal((await server.get(`/api/sessions/${other}/attachments/${receipt.id}`)).status, 404);
  const download = await server.get(`${route}/attachments/${receipt.id}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), contents);
  await writeFile(join(cwd, "example.txt"), "changed after sending");
  await stop();
  const restarted = await connect();
  const persisted = await restarted.get(`${route}/attachments/${receipt.id}`);
  assert.equal(persisted.status, 200);
  assert.equal(await persisted.text(), contents);
  assert.equal((await restarted.post(`${route}/actions`, { action: "resume" })).status, 200);
  const history = snapshotSchema.parse(await (await restarted.get(route)).json());
  assert(history.messages.some(message => message.role === "toolResult" && message.toolName === "send_file" &&
    message.content?.some(part => part.text === text)));
  console.log(JSON.stringify({ entry, receipt, modelCalls: calls, downloads: "exact bytes",
    refused: ["outside", "missing", "configured quota", "other session"], preDownloadLeak: false, persisted: true }));
} finally {
  try { await stop(); } finally { provider.stop(true); await rm(root, { recursive: true, force: true }); }
}
