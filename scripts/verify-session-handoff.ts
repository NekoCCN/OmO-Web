import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { array, record } from "../src/protocol.ts";
import { startApp } from "../src/server.ts";

const cliMain = process.argv[2];
assert(cliMain?.endsWith("/dist/cli-main.js") && await Bun.file(cliMain).exists(),
  "Usage: bun --no-orphans scripts/verify-session-handoff.ts /absolute/runtime/dist/cli-main.js");
const root = await realpath(await mkdtemp(join(tmpdir(), "omo-web-handoff-")));
const profile = join(root, "profile");
const cwd = join(root, "workspace");
const omittedCwd = join(root, "other-workspace");
const dataDir = join(root, "web");
const localBin = join(root, "bin");
const model = "handoff-proof";
const seed = "HANDOFF-CLI-SEED";
const web = "HANDOFF-WEB-TURN";
const cliAgain = "HANDOFF-CLI-AGAIN";
const webAgain = "HANDOFF-WEB-AGAIN";
const untouched = "HANDOFF-OTHER-WORKSPACE";
const webCreated = "HANDOFF-WEB-CREATED";
const oldBranch = "HANDOFF-ABANDONED-BRANCH";
const fromWeb = "HANDOFF-CLI-FROM-WEB";
const webName = "Sequential handoff proof";
const cliName = "Renamed in the reopened CLI";
const held = Promise.withResolvers<void>();
const drain = Promise.withResolvers<void>();
const calls: { readonly turn: string; readonly history: string }[] = [];
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
  assert.equal(request.headers.get("Authorization"), "Bearer handoff-mock");
  const input = record(await request.json());
  assert.equal(input.model, model);
  const messages = array(input.messages);
  const marker = [seed, untouched, web, cliAgain, webAgain, webCreated, oldBranch, fromWeb].find(turn =>
    textOf(messages.at(-1)).includes(turn));
  assert(marker, "Unexpected user prompt in isolated handoff fixture");
  calls.push({ turn: marker, history: messages.map(textOf).join("\n") });
  const event = (delta: object, reason: null | "stop") => `data: ${JSON.stringify({
    id: "handoff-completion", model, object: "chat.completion.chunk", created: 1,
    choices: [{ index: 0, delta, finish_reason: reason }],
  })}\n\n`;
  if (marker === web) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      async start(stream) {
        stream.enqueue(encoder.encode(event({ role: "assistant", content: "Handoff still running" }, null)));
        held.resolve();
        await drain.promise;
        stream.enqueue(encoder.encode(event({ content: ` · Reply ${marker}` }, null) + event({}, "stop") + "data: [DONE]\n\n"));
        stream.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  }
  return new Response(event({ role: "assistant", content: `Reply ${marker}` }, null) + event({}, "stop") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
} });

function textOf(input: unknown): string {
  const content = record(input).content;
  return typeof content === "string" ? content : array(content).map(item => record(item).text).join("");
}

