import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
