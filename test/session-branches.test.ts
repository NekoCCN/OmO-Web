import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliHistory } from "../src/cli-history.ts";
import { Engine } from "../src/engine.ts";
import { record } from "../src/protocol.ts";
import type { WireObject } from "../src/protocol.ts";
import { Sessions } from "../src/sessions.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const timestamp = "2026-11-25T00:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const messages = [
  { id: "u1", parentId: null, role: "user", text: "root input" },
  { id: "a1", parentId: "u1", role: "assistant", text: "first answer" },
  { id: "u2", parentId: "a1", role: "user", text: "second input" },
  { id: "a2", parentId: "u2", role: "assistant", text: "second answer" },
  { id: "alt", parentId: "a1", role: "user", text: "last saved on disk" },
];
const entries = messages.map(({ id, parentId, role, text }) => ({
  type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] },
}));
const header = (id: string, cwd: string) => ({ type: "session", version: 3, id, cwd, timestamp });

type Runtime = {
  cwd: string; path: string; nativeId: string; name: string; leafId: string | null;
  entries: WireObject[]; busy: boolean;
};

class BranchEngine extends Engine {
  readonly runtimes = new Map<string, Runtime>();
  failure: "cancel" | "missing" | "outside" | undefined;

  constructor(cwd: string) { super(["never-spawned"], cwd, () => {}, () => {}); }

  override async request(type: string, fields: WireObject): Promise<WireObject> {
    if (type !== "open_session" || typeof fields.sessionPath !== "string" || typeof fields.cwd !== "string") {
      throw new Error(`Unexpected fixture open ${type}`);
    }
    const path = fields.sessionPath;
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const [head, ...entries] = text.split("\n").filter(Boolean).map(line => record(JSON.parse(line)));
    const runtime = { path, cwd: fields.cwd, nativeId: String(head?.id ?? crypto.randomUUID()),
      name: "", leafId: typeof entries.at(-1)?.id === "string" ? String(entries.at(-1)?.id) : null,
      entries, busy: false };
    const route = crypto.randomUUID();
    this.runtimes.set(route, runtime);
    return { sessionId: route, state: this.#state(runtime), permissionPreset: "ask", permissionPresetStatus: "applied" };
  }

  override async requestExisting(type: string, fields: WireObject): Promise<WireObject> {
    const route = String(fields.sessionId);
    const runtime = this.runtimes.get(route);
    if (!runtime) throw new Error("Unknown runtime");
    switch (type) {
      case "get_state": return this.#state(runtime);
      case "get_tree": return { leafId: runtime.leafId, tree: [] };
      case "get_messages": return { messages: this.#path(runtime, runtime.leafId).map(entry => entry.message) };
      case "get_fork_messages": return { messages: runtime.entries.flatMap(entry => {
        const user = messages.find(row => row.id === entry.id && row.role === "user");
        return user ? [{ entryId: user.id, text: user.text, path: runtime.path }] : [];
      }) };
      case "navigate_tree": {
        const target = runtime.entries.find(entry => entry.id === fields.targetId);
        if (!target || fields.expectedLeafId !== runtime.leafId) throw new Error("Stale navigation");
        runtime.leafId = fields.intent === "resume" ? String(target.id) : (typeof target.parentId === "string" ? target.parentId : null);
        return { leafId: runtime.leafId, cancelled: false };
      }
      case "fork":
      case "clone": {
        if (this.failure === "cancel") return { cancelled: true };
        const target = runtime.entries.find(entry => entry.id === fields.entryId);
        const leaf = type === "clone" ? runtime.leafId : (typeof target?.parentId === "string" ? target.parentId : null);
        const text = messages.find(row => row.id === target?.id)?.text;
        runtime.entries = this.#path(runtime, leaf);
        runtime.leafId = leaf;
        runtime.nativeId = crypto.randomUUID();
        const parent = dirname(runtime.path);
        runtime.path = join(this.failure === "outside" ? dirname(parent) : parent,
          `${timestamp.replace(/[:.]/g, "-")}_${runtime.nativeId}.jsonl`);
        if (runtime.entries.length && !this.failure) await this.#export(runtime, runtime.path);
        return { cancelled: false, ...(type === "fork" ? { text } : {}) };
      }
      case "export_jsonl": {
        if (typeof fields.outputPath !== "string") throw new Error("Missing export path");
        await this.#export(runtime, fields.outputPath);
        return { path: fields.outputPath };
      }
      case "close_session": this.runtimes.delete(route); return {};
      case "set_session_name": runtime.name = String(fields.name); return {};
      default: throw new Error(`Unexpected fixture request ${type}`);
    }
  }

  #state(runtime: Runtime) {
    return { cwd: runtime.cwd, sessionFile: runtime.path, sessionId: runtime.nativeId,
      sessionName: runtime.name, isStreaming: runtime.busy };
  }

  #path(runtime: Runtime, leaf: string | null) {
    const entries: WireObject[] = [];
    for (let current = runtime.entries.find(entry => entry.id === leaf); current;
      current = runtime.entries.find(entry => entry.id === current?.parentId)) entries.unshift(current);
    return entries;
  }

