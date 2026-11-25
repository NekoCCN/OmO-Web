import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { array, record } from "../src/protocol.ts";
import { startApp } from "../src/server.ts";

const cliMain = process.argv[2];
assert(cliMain && cliMain.endsWith("/dist/cli-main.js") && await Bun.file(cliMain).exists(),
  "Usage: bun --no-orphans scripts/verify-cli-live.ts /absolute/runtime/dist/cli-main.js");

const root = await realpath(await mkdtemp(join(tmpdir(), "omo-web-cli-live-")));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const modelId = "cli-live-proof-model";
const rand = Math.random().toString(36).slice(2, 8);
const ptyFirst = `cli-live pty first ${rand}`;
const ptySecond = `cli-live pty second ${rand}`;
const webMarker = `cli-live web prompt ${rand}`;
const markers = [ptyFirst, ptySecond, webMarker];

const seen: string[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const body = record(await request.json());
    assert.equal(body.model, modelId);
    const last = record(array(body.messages).at(-1));
    const content = last.content;
    const text = typeof content === "string"
      ? content
      : array(content).map((part) => String(record(part).text ?? "")).join("");
    const latest = markers.reduce((best, marker) =>
      text.lastIndexOf(marker) > text.lastIndexOf(best) ? marker : best, "\0");
    const hit = latest === "\0" ? "unmarked-live" : latest;
    seen.push(hit);
    const event = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
      id: "cli-live-proof", model: modelId, object: "chat.completion.chunk", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    return new Response(event({ role: "assistant", content: "Mock reply to " }, null)
      + event({ content: hit }, null) + event({}, "stop") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  },
});

const env: Record<string, string> = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(root, "home"),
  TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  OMO_CODING_AGENT_DIR: profile,
  SENPI_CODING_AGENT_DIR: profile,
  PI_CODING_AGENT_DIR: profile,
  SENPI_TEST_AGENT_DIR_GUARD: "1",
  TERM: "xterm-256color",
  NO_PROXY: "127.0.0.1,localhost",
};
const entry = [process.execPath, "--no-orphans", "--no-env-file", cliMain] as const;
const rpc = ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ...entry, "--mode", "rpc", "--multi-session", "--offline", "--no-approve"] as unknown as readonly [string, ...string[]];

let app: Awaited<ReturnType<typeof startApp>> | undefined;
let stopTui: (() => Promise<void>) | undefined;
let tuiOutput = "";

function textOf(value: unknown): string {
  const content = record(value).content;
  if (typeof content === "string") return content;
  return array(content).map((part) => String(record(part).text ?? "")).join("");
}

function liveTextOf(value: unknown): string {
  const content = record(value).content;
  return typeof content === "string" ? content : "";
}

