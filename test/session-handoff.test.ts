import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDirName } from "../src/cli-history.ts";
import { Engine } from "../src/engine.ts";
import type { EngineStatus } from "../src/engine.ts";
import { WebError } from "../src/protocol.ts";
import type { SessionKey, WireObject } from "../src/protocol.ts";
import { Sessions } from "../src/sessions.ts";
import { startApp } from "../src/server.ts";

const httpFixture = fileURLToPath(new URL("./session-handoff-engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.SESSION_HANDOFF_HELD;
  delete process.env.SESSION_HANDOFF_PROFILE;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const iso = "2026-11-25T00:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const headerOf = (id: string, cwd: string) => ({ type: "session", version: 3, id, timestamp: iso, cwd });
const userEntry = (id: string, parentId: string | null, text: string) =>
  ({ type: "message", id, parentId, timestamp: iso, message: { role: "user", content: text, timestamp: 1 } });
const assistantEntry = (id: string, parentId: string, text: string) =>
  ({ type: "message", id, parentId, timestamp: iso,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } });
const nameEntry = (parentId: string | null, name: string) =>
  ({ type: "session_info", id: crypto.randomUUID(), parentId, timestamp: iso, name });

async function journal(agent: string, cwd: string, id: string, title: string, seed: string): Promise<string> {
  const dir = join(agent, "sessions", sessionDirName(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `history-${id.slice(0, 8)}.jsonl`);
  await writeFile(path, line(headerOf(id, cwd)) + line(userEntry("u1", null, seed)) +
    line(assistantEntry("a1", "u1", `Reply ${seed}`)) + line(nameEntry("a1", title)));
  return path;
}

async function bigJournal(agent: string, cwd: string, id: string, title: string): Promise<string> {
  const dir = join(agent, "sessions", sessionDirName(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `history-${id.slice(0, 8)}.jsonl`);
  await writeFile(path, line(headerOf(id, cwd)) + line(nameEntry(null, title)) +
    line(userEntry("u-big", null, "x".repeat(9 * 1024 * 1024))));
  return path;
}

async function prepareDirs() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-handoff-http-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  return { root, agent, cwd };
}

async function launchHttp(held: readonly string[] = [], { profile = true, prime }: {
  readonly profile?: boolean;
  readonly prime?: (dirs: { readonly root: string; readonly agent: string; readonly cwd: string }) =>
    Promise<readonly string[]>;
} = {}) {
  const { root, agent, cwd } = await prepareDirs();
  const primed = prime ? await prime({ root, agent, cwd }) : [];
  if (held.length || primed.length) process.env.SESSION_HANDOFF_HELD = [...held, ...primed].join(",");
  if (profile) process.env.SESSION_HANDOFF_PROFILE = agent;
  const dataDir = join(root, "web");
  const app = await startApp({
    dataDir,
    workspaces: [cwd],
    engineCommand: [process.execPath, httpFixture],
    port: 0,
    ...(profile ? { cliAgentDir: agent } : {}),
  });
  cleanups.push(() => app.stop());
  const origin = app.url.origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token };
  const get = (path: string) => fetch(`${origin}${path}`);
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const sessionsDir = join(dataDir, "sessions");
  return { app, agent, cwd, dataDir: sessionsDir, bootstrap, get, post };
}

describe("sequential handoff HTTP routes", () => {
  test("without a profile, history is unavailable and handoff stays closed", async () => {
    const client = await launchHttp([], { profile: false });
    const nativeId = crypto.randomUUID();
    await journal(client.agent, client.cwd, nativeId, "CLI seed", "http-seed");
    const history = await (await client.get("/api/cli-history")).json();
    expect(history).toEqual({ available: false, sessions: [] });
    expect(client.bootstrap.handoff).toEqual({ supported: false, reason: "shared_transport" });
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "private born" });
    expect(created.status).toBe(201);
    const webId = String((await created.json()).session.id);
    const handoff = await client.post(`/api/sessions/${webId}/handoff`, {});
    expect(handoff.status).toBe(409);
    expect((await handoff.json()).code).toBe("handoff_unsupported");
    expect((await (await client.get("/api/sessions")).json()).sessions).toHaveLength(1);
    const journals = (await readdir(client.dataDir)).filter(name => name.endsWith(".jsonl"));
    expect(journals).toEqual([`${webId}.jsonl`]);
  });

  test("private stdio shares one journal from Web create to CLI resume and back", async () => {
    const client = await launchHttp();
    expect(client.bootstrap.handoff).toEqual({ supported: true });
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "web born" });
    expect(created.status).toBe(201);
    const webId = String((await created.json()).session.id);
    // The runtime places the journal itself in the native bucket, not the Web store.
    const bucket = join(client.agent, "sessions", sessionDirName(client.cwd));
    const journals = (await readdir(bucket)).filter(name => name.endsWith(".jsonl"));
    expect(journals).toHaveLength(1);
    const prompt = await client.post(`/api/sessions/${webId}/actions`,
      { action: "prompt", message: "web turn", clientMessageId: crypto.randomUUID() });
    expect(prompt.status).toBe(200);
    expect(await (await client.get(`/api/sessions/${webId}/last-assistant`)).json())
      .toEqual({ text: "Echo: web turn" });
    const thinking = await client.post(`/api/sessions/${webId}/actions`, { action: "thinking", level: "low" });
    expect(thinking.status).toBe(200);
    // Plain release answers attached (the native miscount); the scoped force
    // retry releases quietly and returns a quoted local command.
    const handoff = await client.post(`/api/sessions/${webId}/handoff`, {});
    expect(handoff.status).toBe(200);
    const receipt = await handoff.json();
    expect(receipt.command).toContain(join(bucket, journals[0]));
    expect((await (await client.get("/api/sessions")).json()).sessions[0])
      .toMatchObject({ id: webId, active: false });
    // The CLI picker discovers the same journal; resume coalesces the alias.
    const history = await (await client.get("/api/cli-history")).json();
    expect(history.available).toBe(true);
    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]).toMatchObject({ adopted: true, cwd: client.cwd });
    const opaque = String(history.sessions[0].id);
    const resumed = await client.post(`/api/cli-history/${opaque}/resume`, {});
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).session.id).toBe(webId);
    expect((await (await client.get("/api/sessions")).json()).sessions[0])
      .toMatchObject({ id: webId, active: true });
  });

  test("oversized journals resume through the opaque key with capped preview", async () => {
    const nativeId = crypto.randomUUID();
    const client = await launchHttp([], { prime: async ({ agent, cwd }) => {
      await bigJournal(agent, cwd, nativeId, "Oversized HTTP history");
      return [];
    } });
    const history = await (await client.get("/api/cli-history")).json();
    expect(history.available).toBe(true);
    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]).toMatchObject({ name: "Oversized HTTP history", cwd: client.cwd, adopted: false });
    expect(JSON.stringify(history)).not.toContain(nativeId);
    const opaque = String(history.sessions[0].id);
    const preview = await client.get(`/api/cli-history/${opaque}`);
    expect(preview.status).toBe(400);
    expect(await preview.json()).toMatchObject({ code: "history_too_large" });
    const resumed = await client.post(`/api/cli-history/${opaque}/resume`, {});
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).session)
      .toMatchObject({ active: true, cwd: client.cwd, name: "Oversized HTTP history" });
    const again = await (await client.get("/api/cli-history")).json();
    expect(again.sessions).toMatchObject([{ id: opaque, adopted: true }]);
  });

  test("CLI history resumes its original journal despite a stale device number on the Web bookmark", async () => {
    const nativeId = crypto.randomUUID();
    const staleId = crypto.randomUUID();
    const client = await launchHttp([], { prime: async ({ root, agent, cwd }) => {
      await journal(agent, cwd, nativeId, "Still authorized", "original journal");
      const { dev, ino, birthtimeNs } = await lstat(cwd, { bigint: true });
      const sessions = join(root, "web", "sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(join(sessions, `${staleId}.json`), JSON.stringify({
        id: staleId, cwd, nativeId, name: "Previous bookmark", updatedAt: 1, archived: false,
        settled: false, cliBookmark: true, workspaceKey: `${dev + 1n}:${ino}:${birthtimeNs}`,
      }));
      return [];
    } });
    const stalePath = join(client.dataDir, `${staleId}.json`);
    const staleBefore = await readFile(stalePath, "utf8");
    const source = join(client.agent, "sessions", sessionDirName(client.cwd), `history-${nativeId.slice(0, 8)}.jsonl`);
    const journalBefore = await readFile(source, "utf8");
    expect((await client.post(`/api/sessions/${staleId}/actions`, { action: "resume" })).status).toBe(403);
    const { sessions: [history] } = await (await client.get("/api/cli-history")).json();
    expect(history).toMatchObject({ name: "Still authorized", cwd: client.cwd, adopted: false });
    const resume = () => client.post(`/api/cli-history/${history.id}/resume`, {});

    const replies = await Promise.all([resume(), resume()]);
    const opened = await Promise.all(replies.map(async response => ({ status: response.status, body: await response.json() })));

    expect(opened).toMatchObject([200, 200].map(status => ({ status, body: { session: { active: true, cwd: client.cwd } } })));
    const id = opened[0].body.session.id;
    expect(id).not.toBe(staleId);
    expect(opened[1].body.session.id).toBe(id);
    expect(await (await client.get("/api/sessions")).json()).toMatchObject({ sessions: [{ id, active: true }] });
    expect(await (await client.get("/api/cli-history")).json()).toMatchObject({ sessions: [{ id: history.id, adopted: true }] });
    expect((await (await resume()).json()).session.id).toBe(id);
    expect(await readFile(source, "utf8")).toBe(journalBefore);
    expect(await readFile(stalePath, "utf8")).toBe(staleBefore);
  });

  test("held oversized journals refuse resume without publishing a bookmark", async () => {
    const nativeId = crypto.randomUUID();
    const client = await launchHttp([], { prime: async ({ agent, cwd }) => {
      const source = await bigJournal(agent, cwd, nativeId, "Held oversized history");
      return [source];
    } });
    const history = await (await client.get("/api/cli-history")).json();
    expect(history.sessions).toMatchObject([{ name: "Held oversized history", cwd: client.cwd }]);
    const opaque = String(history.sessions[0].id);
    const refused = await client.post(`/api/cli-history/${opaque}/resume`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "session_held" });
    expect((await (await client.get("/api/sessions")).json()).sessions).toEqual([]);
  });

  test("resume rejects strict bodies and unknown keys before touching the engine", async () => {
    const client = await launchHttp();
    const nativeId = crypto.randomUUID();
    await journal(client.agent, client.cwd, nativeId, "CLI seed", "held-seed");
    const opaque = String((await (await client.get("/api/cli-history")).json()).sessions[0].id);
    expect((await client.post(`/api/cli-history/${opaque}/resume`, { unexpected: 1 })).status).toBe(400);
    expect((await client.post(`/api/cli-history/${"0".repeat(64)}/resume`, {})).status).toBe(404);
    expect((await client.post(`/api/sessions/${crypto.randomUUID()}/handoff`, { unexpected: 1 })).status).toBe(400);
  });

  test("private stdio supports last-assistant, thinking, and handoff", async () => {
    const client = await launchHttp();
    const created = await client.post("/api/sessions", { cwd: client.cwd, name: "web born" });
    expect(created.status).toBe(201);
    const webId = String((await created.json()).session.id);
    const prompt = await client.post(`/api/sessions/${webId}/actions`,
      { action: "prompt", message: "web turn", clientMessageId: crypto.randomUUID() });
    expect(prompt.status).toBe(200);
    expect(await (await client.get(`/api/sessions/${webId}/last-assistant`)).json())
      .toEqual({ text: "Echo: web turn" });
    const thinking = await client.post(`/api/sessions/${webId}/actions`, { action: "thinking", level: "low" });
    expect(thinking.status).toBe(200);
    expect((await (await client.get(`/api/sessions/${webId}/last-assistant`)).json()).text).toContain("web turn");
    const handoff = await client.post(`/api/sessions/${webId}/handoff`, {});
    expect(handoff.status).toBe(200);
  });

  test("restart resumes the same legacy Web session without a guard", async () => {
    const { root, agent, cwd } = await prepareDirs();
    process.env.SESSION_HANDOFF_PROFILE = agent;
    const settings = { dataDir: join(root, "web"), workspaces: [cwd],
      engineCommand: [process.execPath, httpFixture] as [string, ...string[]], port: 0, cliAgentDir: agent };
    const first = await startApp(settings);
    let id = "";
    try {
      const origin = first.url.origin;
      const boot = await (await fetch(`${origin}/api/bootstrap`)).json();
      const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": boot.token };
      const post = (path: string, body: unknown) =>
        fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      id = String((await (await post("/api/sessions", { cwd, name: "Keep this title" })).json()).session.id);
      const prompt = await post(`/api/sessions/${id}/actions`,
        { action: "prompt", message: "restart-seed", clientMessageId: crypto.randomUUID() });
      expect(prompt.status).toBe(200);
    } finally {
      await first.stop();
    }
    const second = await startApp(settings);
    cleanups.push(() => second.stop());
    try {
      const origin = second.url.origin;
      const boot = await (await fetch(`${origin}/api/bootstrap`)).json();
      expect(boot.handoff).toEqual({ supported: true });
      const [row] = (await (await fetch(`${origin}/api/sessions`,
        { headers: { Origin: origin } })).json()).sessions;
      expect(row).toMatchObject({ id, name: "Keep this title", active: false });
      const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": boot.token };
      const reopen = await fetch(`${origin}/api/sessions/${id}/actions`, {
        method: "POST", headers, body: JSON.stringify({ action: "resume" }),
      });
      expect(reopen.status).toBe(200);
      const snapshot = await (await fetch(`${origin}/api/sessions/${id}`)).json();
      expect(snapshot.session).toMatchObject({ name: "Keep this title", active: true });
      expect(snapshot.messages.map((message: { content: string }) => message.content)).toContain("restart-seed");
    } finally {
      await second.stop();
    }
  });
});

