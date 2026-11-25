import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "../src/protocol.ts";
import { startApp } from "../src/server.ts";
import { terminalFixture } from "./terminal-socket-fixture.ts";

const engine = fileURLToPath(new URL("./engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(enabled = true) {
  const terminal = await terminalFixture();
  cleanups.push(() => terminal.close());
  const app = await startApp({
    dataDir: join(dirname(terminal.cwd), "web"),
    workspaces: [terminal.cwd],
    engineCommand: [process.execPath, engine], port: 0,
    ...(enabled ? { cliAgentDir: terminal.agentDir } : {}),
  });
  cleanups.push(() => app.stop());
  const origin = app.url.origin;
  const get = (path: string, options?: RequestInit) => fetch(`${origin}${path}`, options);
  const data = async (response: Response) => record(await response.json());
  const { token } = await data(await get("/api/bootstrap"));
  const post = (path: string, body: object, headers: Record<string, string> = {}) => get(path, {
    method: "POST", body: JSON.stringify(body),
    headers: { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": String(token), ...headers },
  });
  async function discover() {
    const response = await get("/api/cli-live");
    expect(response.status).toBe(200);
    const { available, sessions } = await data(response);
    expect(available).toBe(true);
    expect(sessions).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: "Fixture TUI", cwd: terminal.cwd,
      attached: false, running: false }]);
    if (!Array.isArray(sessions)) throw new Error("Missing fixture discovery");
    return String(record(sessions[0]).id);
  }
  return { ...terminal, get, post, data, discover };
}

const input = { action: "input", mode: "prompt", message: "Web fixture prompt", clientMessageId: "web-1" } as const;

