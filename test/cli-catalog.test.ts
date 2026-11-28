import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_HISTORY_LIMITS, sessionDirName } from "../src/cli-history.ts";
import { startApp } from "../src/server.ts";

const engineFixture = fileURLToPath(new URL("./session-handoff-engine-fixture.ts", import.meta.url));
const catalog = "/api/cli-history";
const scope = (cwd: string) => `${catalog}?${new URLSearchParams({ cwd })}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-catalog-http-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  const alpha = join(root, "alpha-project");
  const colliding = join(root, "alpha", "project");
  const beta = join(root, "beta");
  const child = join(alpha, "child");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(beta), mkdir(colliding, { recursive: true })]);
  const app = await startApp({ dataDir: join(root, "web"), workspaces: [alpha, beta],
    engineCommand: [process.execPath, engineFixture], port: 0, cliAgentDir: profile });
  cleanups.push(() => app.stop());
  const origin = app.url.origin;
  const get = (path: string) => fetch(`${origin}${path}`);
  const { token } = await (await get("/api/bootstrap")).json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": token };
  const post = (path: string, body: unknown = {}) =>
    fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  async function seed(cwd: string, name: string, order: number, oversized = false) {
    const id = crypto.randomUUID();
    const bucket = join(profile, "sessions", sessionDirName(cwd));
    await mkdir(bucket, { recursive: true });
    const journal = join(bucket, `${id}.jsonl`);
    const timestamp = "2026-11-26T00:00:00.000Z";
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd },
      { type: "session_info", id: "title", parentId: null, timestamp, name },
      { type: "message", id: "user", parentId: "title", timestamp,
        message: { role: "user", content: oversized ? "x".repeat(CLI_HISTORY_LIMITS.maxFileBytes + 1) : name, timestamp: 1 } },
    ];
    await writeFile(journal, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
    const time = new Date(1_700_000_000_000 + order * 1000);
    await utimes(journal, time, time);
    return id;
  }
  return { alpha, beta, child, colliding, get, post, seed };
}

test("exact directory has its own ranking and parse budget despite a busier directory", async () => {
  const { alpha, beta, get, seed } = await fixture();
  const id = await seed(alpha, "Alpha oversized", 1, true);
  const betaNames = Array.from({ length: CLI_HISTORY_LIMITS.maxListFiles + 1 }, (_, index) => `Beta ${index}`);
  await Promise.all(betaNames.map((name, index) => seed(beta, name, index + 2)));

  const [alphaResponse, betaResponse, legacyResponse] = await Promise.all([get(scope(alpha)), get(scope(beta)), get(catalog)]);

  expect(alphaResponse.status).toBe(200);
  const alphaList = await alphaResponse.json();
  expect(alphaList).toEqual({ available: true, sessions: [{ id: expect.stringMatching(/^[a-f0-9]{64}$/),
    name: "Alpha oversized", cwd: alpha, updatedAt: 1_700_000_001_000, adopted: false }] });
  expect(JSON.stringify(alphaList)).not.toContain(id);
  const betaExpected = betaNames.slice(1).reverse().map(name => [beta, name]);
  for (const response of [betaResponse, legacyResponse]) {
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.sessions.map(({ cwd, name }: { cwd: string; name: string }) => [cwd, name])).toEqual(betaExpected);
  }
  const preview = await get(`${catalog}/${alphaList.sessions[0].id}`);
  expect(preview.status).toBe(400);
  expect(await preview.json()).toMatchObject({ code: "history_too_large" });
});

test("preview and oversized resume keep the chosen identity after other scoped and legacy reads", async () => {
  const { alpha, beta, get, post, seed } = await fixture();
  await seed(alpha, "Open oversized alpha", 1, true);
  await seed(alpha, "Preview alpha", 2);
  const initial = await (await get(scope(alpha))).json();
  const [previewable, resumable] = initial.sessions;
  await Promise.all(Array.from({ length: CLI_HISTORY_LIMITS.maxListFiles }, (_, index) =>
    seed(beta, `New Beta ${index}`, index + 3)));
  // By now even the legacy global list omits alpha; neither read may evict it.
  await Promise.all([get(scope(beta)), get(scope(beta)), get(catalog)]);
  await (await get(scope(beta))).text();

  const preview = await get(`${catalog}/${previewable.id}`);
  const resumed = await post(`${catalog}/${resumable.id}/resume`);

  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ session: { id: previewable.id, cwd: alpha }, messages: [
    { content: "Preview alpha" },
  ] });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ session: { active: true, cwd: alpha, name: "Open oversized alpha" } });
  expect(await (await get(scope(alpha))).json()).toMatchObject({ sessions: [
    { id: previewable.id, adopted: false }, { id: resumable.id, adopted: true },
  ] });
});

test("journals sharing a native bucket are scoped by their recorded cwd before ranking", async () => {
  const { alpha, colliding, get, seed } = await fixture();
  await seed(alpha, "Only Alpha", 1);
  await Promise.all(Array.from({ length: CLI_HISTORY_LIMITS.maxListFiles }, (_, index) =>
    seed(colliding, `Colliding cwd ${index}`, index + 2)));

  const response = await get(scope(alpha));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sessions: [{ name: "Only Alpha", cwd: alpha }] });
});

test("the catalog refuses unauthorized and noncanonical exact scopes", async () => {
  const { alpha, child, get, seed } = await fixture();
  await seed(child, "Not authorized by the parent grant", 1);
  const cases = [
    [scope(child), 403, "workspace_refused"],
    [scope(`${alpha}/.`), 403, "workspace_refused"],
    [`${catalog}?cwd=`, 400, "invalid_request"],
    [`${scope(alpha)}&cwd=${encodeURIComponent(child)}`, 400, "invalid_request"],
  ] as const;
  for (const [path, status, code] of cases) {
    const response = await get(path);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
});

test("replacing and reauthorizing a workspace never rebinds an old catalog reference", async () => {
  const { alpha, get, post, seed } = await fixture();
  await seed(alpha, "Original identity", 1);
  const { sessions: [original] } = await (await get(scope(alpha))).json();
  await rename(alpha, `${alpha}-moved`);
  await mkdir(alpha);

  const refused = await get(scope(alpha));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "workspace_refused" });
  const { status, confirmation } = await (await post("/api/workspaces/prepare", { path: alpha })).json();
  expect(status).toBe("confirmation_required");
  expect((await post("/api/workspaces/confirm", { confirmation, allow: true })).status).toBe(200);
  const { sessions: [replacement] } = await (await get(scope(alpha))).json();
  expect(replacement).toMatchObject({ cwd: alpha, name: "Original identity" });
  expect(replacement.id).not.toBe(original.id);
  const old = `${catalog}/${original.id}`;
  const responses = await Promise.all([get(old), get(`${old}/activity`), get(`${old}/branch-options`),
    post(`${old}/resume`), post(`${old}/branches`, { kind: "fork", entryId: "user" })]);
  for (const response of responses) {
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "history_not_found" });
  }
});
