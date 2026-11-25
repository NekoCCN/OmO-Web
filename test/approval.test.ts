import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./approval-engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.APPROVAL_FIXTURE_NO_AUTO;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function launch() {
  const root = await mkdtemp(join(tmpdir(), "omo-approval-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await Bun.$`mkdir -p ${cwd}`.quiet();
  const app = await startApp({
    dataDir: join(root, "web"), workspaces: [cwd], port: 0,
    engineCommand: [process.execPath, fixture],
  });
  cleanups.push(() => app.stop());
  const origin = app.url.origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { token: string };
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { headers: { Origin: origin } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { post, get, cwd };
}

describe("approval presets", () => {
  test("open defaults to ask and switches to auto/full-access with acknowledged effective state", async () => {
    const client = await launch();
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "approval" });
    expect(created.status).toBe(201);
    const id = String((created.body.session as { id: string }).id);
    const initial = await client.get(`/api/sessions/${id}`);
    expect(initial.status).toBe(200);
    const state = initial.body.state as Record<string, unknown>;
    expect(state.permissionPreset).toBe("ask");
    expect(state.effectivePermissionPreset).toBe("ask");
    const pending = [...(state.pendingQuestions as unknown[]), ...(state.pendingDialogs as unknown[])] as Record<string, unknown>[];
    expect(pending.map(entry => entry.id).sort()).toEqual(["q-structured"]);

    const auto = await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "auto" });
    expect(auto.status).toBe(200);
    expect((await client.get(`/api/sessions/${id}`)).body.state).toMatchObject({
      permissionPreset: "auto", effectivePermissionPreset: "auto",
    });
    const full = await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "full-access" });
    expect(full.status).toBe(200);
    expect((await client.get(`/api/sessions/${id}`)).body.state).toMatchObject({
      permissionPreset: "full-access", effectivePermissionPreset: "full-access",
    });
    const back = await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "ask" });
    expect(back.status).toBe(200);
    const invalid = await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "turbo" });
    expect(invalid.status).toBe(400);
  });

  test("auto without the native capability is refused and a new session still defaults to ask", async () => {
    process.env.APPROVAL_FIXTURE_NO_AUTO = "1";
    const client = await launch();
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "no-auto" });
    expect(created.status).toBe(201);
    const id = String((created.body.session as { id: string }).id);
    const auto = await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "auto" });
    expect(auto.status).toBe(409);
    expect(auto.body.code).toBe("unsupported");
    expect((await client.get(`/api/sessions/${id}`)).body.state).toMatchObject({
      permissionPreset: "ask", effectivePermissionPreset: "ask",
    });
    const second = await client.post("/api/sessions", { cwd: client.cwd, name: "second" });
    expect(second.status).toBe(201);
    const other = String((second.body.session as { id: string }).id);
    expect((await client.get(`/api/sessions/${other}`)).body.state).toMatchObject({
      permissionPreset: "ask", effectivePermissionPreset: "ask",
    });
  });

  test("structured questions stay explicit under full-access and secrets never surface", async () => {
    const client = await launch();
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "questions" });
    expect(created.status).toBe(201);
    const id = String((created.body.session as { id: string }).id);
    expect((await client.post(`/api/sessions/${id}/actions`, { action: "preset", preset: "full-access" })).status).toBe(200);
    const snapshot = await client.get(`/api/sessions/${id}`);
    const state = snapshot.body.state as Record<string, unknown>;
    expect(state.effectivePermissionPreset).toBe("full-access");
    const ids = [...(state.pendingQuestions as unknown[]), ...(state.pendingDialogs as unknown[])] as Record<string, unknown>[];
    expect(ids.map(entry => entry.id)).toEqual(["q-structured"]);

    const empty = await client.post(`/api/sessions/${id}/actions`, { action: "answer", requestId: "q-structured", value: "A" });
    expect(empty.status).toBe(400);
    const secret = await client.post(`/api/sessions/${id}/actions`,
      { action: "answer", requestId: "q-secret", answers: { qq9: { selected: ["S"] } } });
    expect(secret.status).toBe(409);
    expect(secret.body.code).toBe("unknown_dialog");
    const answer = await client.post(`/api/sessions/${id}/actions`,
      { action: "answer", requestId: "q-structured", answers: { qq1: { selected: ["A"] } } });
    expect(answer.status).toBe(200);
  });
});