  #export(runtime: Runtime, path: string) {
    return writeFile(path, line(header(runtime.nativeId, runtime.cwd)) + runtime.entries.map(line).join(""), { flag: "wx" });
  }
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "omo-web-branch-test-")));
  cleanup.push(home);
  const cwd = join(home, "workspace");
  const profile = join(home, "agent");
  const dir = join(profile, "sessions", `--${cwd.slice(1).replace(/[/\\:]/g, "-")}--`);
  const web = join(home, "web", "sessions");
  await mkdir(cwd);
  await mkdir(dir, { recursive: true });
  const engine = new BranchEngine(cwd);
  const sessions = new Sessions(dirname(web), [cwd], engine, () => {});
  await sessions.load();
  const cli = new CliHistory(profile, [cwd]);
  const id = crypto.randomUUID();
  const path = join(dir, "owned-cli.jsonl");
  const bytes = line(header(id, cwd)) + entries.map(line).join("");
  await writeFile(path, bytes);
  return { cwd, cli, dir, home, id, path, bytes, engine, sessions, web };
}

test("active Web clones use the live leaf rather than the last appended entry", async () => {
  const { cwd, engine, sessions } = await fixture();
  const source = await sessions.create(cwd);
  const [live] = [...engine.runtimes.values()];
  live.entries = entries;
  // The third entry is a user message: select intent would leave its parent instead.
  live.leafId = "u2";
  const previousPath = live.path;
  const previousId = live.nativeId;
  const bytes = line(header(previousId, cwd)) + entries.map(line).join("");
  await writeFile(previousPath, bytes);

  const options = await sessions.webBranchOptions(source.id);
  expect(options).toEqual({ canClone: true, forkMessages: [
    { entryId: "u1", text: "root input" }, { entryId: "u2", text: "second input" }, { entryId: "alt", text: "last saved on disk" },
  ] });
  const result = await sessions.branchWeb(source.id, { kind: "clone" });
  if (result.cancelled) throw new Error("Expected clone");
  expect((await sessions.snapshot(result.session.id)).messages).toHaveLength(3);
  expect(engine.runtimes.size).toBe(2);
  expect(await sessions.nativeSessionId(source.id)).toBe(previousId);
  expect(live.leafId).toBe("u2");
  expect(live.path).toBe(previousPath);
  expect(await readFile(previousPath, "utf8")).toBe(bytes);
});