async function until<T>(label: string, read: () => Promise<T | undefined>, ms = 45_000): Promise<T> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const found = await read();
    if (found !== undefined) return found;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(env.HOME, { recursive: true }),
    mkdir(env.TMPDIR, { recursive: true }), mkdir(join(profile, "extensions"), { recursive: true })]);
  await writeFile(join(profile, "settings.json"), JSON.stringify({
    defaultProvider: "cli-live-proof", defaultModel: modelId, quietStartup: true }) + "\n");
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "cli-live-proof": {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "live-test-token",
    models: [{ id: modelId, name: modelId, input: ["text"], contextWindow: 128000, maxTokens: 4000 }],
  } } }) + "\n");
  await writeFile(join(profile, "extensions", "cli-live-control-endpoint.ts"), `
export default function(pi) {
  pi.on("session_start", async () => {
    const dir = (process.env.OMO_CODING_AGENT_DIR || process.env.SENPI_CODING_AGENT_DIR || "") + "/control-inbox";
    await pi.session.registerControlEndpoint({
      inboxDir: dir,
      drain: async () => ({ admitted: [] }),
    });
  });
}
`);

  app = await startApp({
    dataDir: join(root, "web"), workspaces: [workspace], port: 0,
    cliAgentDir: profile, engineCommand: rpc,
  });
  const origin = app.url.origin;
  const boot = record(await (await fetch(`${origin}/api/bootstrap`)).json());
  const token = boot.token;
  assert(typeof token === "string" && token.length > 0, "Expected an opaque app token");

  async function get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(origin + path, { signal: AbortSignal.timeout(15_000) });
    const body = record(await res.json());
    assert.equal(res.status, 200, path);
    return body;
  }

  async function post(path: string, payload: unknown, status = 200): Promise<Record<string, unknown>> {
    const res = await fetch(origin + path, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": String(token) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    const body = record(await res.json());
    assert.equal(res.status, status, path);
    return body;
  }

  async function postRaw(path: string, payload: unknown): Promise<{ status: number; code: string }> {
    const res = await fetch(origin + path, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": String(token) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    const body = record(await res.json());
    const code = typeof body.code === "string" ? body.code : `http-${res.status}`;
    return { status: res.status, code };
  }

  const tui = Bun.spawn([...entry, "--offline", "--no-approve", ptyFirst], { cwd: workspace, env,
    timeout: 120_000, killSignal: "SIGKILL",
    terminal: { cols: 106, rows: 34, data(_terminal, chunk) {
      tuiOutput = (tuiOutput + Buffer.from(chunk).toString("utf8")).slice(-32768);
    } } });
  stopTui = async () => {
    try {
      if (tui.exitCode === null) tui.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([tui.exited, new Promise<void>((resolve) => { timer = setTimeout(() => {
          if (tui.exitCode === null) tui.kill("SIGKILL");
          resolve();
        }, 2_000); })]);
      } finally { clearTimeout(timer); }
      await tui.exited;
    } finally { tui.terminal?.close(); }
  };
  assert(tui.terminal, "Owned PTY did not allocate a terminal");
  const terminal = tui.terminal;

  const live = await until("owned TUI registers a real control endpoint", async () => {
    const listing = await get("/api/cli-live");
    if (listing.available !== true) return undefined;
    const row = array(listing.sessions).map(record).find((item) => item.cwd === workspace);
    if (!row || typeof row.id !== "string") return undefined;
    return { id: String(row.id), cwd: String(row.cwd) };
  });
  assert.match(live.id, /^[a-f0-9]{64}$/);
  console.log("PASS live discovery: real TUI endpoint registered for owned workspace");

  const beforeConnect = await (async () => {
    const res = await fetch(`${origin}/api/cli-live/${live.id}`, { signal: AbortSignal.timeout(15_000) });
    const body = record(await res.json());
    return { status: res.status, code: typeof body.code === "string" ? body.code : "unknown" };
  })();
  assert.equal(beforeConnect.status, 409, "unattached snapshot must require connect");
  console.log("PASS explicit connect required: unattached snapshot refused");

  let snapshot = await post(`/api/cli-live/${live.id}/actions`, { action: "connect" });
  assert.equal(String(record(snapshot.session).id), live.id, "attach must return the opaque live session");
  console.log("PASS attach: real TUI endpoint attached without touching user data");

  await until("initial owned TUI turn settles into Web transcript", async () => {
    snapshot = await get(`/api/cli-live/${live.id}`);
    const texts = array(snapshot.messages).map(liveTextOf).join("\n");
    if (texts.includes(ptyFirst) && texts.includes(`Mock reply to ${ptyFirst}`)) return true;
    return undefined;
  });
  assert(seen.includes(ptyFirst), "Owned TUI turn must reach the mock model request");
  console.log("PASS CLI PTY input to Web transcript: initial TUI turn visible via app");

  terminal.write(ptySecond);
  terminal.write("\r");
  await until("second PTY turn appears in attached Web transcript", async () => {
    snapshot = await get(`/api/cli-live/${live.id}`);
    const texts = array(snapshot.messages).map(liveTextOf).join("\n");
    if (texts.includes(ptySecond) && texts.includes(`Mock reply to ${ptySecond}`)) return true;
    return undefined;
  });
  console.log("PASS CLI PTY keystrokes stream to attached Web snapshot");

  const webClientId = `web-${rand}-1`;
  const inputResult = record(await post(`/api/cli-live/${live.id}/actions`,
    { action: "input", mode: "prompt", message: webMarker, clientMessageId: webClientId }));
  assert(["started", "queued", "held"].includes(String(inputResult.disposition)), "unexpected input disposition");
  assert.equal(inputResult.clientMessageId, webClientId);
  assert.equal(inputResult.duplicate, false);
  const pendingState = String(inputResult.disposition);
  snapshot = await get(`/api/cli-live/${live.id}`);
  const snapState = record(snapshot.state);
  assert(typeof snapState.running === "boolean", "snapshot must distinguish active running state");
  assert(snapState.turnId === null || typeof snapState.turnId === "string", "snapshot must carry a turn id or null");
  console.log(`PASS Web input accepted by exact CLI session: disposition=${pendingState} running=${String(snapState.running)}`);

  await until("attached Web prompt settles in the same CLI session", async () => {
    snapshot = await get(`/api/cli-live/${live.id}`);
    const texts = array(snapshot.messages).map(liveTextOf).join("\n");
    if (texts.includes(webMarker) && texts.includes(`Mock reply to ${webMarker}`)) return true;
    return undefined;
  });
  assert(seen.includes(webMarker), "Attached Web prompt must reach the mock model request");
  const transcriptEvidence = array(snapshot.messages).map(liveTextOf).join("\n").includes(`Mock reply to ${webMarker}`);
  assert(transcriptEvidence, "Native transcript must carry the Web-driven reply");
  const ttyEvidence = tuiOutput.includes(`Mock reply to ${webMarker}`);
  console.log(`PASS Web prompt reaches exact CLI session: model request and native transcript evidence tty=${ttyEvidence}`);
  assert.equal(tui.exitCode, null, "Web input must not end the owned CLI");

  const dup = record(await post(`/api/cli-live/${live.id}/actions`,
    { action: "input", mode: "prompt", message: webMarker, clientMessageId: webClientId }));
  assert.equal(dup.duplicate, true, "Same clientMessageId must report duplicate");
  assert.equal(dup.clientMessageId, webClientId);
  console.log(`PASS active/pending result state distinguished: duplicate=true disposition=${String(dup.disposition)}`);

  const idleState = record(snapshot.state);
  const idleTurnId = typeof idleState.turnId === "string" ? idleState.turnId : null;
  if (idleTurnId) {
    const wrong = await postRaw(`/api/cli-live/${live.id}/actions`, { action: "stop", expectedTurnId: `${idleTurnId}999` });
    assert([409, 400].includes(wrong.status), "wrong later turn token must be refused");
    console.log(`PASS stop is targeted: wrong later turn token refused (${wrong.code})`);
  } else {
    console.log("SKIP stop targeting: no idle turn id to mismatch");
  }
  const stopAttempt = await postRaw(`/api/cli-live/${live.id}/actions`,
    { action: "stop", expectedTurnId: idleTurnId ?? "0" });
  console.log(`EVIDENCE stop attempt on idle CLI: status=${stopAttempt.status} code=${stopAttempt.code}`);
  assert.equal(tui.exitCode, null, "Stop attempt must not end the owned CLI process");

  const detached = record(await post(`/api/cli-live/${live.id}/actions`, { action: "disconnect" }));
  assert.equal(detached.detached, true);
  assert.equal(tui.exitCode, null, "Explicit detach must not end the CLI");
  const afterDetach = await (async () => {
    const res = await fetch(`${origin}/api/cli-live/${live.id}`, { signal: AbortSignal.timeout(15_000) });
    return res.status;
  })();
  assert.equal(afterDetach, 409, "detached snapshot must require re-attach");
  const relist = await get("/api/cli-live");
  assert(array(relist.sessions).map(record).some((item) => item.id === live.id), "detached CLI must remain listed");
  console.log("PASS explicit detach releases only Web: CLI alive, listed, snapshot requires re-attach");

  snapshot = await post(`/api/cli-live/${live.id}/actions`, { action: "connect" });
  await until("re-attached CLI still streams", async () => {
    const current = await get(`/api/cli-live/${live.id}`);
    if (array(current.messages).map(liveTextOf).join("\n").includes(`Mock reply to ${webMarker}`)) return true;
    return undefined;
  });
  const beforeBranch = array((await get(`/api/cli-live/${live.id}`)).messages).map(liveTextOf).join("\n");
  const options = await get(`/api/cli-live/${live.id}/branch-options`);
  assert.equal(options.canClone, true, "expected a cloneable idle leaf");
  const forkMessages = array(options.forkMessages).map(record);
  assert(forkMessages.length > 0, "Expected forkable CLI messages");
  const target = forkMessages.find((item) => String(item.text).includes(ptySecond)) ?? forkMessages[0];
  assert(target && typeof target.entryId === "string", "Expected a fork entry id");
  const targetText = String(record(target).text);
  const targetEntryId = String(record(target).entryId);

  const fork = record(await post(`/api/cli-live/${live.id}/branches`, { kind: "fork", entryId: targetEntryId }, 201));
  assert(!fork.cancelled && record(fork.session).id, "Fork must open an independent Web session");
  const forkId = String(record(fork.session).id);
  assert(forkId !== live.id, "Fork Web id must be newly generated");
  assert(String(fork.editorText ?? "").includes(targetText.slice(0, 20)), "Fork must return the selected text as unsent draft");
  const forkSnap = await get(`/api/sessions/${forkId}`);
  const forkTexts = array(forkSnap.messages).map(textOf).join("\n");
  assert(forkTexts.includes(ptyFirst), "Fork must carry native saved messages");
  console.log("PASS true Fork via app: new Web session with native prefix, draft unsent");

  const clone = record(await post(`/api/cli-live/${live.id}/branches`, { kind: "clone" }, 201));
  assert(!clone.cancelled && record(clone.session).id, "Clone must open an independent Web session");
  const cloneId = String(record(clone.session).id);
  assert(cloneId !== live.id && cloneId !== forkId, "Clone id must be newly generated and distinct");
  assert(clone.editorText === undefined, "Clone must not fabricate a draft");
  const cloneSnap = await get(`/api/sessions/${cloneId}`);
  const cloneTexts = array(cloneSnap.messages).map(textOf).join("\n");
  assert(cloneTexts.includes(ptyFirst) && cloneTexts.includes(webMarker), "Clone must carry native saved messages at the leaf");
  console.log("PASS true Clone via app: new Web session with full native leaf");

  const afterBranch = array((await get(`/api/cli-live/${live.id}`)).messages).map(liveTextOf).join("\n");
  assert.equal(afterBranch, beforeBranch, "Original CLI read must be unaffected by Web branches");
  const sessionsList = await get("/api/sessions");
  const ids = array(sessionsList.sessions).map((item) => String(record(item).id));
  assert(ids.includes(forkId) && ids.includes(cloneId), "Branched Web sessions must be registered");
  assert(!ids.includes(live.id), "Live CLI id must never leak into the Web registry");
  console.log("PASS branches leave original identity/read unaffected; IDs independent");

  console.log(`NATIVE_CLI_LIVE_OK disposition=${pendingState} tty=${ttyEvidence}`);
} finally {
  try { await stopTui?.(); } finally {
    try { await app?.stop(); } finally {
      provider.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
}
