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
const cliMarker = "CLI history smoke test.";
const commandMarker = "Native template expansion for workbench smoke.";
const blockedFile = join(workspace, "should-not-exist.txt");
let received = 0;
let expandedCommand = false;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const params = await request.json();
    assert.equal(params.model, modelId);
    received++;
    if (JSON.stringify(params.messages.at(-1)).includes(commandMarker)) expandedCommand = true;
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
  await Promise.all([mkdir(join(profile, "prompts"), { recursive: true }), mkdir(workspace)]);
  await writeFile(join(profile, "prompts", "web-workbench-smoke.md"), commandMarker + "\n");
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "web-test": {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-dummy",
    models: [{ id: modelId, name: "Web Smoke Model", input: ["text"], contextWindow: 128000, maxTokens: 4000 }],
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "web-test", defaultModel: modelId }));
  process.env.OMO_CODING_AGENT_DIR = profile;
  const settings: AppSettings = {
    dataDir: join(directory, "web"), workspaces: [workspace], port: 0,
    cliAgentDir: profile,
    engineCommand: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve", "--session-runtime", "in-process"],
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
  assert(options.commands.some((row: { invocation?: string }) => row.invocation === "/web-workbench-smoke"),
    "Expected the loaded native prompt template with an executable Web invocation");
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

  const commandSession = await later.post("/api/sessions", { cwd: workspace, name: "Native command smoke" }, 201);
  const commandPath = `/api/sessions/${commandSession.session.id}`;
  const commandEvents = await fetch(`${later.origin}/api/events`, { signal: AbortSignal.timeout(20_000) });
  const commandReader = commandEvents.body?.pipeThrough(new TextDecoderStream()).getReader();
  assert(commandReader);
  try {
    approvalWire = "";
    await later.post(`${commandPath}/actions`, { action: "command", invocation: "/web-workbench-smoke" });
    await readUntil(commandReader, '"type":"agent_settled"');
    assert(expandedCommand, "The native provider should receive the expanded template, not its invocation");
  } finally {
    await commandReader.cancel();
  }

  const cli = Bun.spawn([settings.engineCommand[0], "-p", "--offline", "--no-approve", "--name", "CLI smoke history", cliMarker], {
    cwd: workspace, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000,
  });
  const [cliCode, , cliError] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  assert.equal(cliCode, 0, cliError);
  const history = await later.get("/api/cli-history");
  const cliSession = history.sessions.find((row: { name: string }) => row.name === "CLI smoke history");
  assert(cliSession, "The native CLI session must appear independently of the Web registry");
  const cliSnapshot = await later.get(`/api/cli-history/${encodeURIComponent(cliSession.id)}`);
  assert(cliSnapshot.messages.some((m: { role: string; content: { text?: string }[] }) =>
    m.role === "assistant" && m.content.some(block => block.text === answer)));
  assert(!(await later.get("/api/sessions")).sessions.some((row: { name: string }) => row.name === "CLI smoke history"));
  console.log(`NATIVE PASS · ${later.boot.engine.version} · stream, explicit tool denial, restart and resume, template execution, CLI-created read-only history`);
} finally {
  await app?.stop();
  await provider.stop(true);
  await rm(directory, { recursive: true, force: true });
}
