import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { startApp } from "../src/server.ts";

/**
 * Shared-store lane verifier through the production entry (startApp) with the
 * real `omo` binary, an isolated profile, and a loopback model.
 *
 * Proves, in order: the Web host is private (bootstrap reports handoff
 * supported); a Web create lands in the native profile bucket with a bound
 * durable id; a naked stock `omo --session` is refused while Web holds it;
 * deliberate handoff releases quietly with a quoted local command; a second
 * opener reads the same journal while Web resume is refused (and vice versa
 * after the forced release); and a custom settings.json sessionDir does not
 * move pathless placement (documented as unsupported).
 *
 * Run: `bun scripts/verify-shared-store.ts` (needs `omo` on PATH or
 * OMO_WEB_BIN). Uses TMPDIR, XDG_RUNTIME_DIR or the OS temporary directory.
 */
function executable(name: string): string {
  const found = Bun.which(name);
  assert(found, `This verifier needs the executable ${name}.`);
  return found;
}
const bin = executable(process.env.OMO_WEB_BIN || "omo");
const envProgram = executable("env");
const runtimeBase = process.env.TMPDIR || process.env.XDG_RUNTIME_DIR || tmpdir();
const root = await mkdtemp(join(runtimeBase, "omo-shared-store-"));
const profile = join(root, "profile");
const home = join(root, "home");
const workspace = join(root, "workspace");
await Promise.all([mkdir(profile, { recursive: true }), mkdir(home, { recursive: true }), mkdir(workspace)]);
const env = {
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), HOME: home, TMPDIR: root,
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
  OMO_CODING_AGENT_DIR: profile, SENPI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_DIR: profile,
  OMO_RPC_CLIENT_CAPABILITIES: "question", SENPI_RPC_CLIENT_CAPABILITIES: "question",
  PI_RPC_CLIENT_CAPABILITIES: "question", SENPI_TEST_AGENT_DIR_GUARD: "1",
  TERM: "xterm-256color", NO_COLOR: "1", NO_PROXY: "127.0.0.1,localhost",
};
const webSeed = "SHARED-VERIFY-SEED";
const cliSeed = "CLI-TURN-AFTER-HANDOFF";

const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const input = await request.json() as { messages?: unknown[] };
  const last = JSON.stringify(input.messages?.at(-1) ?? "");
  assert.match(last, /SHARED-VERIFY-SEED|CLI-TURN-AFTER-HANDOFF/, "loopback provider saw an unexpected prompt");
  const event = (delta: object, reason: null | "stop") => `data: ${JSON.stringify({
    id: "shared-verify", object: "chat.completion.chunk", created: 1, model: "loop-model",
    choices: [{ index: 0, delta, finish_reason: reason }],
  })}\n\n`;
  return new Response(event({ role: "assistant", content: `Reply ${last.slice(0, 64)}` }, null)
    + event({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
} });
async function writeSettings(extra: Record<string, unknown> = {}) {
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { loop: {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-dummy",
    models: [{ id: "loop-model", name: "Loopback", input: ["text"], contextWindow: 128000, maxTokens: 4000 }],
  } } }));
  await writeFile(join(profile, "settings.json"),
    JSON.stringify({ defaultProvider: "loop", defaultModel: "loop-model", ...extra }));
}
await writeSettings();

function rpcClient(name: string, extraArgs: string[] = []) {
  const child = Bun.spawn([bin, "--mode", "rpc", "--multi-session", "--offline", "--no-approve", ...extraArgs], {
    cwd: workspace, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let buffer = "";
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  let sequence = 0;
  const reader = child.stdout.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done) break;
      if (value) {
        buffer += decoder.decode(value);
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith("{")) {
            try {
              const frame = JSON.parse(line) as Record<string, unknown>;
              if (frame.type === "response" && typeof frame.id === "string") pending.get(frame.id)?.(frame);
            } catch { /* ignore */ }
          }
          index = buffer.indexOf("\n");
        }
      }
    }
  })();
  const request = (type: string, fields: Record<string, unknown> = {}, timeoutMs = 25_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `${name}-${++sequence}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} timed out on ${type}`)); }, timeoutMs);
      pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
      child.stdin.write(JSON.stringify({ ...fields, id, type }) + "\n");
    });
  return { request, stop: () => child.kill("SIGKILL") };
}
const succeed = async (client: ReturnType<typeof rpcClient>, type: string, fields: Record<string, unknown> = {}) => {
  const frame = await client.request(type, fields);
  assert.equal(frame.success, true, `${type} refused: ${JSON.stringify(frame).slice(0, 400)}`);
  return frame.data as Record<string, unknown>;
};

