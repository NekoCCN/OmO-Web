import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server.ts";
import type { AppSettings } from "../src/server.ts";

const directory = await mkdtemp(join(tmpdir(), "omo-web-native-"));
const profile = join(directory, "profile");
const workspace = join(directory, "workspace");
const answer = "Native RPC stream verified.";
const modelId = "web-smoke";
const permissionMarker = "Please test the write approval flow.";
const blockedFile = join(workspace, "should-not-exist.txt");
let received = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const params = await request.json();
    assert.equal(params.model, modelId);
    received++;
    const data = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "chatcmpl-web-smoke", object: "chat.completion.chunk", created: 1795460000, model: modelId,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    if (JSON.stringify(params.messages.at(-1)).includes(permissionMarker)) {
      const write = params.tools.find((tool: { function: { name: string } }) => tool.function.name === "write");
      assert(write, "The real engine must publish its write tool");
      const pathKey = Object.hasOwn(write.function.parameters.properties, "path") ? "path" : "file_path";
      return new Response(data({ role: "assistant", tool_calls: [{
        index: 0, id: "call_web_smoke_write", type: "function",
        function: { name: "write", arguments: JSON.stringify({ [pathKey]: blockedFile, content: "not approved" }) },
      }] }, null) + data({}, "tool_calls") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(data({ role: "assistant", content: "Native RPC " }, null)
      + data({ content: "stream verified." }, null) + data({}, "stop") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
  },
});
let app: Awaited<ReturnType<typeof startApp>> | undefined;
try {
  await Promise.all([mkdir(profile), mkdir(workspace)]);
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "web-test": {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-dummy",
    models: [{ id: modelId, name: "Web Smoke Model", input: ["text"], contextWindow: 128000, maxTokens: 4000 }],
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "web-test", defaultModel: modelId }));
  process.env.OMO_CODING_AGENT_DIR = profile;
  const settings: AppSettings = {
    dataDir: join(directory, "web"), workspaces: [workspace], port: 0,
    engineCommand: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve"],
  };
  async function connect() {
    const connection = await startApp(settings);
    const origin = connection.url.origin;
    const get = async (path: string) => {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const boot = await get("/api/bootstrap");
    assert.equal(boot.engine.online, true, JSON.stringify(boot.engine));
    const post = async (path: string, body: object, status = 200) => {
      const response = await fetch(origin + path, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": boot.token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    };
    return { connection, origin, boot, get, post };
  }

  const first = await connect();
  app = first.connection;
  const created = await first.post("/api/sessions", { name: "Native smoke", cwd: workspace }, 201);
  const path = `/api/sessions/${created.session.id}`;
  const options = await first.get(`${path}/options`);
  assert(options.models.some((m: { id: string }) => m.id === modelId));
  await first.post(`${path}/actions`, { action: "model", provider: "web-test", modelId });
  const details = await first.get(`${path}/details`);
  assert.equal(details.stats.userMessages, 0);
  const stream = await fetch(`${first.origin}/api/events`, { signal: AbortSignal.timeout(20_000) });
  const reader = stream.body?.pipeThrough(new TextDecoderStream()).getReader();
  assert(reader, "Expected an SSE body");
  let wire = "";
  try {
    await first.post(`${path}/actions`, { action: "prompt", message: "Reply with the smoke-test marker." });
    while (!wire.includes('"type":"agent_settled"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      wire += chunk.value;
    }
  } finally {
    await reader.cancel();
  }
  assert(wire.includes('"type":"message_update"'), "Expected a real message_update event");
  assert(wire.includes(answer), "Expected the final text in the stream");
  assert.equal(received, 1);
  const initial = await first.get(path);
  assert.equal(initial.state.permissionPreset, "ask");
  assert(initial.messages.some((m: { role: string; content: { text?: string }[] }) =>
    m.role === "assistant" && m.content.some(block => block.text === answer)));

  const approvalEvents = await fetch(`${first.origin}/api/events`, { signal: AbortSignal.timeout(20_000) });
  const approvalReader = approvalEvents.body?.pipeThrough(new TextDecoderStream()).getReader();
  assert(approvalReader);
  let approvalWire = "";
  async function readUntil(reader: NonNullable<typeof approvalReader>, marker: string) {
    while (!approvalWire.includes(marker)) {
      const chunk = await reader.read();
      assert(!chunk.done, `Expected ${marker} before the stream closed`);
      approvalWire += chunk.value;
    }
  }
  try {
    await first.post(`${path}/actions`, { action: "prompt", message: permissionMarker });
    await readUntil(approvalReader, '"type":"extension_ui_request"');
    const pending = await first.get(path);
    const approval = pending.state.pendingDialogs.find((entry: { method: string }) => entry.method === "select");
    assert(approval?.options.includes("Deny"), "Expected an explicit native approval");
    await first.post(`${path}/actions`, { action: "answer", requestId: approval.id, value: "not an offered choice" }, 400);
    await first.post(`${path}/actions`, { action: "answer", requestId: approval.id, value: "Deny" });
    await readUntil(approvalReader, '"type":"agent_settled"');
    await assert.rejects(access(blockedFile), { code: "ENOENT" });
  } finally {
    await approvalReader.cancel();
  }
  const messages = (await first.get(path)).messages;
  assert(messages.some((m: { role: string; content: { text?: string }[] }) =>
    m.role === "assistant" && m.content.some(block => block.text === answer)));
  await first.post(`${path}/actions`, { action: "rename", name: "Native persisted" });
  await first.post(`${path}/actions`, { action: "archive", enabled: true });
  await first.connection.stop();

  const later = await connect();
  app = later.connection;
  assert.deepEqual(later.boot.sessions.map((s: { name: string; active: boolean; archived: boolean }) =>
    [s.name, s.active, s.archived]), [["Native persisted", false, true]]);
  await later.post(`${path}/actions`, { action: "resume" });
  const reopened = await later.get(path);
  assert.deepEqual(reopened.messages, messages);
  console.log(`NATIVE PASS · ${later.boot.engine.version} · stream, explicit tool denial, restart and resume`);
} finally {
  await app?.stop();
  await provider.stop(true);
  await rm(directory, { recursive: true, force: true });
}
