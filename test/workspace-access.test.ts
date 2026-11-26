import { afterEach, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const windows = process.platform === "win32";
const fixture = fileURLToPath(new URL("./engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function launch(separateEngineRoot = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "omo-workspace-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const outside = join(base, "root sibling");
  const child = join(root, "child space");
  const profile = join(base, "agent");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(outside), mkdir(join(profile, "sessions"), { recursive: true })]);
  const engineRoot = separateEngineRoot ? join(base, "engine working dir") : root;
  if (separateEngineRoot) await mkdir(engineRoot);
  async function start() {
    const app = await startApp({ dataDir: join(base, "data"), workspaces: separateEngineRoot ? [engineRoot, root] : [root],
      engineCommand: [process.execPath, fixture], port: 0, cliAgentDir: profile });
    cleanups.push(() => app.stop());
    const get = (route: string) => fetch(new URL(`/api/${route}`, app.url));
    const bootstrap = await (await get("bootstrap")).json();
    const post = (route: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(new URL(`/api/${route}`, app.url), {
        method: "POST", body: JSON.stringify(body),
        headers: { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token, ...extra },
      });
    return { app, bootstrap, get, post };
  }
  return { base, root, child, outside, profile, engineRoot, start, ...await start() };
}

test("browse is POST-only, token-bound, names-only and confined to the configured tree", async () => {
  const { bootstrap, get, post, root, child, outside } = await launch();
  expect(bootstrap.fileBrowser).toEqual({ platform: windows ? "win32" : "posix" });
  await writeFile(join(root, "private.txt"), "a fixture secret that must not appear in any response");
  expect((await get("workspaces/browse")).status).toBe(404);
  expect((await post("workspaces/browse", { path: root }, { "X-OmO-Token": "" })).status).toBe(403);
  expect((await post("workspaces/browse", { path: root }, { Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await post("workspaces/browse", { path: root, include: "content" })).status).toBe(400);
  expect((await post("workspaces/browse", { path: outside })).status).toBe(403);
  const result = await (await post("workspaces/browse", { path: root })).json();
  expect(result).toEqual({ path: root, parent: null, truncated: false, entries: [
    { name: "child space", path: child, kind: "directory" },
    { name: "private.txt", path: join(root, "private.txt"), kind: "file" },
  ] });
  expect(await (await post("workspaces/browse", { path: child })).json()).toEqual({
    path: child, parent: root, entries: [], truncated: false,
  });
});

test("listing stops at the entry budget and reports truncation", async () => {
  const { post, child } = await launch();
  for (let i = 0; i < 300; i++) await writeFile(join(child, `file-${i}`), "");
  const result = await (await post("workspaces/browse", { path: child })).json();
  expect(result.truncated).toBe(true);
  expect(result.entries).toHaveLength(256);
});

test("strict one-shot confirmation grants only on allow, refreshes history and expires on restart", async () => {
  const { post, get, base, root, child, outside, profile, start, app } = await launch();
  const bucket = join(profile, "sessions", `--${outside.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(bucket);
  await writeFile(join(bucket, "local.jsonl"), `${JSON.stringify({
    type: "session", version: 3, id: "grant-local", cwd: outside, timestamp: "2026-11-20T00:00:00Z",
  })}\n`);
  expect(await (await get("cli-history")).json()).toEqual({ available: true, sessions: [] });
  const first = await (await post("workspaces/prepare", { path: outside })).json();
  expect(first).toMatchObject({ status: "confirmation_required", path: outside });
  expect((await post("workspaces/browse", { path: outside })).status).toBe(403);
  expect((await post("workspaces/confirm", { confirmation: first.confirmation, allow: true, path: outside })).status).toBe(400);
  expect((await post("workspaces/confirm", { confirmation: first.confirmation, allow: "true" })).status).toBe(400);
  expect(await (await post("workspaces/confirm", { confirmation: first.confirmation, allow: false })).json()).toEqual({ status: "cancelled" });
  expect((await post("workspaces/confirm", { confirmation: first.confirmation, allow: true })).status).toBe(409);
  expect((await post("sessions", { cwd: outside })).status).toBe(403);
  expect((await post("sessions", { cwd: child })).status).toBe(403);
  const second = await (await post("workspaces/prepare", { path: outside })).json();
  const decisions = await Promise.all([true, true].map(allow =>
    post("workspaces/confirm", { confirmation: second.confirmation, allow })));
  expect(decisions.map(r => r.status).sort()).toEqual([200, 409]);
  const accepted = decisions.find(r => r.ok);
  expect(await accepted?.json()).toEqual({ path: outside, workspaces: [root, outside] });
  expect(await (await post("workspaces/prepare", { path: outside })).json()).toEqual({
    status: "authorized", path: outside, workspaces: [root, outside],
  });
  expect((await post("workspaces/browse", { path: outside })).status).toBe(200);
  const created = await post("sessions", { cwd: outside });
  expect(created.status).toBe(201);
  const { session } = await created.json();
  const { sessions } = await (await get("cli-history")).json();
  expect(sessions).toMatchObject([{ cwd: outside }]);
  await app.stop();
  const restarted = await start();
  expect(restarted.bootstrap.workspaces).toEqual([root]);
  expect(restarted.bootstrap.sessions).toEqual([]);
  expect(await (await restarted.get("sessions")).json()).toEqual({ sessions: [] });
  expect((await lstat(join(base, "data", "sessions", `${session.id}.json`))).isFile()).toBe(true);
  expect((await restarted.post("workspaces/browse", { path: outside })).status).toBe(403);
  expect((await restarted.post(`sessions/${session.id}/actions`, { action: "resume" })).status).toBe(403);
});

test("legacy Web rows require the original startup root, not approval of a replacement", async () => {
  const { app, base, outside, root, start } = await launch(true);
  await app.stop();
  const seed = async (cwd: string) => {
    const id = crypto.randomUUID();
    await writeFile(join(base, "data", "sessions", `${id}.json`), JSON.stringify({
      id, cwd, name: "Legacy session", updatedAt: 1, archived: false, settled: false,
    }));
    return id;
  };
  const configured = await seed(root);
  const unbound = await seed(outside);
  await rename(outside, join(base, "former unbound workspace"));
  await mkdir(outside);
  const restarted = await start();
  const resume = (id: string) => restarted.post(`sessions/${id}/actions`, { action: "resume" });
  const listedIds = async () => (await (await restarted.get("sessions")).json()).sessions
    .map((row: { id: string }) => row.id);
  const approve = async (path: string) => {
    const prepared = await (await restarted.post("workspaces/prepare", { path })).json();
    expect((await restarted.post("workspaces/confirm", { confirmation: prepared.confirmation, allow: true })).status).toBe(200);
  };
  expect((await resume(configured)).status).toBe(200);
  await approve(outside);
  expect((await resume(unbound)).status).toBe(403);
  expect(restarted.bootstrap.sessions.map((row: { id: string }) => row.id)).toEqual([configured]);
  expect(await listedIds()).toEqual([configured]);
  expect((await restarted.post("sessions", { cwd: outside })).status).toBe(201);

  await rename(root, join(base, "former configured workspace"));
  await mkdir(root);
  await approve(root);
  expect((await resume(configured)).status).toBe(403);
  expect(await listedIds()).not.toContain(configured);
});

test("confirmation cannot grant an expired or replaced directory", async () => {
  const { post, outside, base } = await launch();
  const prior = await (await post("workspaces/prepare", { path: outside })).json();
  const clock = spyOn(Date, "now").mockReturnValue(prior.expiresAt + 1);
  try {
    expect((await post("workspaces/confirm", { confirmation: prior.confirmation, allow: true })).status).toBe(409);
  } finally { clock.mockRestore(); }
  const prepared = await (await post("workspaces/prepare", { path: outside })).json();
  await rename(outside, join(base, "formerly outside"));
  await mkdir(outside);
  expect((await post("workspaces/confirm", { confirmation: prepared.confirmation, allow: true })).status).toBe(409);
  expect((await post("workspaces/browse", { path: outside })).status).toBe(403);
});

test("a reapproved replacement never becomes the cwd of an old Web session", async () => {
  const { base, get, outside, post } = await launch();
  const approve = async () => {
    const prepared = await (await post("workspaces/prepare", { path: outside })).json();
    expect((await post("workspaces/confirm", { confirmation: prepared.confirmation, allow: true })).status).toBe(200);
  };
  await approve();
  const { session } = await (await post("sessions", { cwd: outside })).json();
  await rename(outside, join(base, "renamed workspace"));
  await mkdir(outside);
  expect((await post("workspaces/browse", { path: outside })).status).toBe(403);
  expect((await post("sessions", { cwd: outside })).status).toBe(403);
  await approve();
  expect((await post(`sessions/${session.id}/actions`, { action: "resume" })).status).toBe(403);
  expect((await (await get("bootstrap")).json()).sessions).toEqual([]);
  expect(await (await get("sessions")).json()).toEqual({ sessions: [] });
  expect((await post("sessions", { cwd: outside })).status).toBe(201);
});

test("configured grants also reject a same-path replacement", async () => {
  const { base, child, engineRoot, get, post, root } = await launch(true);
  await rename(root, join(base, "old configured root"));
  await mkdir(child, { recursive: true });
  expect((await post("workspaces/browse", { path: child })).status).toBe(403);
  expect((await post("sessions", { cwd: root })).status).toBe(403);
  expect((await (await get("bootstrap")).json()).workspaces).toEqual([engineRoot]);
});

test("prepare rejects invalid paths before interpreting them with the host filesystem", async () => {
  const { post, root } = await launch();
  const drive = parse(root).root.slice(0, 2);
  const invalid = ["./relative", "~/not-expanded", `${root}\0bad`, `${root}\nbad`, ...(windows
    ? [`${drive}relative`, "\\relative", "\\\\server\\share", `\\\\?\\${root}`, "\\\\.\\NUL",
      `${root}\\stream:alt`, `${root}\\NUL.txt`, `${root}\\COM¹`, `${root}\\LPT1 .txt`, `${root}.`, `${root} `,
      `${root}\\invalid?`, `${root}\\.. \\unreachable`]
    : ["C:\\drive", "relative"])];
  const results = await Promise.all(invalid.map(path => post("workspaces/prepare", { path })));
  expect(results.map(r => r.status)).toEqual(invalid.map(() => 400));
  const input = windows ? root.replace(/\\/g, "/") : `${root}/`;
  expect(await (await post("workspaces/prepare", { path: input })).json()).toMatchObject({ status: "authorized", path: root });
});

test("confirmation and native listings never display direction or control characters", async () => {
  const { post, root, child, outside } = await launch();
  const controls = ["\u007f", "\u0085", "\u061c", "\u200b", "\u200f", "\u2028", "\u202e", "\u2066"];
  for (const character of controls) {
    await mkdir(join(outside, `approve${character}directory`));
    await mkdir(join(root, `directory${character}`));
    await writeFile(join(root, `file${character}.txt`), "");
    expect((await post("workspaces/prepare", { path: join(outside, `approve${character}directory`) })).status).toBe(400);
    expect((await post("workspaces/browse", { path: join(root, `directory${character}`) })).status).toBe(400);
  }
  await writeFile(join(root, "正常.txt"), "");
  expect(await (await post("workspaces/browse", { path: root })).json()).toEqual({
    path: root, parent: null, truncated: false, entries: [
      { name: "child space", path: child, kind: "directory" },
      { name: "正常.txt", path: join(root, "正常.txt"), kind: "file" },
    ],
  });
});

test("workspace paths preserve native casing without widening the canonical root boundary", async () => {
  const { post, root, child } = await launch();
  const alternateRoot = `${root.slice(0, -4)}ROOT`;
  const alternateChild = join(alternateRoot, "CHILD SPACE");
  const prepared = await post("workspaces/prepare", { path: alternateRoot });
  const browsed = await post("workspaces/browse", { path: alternateChild });
  if (windows) {
    expect(await prepared.json()).toMatchObject({ status: "authorized", path: root });
    expect(await browsed.json()).toEqual({ path: child, parent: root, entries: [], truncated: false });
  } else {
    expect([prepared.status, browsed.status]).toEqual([400, 403]);
  }
});

test("the host Bun filesystem provides bigint directory identity fields", async () => {
  const { root } = await launch();
  const { dev, ino, birthtimeNs } = await lstat(root, { bigint: true });
  expect([typeof dev, typeof ino, typeof birthtimeNs]).toEqual(["bigint", "bigint", "bigint"]);
  expect(ino).not.toBe(0n);
});

test("out-of-tree aliases cannot be listed or used to approve a different directory", async () => {
  const { root, outside, post } = await launch();
  const link = join(root, "escape");
  await symlink(outside, link, windows ? "junction" : "dir");
  expect((await post("workspaces/browse", { path: link })).status).toBe(403);
  expect((await post("workspaces/prepare", { path: link })).status).toBe(400);
  expect(await (await post("workspaces/browse", { path: root })).json()).toMatchObject({
    entries: [{ name: "child space", kind: "directory" }],
  });
});
