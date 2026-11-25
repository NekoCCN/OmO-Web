import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliHistory } from "../src/cli-history.ts";
import { Engine } from "../src/engine.ts";
import { array, record } from "../src/protocol.ts";
import type { SessionKey, WireObject } from "../src/protocol.ts";
import { Sessions } from "../src/sessions.ts";
import type { BranchResult } from "../src/sessions.ts";

// Pass the installed runtime's direct dist/cli-main.js. Skipping the launcher
// keeps all runtime snapshots and their claim writes out of the real install.
const cliMain = process.argv[2];
assert(cliMain && cliMain.endsWith("/dist/cli-main.js") && await Bun.file(cliMain).exists(),
  "Usage: bun --no-orphans scripts/verify-session-branches.ts /absolute/runtime/dist/cli-main.js");
const root = await realpath(await mkdtemp(join(tmpdir(), "omo-web-branch-proof-")));
const cwd = join(root, "workspace");
const profile = join(root, "profile");
const store = join(root, "web", "sessions");
const modelId = "branch-proof-model";
const cancelledEntry = "cancel-entry";
const busyStarted = Promise.withResolvers<void>();
const releaseBusy = Promise.withResolvers<void>();
const prompts: string[] = [];
const markers = ["first Web turn", "second Web turn", "continue Web clone", "continue original Web",
  "first CLI turn", "second CLI turn", "continue CLI-derived Web fork", "continue original CLI", "busy source fixture"];
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  assert.equal(request.headers.get("Authorization"), "Bearer branch-test-token");
  const input = record(await request.json());
  assert.equal(input.model, modelId);
  const content = record(array(input.messages).at(-1)).content;
  const text = typeof content === "string" ? content : array(content).map(item => record(item).text).join("");
  // Native adds reminders and can coalesce consecutive user entries for this provider.
  const prompt = markers.reduce((latest, marker) => text.lastIndexOf(marker) > text.lastIndexOf(latest) ? marker : latest,
    "\0");
  assert.notEqual(prompt, "\0", "Expected an owned test marker in the native provider request");
  prompts.push(prompt);
  if (prompt === "busy source fixture") {
    busyStarted.resolve();
    await releaseBusy.promise;
  }
  const event = (delta: WireObject, finish_reason: null | "stop") => `data: ${JSON.stringify({
    id: "branch-proof-completion", model: modelId, object: "chat.completion.chunk", created: 1,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  return new Response(event({ role: "assistant", content: `Mock reply to ${prompt}` }, null) +
    event({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
} });

const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
  OMO_CODING_AGENT_DIR: profile, SENPI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_DIR: profile,
  SENPI_TEST_AGENT_DIR_GUARD: "1", TERM: "xterm-256color", NO_PROXY: "127.0.0.1,localhost",
};
const entry = [process.execPath, "--no-orphans", "--no-env-file", cliMain] as const;
const rpc = ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ...entry, "--mode", "rpc", "--multi-session", "--offline", "--no-approve"] as const;

class WitnessEngine extends Engine {
  readonly routes = new Map<string, string>();
  sawLazyBranch = false;

  override async request(type: string, fields?: WireObject, timeout?: number) {
    const result = await super.request(type, fields, timeout);
    if (type === "open_session" && typeof result.sessionId === "string" && typeof fields?.sessionPath === "string") {
      this.routes.set(fields.sessionPath, result.sessionId);
    }
    return result;
  }

  override async requestExisting(type: string, fields?: WireObject, timeout?: number) {
    const result = await super.requestExisting(type, fields, timeout);
    if (type === "get_state" && typeof result.sessionFile === "string" &&
      result.sessionFile.includes(".omo-web-branch-") && !result.sessionFile.endsWith("/source.jsonl") &&
      !await Bun.file(result.sessionFile).exists()) this.sawLazyBranch = true;
    return result;
  }
}

const engine = new WitnessEngine(rpc, cwd, event => sessions.event(event), () => {});
const sessions = new Sessions(dirname(store), [cwd], engine, () => {});
const history = new CliHistory(profile, [cwd]);
let stopCli: (() => Promise<void>) | undefined;

async function until<T>(label: string, read: () => Promise<T | undefined>, ms = 12_000): Promise<T> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const found = await read();
    if (found !== undefined) return found;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function messages(id: SessionKey) {
  return (await sessions.snapshot(id)).messages.map(messageText);
}

function messageText(value: unknown) {
  const { content } = record(value);
  return typeof content === "string" ? content : array(content).map(part => record(part).text).join("");
}

async function settled(id: SessionKey, marker: string) {
  let witness: Pick<Awaited<ReturnType<Sessions["snapshot"]>>, "session" | "state" | "messages"> | undefined;
  try {
    await until(`Web settle ${marker}`, async () => {
      witness = await sessions.snapshot(id);
      if (witness.state.isStreaming) return;
      if (witness.messages.map(messageText).includes(`Mock reply to ${marker}`)) return true;
      const response = witness.messages.map(record).findLast(entry => entry.role === "assistant");
      if (response?.errorMessage) throw new Error(`Owned mock turn failed: ${String(response.errorMessage)}`);
    });
  } catch (error) {
    console.error("Owned mock turn evidence", JSON.stringify({
      prompts, streaming: witness?.state.isStreaming, model: record(witness?.state).model,
      recentMessages: witness?.messages.slice(-3),
    }).slice(0, 2400));
    throw error;
  }
}

async function prompt(id: SessionKey, message: string) {
  await sessions.action(id, { action: "prompt", mode: "prompt", message });
}

function opened(result: BranchResult) {
  assert(!result.cancelled && result.session);
  return result;
}

try {
  await Promise.all([mkdir(cwd), mkdir(env.HOME), mkdir(env.TMPDIR), mkdir(join(profile, "extensions"), { recursive: true })]);
  await writeFile(join(profile, "settings.json"), JSON.stringify({
    defaultProvider: "branch-proof", defaultModel: modelId, quietStartup: true,
  }));
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "branch-proof": {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "branch-test-token",
    models: [{ id: modelId, name: modelId, input: ["text"], contextWindow: 128000, maxTokens: 4000 }],
  } } }));
  await writeFile(join(profile, "extensions", "branch-veto.ts"), `export default pi => {
    pi.on("session_before_fork", event => {
      if (event.entryId === ${JSON.stringify(cancelledEntry)}) return { cancel: true };
    });
  };`);
  await sessions.load();
  const web = await sessions.create(cwd, "Owned native Web source");
  const webPath = join(store, `${web.id}.jsonl`);
  const webRoute = engine.routes.get(webPath);
  assert(webRoute);
  await prompt(web.id, "first Web turn");
  await settled(web.id, "first Web turn");
  await prompt(web.id, "second Web turn");
  await settled(web.id, "second Web turn");
  const nativeBefore = await engine.requestExisting("get_state", { sessionId: webRoute });
  const { forkMessages } = await sessions.webBranchOptions(web.id);
  const first = forkMessages.find(option => option.text === "first Web turn");
  assert(first);
  const moved = await engine.requestExisting("navigate_tree", { sessionId: webRoute, targetId: first.entryId, intent: "resume" });
  assert.equal(moved.leafId, first.entryId);
  const webBefore = await readFile(webPath);
  const webClone = opened(await sessions.branchWeb(web.id, { kind: "clone" }));
  assert.deepEqual(await messages(webClone.session.id), ["first Web turn"]);
  assert.deepEqual(await readFile(webPath), webBefore);
  const nativeAfter = await engine.requestExisting("get_state", { sessionId: webRoute });
  assert.equal(nativeAfter.sessionFile, nativeBefore.sessionFile);
  assert.equal(nativeAfter.sessionId, nativeBefore.sessionId);
  assert.equal((await engine.requestExisting("get_tree", { sessionId: webRoute })).leafId, first.entryId);
  assert.notEqual(await sessions.nativeSessionId(webClone.session.id), nativeBefore.sessionId);
  await prompt(webClone.session.id, "continue Web clone");
  await settled(webClone.session.id, "continue Web clone");
  assert.deepEqual(await readFile(webPath), webBefore);
  await prompt(web.id, "continue original Web");
  await settled(web.id, "continue original Web");
  assert(!(await messages(webClone.session.id)).includes("continue original Web"));
  console.log("PASS native Web clone: exact older leaf, unchanged original handle/file, independent continuation");

  let tuiOutput = "";
  const cli = Bun.spawn([...entry, "--offline", "--no-approve", "first CLI turn"], { cwd, env,
    timeout: 90_000, killSignal: "SIGKILL", terminal: { cols: 106, rows: 34, data(_terminal, chunk) {
      tuiOutput = (tuiOutput + Buffer.from(chunk).toString("utf8")).slice(-16384);
    } } });
  stopCli = async () => {
    try {
      if (cli.exitCode === null) cli.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([cli.exited, new Promise<void>(resolve => { timer = setTimeout(() => {
          cli.kill("SIGKILL"); resolve();
        }, 2_000); })]);
      } finally { clearTimeout(timer); }
      await cli.exited;
    } finally { cli.terminal?.close(); }
  };
  const terminal = cli.terminal;
  assert(terminal);
  const cliRow = await until("owned TUI transcript", async () => {
    assert.equal(cli.exitCode, null, Bun.stripANSI(tuiOutput));
    for (const row of (await history.list()).sessions) {
      const source = await history.branchSource(row.id, cwd);
      if ((await readFile(source.sourcePath, "utf8")).includes("Mock reply to first CLI turn")) return row;
    }
  });
  terminal.write("second CLI turn");
  terminal.write("\r");
  const cliSource = await history.branchSource(cliRow.id, cwd);
  const cliBefore = await until("second TUI turn", async () => {
    const text = await readFile(cliSource.sourcePath, "utf8");
    if (text.includes("Mock reply to second CLI turn")) return text;
  });
  const options = await sessions.branchOptionsFor(cliSource);
  const selected = options.forkMessages.find(option => option.text === "second CLI turn");
  assert(selected);
  const beforeFork = prompts.length;
  const cliFork = opened(await sessions.branchFrom(cliSource, { kind: "fork", entryId: selected.entryId }));
  assert.equal(cliFork.editorText, "second CLI turn");
  assert.deepEqual(await messages(cliFork.session.id), ["first CLI turn", "Mock reply to first CLI turn"]);
  assert.equal(prompts.length, beforeFork, "fork draft must not have been sent");
  assert.equal(await readFile(cliSource.sourcePath, "utf8"), cliBefore);
  await prompt(cliFork.session.id, "continue CLI-derived Web fork");
  await settled(cliFork.session.id, "continue CLI-derived Web fork");
  assert.equal(await readFile(cliSource.sourcePath, "utf8"), cliBefore);
  assert.equal(cli.exitCode, null);
  terminal.write("continue original CLI");
  terminal.write("\r");
  await until("original TUI continuation", async () => {
    if ((await readFile(cliSource.sourcePath, "utf8")).includes("Mock reply to continue original CLI")) return true;
  });
  assert(!(await messages(cliFork.session.id)).includes("continue original CLI"));
  console.log("PASS native CLI fork: prefix and unsent draft, unchanged source, PTY and Web continue separately");

  const seedId = crypto.randomUUID();
  const seedPath = join(dirname(cliSource.sourcePath), "owned-branch-root-fixture.jsonl");
  const timestamp = new Date().toISOString();
  const seed = [
    { type: "session", version: 3, id: seedId, timestamp, cwd },
    { type: "message", id: "root-entry", parentId: null, timestamp,
      message: { role: "user", content: "root draft", timestamp: Date.now() } },
    { type: "message", id: cancelledEntry, parentId: "root-entry", timestamp,
      message: { role: "user", content: "veto branch", timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(seedPath, seed, { flag: "wx", mode: 0o600 });
  const seedSource = await history.branchSource(seedId, cwd);
  const rootFork = opened(await sessions.branchFrom(seedSource, { kind: "fork", entryId: "root-entry" }));
  assert(engine.sawLazyBranch, "native root fork should return a new path without creating a file");
  assert.equal(rootFork.editorText, "root draft");
  assert.deepEqual(await messages(rootFork.session.id), []);
  const rootNativeId = await sessions.nativeSessionId(rootFork.session.id);
  assert(rootNativeId && rootNativeId !== seedId);
  assert.equal(record(JSON.parse((await readFile(join(store, `${rootFork.session.id}.jsonl`), "utf8")).split("\n")[0])).id, rootNativeId);
  assert.deepEqual(await sessions.branchFrom(seedSource, { kind: "fork", entryId: cancelledEntry }), { cancelled: true });
  assert.equal(await readFile(seedPath, "utf8"), seed);
  await assert.rejects(sessions.branchFrom({ ...seedSource, leafId: "not-saved" }, { kind: "clone" }), { code: "branch_stale" });
  await writeFile(seedPath, seed + '{"type":');
  await assert.rejects(sessions.branchOptionsFor(seedSource), { code: "branch_source_invalid" });
  const busy = prompt(web.id, "busy source fixture");
  try {
    await Promise.race([busyStarted.promise, Bun.sleep(10_000).then(() => { throw new Error("Busy provider request missing"); })]);
    await assert.rejects(sessions.branchWeb(web.id, { kind: "clone" }), { code: "session_busy" });
  } finally {
    releaseBusy.resolve();
    await busy;
  }
  await settled(web.id, "busy source fixture");
  assert.equal(sessions.list().length, 4);
  assert(!((await readdir(store)).some(path => path.startsWith(".omo-web-branch-"))));
  assert.equal((await lstat(store)).mode & 0o077, 0, "Web session store must be private");
  console.log("PASS native root no-disk fork, native hook cancellation, stale/malformed/busy refusal and private cleanup");
  console.log("NATIVE_SESSION_BRANCHES_OK");
} finally {
  releaseBusy.resolve();
  try { await stopCli?.(); }
  finally {
    try { await engine.stop(); }
    finally {
      provider.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
}