type FakeRuntime = {
  path: string;
  nativeId: string;
  cwd: string;
  archived: boolean;
  settled: boolean;
  leaf: string | null;
};

const entryText = (entry: Record<string, unknown>): string => {
  const message = entry.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter(part => (part as Record<string, unknown>)?.type === "text")
      .map(part => String((part as Record<string, unknown>).text ?? "")).join("");
  }
  return "";
};

class HandoffEngine extends Engine {
  readonly routes = new Map<string, FakeRuntime>();
  readonly byPath = new Map<string, string>();
  readonly held = new Set<string>();
  readonly busyIds = new Set<string>();
  readonly dialogIds = new Set<string>();
  readonly attachedElsewhere = new Set<string>();
  readonly thinkingScopes: unknown[] = [];
  readonly setNames: { route: string; name: unknown }[] = [];
  readonly opened: { path: string; durable: unknown; sentPath: string | undefined }[] = [];
  readonly releases: { route: string; reason: unknown; force?: true }[] = [];
  /** Native ids whose plain takeover release answers `attached` although the
   * caller is the only attachment: the version-native miscount case. */
  readonly miscounted = new Set<string>();
  /** Per-native-id attachment counts reported by list_sessions (default 1). */
  readonly attachCounts = new Map<string, number>();
  listFails = false;
  deferHeader = false;
  readonly buffered = new Map<string, { header: Record<string, unknown>; name?: unknown }>();
  forceBusy = false;
  omitDropped = false;
  /** Native-placed opens land outside the profile bucket (unsupported layout). */
  misplace = false;
  timeoutReleaseAfterWrite = false;
  dropRouteOnTimeout = true;
  private sequence = 0;
  override readonly capabilities = new Set<unknown>(["multi_session", "session_model_scope",
    "session_held", "release_caller_aware", "durable_session_id"]);
  override status: EngineStatus = { online: true };
  constructor(cwd: string, private readonly privateTransport = true, caps?: readonly string[],
    private readonly profileDir?: string) {
    super(["never-spawned"], cwd, () => undefined, () => undefined);
    if (caps !== undefined) this.capabilities = new Set<unknown>(caps);
  }
  override get isPrivateHost(): boolean {
    return this.privateTransport;
  }
  override get usesPrivateSocketTransport(): boolean {
    return this.privateTransport;
  }
  override async probe(): Promise<void> {
    this.status = { online: true };
  }
  private async readJournal(path: string) {
    const rows = (await readFile(path, "utf8")).split("\n").filter(entry => entry.trim()).map(entry => JSON.parse(entry));
    const [header, ...entries] = rows;
    return { header: header as Record<string, unknown>, entries: entries as Record<string, unknown>[] };
  }
  private nameOf(entries: Record<string, unknown>[]): string {
    let name = "";
    for (const entry of entries) {
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name;
    }
    return name;
  }
  private leafOf(entries: Record<string, unknown>[]): string | null {
    const last = entries.at(-1);
    return last && typeof last.id === "string" ? String(last.id) : null;
  }
  private async stateOf(runtime: FakeRuntime): Promise<WireObject> {
    const pending = this.buffered.get(runtime.path);
    const { header, entries } = pending
      ? { header: pending.header, entries: [{ type: "session_info", name: pending.name }] }
      : await this.readJournal(runtime.path);
    return {
      sessionId: header.id,
      sessionFile: runtime.path,
      cwd: header.cwd,
      sessionName: this.nameOf(entries),
      isStreaming: runtime.nativeId !== undefined && this.busyIds.has(String(header.id)),
      isCompacting: false,
      isBashRunning: false,
      runPaused: false,
      archived: runtime.archived,
      settled: runtime.settled,
      pendingDialogs: this.dialogIds.has(String(header.id)) ? [{ id: "dlg-1", method: "confirm" }] : [],
      pendingQuestions: [],
      permissionPreset: "ask",
    };
  }
  private assistantText(entries: Record<string, unknown>[]): string | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const message = entries[index].message as Record<string, unknown> | undefined;
      if (entries[index].type !== "message" || message?.role !== "assistant") continue;
      const text = Array.isArray(message.content)
        ? message.content.filter(part => part?.type === "text").map(part => String(part.text)).join("")
        : typeof message.content === "string" ? message.content : "";
      if (text.trim()) return text;
    }
    return null;
  }
  override async request(type: string, fields: WireObject = {}): Promise<WireObject> {
    if (type !== "open_session") throw new WebError(409, "engine_refused", "Unexpected fixture request.");
    const folder = String(fields.cwd);
    const durable = typeof fields.durableSessionId === "string" && fields.durableSessionId
      ? String(fields.durableSessionId) : undefined;
    const sentPath = typeof fields.sessionPath === "string" ? fields.sessionPath : undefined;
    // A native-placed (shared) open omits sessionPath: the runtime generates the
    // journal under the shared profile bucket and binds the durable id.
    let path = sentPath;
    if (path === undefined) {
      if (!this.profileDir) throw new WebError(409, "engine_refused", "Unexpected fixture request.");
      const bucket = join(this.profileDir, "sessions", sessionDirName(folder));
      path = this.misplace ? join(this.profileDir, "stray.jsonl")
        : join(bucket, `${Date.now()}_${durable ?? crypto.randomUUID()}.jsonl`);
      await mkdir(this.misplace ? this.profileDir : bucket, { recursive: true });
    }
    if (this.held.has(path)) throw new WebError(409, "session_held", "会话正被另一进程持有。");
    const attached = this.byPath.get(path);
    if (attached && this.routes.has(attached)) {
      const runtime = this.routes.get(attached)!;
      return { sessionId: attached, attached: true, state: await this.stateOf(runtime),
        permissionPreset: "ask", permissionPresetStatus: "applied" };
    }
    let header: Record<string, unknown>;
    try {
      header = (await this.readJournal(path)).header;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new WebError(400, "history_invalid", `无法读取来源日志：${(error as Error).message}`);
      }
      header = { type: "session", version: 3, id: durable ?? crypto.randomUUID(),
        timestamp: new Date().toISOString(), cwd: folder };
      if (this.deferHeader && sentPath === undefined) this.buffered.set(path, { header });
      else await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    }
    const runtime: FakeRuntime = { path, nativeId: String(header.id), cwd: String(header.cwd),
      archived: false, settled: false, leaf: null };
    const route = `rpc-${++this.sequence}`;
    this.routes.set(route, runtime);
    this.byPath.set(path, route);
    this.opened.push({ path, durable: fields.durableSessionId, sentPath });
    return { sessionId: route, attached: false, state: await this.stateOf(runtime),
      permissionPreset: "ask", permissionPresetStatus: "applied" };
  }
  override async requestExisting(type: string, fields: WireObject = {}): Promise<WireObject> {
    // list_sessions is connection-level: it carries no session route.
    if (type === "list_sessions") {
      if (this.listFails) throw new WebError(409, "engine_refused", "No session list.");
      return { sessions: [...this.routes].map(([sessionId, item]) => ({
        sessionId, durableSessionId: item.nativeId, sessionPath: item.path, cwd: item.cwd,
        kind: "interactive", attachments: this.attachCounts.get(item.nativeId) ?? 1,
      })) };
    }
    const route = String(fields.sessionId);
    const runtime = this.routes.get(route);
    if (!runtime) throw new WebError(409, "unknown_session", "Unknown test session.");
    switch (type) {
      case "get_state": return this.stateOf(runtime);
      case "get_messages": {
        const { entries } = await this.readJournal(runtime.path);
        return { messages: entries.filter(entry => entry.type === "message").map(entry => entry.message) };
      }
      case "get_tree": {
        const { entries } = await this.readJournal(runtime.path);
        return { tree: [], leafId: runtime.leaf ?? this.leafOf(entries) };
      }
      case "get_entries": {
        if (fields.tail !== 1 || fields.maxBytes !== 262_144 || Object.keys(fields).length !== 3) {
          throw new WebError(409, "invalid_argument", "Expected a bounded leaf read.");
        }
        const { entries } = await this.readJournal(runtime.path);
        const tail = entries.slice(-1);
        const hasMore = entries.length > 1;
        return { entries: tail, leafId: runtime.leaf ?? this.leafOf(entries), hasMore,
          ...(hasMore ? { next_before: tail[0].id } : {}) };
      }
      case "get_fork_messages": {
        const { entries } = await this.readJournal(runtime.path);
        return { messages: entries
          .filter(entry => entry.type === "message" &&
            (entry.message as Record<string, unknown> | undefined)?.role === "user")
          .map(entry => ({ entryId: entry.id, text: entryText(entry) }))
          .filter(row => row.text.trim()) };
      }
      case "fork": {
        const { entries } = await this.readJournal(runtime.path);
        const target = entries.find(entry => entry.id === fields.entryId);
        if (!target) throw new WebError(409, "stale_branch", "Stale.");
        const forkLeaf = (target.parentId as string | null) ?? null;
        const prefix: Record<string, unknown>[] = [];
        for (const entry of entries) {
          prefix.push(entry);
          if (entry.id === forkLeaf) break;
        }
        if (forkLeaf !== null && prefix.at(-1)?.id !== forkLeaf) throw new WebError(409, "stale_branch", "Stale.");
        const kept = forkLeaf === null ? [] : prefix;
        const newId = crypto.randomUUID();
        const file = join(dirname(runtime.path), `${Date.now()}_${newId}.jsonl`);
        await writeFile(file, line({ type: "session", version: 3, id: newId,
          timestamp: iso, cwd: runtime.cwd }) + kept.map(keptLine => line(keptLine)).join(""),
        { flag: "wx", mode: 0o600 });
        this.byPath.delete(runtime.path);
        runtime.path = file;
        runtime.nativeId = newId;
        runtime.leaf = null;
        this.byPath.set(file, route);
        return { cancelled: false, text: `Forked from ${String(fields.entryId)}` };
      }
      case "clone": {
        const { entries } = await this.readJournal(runtime.path);
        const newId = crypto.randomUUID();
        const file = join(dirname(runtime.path), `${Date.now()}_${newId}.jsonl`);
        await writeFile(file, line({ type: "session", version: 3, id: newId,
          timestamp: iso, cwd: runtime.cwd }) + entries.map(keptLine => line(keptLine)).join(""),
        { flag: "wx", mode: 0o600 });
        this.byPath.delete(runtime.path);
        runtime.path = file;
        runtime.nativeId = newId;
        runtime.leaf = null;
        this.byPath.set(file, route);
        return { cancelled: false };
      }
      case "navigate_tree": {
        const { entries } = await this.readJournal(runtime.path);
        if (fields.expectedLeafId !== (runtime.leaf ?? this.leafOf(entries))) {
          throw new WebError(409, "stale_leaf", "Stale.");
        }
        if (!entries.some(entry => entry.id === fields.targetId)) throw new WebError(409, "stale_branch", "Stale.");
        runtime.leaf = typeof fields.targetId === "string" ? fields.targetId : null;
        return { leafId: runtime.leaf, cancelled: false };
      }
      case "set_session_name": {
        this.setNames.push({ route, name: fields.name });
        const pending = this.buffered.get(runtime.path);
        if (pending) {
          pending.name = fields.name;
          return {};
        }
        const { entries } = await this.readJournal(runtime.path);
        await appendFile(runtime.path, line({ type: "session_info", id: crypto.randomUUID(),
          parentId: runtime.leaf ?? this.leafOf(entries), timestamp: iso, name: fields.name }));
        return {};
      }
      case "set_session_archived": runtime.archived = fields.archived === true; return {};
      case "set_session_settled": runtime.settled = fields.settled === true; return {};
      case "set_thinking_level":
        this.thinkingScopes.push(fields.scope);
        if (fields.scope !== "turn") throw new WebError(409, "scope_required", "Web 只使用 turn 作用域。");
        return {};
      case "get_last_assistant_text": {
        const { entries } = await this.readJournal(runtime.path);
        return { text: this.assistantText(entries) };
      }
      case "release_session": {
        this.releases.push({ route, reason: fields.reason,
          ...(fields.force === true ? { force: true as const } : {}) });
        if (fields.reason !== "takeover") throw new WebError(409, "invalid_release_reason", "Bad reason.");
        if (fields.force === true && fields.interrupt !== undefined) {
          throw new WebError(409, "invalid_release_reason", "Force must never interrupt.");
        }
        if (this.busyIds.has(runtime.nativeId)) throw new WebError(409, "turn_active", "Busy turn.");
        // The version-native miscount answers plain takeover release with
        // `attached` although the caller is the only attachment; the scoped
        // force retry is the only path that may still release this holder.
        const claimed = this.attachedElsewhere.has(runtime.nativeId) || this.miscounted.has(runtime.nativeId);
        if (claimed && !(fields.force === true && this.miscounted.has(runtime.nativeId))) {
          throw new WebError(409, "attached", "Another client is attached.");
        }
        if (fields.force === true && this.forceBusy) {
          throw new WebError(409, "turn_active", "Native work started before release.");
        }
        const pending = this.buffered.get(runtime.path);
        if (pending) {
          await writeFile(runtime.path, line(pending.header) + line({
            type: "session_info", id: crypto.randomUUID(), parentId: null, timestamp: iso, name: pending.name,
          }), { flag: "wx", mode: 0o600 });
          this.buffered.delete(runtime.path);
        }
        if (this.timeoutReleaseAfterWrite && this.dropRouteOnTimeout) {
          const { entries } = await this.readJournal(runtime.path);
          await appendFile(runtime.path, line({ type: "custom", id: crypto.randomUUID(),
            parentId: runtime.leaf ?? this.leafOf(entries), timestamp: iso, customType: "session_released",
            details: { reason: "takeover", interrupted: false, attachments: [], released_at: iso } }));
          this.routes.delete(route);
          if (this.byPath.get(runtime.path) === route) this.byPath.delete(runtime.path);
          throw new WebError(504, "engine_timeout", "Release timed out.");
        }
        if (this.timeoutReleaseAfterWrite) throw new WebError(504, "engine_timeout", "Release timed out.");
        const { entries } = await this.readJournal(runtime.path);
        await appendFile(runtime.path, line({ type: "custom", id: crypto.randomUUID(),
          parentId: runtime.leaf ?? this.leafOf(entries), timestamp: iso, customType: "session_released",
          details: { reason: "takeover", interrupted: false, attachments: [], released_at: iso } }));
        this.routes.delete(route);
        if (this.byPath.get(runtime.path) === route) this.byPath.delete(runtime.path);
        return { released: true, session_path: runtime.path, attachments: [],
          ...(this.omitDropped ? {} : { dropped: { deliveries: [], user_messages: [] } }) };
      }
      case "close_session":
        this.routes.delete(route);
        if (this.byPath.get(runtime.path) === route) this.byPath.delete(runtime.path);
        return {};
      case "prompt": {
        const { entries } = await this.readJournal(runtime.path);
        const leaf = runtime.leaf ?? this.leafOf(entries);
        const userId = crypto.randomUUID();
        const assistantId = crypto.randomUUID();
        await appendFile(runtime.path, [
          { type: "message", id: userId, parentId: leaf, timestamp: iso,
            message: { role: "user", content: String(fields.message), timestamp: 3 } },
          { type: "message", id: assistantId, parentId: userId, timestamp: iso,
            message: { role: "assistant", content: [{ type: "text", text: `Echo: ${fields.message}` }], timestamp: 4 } },
        ].map(line).join(""));
        runtime.leaf = assistantId;
        return { disposition: "started", turnId: "turn-1", clientMessageId: fields.clientMessageId };
      }
      case "get_session_stats": return { totalMessages: 0, cost: 0 };
      case "get_pending_inputs": return { inputs: [], outcomes: [] };
      case "get_available_models": return { models: [] };
      case "get_available_thinking_levels": return { levels: ["off", "low", "high"] };
      case "get_commands": return { commands: [] };
      default: throw new WebError(409, "engine_refused", "Unexpected fixture request.");
    }
  }
}