test("CLI history forks privately before the selected message and returns its unsent draft", async () => {
  const { cli, cwd, id, path, bytes, sessions } = await fixture();
  const source = await cli.branchSource(id, cwd);
  const result = await sessions.branchFrom(source, { kind: "fork", entryId: "u2" });
  if (result.cancelled) throw new Error("Expected fork");
  expect(result.editorText).toBe("second input");
  expect((await sessions.snapshot(result.session.id)).messages).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain(".jsonl");
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("CLI branch options are available while the native engine is offline", async () => {
  const { cli, cwd, id, web } = await fixture();
  const engine = new Engine([join(cwd, "unavailable-omo")], cwd, () => {}, () => {});
  const sessions = new Sessions(dirname(web), [cwd], engine, () => {});
  try {
    await sessions.load();
    const options = await sessions.branchOptionsFor(await cli.branchSource(id, cwd));
    expect(options).toEqual({ canClone: true, forkMessages: [
      { entryId: "u1", text: "root input" }, { entryId: "u2", text: "second input" }, { entryId: "alt", text: "last saved on disk" },
    ] });
    expect(await readdir(web)).toEqual([]);
  } finally { await engine.stop(); }
});

test("attached CLI selection uses its authoritative leaf and never falls back to disk", async () => {
  const { cli, cwd, id, sessions } = await fixture();
  const source = await cli.branchSource(id, cwd);
  await expect(sessions.branchFrom({ ...source, leafId: "not-flushed" }, { kind: "clone" }))
    .rejects.toMatchObject({ status: 409, code: "branch_stale" });
  expect(await sessions.branchOptionsFor({ ...source, leafId: null })).toEqual({ canClone: false, forkMessages: [] });
  await expect(sessions.branchFrom({ ...source, leafId: null }, { kind: "clone" }))
    .rejects.toMatchObject({ status: 409, code: "branch_stale" });
  await expect(sessions.branchFrom({ ...source, leafId: null }, { kind: "fork", entryId: "u1" }))
    .rejects.toMatchObject({ status: 409, code: "branch_stale" });
  const result = await sessions.branchFrom({ ...source, leafId: "u1" }, { kind: "clone" });
  if (result.cancelled) throw new Error("Expected attached CLI clone");
  expect((await sessions.snapshot(result.session.id)).messages).toHaveLength(1);
});

test("a saved inactive Web source can fork without reopening its original runtime", async () => {
  const { cwd, engine, sessions } = await fixture();
  const source = await sessions.create(cwd);
  const [live] = [...engine.runtimes.values()];
  const bytes = line(header(live.nativeId, cwd)) + entries.map(line).join("");
  await writeFile(live.path, bytes);
  engine.runtimes.clear();
  sessions.disconnected();

  const result = await sessions.branchWeb(source.id, { kind: "fork", entryId: "u2" });
  if (result.cancelled) throw new Error("Expected inactive Web fork");
  expect(sessions.list().find(row => row.id === source.id)?.active).toBe(false);
  expect((await sessions.snapshot(result.session.id)).messages).toHaveLength(2);
  expect(await readFile(live.path, "utf8")).toBe(bytes);
});

test("the native root fork opens an empty durable branch and returns the original input", async () => {
  const { cli, cwd, id, sessions, web } = await fixture();
  const result = await sessions.branchFrom(await cli.branchSource(id, cwd), { kind: "fork", entryId: "u1" });
  if (result.cancelled) throw new Error("Expected root fork");
  expect(result.editorText).toBe("root input");
  expect((await sessions.snapshot(result.session.id)).messages).toEqual([]);
  expect(await readdir(web)).toEqual(expect.arrayContaining([`${result.session.id}.json`, `${result.session.id}.jsonl`]));
});

test("cancellation or unverified native output never publishes a Web session", async () => {
  const { cli, cwd, id, engine, sessions, web } = await fixture();
  const source = await cli.branchSource(id, cwd);
  engine.failure = "cancel";
  expect(await sessions.branchFrom(source, { kind: "clone" })).toEqual({ cancelled: true });
  for (const failure of ["missing", "outside"] as const) {
    engine.failure = failure;
    await expect(sessions.branchFrom(source, { kind: "clone" })).rejects.toMatchObject({ status: 502, code: "branch_output_invalid" });
  }
  expect(sessions.list()).toEqual([]);
  expect(engine.runtimes.size).toBe(0);
  expect(await readdir(web)).toEqual([]);
});

test("stale choices, malformed transcripts and unauthorized directory aliases fail closed", async () => {
  const { cli, cwd, id, path, bytes, dir, home, sessions } = await fixture();
  const source = await cli.branchSource(id, cwd);
  await expect(sessions.branchFrom(source, { kind: "fork", entryId: "absent" })).rejects.toMatchObject({ status: 409, code: "branch_stale" });
  await writeFile(path, bytes + '{"truncated":');
  await expect(sessions.branchOptionsFor(source)).rejects.toMatchObject({ code: "branch_source_invalid" });
  const alias = join(home, "alias");
  await symlink(dir, alias);
  await expect(sessions.branchOptionsFor({ ...source, sourcePath: join(alias, "owned-cli.jsonl") }))
    .rejects.toMatchObject({ code: "branch_source_invalid" });
  expect(sessions.list()).toEqual([]);
});

test("running or unflushed active sources do not branch from stale disk contents", async () => {
  const { cwd, engine, sessions } = await fixture();
  const source = await sessions.create(cwd);
  const [runtime] = [...engine.runtimes.values()];
  runtime.busy = true;
  await expect(sessions.branchWeb(source.id, { kind: "clone" })).rejects.toMatchObject({ status: 409, code: "session_busy" });
  runtime.busy = false;
  runtime.leafId = "unflushed";
  await expect(sessions.branchWeb(source.id, { kind: "clone" })).rejects.toMatchObject({ status: 409, code: "branch_stale" });
  expect(sessions.list().map(row => row.id)).toEqual([source.id]);
});