test("CLI HTTP mutations reject foreign origin, missing token and passthrough fields before attachment", async () => {
  const f = await setup();
  const path = `/api/cli-live/${await f.discover()}/actions`;
  const connect = { action: "connect" };
  expect((await f.post(path, connect, { Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await f.post(path, connect, { "X-OmO-Token": "" })).status).toBe(403);
  for (const body of [{ ...connect, sessionPath: "/nothing" }, { ...input, rpc: "bash" },
    { ...input, message: "$private" }, { ...input, expectedTurnId: "1" },
    { action: "stop", expectedTurnId: 1 }, { action: "answer", requestId: "private" }]) {
    const response = await f.post(path, body);
    expect([response.status, (await f.data(response)).code]).toEqual([400, "invalid_request"]);
  }
  const response = await f.post(path, input);
  expect([response.status, (await f.data(response)).code]).toEqual([409, "terminal_not_attached"]);
  expect(f.delivered).toEqual([]);
});

test("CLI discovery expires prior keys across native identity changes and honors the profile opt-out", async () => {
  const f = await setup();
  const id = await f.discover();
  expect(await f.discover()).toBe(id);
  f.state.durable = "changed-synthetic-native";
  expect(await f.discover()).not.toBe(id);
  const stale = `/api/cli-live/${id}`;
  for (const response of [await f.get(stale), await f.post(`${stale}/actions`, { action: "connect" })]) {
    expect([response.status, (await f.data(response)).code]).toEqual([404, "terminal_not_found"]);
  }
  const optedOut = await setup(false);
  expect(await optedOut.data(await optedOut.get("/api/cli-live"))).toEqual({ available: false, sessions: [] });
});

test("live HTTP attach, invalidation, prompt, exact stop and detach stay on the selected TUI", async () => {
  const f = await setup();
  const id = await f.discover();
  const path = `/api/cli-live/${id}`;
  const signal = AbortSignal.timeout(4000);
  const stream = (await f.get("/api/events", { signal })).body?.getReader();
  if (!stream) throw new Error("Missing events stream");
  try {
    expect(new TextDecoder().decode((await stream.read()).value)).toContain('"type":"ready"');
    const attach = await f.post(`${path}/actions`, { action: "connect" });
    expect(attach.status).toBe(200);
    expect(record((await f.data(attach)).session).attached).toBe(true);
    f.state.messages.push({ role: "user", content: "CLI fixture prompt" });
    f.emit("message_end", { message: f.state.messages[0], private: "fixture-private" });
    const expected = `event: omo\ndata: ${JSON.stringify({ type: "cli-live", id })}\n\n`;
    let invalidated = "";
    while (!invalidated.includes(expected)) {
      const next = await stream.read();
      if (next.done) throw new Error("SSE ended before invalidation");
      invalidated += new TextDecoder().decode(next.value);
    }
    expect(invalidated).not.toContain("fixture-private");
    expect((await f.data(await f.get(path))).messages).toEqual([{ role: "user", content: "CLI fixture prompt" }]);
    const sent = await f.post(`${path}/actions`, input);
    expect(await f.data(sent)).toEqual({ disposition: "started", clientMessageId: "web-1", duplicate: false });
    expect(f.delivered.map(row => row.message)).toEqual([input.message]);
    const { turnId } = record((await f.data(await f.get(path))).state);
    expect(typeof turnId).toBe("string");
    const stale = await f.post(`${path}/actions`, { action: "stop", expectedTurnId: "0" });
    expect([stale.status, (await f.data(stale)).code]).toEqual([409, "turn_conflict"]);
    expect((await f.post(`${path}/actions`, { action: "stop", expectedTurnId: turnId })).status).toBe(200);
    expect(f.state.interrupted).toBe(1);
    expect(await f.data(await f.post(`${path}/actions`, { action: "disconnect" }))).toEqual({ detached: true });
    expect((await f.get(path)).status).toBe(409);
    expect(await f.discover()).toBe(id);
  } finally {
    await stream.cancel();
  }
});

test("losing an admitted prompt response does not make reconnect or baseline reads send it again", async () => {
  const f = await setup();
  const path = `/api/cli-live/${await f.discover()}`;
  expect((await f.post(`${path}/actions`, { action: "connect" })).status).toBe(200);
  f.state.noInputResponse = true;
  const response = await f.post(`${path}/actions`, input);
  expect([response.status, (await f.data(response)).code]).toEqual([409, "terminal_outcome_unknown"]);
  expect((await f.get(path)).status).toBe(409);
  expect((await f.post(`${path}/actions`, { action: "connect" })).status).toBe(200);
  expect((await f.data(await f.get(path))).messages).toEqual([
    { role: "custom", customType: "session_control_delivery", content: input.message },
  ]);
  expect(f.delivered.map(row => row.message)).toEqual([input.message]);
});

test("branch HTTP sources cannot be selected using another route's key, native id, leaf or path", async () => {
  const f = await setup();
  const id = await f.discover();
  const dir = join(f.agentDir, "sessions", `--${f.cwd.slice(1).replaceAll("/", "-")}--`);
  await mkdir(dir, { recursive: true });
  const timestamp = "2026-11-25T00:00:00.000Z";
  await writeFile(join(dir, "own.jsonl"), [
    { type: "session", id: f.state.durable, cwd: f.cwd, version: 3, timestamp },
    { type: "message", id: "saved-other-leaf", parentId: null, timestamp, message: { role: "user", content: "Only on disk" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const history = await f.data(await f.get("/api/cli-history"));
  if (!Array.isArray(history.sessions)) throw new Error("Missing fixture history");
  const historyId = record(history.sessions[0]).id;
  const live = `/api/cli-live/${id}`;
  const saved = `/api/cli-history/${String(historyId)}`;
  const unselected = await f.get(`${live}/branch-options`);
  expect([unselected.status, (await f.data(unselected)).code]).toEqual([409, "terminal_not_attached"]);
  expect((await f.post(`${live}/actions`, { action: "connect" })).status).toBe(200);
  const mismatchedLeaf = await f.get(`${live}/branch-options`);
  expect([mismatchedLeaf.status, (await f.data(mismatchedLeaf)).code]).toEqual([409, "branch_stale"]);
  const wrongLeafWrite = await f.post(`${live}/branches`, { kind: "clone" });
  expect([wrongLeafWrite.status, (await f.data(wrongLeafWrite)).code]).toEqual([409, "branch_stale"]);
  for (const key of [id, f.state.durable]) {
    const response = await f.get(`/api/cli-history/${key}/branch-options`);
    expect(response.status).toBe(404);
  }
  for (const path of [saved, live]) {
    const extra = await f.post(`${path}/branches`, { kind: "clone", leafId: "saved-other-leaf", sourcePath: dir });
    expect([extra.status, (await f.data(extra)).code]).toEqual([400, "invalid_request"]);
  }
  const wrongKind = await f.get(`/api/sessions/${String(historyId)}/branch-options`);
  expect([wrongKind.status, (await f.data(wrongKind)).code]).toEqual([400, "invalid_request"]);
  const expected = { canClone: true, forkMessages: [{ entryId: "saved-other-leaf", text: "Only on disk" }] };
  expect(await f.data(await f.get(`${saved}/branch-options`))).toEqual(expected);
  f.state.leafId = "saved-other-leaf";
  expect(await f.data(await f.get(`${live}/branch-options`))).toEqual(expected);
});