async function setupSessions(privateTransport = true, caps?: readonly string[],
  guard?: { sameProfile: boolean; profileDir?: string }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omo-handoff-unit-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "work space");
  await mkdir(cwd, { recursive: true });
  const dataDir = join(root, "web");
  const engine = new HandoffEngine(cwd, privateTransport, caps, agent);
  const paths = new Map<string, string>();
  const sessions = new Sessions(dataDir, [cwd], engine, () => undefined,
    async nativeId => {
      const direct = paths.get(nativeId);
      if (direct) return { sourcePath: direct };
      // Shared rows are resolved by durable id through the profile bucket,
      // mirroring CliHistory.branchSource without trusting a stored path.
      const bucket = join(agent, "sessions", sessionDirName(cwd));
      for (const name of await readdir(bucket).catch((): string[] => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const candidate = join(bucket, name);
        try {
          const header = JSON.parse((await readFile(candidate, "utf8")).split("\n", 1)[0]);
          if (header?.type === "session" && header?.id === nativeId && header?.cwd === cwd) {
            return { sourcePath: candidate };
          }
        } catch {
          continue;
        }
      }
      throw new WebError(404, "history_not_found", "找不到这条 CLI 历史。");
    },
    guard ?? { sameProfile: true, profileDir: agent });
  await sessions.load();
  return { root, agent, cwd, dataDir, engine, sessions, paths };
}