const env = {
  PATH: `${localBin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
  OMO_CODING_AGENT_DIR: profile, SENPI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_DIR: profile,
  SENPI_TEST_AGENT_DIR_GUARD: "1", SENPI_RPC_CLIENT_CAPABILITIES: "question", TERM: "xterm-256color", NO_PROXY: "127.0.0.1,localhost",
};
const entry = [process.execPath, "--no-orphans", "--no-env-file", cliMain] as const;
const isolated = ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)] as const;
const engineCommand = [...isolated, ...entry, "--mode", "rpc", "--multi-session",
  "--offline", "--no-approve", "--session-runtime", "in-process"] as const;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function until(label: string, predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 14_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(35);
  }
  assert.fail(`Timed out: ${label}`);
}

const terminals = new Set<ReturnType<typeof terminal>>();
function terminal(directory: string, argv: readonly string[], terminalEnv = env) {
  let display = "";
  const child = Bun.spawn([...argv], {
    cwd: directory, env: terminalEnv, timeout: 70_000, killSignal: "SIGKILL",
    terminal: { cols: 104, rows: 34, data(_terminal, chunk) {
      display = (display + Buffer.from(chunk).toString()).slice(-65_536);
    } },
  });
  async function stop() {
    if (child.exitCode === null) child.kill("SIGTERM");
    const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000);
    try { await child.exited; } finally { clearTimeout(kill); child.terminal?.close(); }
  }
  return {
    sees: (text: string) => stripVTControlCharacters(display).includes(text),
    tail: () => stripVTControlCharacters(display).slice(-1100),
    submit(text: string) {
      assert(child.terminal);
      child.terminal.write(text);
      child.terminal.write("\r");
    },
    async quit() {
      child.terminal?.write("\x04");
      await until("terminal exited with its native quit binding", () => child.exitCode !== null);
      assert.equal(child.exitCode, 0);
      child.terminal?.close();
    },
    stop,
  };
}
function tui(directory: string, args: readonly string[]) {
  const handle = terminal(directory, [...entry, "--offline", "--no-approve", "--no-context-files", ...args]);
  terminals.add(handle);
  return handle;
}

function runCopiedCommand(command: string, prompt: string) {
  const ambient = join(root, "unrelated-terminal-profile");
  const handle = terminal(omittedCwd, ["/bin/sh", "-c", `${command} ${quote(prompt)}`], {
    ...env, OMO_CODING_AGENT_DIR: ambient, SENPI_CODING_AGENT_DIR: ambient, PI_CODING_AGENT_DIR: ambient,
  });
  terminals.add(handle);
  return handle;
}

async function verifyTuiReply(handle: ReturnType<typeof terminal>, marker: string) {
  try { await until(`real CLI displays Reply ${marker}`, () => handle.sees(`Reply ${marker}`)); }
  catch (error) {
    console.error("Isolated native terminal proof:", JSON.stringify({
      marker, turns: calls.map(call => call.turn), tail: handle.tail(),
    }));
    throw error;
  }
}

let app: Awaited<ReturnType<typeof startApp>> | undefined;
let origin: string;
let token: string;
type BrowserProof = {
  readonly enterNew: (url: string) => Promise<void>;
  readonly enterHistory: (url: string, marker: string) => Promise<void>;
  readonly send: (marker: string) => Promise<void>;
  readonly proveBuiltins: (name: string) => Promise<void>;
  readonly proveCopy: (url: string, text: string) => Promise<void>;
  readonly proveThinking: (level: string) => Promise<void>;
  readonly handoff: (sourcePath: string) => Promise<string>;
  readonly reopen: (url: string, marker: string) => Promise<void>;
  readonly close: () => Promise<void>;
};
let browser: BrowserProof | undefined;
async function launchBrowser(): Promise<BrowserProof> {
  const harness: { readonly openBrowserProof: () => Promise<BrowserProof> } =
    await import(new URL("./verify-session-handoff-browser.mjs", import.meta.url).href);
  return harness.openBrowserProof();
}
async function start() {
  app = await startApp({ dataDir, workspaces: [cwd], cliAgentDir: profile, port: 0, engineCommand });
  origin = app.url.origin;
  const boot = await request("/api/bootstrap");
  assert.equal(record(boot.engine).online, true, "The private non-listening native Web engine must be online");
  assert.equal(typeof boot.token, "string");
  token = String(boot.token);
  return origin;
}

async function request(path: string, body?: object, status = 200) {
  const response = await fetch(origin + path, body === undefined ? { signal: AbortSignal.timeout(10_000) } : {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-OmO-Token": token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
  });
  const result = record(await response.json());
  assert.equal(response.status, status, `${path}: ${String(result.code ?? "ok")}`);
  return result;
}

async function journalFiles() {
  const base = join(profile, "sessions");
  const stores = await readdir(base, { withFileTypes: true });
  return (await Promise.all(stores.filter(dir => dir.isDirectory() && dir.name.startsWith("--")).map(async dir => {
    const directory = join(base, dir.name);
    return (await readdir(directory)).filter(name => name.endsWith(".jsonl")).map(name => join(directory, name));
  }))).flat().sort();
}

async function verify() {
try {
  const proveThinking = process.argv.includes("--thinking");
  await Promise.all([profile, cwd, omittedCwd, env.HOME, env.TMPDIR, localBin].map(dir => mkdir(dir, { mode: 0o700 })));
  await writeFile(join(localBin, "omo"),
    `#!/bin/sh\nexec ${entry.map(quote).join(" ")} --offline --no-approve --no-context-files "$@"\n`, { mode: 0o700 });
  await writeFile(join(profile, "settings.json"), JSON.stringify({
    defaultProvider: "proof", defaultModel: model, quietStartup: true,
    ...(proveThinking ? { defaultThinkingLevel: "low" } : {}),
  }));
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { proof: {
    baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "handoff-mock",
    models: [{ id: model, name: model, input: ["text"], contextWindow: 128_000, maxTokens: 4096,
      ...(proveThinking ? { reasoning: true } : {}) }],
  } } }));

  if (process.argv.includes("--commands-only")) {
    const url = await start();
    browser = await launchBrowser();
    await browser.enterNew(url);
    const [row] = array((await request("/api/sessions")).sessions).map(record);
    assert(typeof row?.id === "string");
    await browser.send(seed);
    await until("a real model reply makes the branch picker usable", async () => {
      const snapshot = await request(`/api/sessions/${row.id}`);
      return record(snapshot.state).isStreaming === false &&
        array(snapshot.messages).some(message => textOf(message).includes(`Reply ${seed}`));
    });
    await browser.proveBuiltins(webName);
    if (process.argv.includes("--copy")) await browser.proveCopy(url, `Reply ${seed}`);
    if (proveThinking) {
      const url = `/api/sessions/${row.id}`;
      const defaultsBefore = await readFile(join(profile, "settings.json"), "utf8");
      assert(array((await request(`${url}/options`)).levels).includes("high"));
      await browser.proveThinking("high");
      assert.equal(record((await request(url)).state).thinkingLevel, "high");
      assert.equal(await readFile(join(profile, "settings.json"), "utf8"), defaultsBefore, "Session thinking must not rewrite the profile");
    }
    assert.equal(record((await request(`/api/sessions/${row.id}`)).session).name, webName);
    assert.deepEqual(calls.map(call => call.turn), [seed], "Web built-ins and unsupported TUI commands are not model prompts");
    console.log("BROWSER_BUILTIN_PARITY_OK native-rename details fork-selector tui-only-not-sent");
    return;
  }

  // Name the two startup sessions so native background title generation
  // cannot add provider requests unrelated to user-message admission.
  const hidden = tui(omittedCwd, ["--name", "Unauthorized workspace fixture", untouched]);
  await verifyTuiReply(hidden, untouched);
  await hidden.quit();
  const original = tui(cwd, ["--name", "Sequential CLI fixture", seed]);
  await verifyTuiReply(original, seed);

  const initialOrigin = await start();
  const history = array((await request("/api/cli-history")).sessions).map(record);
  assert.equal(history.length, 1, "The unauthorized workspace does not appear in history");
  const selected = history[0];
  assert.equal(selected.cwd, cwd);
  assert.equal(typeof selected.id, "string");
  const historyResume = `/api/cli-history/${String(selected.id)}/resume`;
  await request(historyResume, {}, 409);
  assert.deepEqual(array((await request("/api/sessions")).sessions), [], "Live foreign holder must not publish a bookmark");

  await original.quit();
  const paths = await journalFiles();
  assert.equal(paths.length, 2, "Only the two original CLI journals exist");
  const owned = (await Promise.all(paths.map(async path => ({ path, file: await readFile(path, "utf8") }))))
    .find(item => item.file.includes(seed));
  assert(owned);
  const originalHeader = record(JSON.parse(owned.file.split("\n", 1)[0]));
  assert.equal(originalHeader.cwd, cwd);
  assert.equal(typeof originalHeader.id, "string");
  if (process.argv.includes("--browser")) {
    browser = await launchBrowser();
    await browser.enterHistory(initialOrigin, seed);
    assert.equal(array((await request("/api/sessions")).sessions).length, 1,
      "The browser actually opens a normal selectable Web session");
  }
  const { session } = await request(historyResume, {});
  const id = record(session).id;
  assert.equal(typeof id, "string");
  assert.equal(record((await request(historyResume, {})).session).id, id, "Opening the same CLI history must not make two bookmarks");
  const target = `/api/sessions/${String(id)}`;
  const view = async () => request(target);
  const includes = async (marker: string) => array((await view()).messages).some(msg => textOf(msg).includes(`Reply ${marker}`));
  assert(await includes(seed));
  assert.equal(record((await view()).state).permissionPreset, "ask");
  if (browser && process.argv.includes("--slash")) await browser.proveBuiltins(webName);
  else await request(`${target}/actions`, { action: "rename", name: webName });
  assert.equal(record((await view()).session).name, webName);
  if (browser) await browser.send(web);
  else await request(`${target}/actions`, { action: "prompt", message: web, clientMessageId: crypto.randomUUID() });
  await until("the held model reply is open", () => calls.some(call => call.turn === web));
  await held.promise;
  await request(`${target}/handoff`, {}, 409);
  assert.equal(record((await view()).session).active, true, "Failed handoff cannot release a busy turn");
  drain.resolve();
  await until("Web sees reply after refused handoff", async () =>
    await includes(web) && record((await view()).state).isStreaming === false);
  const command = browser ? await browser.handoff(owned.path) : (await request(`${target}/handoff`, {})).command;
  assert(typeof command === "string" && command.includes(owned.path), "The command points to the original fixture journal");
  const privateSession = array((await request("/api/sessions")).sessions).map(record).find(row => row.id === id);
  assert.equal(privateSession?.active, false);
  assert.equal((await journalFiles()).join("\n"), paths.join("\n"), "Handoff must not create or rename a source journal");

  const second = runCopiedCommand(command, cliAgain);
  await verifyTuiReply(second, cliAgain);
  await request(`${target}/actions`, { action: "resume" }, 409);
  second.submit(`/name ${cliName}`);
  await until("native TUI rename reaches the same journal", async () => (await readFile(owned.path, "utf8")).includes(cliName));
  await second.quit();

  await app?.stop();
  const restartedOrigin = await start();
  if (browser) await browser.reopen(restartedOrigin, cliAgain);
  else await request(`${target}/actions`, { action: "resume" });
  assert.equal(record((await view()).session).name, cliName, "Resuming in Web cannot overwrite a native CLI rename");
  for (const mark of [seed, web, cliAgain]) assert(await includes(mark), `Lost ${mark} across restart`);
  if (browser) await browser.send(webAgain);
  else await request(`${target}/actions`, { action: "prompt", message: webAgain, clientMessageId: crypto.randomUUID() });
  await until("real Web work resumed after terminal quit", () => includes(webAgain));
  assert.deepEqual(calls.map(call => call.turn), [untouched, seed, web, cliAgain, webAgain]);
  for (const [index, turn] of [seed, web, cliAgain, webAgain].entries()) {
    const delivered = calls.find(call => call.turn === turn);
    assert(delivered);
    for (const earlier of [seed, web, cliAgain, webAgain].slice(0, index)) {
      assert(delivered.history.includes(earlier), `Provider working context lost ${earlier} when processing ${turn}`);
    }
  }
  const finalHeader = record(JSON.parse((await readFile(owned.path, "utf8")).split("\n", 1)[0]));
  assert.equal(finalHeader.id, originalHeader.id);
  assert.deepEqual(await journalFiles(), paths);
  const webStore = join(dataDir, "sessions");
  assert.deepEqual((await readdir(webStore)).filter(name => name.endsWith(".jsonl")), [],
    "A Web bookmark must not materialize a copy of the OmO transcript");

  const webBorn = record((await request("/api/sessions", { cwd, name: "Created in Web" }, 201)).session);
  assert(typeof webBorn.id === "string" && /^[a-f0-9-]{36}$/.test(webBorn.id));
  const webBornApi = `/api/sessions/${webBorn.id}`;
  for (const marker of [webCreated, oldBranch]) {
    await request(`${webBornApi}/actions`, { action: "prompt", message: marker, clientMessageId: crypto.randomUUID() });
    await until(`Web-born conversation finished ${marker}`, async () => {
      const snapshot = await request(webBornApi);
      return record(snapshot.state).isStreaming === false &&
        array(snapshot.messages).some(message => textOf(message).includes(`Reply ${marker}`));
    });
  }
  const tree = record((await request(`${webBornApi}/details`)).tree);
  const nodes = array(tree.tree).map(record);
  let leaf: string | undefined;
  for (const node of nodes) {
    nodes.push(...array(node.children).map(record));
    const entry = record(node.entry);
    if (typeof entry.id === "string" && record(entry.message).role === "assistant" &&
        textOf(entry.message) === `Reply ${webCreated}`) leaf = entry.id;
  }
  assert(leaf && tree.leafId !== leaf, "The test must branch away from a newer active descendant");
  assert.equal(record((await request(`${webBornApi}/actions`, { action: "navigate", targetId: leaf })).result).cancelled, false);
  // Native session_tree hooks may append descriptive metadata below the chosen
  // node. The proof is the visible/model ancestry, not that metadata entry ID.
  const afterNavigation = array((await request(webBornApi)).messages).map(textOf);
  assert(afterNavigation.some(text => text.includes(webCreated)));
  assert(!afterNavigation.some(text => text.includes(oldBranch)));
  const [webBornPath, ...extras] = (await journalFiles()).filter(path => !paths.includes(path));
  assert(webBornPath && extras.length === 0, "There is only one Web-origin journal in the shared native store");
  assert.deepEqual((await readdir(webStore)).filter(name => name.endsWith(".jsonl")), []);
  const webBornHeader = record(JSON.parse((await readFile(webBornPath, "utf8")).split("\n", 1)[0]));
  assert(typeof webBornHeader.id === "string");
  const cannotAttach = terminal(cwd, [...entry, "--session", webBornPath]);
  terminals.add(cannotAttach);
  await until("a stock TUI cannot attach to the Web-held journal",
    () => cannotAttach.sees("Not opened:") && cannotAttach.sees("close it there"));
  await cannotAttach.stop();
  assert(!calls.some(call => call.turn === fromWeb));
  const webBornCommand = (await request(`${webBornApi}/handoff`, {})).command;
  assert(typeof webBornCommand === "string" && webBornCommand.includes(webBornPath));
  const webBornCli = runCopiedCommand(webBornCommand, fromWeb);
  await verifyTuiReply(webBornCli, fromWeb);
  await webBornCli.quit();
  const resumedJournal = await readFile(webBornPath, "utf8");
  const webBornAfter = record(JSON.parse(resumedJournal.split("\n", 1)[0]));
  assert.equal(webBornAfter.id, webBornHeader.id);
  assert.deepEqual(calls.slice(-3).map(call => call.turn), [webCreated, oldBranch, fromWeb]);
  assert(calls.at(-1)?.history.includes(webCreated));
  assert(!calls.at(-1)?.history.includes(oldBranch), "The real CLI must continue from the selected older Web branch");
  assert(resumedJournal.includes(oldBranch), "The abandoned branch must remain in the same native journal");

  const adoptedBefore = await readFile(owned.path, "utf8");
  const options = await request(`${target}/branch-options`);
  assert.equal(options.canClone, true);
  const candidate = array(options.forkMessages).map(record).find(item => item.text === web);
  assert(typeof candidate?.entryId === "string", "An adopted CLI journal must supply its original native branch choices");
  const fork = await request(`${target}/branches`, { kind: "fork", entryId: candidate.entryId }, 201);
  const clone = await request(`${target}/branches`, { kind: "clone" }, 201);
  const forkSession = record(fork.session);
  const cloneSession = record(clone.session);
  assert(typeof forkSession.id === "string" && typeof cloneSession.id === "string");
  assert.equal(new Set([id, forkSession.id, cloneSession.id]).size, 3);
  assert.equal(fork.editorText, web, "Fork uses native draft reinsertion without resubmission");
  const forkMessages = array((await request(`/api/sessions/${forkSession.id}`)).messages).map(textOf);
  const cloneMessages = array((await request(`/api/sessions/${cloneSession.id}`)).messages).map(textOf);
  assert(forkMessages.some(text => text.includes(seed)) && !forkMessages.some(text => text.includes(web)));
  assert(cloneMessages.some(text => text.includes(webAgain)));
  assert.equal(await readFile(owned.path, "utf8"), adoptedBefore, "Separate branches must not change the adopted journal");
  assert.equal((await journalFiles()).length, paths.length + 3, "Both branches are discoverable in the native store");
  assert.equal(calls.length, 8, "Fork and Clone are not prompts");
  console.log("NATIVE_SESSION_HANDOFF_OK same-journal same-native-id live-holder-rejected busy-release-rejected restart-resumed branch-preserved requests-once");
  if (browser) console.log("BROWSER_SESSION_HANDOFF_OK real-CLI recorded-history main-workbench release resume");
  if (browser && process.argv.includes("--slash")) console.log("BROWSER_BUILTIN_PARITY_OK native-rename details fork-selector tui-only-not-sent");
} finally {
  drain.resolve();
  try { await browser?.close(); } finally {
    try { await app?.stop(); } finally {
      try { await Promise.all([...terminals].map(handle => handle.stop())); } finally {
        provider.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
}

await verify();
