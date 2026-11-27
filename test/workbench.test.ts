import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./command-engine-fixture.ts", import.meta.url));
const cliId = "aaaaaaaa-1111-4111-8111-111111111111";
const foreignId = "bbbbbbbb-2222-4222-8222-222222222222";
const updatedAt = 1_795_460_000_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function journal(agent: string, cwd: string, id: string, title: string): Promise<void> {
  const dir = join(agent, "sessions", `--${cwd.slice(1).replace(/[/\\:]/g, "-")}--`);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date(updatedAt).toISOString();
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: "Synthetic transcript", timestamp: updatedAt } },
    { type: "session_info", id: "m2", parentId: "m1", timestamp, name: title },
  ];
  await writeFile(join(dir, `private-${id}.jsonl`), `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function projection(agent: string, n: number, id: string, name: string): Promise<void> {
  const dir = join(agent, "herdr-dag");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${String(n).padStart(24, "0")}.json`), JSON.stringify({
    version: 1, sessionId: id, connected: false, language: "zh-CN", updatedAt,
    runs: [{ id: "run-test", name, status: "done", createdAt: updatedAt, updatedAt,
      nodes: [{ id: "read", label: "Read fixture", state: "done", attempt: 1 },
        { id: "check", label: "Check fixture", state: "done", attempt: 2, taskId: "child-test" }],
      edges: [{ from: "read", to: "check" }] }],
    tasks: [{ id: "child-test", description: "Check the sample", agent: "fixture", model: "local",
      status: "done", startedAt: updatedAt, turns: 1, toolCalls: 0 }],
    journalPath: "/private/test-journal.jsonl",
  }));
}

async function launch({ enabled = true, online = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omo-web-workbench-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace");
  const foreign = join(root, "other");
  await mkdir(cwd);
  await journal(agent, cwd, cliId, "Owned synthetic history");
  await journal(agent, foreign, foreignId, "Foreign synthetic history");
  await projection(agent, 1, cliId, "CLI snapshot");
  await projection(agent, 2, foreignId, "Foreign snapshot");
  const settings = {
    dataDir: join(root, "web"),
    workspaces: [cwd],
    engineCommand: (online ? [process.execPath, fixture] : [join(root, "no-engine")]) satisfies [string, ...string[]],
    port: 0,
    ...(enabled ? { cliAgentDir: agent } : {}),
  };
  const app = await startApp(settings);
  cleanups.push(() => app.stop());
  const get = (path: string) => fetch(new URL(path, app.url));
  const bootstrap = await (await get("/api/bootstrap")).json();
  const post = (path: string, body: object) => fetch(new URL(path, app.url), {
    method: "POST", headers: { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token },
    body: JSON.stringify(body),
  });
  return { agent, cwd, engine: bootstrap.engine, get, post };
}

test("offline CLI history projects only authorized readable transcripts", async () => {
  const { get, post, engine, cwd } = await launch();
  expect(engine.online).toBe(false);
  const listing = await get("/api/cli-history");
  expect(listing.status).toBe(200);
  const { available, sessions } = await listing.json();
  expect(available).toBe(true);
  expect(sessions).toMatchObject([{ name: "Owned synthetic history", cwd }]);
  const path = `/api/cli-history/${sessions[0].id}`;
  const response = await get(path);
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(JSON.parse(raw)).toMatchObject({
    session: sessions[0],
    messages: [{ role: "user", content: "Synthetic transcript" }],
  });
  expect(raw).not.toContain(cliId);
  expect(raw).not.toContain("private-");
  expect(raw).not.toContain("internal");
  expect((await post(path, { action: "resume" })).status).toBe(404);
});

test("CLI activity needs a matching owned history selection", async () => {
  const { get } = await launch();
  const listing = await get("/api/cli-history");
  expect(listing.status).toBe(200);
  const { sessions } = await listing.json();
  const activity = await get(`/api/cli-history/${sessions[0].id}/activity`);
  expect(activity.status).toBe(200);
  const raw = await activity.text();
  expect(JSON.parse(raw)).toMatchObject({
    status: "ok", updatedAt, runs: [{ name: "CLI snapshot", nodes: [{ label: "Read fixture" }, { upstream: ["Read fixture"] }] }],
    tasks: [{ agent: "fixture" }],
  });
  expect(raw).not.toContain(cliId);
  expect(raw).not.toContain("journal");
  for (const id of [cliId, foreignId]) {
    expect((await get(`/api/cli-history/${id}/activity`)).status).toBe(404);
  }
});

test("Web activity uses the loaded session durable identity, not its public or RPC ID", async () => {
  const { get, post, cwd, agent } = await launch({ online: true });
  const opened = await post("/api/sessions", { cwd });
  expect(opened.status).toBe(201);
  const { session: { id } } = await opened.json();
  await projection(agent, 3, id, "Wrong Web ID");
  await projection(agent, 4, "rpc-1", "Wrong RPC handle");
  const path = `/api/sessions/${id}/activity`;
  const missing = await get(`${path}?sessionId=${cliId}`);
  expect(missing.status).toBe(200);
  expect(await missing.json()).toMatchObject({ status: "unavailable" });
  await projection(agent, 5, "durable-rpc-1", "Web snapshot");
  const found = await get(path);
  expect(found.status).toBe(200);
  const raw = await found.text();
  expect(JSON.parse(raw)).toMatchObject({ status: "ok", runs: [{ name: "Web snapshot" }] });
  expect(raw).not.toContain("durable-rpc-1");
});

test("omitting the profile disables CLI history", async () => {
  const { get } = await launch({ enabled: false });
  const response = await get("/api/cli-history");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ available: false, sessions: [] });
});

test("oversized CLI journals stay discoverable with capped preview and gated resume", async () => {
  const { agent, cwd, get, post } = await launch();
  const bigId = "cccccccc-3333-4333-8333-333333333333";
  const dir = join(agent, "sessions", `--${cwd.slice(1).replace(/[/\\:]/g, "-")}--`);
  const timestamp = new Date(updatedAt).toISOString();
  const entries = [
    { type: "session", version: 3, id: bigId, timestamp, cwd },
    { type: "session_info", id: "s-big", parentId: null, timestamp, name: "Oversized synthetic history" },
    { type: "message", id: "m-big", parentId: null, timestamp,
      message: { role: "user", content: `filler ${"x".repeat(9 * 1024 * 1024)}`, timestamp: updatedAt } },
  ];
  await writeFile(join(dir, `private-${bigId}.jsonl`), `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
  const listing = await get("/api/cli-history");
  expect(listing.status).toBe(200);
  const { sessions } = await listing.json();
  const big = sessions.find((session: { name?: unknown }) => session.name === "Oversized synthetic history");
  expect(big).toMatchObject({ name: "Oversized synthetic history", cwd });
  expect(JSON.stringify(sessions)).not.toContain(bigId);
  expect(JSON.stringify(sessions)).not.toContain("private-");
  const preview = await get(`/api/cli-history/${big.id}`);
  expect(preview.status).toBe(400);
  expect(await preview.json()).toMatchObject({ code: "history_too_large" });
  const activity = await get(`/api/cli-history/${big.id}/activity`);
  expect(activity.status).toBe(400);
  const resume = await post(`/api/cli-history/${big.id}/resume`, {});
  expect(resume.status).toBe(503);
  expect(await resume.json()).toMatchObject({ code: "engine_unavailable" });
});