let app: Awaited<ReturnType<typeof startApp>> | undefined;
try {
  app = await startApp({
    dataDir: join(root, "web"), workspaces: [workspace], port: 0, cliAgentDir: profile,
    engineCommand: [envProgram, "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      bin, "--mode", "rpc", "--multi-session", "--offline", "--no-approve",
      "--session-runtime", "in-process"],
  });
  const origin = app.url.origin;
  const boot = await (await fetch(`${origin}/api/bootstrap`)).json() as {
    token: string; engine: { online: boolean }; handoff: { supported: boolean; reason?: string };
  };
  assert.equal(boot.engine.online, true, "production engine did not come online");
  assert.equal(boot.handoff.supported, true, `expected a private host: ${JSON.stringify(boot.handoff)}`);
  console.log("1. private host: handoff supported");
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": boot.token };
  const post = async (path: string, body: unknown, status = 200) => {
    const response = await fetch(`${origin}${path}`,
      { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(response.status, status, `${path}: ${JSON.stringify(payload).slice(0, 400)}`);
    return payload;
  };
  const get = async (path: string, status = 200) => {
    const response = await fetch(`${origin}${path}`, { headers: { Origin: origin }, signal: AbortSignal.timeout(30_000) });
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(response.status, status, `${path}: ${JSON.stringify(payload).slice(0, 400)}`);
    return payload;
  };

  const created = await post("/api/sessions", { cwd: workspace, name: "Shared verify" }, 201);
  const webId = (created.session as { id: string }).id;
  const bucket = join(profile, "sessions", `--${workspace.slice(1).replace(/[/\\:]/g, "-")}--`);
  const journals = (await readdir(bucket)).filter(name => name.endsWith(".jsonl"));
  assert.equal(journals.length, 1, `expected one native journal, saw ${journals.join(",")}`);
  const journal = join(bucket, journals[0]);
  const header = JSON.parse((await readFile(journal, "utf8")).split("\n", 1)[0]) as {
    type: string; version: number; id: string; cwd: string;
  };
  assert.deepEqual({ type: header.type, version: header.version, cwd: header.cwd }, { type: "session", version: 3, cwd: workspace });
  console.log(`2. Web create placed natively: ${journal} (durable ${header.id})`);

  await post(`/api/sessions/${webId}/actions`,
    { action: "prompt", message: webSeed, clientMessageId: crypto.randomUUID() });
  const snapshot = await get(`/api/sessions/${webId}`);
  const rendered = JSON.stringify((snapshot as { messages: unknown }).messages);
  assert.match(rendered, new RegExp(webSeed), "prompt turn missing from the Web snapshot");
  console.log("3. prompt turn answered through the private host");

  const history = await get("/api/cli-history") as {
    available: boolean; sessions: { id: string; adopted: boolean; cwd: string }[];
  };
  assert.equal(history.available, true);
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].adopted, true);
  console.log("4. CLI history discovers the Web journal and coalesces the alias");

  const naked = Bun.spawn([bin, "--session", journal], { cwd: workspace, env,
    stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try { (naked.stdin as unknown as { close: () => void }).close?.(); } catch { /* ignore */ }
  let nakedErr = "";
  const gutter = (async () => {
    const reader = naked.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done) break;
      if (value) nakedErr += decoder.decode(value);
    }
  })();
  const nakedEnd = await Promise.race([naked.exited.then(() => "exited"), Bun.sleep(25_000).then(() => "timeout")]);
  if (nakedEnd === "timeout") naked.kill("SIGKILL");
  await gutter;
  await naked.exited.catch(() => undefined);
  assert.notEqual(naked.exitCode, 0, "a naked stock CLI must not open a Web-held journal");
  assert.match(nakedErr, /multi-session host/, `unexpected naked CLI output: ${nakedErr.slice(-400)}`);
  console.log(`5. naked stock CLI refused while Web holds (exit ${naked.exitCode})`);

  const receipt = await post(`/api/sessions/${webId}/handoff`, {});
  const command = (receipt as { command: string }).command;
  assert.match(command, new RegExp(journal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(command, /token|sock/i);
  assert.match(await readFile(journal, "utf8"), /session_released/);
  const listed = await get("/api/sessions") as { sessions: { id: string; active: boolean }[] };
  assert.deepEqual(listed.sessions.map(row => [row.id, row.active]), [[webId, false]]);
  console.log("6. deliberate handoff released quietly with a quoted local command");

  // Same host shape as the Web engine: without the in-process runtime the
  // native answers release_unsupported (verified worker_runtime detail).
  const peer = rpcClient("peer", ["--session-runtime", "in-process"]);
  try {
    const opened = await succeed(peer, "open_session", { cwd: workspace, sessionPath: journal,
      permissionPreset: "ask", kind: "interactive" });
    assert.equal((opened.state as { sessionId: string }).sessionId, header.id);
    // Mirror the production bridge: identify the client before driving turns.
    await succeed(peer, "set_client_info", { width: 96, capabilities: ["interactive_user", "question"] });
    // Reopening from the same holder attaches to its own route; a different
    // holder is refused instead (proven by the Web resume below).
    const reentry = await peer.request("open_session", { cwd: workspace, sessionPath: journal });
    assert.equal(reentry.success, true);
    assert.equal((reentry.data as { attached: boolean }).attached, true);
    if (process.env.SHARED_VERIFY_DEBUG) {
      console.log(`peer routes: ${JSON.stringify((await succeed(peer, "list_sessions") as { sessions: unknown }).sessions)}`);
    }
    await post(`/api/sessions/${webId}/actions`, { action: "resume" }, 409);
    const refusedBody = await post(`/api/sessions/${webId}/actions`, { action: "resume" }, 409);
    assert.equal((refusedBody as { code: string }).code, "session_held");
    console.log("7. second opener reads the same journal; Web resume is refused while it holds");
    await succeed(peer, "prompt", { sessionId: opened.sessionId as string, message: cliSeed });
    // The prompt RPC only starts the turn: wait until the assistant reply to
    // this seed is journaled before modelling the CLI exit.
    const settled = Date.now() + 60_000;
    for (;;) {
      const history = await succeed(peer, "get_messages", { sessionId: opened.sessionId as string }) as {
        messages: unknown[];
      };
      if (process.env.SHARED_VERIFY_DEBUG) console.log(`peer messages: ${JSON.stringify(history.messages).slice(0, 600)}`);
      const texts = history.messages.map(entry => JSON.stringify((entry as { message?: { content?: unknown } }).message?.content ?? entry));
      const seen = texts.findIndex(text => text.includes(cliSeed));
      if (seen >= 0 && texts.slice(seen).some(text => !text.includes(cliSeed))) break;
      assert(Date.now() < settled, `peer turn never journaled the seed: ${texts.join(" | ").slice(-500)}`);
      await Bun.sleep(500);
    }
    // Model the stock CLI lifecycle: no explicit takeover release is sent on
    // exit. Killing the peer must free the holder so Web resume is admitted.
    // (An explicit force during a live turn is refused turn_active by native;
    // the Web handoff path never forces a busy session either.)
    peer.stop();
    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await fetch(`${origin}/api/sessions/${webId}/actions`,
        { method: "POST", headers, body: JSON.stringify({ action: "resume" }), signal: AbortSignal.timeout(30_000) });
      if (response.status === 200) break;
      const payload = await response.json() as { code?: string };
      assert(Date.now() < deadline, `Web resume never readmitted: ${JSON.stringify(payload)}`);
      assert.equal(payload.code, "session_held");
      await Bun.sleep(500);
    }
    const after = await get(`/api/sessions/${webId}`) as { messages: unknown };
    const both = JSON.stringify(after.messages);
    assert.match(both, new RegExp(webSeed));
    assert.match(both, new RegExp(cliSeed));
    console.log("8. peer exit frees the holder; Web resumes the same transcript");
  } finally {
    peer.stop();
  }

  await writeSettings({ sessionDir: join(root, "custom-dir") });
  const createdCustom = await post("/api/sessions", { cwd: workspace, name: "Custom dir probe" }, 201);
  const customId = (createdCustom.session as { id: string }).id;
  void customId;
  const journalsAfter = (await readdir(bucket)).filter(name => name.endsWith(".jsonl"));
  assert.equal(journalsAfter.length, 2, `custom sessionDir must not move pathless placement: ${journalsAfter.join(",")}`);
  const customEntries = await readdir(join(root, "custom-dir")).catch((): string[] => []);
  assert.equal(customEntries.filter(name => name.endsWith(".jsonl")).length, 0);
  console.log("9. custom settings.json sessionDir ignored by pathless open (unsupported, stays default)");

  console.log(`SHARED-STORE-VERIFY-OK root=${root}`);
} finally {
  await app?.stop();
  await provider.stop();
  if (!process.env.SHARED_VERIFY_KEEP) await rm(root, { recursive: true, force: true });
  else console.log(`kept scratch root=${root}`);
}
