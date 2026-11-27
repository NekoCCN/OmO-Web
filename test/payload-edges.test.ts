import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDirName } from "../src/cli-history.ts";
import { startApp } from "../src/server.ts";

const engine = fileURLToPath(new URL("./payload-edge-engine-fixture.ts", import.meta.url));
const clientMessageId = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "omo-payload-edge-"));
  const cliAgentDir = join(cwd, "agent");
  const journals = join(cliAgentDir, "sessions", sessionDirName(cwd));
  await mkdir(journals, { recursive: true });
  const app = await startApp({ dataDir: join(cwd, "web"), workspaces: [cwd],
    engineCommand: [process.execPath, engine], port: 0, cliAgentDir });
  const get = (path: string, options?: RequestInit) => fetch(new URL(path, app.url), options);
  const { token } = await (await get("/api/bootstrap")).json();
  const post = (path: string, body: object) => get(path, { method: "POST", body: JSON.stringify(body),
    headers: { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": token } });
  return { cwd, journals, get, post, async [Symbol.asyncDispose]() {
    await app.stop();
    await rm(cwd, { recursive: true, force: true });
  } };
}

async function collectTurn(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const frames: { bytes: number; event: Record<string, unknown> }[] = [];
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE ended before settlement");
      pending = Buffer.concat([pending, value]);
      let end: number;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const raw = pending.subarray(0, end + 2);
        pending = pending.subarray(end + 2);
        const frame = raw.toString("utf8");
        if (!frame.startsWith("event: omo\ndata: ")) continue;
        const event = JSON.parse(frame.slice("event: omo\ndata: ".length, -2));
        frames.push({ bytes: raw.byteLength, event });
        if (event.type === "agent_settled") return frames;
      }
    }
  } finally { await reader.cancel(); }
}

test("physical SSE frame limits preserve exact-boundary events, scoped recovery and original admission", async () => {
  await using f = await setup();
  const { session: { id } } = await (await f.post("/api/sessions", { cwd: f.cwd, name: "Edge fixture" })).json();
  const path = `/api/sessions/${id}`;
  expect(await (await f.get(`${path}/last-assistant`)).json()).toEqual({ text: "普通 copy 🐋" });
  const response = await f.get("/api/events", { signal: AbortSignal.timeout(5_000) });
  const stream = response.body;
  if (!stream) throw new Error("Missing SSE body");
  const reading = collectTurn(stream);
  const receipt = await f.post(`${path}/actions`, {
    action: "prompt", mode: "prompt", message: "one real admission", clientMessageId,
  });
  expect(receipt.status).toBe(200);
  expect((await receipt.json()).result).toEqual({
    disposition: "started", turnId: "turn-1", clientMessageId,
  });
  const frames = await reading;
  const sizes = frames.map(frame => frame.bytes);
  console.info("SSE physical frames (bytes):", sizes.join(", "));
  expect(Math.max(...sizes)).toBe(96 * 1024);
  expect(frames.filter(frame => frame.event.sessionId === id).map(frame => frame.event.type)).toEqual([
    "agent_start", "message_update", "transcript_refresh_required", "transcript_refresh_required",
    "state_refresh_required", "state_refresh_required", "state_refresh_required", "message_end", "agent_settled",
  ]);
  expect(frames.filter(frame => /_refresh_required$/.test(String(frame.event.type))).map(frame => frame.event))
    .toEqual(["transcript", "transcript", "state", "state", "state"].map(name => ({ type: `${name}_refresh_required`, sessionId: id })));
  expect(frames.find(frame => frame.event.type === "message_end")?.event.message).toEqual({ role: "assistant", content: "small 中" });
  const snapshot = await f.get(path);
  const snapshotRaw = await snapshot.arrayBuffer();
  expect(snapshot.status).toBe(200);
  expect(snapshotRaw.byteLength).toBeLessThanOrEqual(256 * 1024);
  expect(JSON.parse(new TextDecoder().decode(snapshotRaw)).state.pendingDialogs).toEqual([
    { id: "fixture-decision", type: "extension_ui_request", method: "confirm", message: '中"\\\u0000\n'.repeat(11_000) },
  ]);
  console.info("Pending decision snapshot HTTP body (bytes):", snapshotRaw.byteLength);
  expect(await readFile(join(f.cwd, "operations"), "utf8")).toBe("prompt\n");
});

test("last-assistant refuses oversized exact copies without returning clipped text", async () => {
  await using f = await setup();
  const { session: { id } } = await (await f.post("/api/sessions", { cwd: f.cwd, name: "Edge fixture" })).json();
  const path = `/api/sessions/${id}`;
  expect((await f.post(`${path}/actions`, {
    action: "prompt", mode: "prompt", message: "set fixture state", clientMessageId,
  })).ok).toBe(true);
  const copy = await f.get(`${path}/last-assistant`);
  const copyRaw = await copy.arrayBuffer();
  console.info("Last-assistant HTTP body (bytes):", copyRaw.byteLength);
  expect(copy.status).toBe(502);
  expect(copyRaw.byteLength).toBeLessThan(1024);
  expect(JSON.parse(new TextDecoder().decode(copyRaw))).toEqual({ code: "last_assistant_too_large", error: expect.any(String) });
  expect(await readFile(join(f.cwd, "operations"), "utf8")).toBe("prompt\n");
});

test("generic JSON ceiling fails closed on read and on an already admitted write", async () => {
  await using f = await setup();
  const { session: { id } } = await (await f.post("/api/sessions", { cwd: f.cwd, name: "Edge fixture" })).json();
  const path = `/api/sessions/${id}`;
  const results = await Promise.all([
    f.get(`${path}/options`),
    f.post(`${path}/actions`, { action: "prompt", mode: "prompt", message: "large receipt", clientMessageId }),
  ]);
  const errors = await Promise.all(results.map(async response => {
    const bytes = await response.arrayBuffer();
    console.info("Generic JSON HTTP body (bytes):", bytes.byteLength);
    expect(bytes.byteLength).toBeLessThan(1024);
    expect(response.status).toBe(502);
    return JSON.parse(new TextDecoder().decode(bytes));
  }));
  expect(errors).toEqual([
    { code: "response_too_large", error: expect.any(String) },
    { code: "response_too_large_outcome_unknown", error: expect.stringContaining("不要重复") },
  ]);
  expect(await readFile(join(f.cwd, "operations"), "utf8")).toBe("prompt\n");
});

test("CLI journal preview measures escaped JSON and refuses locally without changing the journal", async () => {
  await using f = await setup();
  const journal = join(f.journals, "2026-11-20T00-00-00-000Z_fixture.jsonl");
  const escape = '中"\\\u0000\n'.repeat(20_000);
  const raw = [
    { type: "session", version: 3, id: "preview-durable", cwd: f.cwd, timestamp: "2026-11-20T00:00:00.000Z" },
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: escape } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(journal, raw);
  const { sessions: [session] } = await (await f.get("/api/cli-history")).json();
  const response = await f.get(`/api/cli-history/${session.id}`);
  const bytes = await response.arrayBuffer();
  console.info("CLI history preview HTTP body (bytes):", bytes.byteLength);
  expect(response.status).toBe(413);
  expect(bytes.byteLength).toBeLessThan(1024);
  expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ code: "history_preview_too_large" });
  expect(await readFile(journal, "utf8")).toBe(raw);
});
