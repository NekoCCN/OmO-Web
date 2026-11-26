import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./capabilities-engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function launch() {
  const cwd = await mkdtemp(join(tmpdir(), "omo-web-capabilities-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, "calls.jsonl");
  const settings = { dataDir: join(cwd, "data"), workspaces: [cwd], port: 0,
    engineCommand: [process.execPath, fixture, log] as const };
  async function start() {
    const app = await startApp(settings);
    cleanups.push(() => app.stop());
    return app;
  }
  const app = await start();
  const boot = await (await fetch(new URL("/api/bootstrap", app.url))).json();
  return {
    app, start, calls: () => readFile(log, "utf8"),
    async create(name: string) {
      const response = await fetch(new URL("/api/sessions", app.url), {
        method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": boot.token, "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name }),
      });
      expect(response.status).toBe(201);
      return String((await response.json()).session.id);
    },
  };
}

const api = (url: URL, id: string, init?: RequestInit) =>
  fetch(new URL(`/api/sessions/${id}/capabilities`, url), init);
const ok = (rows: readonly unknown[], incomplete = false) => ({ status: "ok", rows, incomplete });
const unavailable = (reason: string) => ({ status: "unavailable", reason });

test("routes fresh inventory reads to the selected session and projects only allowlisted fields", async () => {
  const { app, create, calls } = await launch();
  const active = await create("passive");
  const empty = await create("empty");
  const before = await calls();
  const response = await api(app.url, active);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    extensions: ok([
      { name: "passive-fixture", enabled: true, origin: "top-level" },
      { name: "packaged", enabled: false, origin: "package" },
      { name: "origin-unknown", enabled: true },
    ], true),
    mcpServers: ok([{ name: "local-fixture", status: "connecting", toolCount: 0 }], true),
    commands: ok([
      { name: "fix-tests", source: "prompt", invocation: "/fix-tests" },
      { name: "skill:pdf-tools", source: "skill", invocation: "$pdf-tools" },
      { name: "echo", source: "extension", invocation: "/echo" },
    ], true),
  });
  expect(await (await api(app.url, empty)).json()).toEqual({
    extensions: ok([]), mcpServers: ok([]), commands: ok([]),
  });
  expect(await (await api(app.url, active)).json()).toMatchObject({
    extensions: ok([]), mcpServers: ok([{ name: "local-fixture", status: "connected", toolCount: 3 }]),
  });
  const routed = (await calls()).slice(before.length).trim().split("\n").map(line => JSON.parse(line));
  expect(routed).toEqual(["private-route-1", "private-route-2", "private-route-1"].flatMap(sessionId =>
    ["get_loaded_surfaces", "get_commands"].map(type => ({ type, sessionId }))));
});

test("keeps RPC failure, malformed, empty and filtered sections distinct", async () => {
  const { app, create } = await launch();
  const [legacy, malformed, commandFailure, bounded] = [
    await create("legacy"), await create("malformed"), await create("command-failure"), await create("bounded"),
  ];
  if (!legacy || !malformed || !commandFailure || !bounded) throw new Error("Missing session");
  expect(await (await api(app.url, legacy)).json()).toEqual({
    extensions: unavailable("rpc-failed"), mcpServers: unavailable("rpc-failed"),
    commands: expect.objectContaining({ status: "ok" }),
  });
  expect(await (await api(app.url, malformed)).json()).toEqual({
    extensions: unavailable("invalid-response"), mcpServers: ok([]), commands: unavailable("invalid-response"),
  });
  const failed = await api(app.url, commandFailure);
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({
    extensions: expect.objectContaining({ status: "ok" }), mcpServers: expect.objectContaining({ status: "ok" }),
    commands: unavailable("rpc-failed"),
  });
  expect(await (await api(app.url, bounded)).json()).toMatchObject({
    extensions: ok(Array.from({ length: 128 }, (_, index) => ({ name: `extension-${index}`, enabled: true })), true),
    mcpServers: ok([], true),
  });
});

test("rejects wrong, cross-origin, and parked sessions without booting or reopening native", async () => {
  const { app, create, start, calls } = await launch();
  const known = await create("empty");
  const before = await calls();
  expect((await api(app.url, known, { headers: { Origin: "https://wrong.invalid" } })).status).toBe(403);
  const wrong = await api(app.url, crypto.randomUUID());
  expect(wrong.status).toBe(404);
  expect(await wrong.json()).toMatchObject({ code: "session_not_found" });
  expect(await calls()).toBe(before);
  await app.stop();
  const restarted = await start();
  const parked = await api(restarted.url, known);
  expect(parked.status).toBe(409);
  expect(await parked.json()).toMatchObject({ code: "session_not_open" });
  expect(await calls()).toBe(before);
});

test("discards pending inventory when the binding is parked during a read", async () => {
  const { app, create } = await launch();
  const response = await api(app.url, await create("park-during-read"));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "session_not_open" });
});
