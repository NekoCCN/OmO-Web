import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function launch() {
  const directory = await mkdtemp(join(tmpdir(), "omo-web-test-"));
  const settings = {
    dataDir: join(directory, "data"),
    workspaces: [directory],
    engineCommand: [process.execPath, fixture] as const,
    port: 0,
  };
  const app = await startApp(settings);
  cleanups.push(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const origin = app.url.origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token };
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { origin, settings, app, headers, post, directory };
}

async function create(client: Awaited<ReturnType<typeof launch>>, name = "A new session") {
  const response = await client.post("/api/sessions", { cwd: client.directory, name });
  expect(response.status).toBe(201);
  const payload = await response.json();
  return String(payload.session.id);
}

async function captureScanner() {
  const baseline = new Set(await readdir(tmpdir()));
  return async () => (await readdir(tmpdir())).filter(name => name.startsWith(`.transcript-${process.pid}-`) && !baseline.has(name));
}

describe("local Web bridge", () => {
  test("rejects foreign origin, missing token, and a rebinding Host", async () => {
    const { headers, origin, app, directory } = await launch();
    const url = `${origin}/api/sessions`;
    const body = JSON.stringify({ cwd: directory });
    const foreign = await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://foreign.invalid" }, body });
    const missing = await fetch(url, { method: "POST", headers: { ...headers, "X-OmO-Token": "" }, body });
    const rebinding = await app.fetch(new Request(url, { headers: { Host: "foreign.invalid" } }));
    expect([foreign.status, missing.status, rebinding.status]).toEqual([403, 403, 403]);
  });

  test("rejects an unconfigured workspace and an arbitrary RPC action", async () => {
    const client = await launch();
    const bad = await client.post("/api/sessions", { cwd: tmpdir() });
    const id = await create(client);
    const refused = await client.post(`/api/sessions/${id}/actions`, { action: "bash", command: "echo hello" });
    expect([bad.status, refused.status]).toEqual([403, 400]);
  });

  test("persists Web identity across bridge restarts and resumes against the new engine route", async () => {
    const client = await launch();
    const id = await create(client, "Keep this title");
    await client.app.stop();
    const restarted = await startApp(client.settings);
    cleanups.push(() => restarted.stop());
    const b = await (await fetch(new URL("/api/bootstrap", restarted.url))).json();
    expect(b.sessions.map((s: { id: string; name: string; active: boolean }) => [s.id, s.name, s.active]))
      .toEqual([[id, "Keep this title", false]]);
    const response = await fetch(new URL(`/api/sessions/${id}/actions`, restarted.url), {
      method: "POST",
      headers: { Origin: restarted.url.origin, "Content-Type": "application/json", "X-OmO-Token": b.token },
      body: JSON.stringify({ action: "resume" }),
    });
    expect(response.status).toBe(200);
    const snapshot = await (await fetch(new URL(`/api/sessions/${id}`, restarted.url))).json();
    expect(snapshot.session).toMatchObject({ id, name: "Keep this title", active: true });
    expect(snapshot.messages).toEqual([]);
    expect(snapshot).not.toHaveProperty("transcript");
  });

  test("keeps snapshot state and session controls when just the transcript exceeds the read ceiling", async () => {
    const client = await launch();
    const id = await create(client, "Ceiling fixture");
    const other = await create(client, "Independent synthetic session");
    const path = `/api/sessions/${id}`;
    const response = await fetch(`${client.origin}${path}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: { id, active: true }, state: { permissionPreset: "ask", pendingDialogs: [{ id: "synthetic-confirm", method: "confirm" }] },
      messages: [], transcript: { status: "unavailable" },
    });
    expect((await fetch(`${client.origin}/api/sessions/${other}`)).status).toBe(200);
    expect((await client.post(`${path}/actions`, { action: "rename", name: "After read limit" })).status).toBe(200);
    const after = await (await fetch(`${client.origin}${path}`)).json();
    expect(after.session).toMatchObject({ active: true, name: "After read limit" });
    expect(after).not.toHaveProperty("transcript");
  });

  test("does not treat a Native refusal as a local read ceiling even with the same error code", async () => {
    const client = await launch();
    const id = await create(client, "Refusal fixture");
    const response = await fetch(`${client.origin}/api/sessions/${id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "messages_read_limit" });
  });

  test("pages true older rows and exact escaped Unicode from one Native capture", async () => {
    const client = await launch();
    const id = await create(client, "Paged fixture");
    const path = `${client.origin}/api/sessions/${id}`;
    const measured = { page: 0, content: 0 };
    const read = async (url: string, max: number) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(max);
      const kind = max === 64 * 1024 ? "content" : "page";
      measured[kind] = Math.max(measured[kind], Buffer.byteLength(body));
      return JSON.parse(body);
    };
    const initial = await read(path, 256 * 1024);
    expect(initial.state).toMatchObject({ pendingDialogs: [{ id: "synthetic-confirm" }],
      pendingQuestions: [{ id: "synthetic-question", questions: [{ id: "q" }] }] });
    expect(initial.messages.length).toBeLessThanOrEqual(40);
    expect(initial.messages.at(-1).timestamp).toBe(274);
    expect(initial).not.toHaveProperty("transcript");
    const rows = [...initial.messages];
    let olderCursor: string | undefined = initial.page.olderCursor;
    expect(olderCursor).toBeString();
    while (olderCursor) {
      const prior = olderCursor;
      const page = await read(`${path}/transcript?cursor=${olderCursor}`, 256 * 1024);
      expect(page.page.id).toBe(initial.page.id);
      expect(page.messages.length).toBeWithin(1, 41);
      rows.unshift(...page.messages);
      olderCursor = page.page.olderCursor;
      expect(olderCursor).not.toBe(prior);
    }
    expect(rows.map(row => row.timestamp)).toEqual(Array.from({ length: 275 }, (_, i) => i));
    expect(rows[272].content).toEqual([{ type: "text", text: "image caption" },
      { type: "image", data: "YQ==", mimeType: "image/png" }]);
    expect(rows[271].content[0].text.length).toBeLessThan(75_000);
    const cursor = rows[271].historyContent.cursor;
    expect(cursor).toBeString();
    let next: string | undefined = cursor;
    let full = "";
    while (next) {
      const prior = next;
      const chunk = await read(`${path}/transcript/content?cursor=${next}`, 64 * 1024);
      full += chunk.text;
      next = chunk.nextCursor;
      expect(next).not.toBe(prior);
    }
    expect(full).toBe('中💡"\\\u0000\n'.repeat(75_000) + "\uD800尾");
    expect((await readFile(join(client.directory, "history-reads"), "utf8")).trim()).toBe("get_messages");
    console.log(`service JSON witness: ${rows.length} rows from 1 Native get_messages; max page ${measured.page} bytes; max chunk ${measured.content} bytes`);
    const other = await create(client, "Other fixture");
    for (const url of [
      `${path}/transcript?cursor=${cursor}`,
      `${path}/transcript/content?cursor=${initial.page.olderCursor}`,
      `${path}/transcript?cursor=${initial.page.olderCursor.replace(/^./u, (c: string) => c === "a" ? "b" : "a")}`,
      `${client.origin}/api/sessions/${other}/transcript?cursor=${initial.page.olderCursor}`,
    ]) expect((await fetch(url)).status).toBe(409);
    const refreshed = await read(path, 256 * 1024);
    expect(refreshed.page.id).not.toBe(initial.page.id);
    expect((await fetch(`${path}/transcript?cursor=${initial.page.olderCursor}`)).status).toBe(409);
    expect((await client.post(`/api/sessions/${id}/actions`, { action: "compact" })).status).toBe(200);
    expect((await fetch(`${path}/transcript?cursor=${refreshed.page.olderCursor}`)).status).toBe(409);
  });

  test("returns typed refusal rather than dropping mandatory interaction state", async () => {
    const client = await launch();
    const id = await create(client, "Mandatory state fixture");
    const response = await fetch(`${client.origin}/api/sessions/${id}`);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThan(1024);
    expect(JSON.parse(text)).toMatchObject({ code: "snapshot_state_too_large" });
  });

  test("never publishes corrupt staged rows and evicts history after a workspace stamp changes", async () => {
    const client = await launch();
    const id = await create(client, "Paged fixture corrupt");
    const path = `${client.origin}/api/sessions/${id}`;
    const captures = await captureScanner();
    const failed = await fetch(path);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "messages_frame_malformed" });
    expect(await captures()).toEqual([]);
    const snapshot = await (await fetch(path)).json();
    const [privateDirectory, ...rest] = await captures();
    expect(rest).toEqual([]);
    expect(privateDirectory).toBeString();
    const location = join(tmpdir(), privateDirectory!);
    if (process.platform !== "win32") expect((await stat(location)).mode & 0o777).toBe(0o700);
    const [file] = await readdir(location);
    expect(file).toBeString();
    if (process.platform !== "win32") expect((await stat(join(location, file!))).mode & 0o777).toBe(0o600);
    const moved = `${client.directory}-moved`;
    await rename(client.directory, moved);
    try {
      await mkdir(client.directory);
      expect((await fetch(`${path}/transcript?cursor=${snapshot.page.olderCursor}`)).status).toBe(403);
    } finally {
      await rm(client.directory, { recursive: true, force: true });
      await rename(moved, client.directory);
    }
    expect(await captures()).toEqual([]);
    expect((await fetch(path)).status).toBe(403);
  });

  test("coalesces snapshots and discards provisional rows when the last waiter aborts", async () => {
    const client = await launch();
    const id = await create(client, "Paged fixture held");
    const path = `${client.origin}/api/sessions/${id}`;
    const captures = await captureScanner();
    const first = new AbortController();
    const second = new AbortController();
    const request = (signal: AbortSignal) => client.app.fetch(new Request(path, { signal, headers: { Host: client.app.url.host } }));
    const a = request(first.signal);
    const b = request(second.signal);
    for (let i = 0; i < 100 && !await Bun.file(join(client.directory, "history-staged")).exists(); i++) await Bun.sleep(10);
    expect(await Bun.file(join(client.directory, "history-staged")).exists()).toBe(true);
    expect(await captures()).toHaveLength(1);
    first.abort();
    expect((await a).status).toBe(408);
    expect(await captures()).toHaveLength(1);
    second.abort();
    expect((await b).status).toBe(408);
    expect(await captures()).toEqual([]);
    await writeFile(join(client.directory, "release-messages"), "");
    const after = await (await fetch(path)).json();
    expect(after.messages).not.toBeEmpty();
    expect((await readFile(join(client.directory, "history-reads"), "utf8")).trim().split("\n")).toEqual(["get_messages", "get_messages"]);
  });

  test.each(["release", "source-change", "engine-disconnect"])("withholds a disk read spanning %s and evicts that generation", async change => {
    const client = await launch();
    const id = await create(client, `Paged fixture ${change}`);
    const path = `${client.origin}/api/sessions/${id}`;
    const captures = await captureScanner();
    const initial = await (await fetch(path)).json();
    expect(await captures()).toHaveLength(1);
    const peek = await fetch(`${path}/transcript?cursor=${initial.page.olderCursor}`);
    expect(peek.status).toBe(409);
    expect(await peek.json()).toEqual({ code: "session_changed", error: expect.any(String) });
    expect(await captures()).toEqual([]);
    expect((await readFile(join(client.directory, "history-reads"), "utf8")).trim()).toBe("get_messages");
  });

  test("drops a damaged scratch generation rather than rereading Native", async () => {
    const client = await launch();
    const id = await create(client, "Paged fixture");
    const path = `${client.origin}/api/sessions/${id}`;
    const captures = await captureScanner();
    const initial = await (await fetch(path)).json();
    const [name] = await captures();
    const directory = join(tmpdir(), name!);
    const [file] = await readdir(directory);
    await truncate(join(directory, file!), 0);
    const reply = await fetch(`${path}/transcript?cursor=${initial.page.olderCursor}`);
    expect(reply.status).toBe(502);
    expect(await reply.json()).toMatchObject({ code: "history_capture_failed" });
    expect(await captures()).toEqual([]);
    expect((await readFile(join(client.directory, "history-reads"), "utf8")).trim()).toBe("get_messages");
    expect((await fetch(path)).status).toBe(200);
    expect(await captures()).toHaveLength(1);
    await client.app.stop();
    expect(await captures()).toEqual([]);
  });

  test.each(["Close", "Replace", "Compact"])("does not publish a snapshot spanning %s", async change => {
    const client = await launch();
    const id = await create(client, `${change} during snapshot`);
    const request = () => fetch(`${client.origin}/api/sessions/${id}`);
    const stale = await request();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "session_changed" });
    const fresh = await request();
    expect(fresh.status).toBe(change === "Close" ? 409 : 200);
    if (fresh.ok) expect((await fresh.json()).messages).toEqual([]);
  });

  test("streams a native reply under the correct Web ID without exposing hidden runtime context", async () => {
    const client = await launch();
    const id = await create(client);
    const stream = await fetch(`${client.origin}/api/events`, { signal: AbortSignal.timeout(5000) });
    const reader = stream.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new TypeError("SSE response has no body");
    try {
      const result = await client.post(`/api/sessions/${id}/actions`, { action: "prompt", message: "wire witness" });
      expect(result.status).toBe(200);
      let wire = "";
      while (!wire.includes('"type":"agent_settled"')) {
        const frame = await reader.read();
        if (frame.done) break;
        wire += frame.value;
      }
      const data = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      expect(data.find(frame => frame.type === "message_end" && frame.message?.role === "assistant")).toMatchObject({
        sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "Echo: wire witness" }] },
      });
      const snapshot = await (await fetch(`${client.origin}/api/sessions/${id}`)).json();
      expect(snapshot.state.model).toEqual({ id: "fixture", provider: "local", name: "Fixture model" });
      expect(JSON.stringify(snapshot)).not.toContain("credential.invalid");
      expect(JSON.stringify(snapshot)).not.toContain("hidden test context");
      expect(wire).not.toContain("hidden test context");
    } finally {
      await reader.cancel();
    }
  });
});