async function seedCli(sessions: Awaited<ReturnType<typeof setupSessions>>, nativeId: string, title: string, seed: string) {
  const source = await journal(sessions.agent, sessions.cwd, nativeId, title, seed);
  sessions.paths.set(nativeId, source);
  return source;
}

type SetupContext = Awaited<ReturnType<typeof setupSessions>>;

async function storedRow(context: SetupContext, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(context.dataDir, "sessions", `${id}.json`), "utf8"));
}

/** Locate the shared-bucket journal bound to a durable id (mirrors discovery). */
async function sharedJournal(context: SetupContext, nativeId: string): Promise<string> {
  const bucket = join(context.agent, "sessions", sessionDirName(context.cwd));
  for (const name of await readdir(bucket)) {
    if (!name.endsWith(".jsonl")) continue;
    const candidate = join(bucket, name);
    try {
      const header = JSON.parse((await readFile(candidate, "utf8")).split("\n", 1)[0]);
      if (header?.type === "session" && header?.id === nativeId && header?.cwd === context.cwd) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`shared journal missing for ${nativeId}`);
}

async function seedCliThread(agent: string, cwd: string, id: string, title: string,
  turns: readonly (readonly [string, string])[]): Promise<string> {
  const dir = join(agent, "sessions", `--${cwd.slice(1).replace(/[/\\:]/g, "-")}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `thread-${id.slice(0, 8)}.jsonl`);
  let parent: string | null = null;
  const rows = [line(headerOf(id, cwd))];
  turns.forEach(([user, assistant], index) => {
    const u = `u${index + 1}`;
    const a = `a${index + 1}`;
    rows.push(line(userEntry(u, parent, user)), line(assistantEntry(a, u, assistant)));
    parent = a;
  });
  rows.push(line(nameEntry(parent, title)));
  await writeFile(path, rows.join(""));
  return path;
}

describe("sequential handoff engine wiring", () => {
  test("resume binds the same journal without copying it", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "unit-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }, "CLI title");
    expect(created).toMatchObject({ cwd: context.cwd, name: "CLI title", active: true });
    expect(Object.keys(created).sort()).toEqual(
      ["active", "archived", "cwd", "id", "name", "running", "settled", "updatedAt"]);
    const stored = JSON.parse(await readFile(join(context.dataDir, "sessions", `${created.id}.json`), "utf8"));
    expect(stored).toMatchObject({ nativeId, cliBookmark: true });
    const files = await readdir(join(context.dataDir, "sessions"));
    expect(files.filter(name => name.endsWith(".jsonl"))).toEqual([]);
    const snapshot = await context.sessions.snapshot(created.id as SessionKey);
    expect(snapshot.messages.map(message => (message as { content: string }).content)).toContain("unit-seed");
    expect(snapshot.handoff).toEqual({ eligible: true });
    expect(context.engine.opened).toHaveLength(1);
    expect(context.engine.opened[0]).toMatchObject({ path: source, durable: nativeId });
    const again = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(again.id).toBe(created.id);
    expect(context.engine.opened).toHaveLength(1);
  });

  test("concurrent resume calls settle on one bookmark", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "race-seed");
    const [first, second] = await Promise.all([
      context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }),
      context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }),
    ]);
    expect(first.id).toBe(second.id);
    expect(context.engine.opened).toHaveLength(1);
  });

  test("a foreign holder refuses without publishing a bookmark", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "held-seed");
    context.engine.held.add(source);
    await expect(context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }))
      .rejects.toMatchObject({ code: "session_held" });
    expect(context.sessions.list()).toHaveLength(0);
  });

  test("busy, dialog, and attached sessions refuse handoff and stay active", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "busy-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    context.engine.busyIds.add(nativeId);
    await expect(context.sessions.handoff(created.id as SessionKey)).rejects.toMatchObject({ code: "session_busy" });
    context.engine.busyIds.delete(nativeId);
    context.engine.dialogIds.add(nativeId);
    await expect(context.sessions.handoff(created.id as SessionKey)).rejects.toMatchObject({ code: "dialog_pending" });
    context.engine.dialogIds.delete(nativeId);
    context.engine.attachedElsewhere.add(nativeId);
    context.engine.attachCounts.set(nativeId, 2);
    await expect(context.sessions.handoff(created.id as SessionKey)).rejects.toMatchObject({ code: "attached" });
    context.engine.attachedElsewhere.delete(nativeId);
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: true });
    expect(context.engine.releases).toHaveLength(1);
  });

  test("idle handoff releases quietly and returns a quoted local command", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "handoff-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    const { session, command } = await context.sessions.handoff(id);
    expect(session).toMatchObject({ id: created.id, active: false });
    const profile = `'${context.agent}'`;
    expect(command).toBe(`cd '${context.cwd}' && OMO_CODING_AGENT_DIR=${profile} ` +
      `SENPI_CODING_AGENT_DIR=${profile} PI_CODING_AGENT_DIR=${profile} omo --session '${source}'`);
    expect(command).not.toContain("token");
    expect(command).not.toContain("sock");
    const text = await readFile(source, "utf8");
    expect(text).toContain("session_released");
    const header = JSON.parse(text.split("\n", 1)[0]);
    expect(header.id).toBe(nativeId);
    expect(context.engine.releases).toEqual([{ route: expect.any(String), reason: "takeover" }]);
    const stored = JSON.parse(await readFile(join(context.dataDir, "sessions", `${created.id}.json`), "utf8"));
    expect(stored.nativeId).toBe(nativeId);
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "session_not_open" });
  });

  test("a CLI rename between runs is adopted, never overwritten", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "Old title", "rename-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    await context.sessions.handoff(created.id as SessionKey);
    await appendFile(source, line(nameEntry("a1", "Renamed in the reopened CLI")));
    const namesBefore = context.engine.setNames.length;
    const reopened = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(reopened.id).toBe(created.id);
    expect(reopened.name).toBe("Renamed in the reopened CLI");
    expect(context.engine.setNames.length).toBe(namesBefore);
    const stored = JSON.parse(await readFile(join(context.dataDir, "sessions", `${created.id}.json`), "utf8"));
    expect(stored.name).toBe("Renamed in the reopened CLI");
  });

  test("a changed journal identity refuses instead of rebinding", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "moved-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    await context.sessions.handoff(created.id as SessionKey);
    const rewritten = `${line(headerOf(crypto.randomUUID(), context.cwd))}${line(userEntry("u9", null, "moved-seed"))}`;
    await writeFile(source, rewritten);
    await expect(context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }))
      .rejects.toMatchObject({ code: "resume_unverified" });
    expect(context.sessions.list()[0]).toMatchObject({ active: false });
  });

  test("shared web-born conversations persist the durable id at handoff and keep the branch", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Created in Web");
    const id = created.id as SessionKey;
    const stored = await storedRow(context, created.id);
    expect(stored.shared).toBe(true);
    const durable = String(stored.nativeId);
    // The runtime places the journal itself: no path is sent, the durable id binds.
    expect(context.engine.opened).toEqual([{ path: expect.any(String), durable, sentPath: undefined }]);
    const webStore = await sharedJournal(context, durable);
    expect(webStore).toContain(join("sessions", sessionDirName(context.cwd)));
    const storeFiles = await readdir(join(context.dataDir, "sessions"));
    expect(storeFiles.filter(name => name.endsWith(".jsonl"))).toEqual([]);
    expect(context.sessions.findAlias(durable, context.cwd)).toBe(created.id);
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.action(id, { action: "prompt", mode: "prompt", message: "first branch" });
    await context.sessions.action(id, { action: "prompt", mode: "prompt", message: "second branch" });
    const text = await readFile(webStore, "utf8");
    const assistantIds = text.split("\n").filter(entry => entry.trim()).map(entry => JSON.parse(entry))
      .filter((entry: { type: string }) => entry.type === "message")
      .map((entry: { message: { role: string }; id: string }) => entry.message.role === "assistant" ? entry.id : undefined)
      .filter(Boolean) as string[];
    expect(assistantIds.length).toBeGreaterThanOrEqual(2);
    const older = assistantIds[0];
    await context.sessions.action(id, { action: "navigate", targetId: older });
    const { command } = await context.sessions.handoff(id);
    expect(command).toContain(webStore);
    const after = await readFile(webStore, "utf8");
    const rows = after.split("\n").filter(entry => entry.trim()).map(entry => JSON.parse(entry));
    const marker = rows.find((entry: { customType?: string }) => entry.customType === "session_released");
    expect(marker.parentId).toBe(older);
    expect(after).toContain("second branch");
    const firstHeader = JSON.parse(text.split("\n", 1)[0]);
    const lastHeader = JSON.parse(after.split("\n", 1)[0]);
    expect(lastHeader.id).toBe(firstHeader.id);
    expect(typeof stored.nativeId).toBe("string");
    expect(stored.shared).toBe(true);
  });

  test("uncertain release never replays and reconciles on next resume", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "uncertain-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    context.engine.timeoutReleaseAfterWrite = true;
    await expect(context.sessions.handoff(created.id as SessionKey)).rejects.toMatchObject({ code: "engine_timeout" });
    expect(context.sessions.list()[0]).toMatchObject({ active: false });
    const markers = (await readFile(source, "utf8")).split("\n").filter(entry => entry.includes("session_released"));
    expect(markers).toHaveLength(1);
    context.engine.timeoutReleaseAfterWrite = false;
    const reopened = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(reopened.id).toBe(created.id);
    expect(reopened.active).toBe(true);
  });

  test("shared transport and missing capabilities refuse handoff up front", async () => {
    const stdio = await setupSessions(false);
    expect(stdio.sessions.handoffSupport()).toEqual({ supported: false, reason: "shared_transport" });
    const nativeId = crypto.randomUUID();
    const source = await seedCli(stdio, nativeId, "CLI title", "stdio-seed");
    await expect(stdio.sessions.resumeCli({ cwd: stdio.cwd, nativeSessionId: nativeId, sourcePath: source }))
      .rejects.toMatchObject({ code: "resume_unsupported" });
    expect(stdio.sessions.list()).toHaveLength(0);
    const legacy = await setupSessions(true, ["multi_session"]);
    expect(legacy.sessions.handoffSupport()).toEqual({ supported: false, reason: "missing_capability" });
    const created = await legacy.sessions.create(legacy.cwd, "legacy web");
    await legacy.sessions.action(created.id as SessionKey, { action: "resume" });
    await expect(legacy.sessions.handoff(created.id as SessionKey))
      .rejects.toMatchObject({ code: "handoff_unsupported" });
  });

  test("mismatched engine/profile configuration fails closed, even after restart", async () => {
    const context = await setupSessions(true, undefined, { sameProfile: false });
    expect(context.sessions.handoffSupport()).toEqual({ supported: false, reason: "profile_mismatch" });
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "profile-seed");
    await expect(context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source }))
      .rejects.toMatchObject({ code: "resume_unsupported" });
    expect(context.sessions.list()).toHaveLength(0);
    const aligned = await setupSessions();
    const alignedSource = await seedCli(aligned, nativeId, "CLI title", "profile-seed");
    const created = await aligned.sessions.resumeCli(
      { cwd: aligned.cwd, nativeSessionId: nativeId, sourcePath: alignedSource });
    const engine = new HandoffEngine(aligned.cwd);
    const restarted = new Sessions(aligned.dataDir, [aligned.cwd], engine, () => undefined,
      async () => ({ sourcePath: alignedSource }), { sameProfile: false });
    await restarted.load();
    await expect(restarted.action(created.id as SessionKey, { action: "resume" }))
      .rejects.toMatchObject({ code: "resume_unsupported" });
    expect(restarted.list()[0]).toMatchObject({ active: false });
  });

  test("a deleted or replaced shared journal refuses instead of recreating", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Web origin");
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.action(id, { action: "prompt", mode: "prompt", message: "origin seed" });
    await context.sessions.handoff(id);
    const durable = String((await storedRow(context, created.id)).nativeId);
    const webStore = await sharedJournal(context, durable);
    const opens = context.engine.opened.length;
    await rm(webStore);
    await expect(context.sessions.action(id, { action: "resume" }))
      .rejects.toMatchObject({ code: "resume_source_changed" });
    await writeFile(webStore, `${line(headerOf(crypto.randomUUID(), context.cwd))}`);
    await expect(context.sessions.action(id, { action: "resume" }))
      .rejects.toMatchObject({ code: "resume_source_changed" });
    expect(context.engine.opened.length).toBe(opens);
    expect(context.sessions.list()[0]).toMatchObject({ active: false });
  });

  test("an ineligible host keeps the legacy private journal", async () => {
    const context = await setupSessions(true, ["multi_session"]);
    const created = await context.sessions.create(context.cwd, "Legacy origin");
    const id = created.id as SessionKey;
    expect((await storedRow(context, created.id)).shared).toBeUndefined();
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.action(id, { action: "prompt", mode: "prompt", message: "legacy seed" });
    const webStore = join(context.dataDir, "sessions", `${created.id}.jsonl`);
    expect(await readFile(webStore, "utf8")).toContain("legacy seed");
    expect(context.sessions.handoffSupport()).toEqual({ supported: false, reason: "missing_capability" });
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "handoff_unsupported" });
  });

  test("a timed-out release that kept its route reattaches without a second marker", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "kept-route");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    context.engine.timeoutReleaseAfterWrite = true;
    context.engine.dropRouteOnTimeout = false;
    await expect(context.sessions.handoff(created.id as SessionKey)).rejects.toMatchObject({ code: "engine_timeout" });
    expect((await readFile(source, "utf8")).split("session_released")).toHaveLength(1);
    const reopened = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(reopened).toMatchObject({ id: created.id, active: true });
    expect(context.engine.routes.size).toBe(1);
    expect((await readFile(source, "utf8")).split("session_released")).toHaveLength(1);
  });

  test("adopted live CLI branches preview and fork independently", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCliThread(context.agent, context.cwd, nativeId, "CLI thread",
      [["first input", "First reply"], ["second input", "Second reply"]]);
    context.paths.set(nativeId, source);
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    const preview = await context.sessions.webBranchOptions(id);
    expect(preview.canClone).toBe(true);
    expect(preview.forkMessages.map(message => message.entryId)).toEqual(["u1", "u2"]);
    const before = await readdir(join(context.agent, "sessions", sessionDirName(context.cwd)));
    const forked = await context.sessions.branchWeb(id, { kind: "fork", entryId: "u2" });
    expect(forked.cancelled).toBeFalsy();
    if (forked.cancelled) return;
    expect(forked.session.id).not.toBe(created.id);
    expect(forked.session).toMatchObject({ active: true, name: "CLI thread · 分支" });
    expect(typeof forked.editorText).toBe("string");
    // Shared-mode branches land next to the source so the CLI picker discovers them.
    const after = await readdir(join(context.agent, "sessions", sessionDirName(context.cwd)));
    const added = after.filter(name => !before.includes(name) && name.endsWith(".jsonl"));
    expect(added).toHaveLength(1);
    const branchFile = join(context.agent, "sessions", sessionDirName(context.cwd), added[0]);
    const forkedStored = await storedRow(context, forked.session.id);
    expect(forkedStored.shared).toBe(true);
    expect(typeof forkedStored.nativeId).toBe("string");
    expect(JSON.parse((await readFile(branchFile, "utf8")).split("\n", 1)[0]).id).toBe(forkedStored.nativeId);
    const branchText = await readFile(branchFile, "utf8");
    expect(branchText).toContain("First reply");
    expect(branchText).not.toContain("Second reply");
    const snapshot = await context.sessions.snapshot(forked.session.id as SessionKey);
    const rendered = snapshot.messages.map(message => JSON.stringify(message)).join("\n");
    expect(rendered).toContain("First reply");
    expect(rendered).not.toContain("Second reply");
    await context.sessions.action(forked.session.id as SessionKey,
      { action: "prompt", mode: "prompt", message: "branch-only" });
    expect(await readFile(branchFile, "utf8")).toContain("branch-only");
    expect(await readFile(source, "utf8")).not.toContain("branch-only");
    expect(await readFile(source, "utf8")).not.toContain("session_released");
  });

  test("inactive adopted bookmarks branch from the resolved source", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCliThread(context.agent, context.cwd, nativeId, "CLI thread",
      [["first input", "First reply"], ["second input", "Second reply"]]);
    context.paths.set(nativeId, source);
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    await context.sessions.handoff(id);
    const cloned = await context.sessions.branchWeb(id, { kind: "clone" });
    expect(cloned.cancelled).toBeFalsy();
    if (cloned.cancelled) return;
    expect(cloned.session.id).not.toBe(created.id);
    expect(cloned.session).toMatchObject({ active: true });
    const clonedStored = await storedRow(context, cloned.session.id);
    expect(clonedStored.shared).toBe(true);
    const branchText = await readFile(await sharedJournal(context, String(clonedStored.nativeId)), "utf8");
    expect(branchText).toContain("First reply");
    expect(branchText).toContain("Second reply");
    expect(JSON.parse(branchText.split("\n", 1)[0]).id).not.toBe(nativeId);
  });

  test("a symlinked shared journal refuses resume without opening", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Web origin");
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.handoff(id);
    const durable = String((await storedRow(context, created.id)).nativeId);
    const webStore = await sharedJournal(context, durable);
    const opens = context.engine.opened.length;
    await rm(webStore);
    await symlink("/dev/null", webStore);
    await expect(context.sessions.action(id, { action: "resume" }))
      .rejects.toMatchObject({ code: "resume_source_changed" });
    expect(context.engine.opened.length).toBe(opens);
    expect(context.sessions.list()[0]).toMatchObject({ active: false });
  });

  test("a hardlinked shared journal refuses resume without opening", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Web origin");
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.handoff(id);
    const durable = String((await storedRow(context, created.id)).nativeId);
    const webStore = await sharedJournal(context, durable);
    await link(webStore, `${webStore}.bak`);
    await expect(context.sessions.action(id, { action: "resume" }))
      .rejects.toMatchObject({ code: "resume_source_changed" });
  });

  test("resume reads only the bounded header of a large shared journal", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Web origin");
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.handoff(id);
    const durable = String((await storedRow(context, created.id)).nativeId);
    const webStore = await sharedJournal(context, durable);
    await appendFile(webStore, line({ type: "custom", id: crypto.randomUUID(), parentId: null,
      timestamp: iso, customType: "padding", padding: "x".repeat(1024 * 1024) }));
    await context.sessions.action(id, { action: "resume" });
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: true });
  });

  test("thinking uses turn scope and last-assistant stays minimal", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "scope-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "thinking", level: "low" });
    expect(context.engine.thinkingScopes).toEqual(["turn"]);
    expect(await context.sessions.lastAssistant(id)).toEqual({ text: "Reply scope-seed" });
    await expect(context.sessions.lastAssistant("00000000-0000-4000-8000-000000000000" as SessionKey))
      .rejects.toMatchObject({ code: "session_not_found" });
    await context.sessions.handoff(id);
    await expect(context.sessions.lastAssistant(id)).rejects.toMatchObject({ code: "session_not_open" });
  });

  test("restart reopens the same bookmark against the new route", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "Restart title", "restart-unit");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const engine = new HandoffEngine(context.cwd);
    const restarted = new Sessions(context.dataDir, [context.cwd], engine, () => undefined,
      async () => ({ sourcePath: source }), { sameProfile: true, profileDir: context.agent });
    await restarted.load();
    expect(restarted.list()).toHaveLength(1);
    await restarted.action(created.id as SessionKey, { action: "resume" });
    expect(restarted.list()[0]).toMatchObject({ id: created.id, name: "Restart title", active: true });
    const stored = JSON.parse(await readFile(join(context.dataDir, "sessions", `${created.id}.json`), "utf8"));
    expect(stored.nativeId).toBe(nativeId);
  });

  test("shared create omits the path and binds the durable id", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Shared create");
    expect(created).toMatchObject({ active: true });
    expect(context.engine.opened).toEqual([{ path: expect.any(String), durable: expect.any(String), sentPath: undefined }]);
    const durable = String(context.engine.opened[0].durable);
    const journal = await sharedJournal(context, durable);
    expect(JSON.parse((await readFile(journal, "utf8")).split("\n", 1)[0])).toMatchObject(
      { type: "session", version: 3, id: durable, cwd: context.cwd });
    expect(await storedRow(context, created.id)).toMatchObject({ nativeId: durable, shared: true });
    expect(context.sessions.findAlias(durable, context.cwd)).toBe(created.id);
    const again = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: durable, sourcePath: journal });
    expect(again.id).toBe(created.id);
    expect(context.engine.opened).toHaveLength(1);
  });

  test("restart reopens a shared session from the profile bucket", async () => {
    const context = await setupSessions();
    const created = await context.sessions.create(context.cwd, "Shared restart");
    const durable = String((await storedRow(context, created.id)).nativeId);
    const engine = new HandoffEngine(context.cwd);
    const restarted = new Sessions(context.dataDir, [context.cwd], engine, () => undefined,
      async nativeId => ({ sourcePath: await sharedJournal(context, nativeId) }),
      { sameProfile: true, profileDir: context.agent });
    await restarted.load();
    expect(restarted.list()).toHaveLength(1);
    await restarted.action(created.id as SessionKey, { action: "resume" });
    expect(restarted.list()[0]).toMatchObject({ id: created.id, name: "Shared restart", active: true });
    expect(engine.opened).toEqual([{ path: expect.any(String), durable, sentPath: expect.any(String) }]);
    expect(restarted.findAlias(durable, context.cwd)).toBe(created.id);
    expect(restarted.findAlias(crypto.randomUUID(), context.cwd)).toBeUndefined();
  });

  test("miscounted plain release is retried once with force and verified", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "miscount-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    context.engine.miscounted.add(nativeId);
    const { command } = await context.sessions.handoff(id);
    // Exactly one plain attempt, then one scoped force attempt: interrupt is never sent.
    expect(context.engine.releases).toEqual([
      { route: expect.any(String), reason: "takeover" },
      { route: expect.any(String), reason: "takeover", force: true },
    ]);
    expect(command).toContain(`omo --session '${source}'`);
    expect(context.sessions.list()[0]).toMatchObject({ active: false });
    expect(JSON.parse((await readFile(source, "utf8")).split("\n", 1)[0]).id).toBe(nativeId);
    const reopened = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(reopened).toMatchObject({ id: created.id, active: true });
  });

  test("a new native session without a journal is materialized and reopened without a model turn", async () => {
    const context = await setupSessions();
    context.engine.deferHeader = true;
    const created = await context.sessions.create(context.cwd, "Empty but shared");
    const [placed, reopened] = context.engine.opened;
    expect(placed?.sentPath).toBeUndefined();
    expect(reopened).toMatchObject({ path: placed.path, sentPath: placed.path, durable: placed.durable });
    expect(context.engine.opened).toHaveLength(2);
    expect(created).toMatchObject({ active: true, name: "Empty but shared" });
    expect(context.engine.routes.size).toBe(1);
    expect(context.engine.releases).toEqual([{ route: expect.any(String), reason: "takeover" }]);
    expect(context.sessions.findAlias(String(placed.durable), context.cwd)).toBe(created.id);
    const snapshot = await context.sessions.snapshot(created.id);
    expect(snapshot.messages).toEqual([]);
    expect(JSON.parse((await readFile(placed.path, "utf8")).split("\n", 1)[0]).id).toBe(placed.durable);
  });

  test("an idle-to-busy native refusal during scoped release keeps the live route", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "retained-seed");
    const { id } = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    context.engine.miscounted.add(nativeId);
    context.engine.forceBusy = true;
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "turn_active" });
    expect(context.sessions.list()[0]).toMatchObject({ id, active: true });
    expect((await context.sessions.snapshot(id)).session.active).toBe(true);
  });

  test("an incomplete zero-loss release receipt does not produce a handoff command", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "receipt-seed");
    const { id } = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    context.engine.miscounted.add(nativeId);
    context.engine.omitDropped = true;
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "release_unverified" });
    expect(context.sessions.list()[0]).toMatchObject({ id, active: false });
  });

  test("a genuinely attached session refuses without force and stays active", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "attached-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    context.engine.attachedElsewhere.add(nativeId);
    context.engine.attachCounts.set(nativeId, 2);
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "attached" });
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: true });
    expect(context.engine.releases).toEqual([{ route: expect.any(String), reason: "takeover" }]);
  });

  test("an unverifiable listing keeps the attached refusal", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "nolist-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const id = created.id as SessionKey;
    context.engine.miscounted.add(nativeId);
    context.engine.listFails = true;
    await expect(context.sessions.handoff(id)).rejects.toMatchObject({ code: "attached" });
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: true });
    expect(context.engine.releases).toEqual([{ route: expect.any(String), reason: "takeover" }]);
  });

  test("placement outside the profile bucket fails closed without publishing", async () => {
    const context = await setupSessions();
    context.engine.misplace = true;
    await expect(context.sessions.create(context.cwd, "Stray"))
      .rejects.toMatchObject({ code: "shared_placement_unsupported" });
    expect(context.sessions.list()).toHaveLength(0);
    expect(context.engine.routes.size).toBe(0);
  });

  test("parked and released events drop the route while the row stays", async () => {
    const context = await setupSessions();
    const nativeId = crypto.randomUUID();
    const source = await seedCli(context, nativeId, "CLI title", "park-seed");
    const created = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    const route = [...context.engine.routes.keys()][0];
    context.sessions.event({ type: "session_parked", sessionId: route });
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: false });
    const reopened = await context.sessions.resumeCli({ cwd: context.cwd, nativeSessionId: nativeId, sourcePath: source });
    expect(reopened).toMatchObject({ id: created.id, active: true });
    const route2 = [...context.engine.routes.keys()][0];
    context.sessions.event({ type: "session_released", sessionId: route2 });
    expect(context.sessions.list()[0]).toMatchObject({ id: created.id, active: false });
  });

  test("legacy private sources branch into the private store", async () => {
    const context = await setupSessions(true, ["multi_session"]);
    const created = await context.sessions.create(context.cwd, "Legacy origin");
    const id = created.id as SessionKey;
    await context.sessions.action(id, { action: "resume" });
    await context.sessions.action(id, { action: "prompt", mode: "prompt", message: "legacy seed" });
    const cloned = await context.sessions.branchWeb(id, { kind: "clone" });
    expect(cloned.cancelled).toBeFalsy();
    if (cloned.cancelled) return;
    const branchText = await readFile(join(context.dataDir, "sessions", `${cloned.session.id}.jsonl`), "utf8");
    expect(branchText).toContain("legacy seed");
    const clonedStored = await storedRow(context, cloned.session.id);
    expect(clonedStored.shared).toBeUndefined();
    expect(clonedStored.nativeId).toBeUndefined();
  });
});
