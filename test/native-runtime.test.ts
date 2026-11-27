import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startApp } from "../src/server.ts";

const owned = { status: "ownership_changed" };
const unavailable = (reason: string) => ({ status: "unavailable", reason });
const all = (section: object) => ({ tasks: section, dag: section, memory: section });
const time = Date.parse("2026-11-25T12:34:56.000Z");
const keys = z.object({ session: z.object({ id: z.string() }) });

async function usingApp(mode: string, run: (fixture: {
  readonly app: Awaited<ReturnType<typeof startApp>>;
  readonly cwd: string;
  readonly log: string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omo-web-native-runtime-"));
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const cwd = join(root, "workspace");
    const log = join(root, "fixture-requests.jsonl");
    await mkdir(cwd);
    app = await startApp({ dataDir: join(root, "web"), workspaces: [cwd], port: 0,
      engineCommand: [process.execPath, fileURLToPath(new URL("./native-runtime-engine-fixture.ts", import.meta.url)), mode, log] });
    await run({ app, cwd, log });
  } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function create(app: Awaited<ReturnType<typeof startApp>>, cwd: string) {
  const bootstrap = await fetch(new URL("/api/bootstrap", app.url));
  const { token } = z.object({ token: z.string() }).parse(await bootstrap.json());
  const response = await fetch(new URL("/api/sessions", app.url), {
    method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name: "Synthetic session" }),
  });
  expect(response.status).toBe(201);
  const { session } = keys.parse(await response.json());
  return new URL(`/api/sessions/${session.id}/native-runtime`, app.url);
}

test("native runtime GET projects nonempty data with fixed RPCs and no native strings", async () => {
  await usingApp("current", async ({ app, cwd, log }) => {
    const url = await create(app, cwd);
    url.search = "?name=omo.memory.facts.apply&sessionId=foreign&parent_session_id=foreign&limit=9999";
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      tasks: { status: "ok", rows: [{ status: "error", createdAt: time, updatedAt: time }], omittedCount: 0 },
      dag: { status: "ok", rows: [{ status: "running", createdAt: time, updatedAt: time, nodeCount: 3 }], limitReached: false },
      memory: { status: "ok", totalSteps: 8, reflectedSteps: 5 },
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line =>
      z.object({ type: z.string(), sessionId: z.string().optional(), name: z.string().optional(), data: z.unknown().optional() })
        .parse(JSON.parse(line)));
    expect(calls.filter(call => call.type === "extension_request")).toEqual([
      { type: "extension_request", sessionId: "rpc-private-route", name: "omo.task.list", data: { parent_session_id: "native-private-durable" } },
      { type: "extension_request", sessionId: "rpc-private-route", name: "omo.dag.list", data: { limit: 256 } },
      { type: "extension_request", sessionId: "rpc-private-route", name: "omo.memory.status", data: {} },
    ]);
  });
});

test.each([
  ["invalid", "tasks", { status: "malformed" }],
  ["oversize", "tasks", { status: "malformed" }],
  ["invalid-dag", "dag", { status: "malformed" }],
  ["invalid-memory", "memory", { status: "malformed" }],
  ["configured-unavailable", "tasks", unavailable("native_unavailable")],
  ["dag-unavailable", "dag", unavailable("native_unavailable")],
  ["memory-unavailable", "memory", unavailable("native_unavailable")],
  ["foreign-task", "tasks", owned],
  ["foreign-dag", "dag", owned],
  ["foreign-memory", "memory", owned],
  ["future-memory", "memory", unavailable("unsupported")],
] as const)("native runtime %s does not erase independent proven sections", async (mode, section, outcome) => {
  await usingApp(mode, async ({ app, cwd }) => {
    const response = await fetch(await create(app, cwd));
    expect(response.status).toBe(200);
    const fields = z.object({ tasks: z.object({ status: z.string() }).passthrough(),
      dag: z.object({ status: z.string() }).passthrough(), memory: z.object({ status: z.string() }).passthrough() })
      .parse(await response.json());
    expect(fields[section]).toEqual(outcome);
    for (const name of ["tasks", "dag", "memory"] as const) {
      if (name !== section) expect(fields[name].status).toBe("ok");
    }
    expect(JSON.stringify(fields)).not.toContain("PRIVATE-DO-NOT-RETURN");
  });
});

test.each([
  ["route-change", owned], ["identity-change", owned], ["path-change", owned], ["before-change", owned], ["stale-route", owned],
  ["legacy-route", unavailable("binding_unverified")], ["legacy-no-plugin", unavailable("unsupported")],
] as const)("native runtime %s fails closed across all sections", async (mode, outcome) => {
  await usingApp(mode, async ({ app, cwd, log }) => {
    const response = await fetch(await create(app, cwd));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(all(outcome));
    if (mode === "before-change" || mode === "legacy-route" || mode === "stale-route") {
      expect(await readFile(log, "utf8")).not.toContain("extension_request");
    }
  });
});

test("native runtime keeps empty lists distinct from unavailable and refuses unknown or inactive access", async () => {
  await usingApp("empty", async ({ app, cwd, log }) => {
    const unknown = new URL("/api/sessions/11111111-1111-4111-8111-111111111111/native-runtime", app.url);
    expect((await fetch(unknown)).status).toBe(404);
    expect(await Bun.file(log).exists()).toBe(false);
    const url = await create(app, cwd);
    expect(await (await fetch(url)).json()).toEqual({
      tasks: { status: "empty" }, dag: { status: "empty" }, memory: { status: "ok", totalSteps: 8, reflectedSteps: 5 },
    });
    const { token } = z.object({ token: z.string() }).parse(await (await fetch(new URL("/api/bootstrap", app.url))).json());
    const request = (path: URL, body: unknown) => fetch(path, {
      method: "POST", headers: { Origin: app.url.origin, "X-OmO-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await request(url, { name: "omo.task.cancel" })).status).toBe(404);
    const archived = await request(new URL("actions", url), { action: "archive", enabled: true });
    expect(archived.status).toBe(200);
    const before = await readFile(log, "utf8");
    expect(await (await fetch(url)).json()).toEqual(all(unavailable("inactive")));
    expect(await readFile(log, "utf8")).toBe(before);
  });
});

test.each([
  ["current", { status: "ok", currentTodo: "Review changes", pendingTodo: 1 }],
  ["todo-zero", { status: "ok", pendingTodo: 0 }],
  ["empty", { status: "empty" }],
  ["todo-invalid", unavailable("malformed")],
  ["todo-budget", unavailable("incomplete")],
  ["tree-current", unavailable("incomplete")],
  ["todo-release", unavailable("ownership_changed")],
] as const)("workbench status distinguishes %s Todo without exposing the tree", async (mode, expected) => {
  await usingApp(mode, async ({ app, cwd, log }) => {
    const url = new URL("workbench-status?sessionId=foreign", await create(app, cwd));
    const before = (await readFile(log, "utf8")).length;
    expect((await fetch(url)).status).toBe(400);
    url.search = "";
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expected);
    const requests = (await readFile(log, "utf8")).slice(before).trim().split("\n")
      .map(line => z.object({ type: z.string() }).parse(JSON.parse(line)).type);
    expect(requests).toEqual(mode === "todo-release"
      ? ["get_state", "get_entries"] : ["get_state", "get_entries", "get_state"]);
  });
});

const treePage = z.object({
  nodes: z.array(z.strictObject({ id: z.string(), parentId: z.string().nullable(), type: z.string(),
    role: z.string().optional(), label: z.string().optional(), summary: z.string().optional() })),
  leafId: z.string().nullable(), nextCursor: z.string().optional(),
});
const older = (tree: URL, cursor: string) => new URL(`?cursor=${encodeURIComponent(cursor)}`, tree);

async function postAction(url: URL, body: unknown) {
  const { token } = z.object({ token: z.string() }).parse(await (await fetch(new URL("/api/bootstrap", url))).json());
  return fetch(new URL("actions", url), { method: "POST", headers: { Origin: url.origin,
    "X-OmO-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("details overview retains metrics without requesting history, runtime or queue text", async () => {
  await usingApp("tree-current", async ({ app, cwd, log }) => {
    const url = await create(app, cwd);
    const response = await fetch(new URL("details", url));
    expect(response.status).toBe(200);
    const overview = await response.json();
    expect(overview).not.toHaveProperty("tree");
    expect(overview).not.toHaveProperty("runtime");
    expect(overview).not.toHaveProperty("queue");
    expect(overview).toMatchObject({ stats: { totalMessages: 7, failures: 0 },
      sessionMemory: { status: "unavailable" } });
    expect(await readFile(log, "utf8")).not.toMatch(/"type":"(?:get_tree|get_entries|extension_request|get_pending_inputs)"/);
  });
});

test("tree pages cover append order without exposing message bodies, label metadata, or Native cursors", async () => {
  await usingApp("tree-current", async ({ app, cwd, log }) => {
    const url = new URL("tree", await create(app, cwd));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const receipt = await response.text();
    const newest = treePage.parse(JSON.parse(receipt));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(newest.nodes.map(node => node.id)).toEqual(Array.from({ length: 40 }, (_, i) => `entry-${i + 5}`));
    expect(newest.nodes[0]).toMatchObject({ parentId: "entry-4", role: "assistant" });
    expect(newest.leafId).toBe("entry-42");
    expect(receipt).not.toContain("PRIVATE-DO-NOT-RETURN");
    expect(newest.nextCursor).not.toBe("entry-5");
    const cursor = z.string().parse(newest.nextCursor);
    const previous = treePage.parse(await (await fetch(older(url, cursor))).json());
    expect(previous.nodes.map(node => node.id)).toEqual(["entry-0", "entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(previous.nodes[3]).toMatchObject({ parentId: "entry-1", type: "custom" });
    expect(previous.leafId).toBe("entry-42");
    expect(previous.nextCursor).toBeUndefined();
    expect(JSON.stringify(previous)).not.toContain("Paged Todo");
    const calls = (await readFile(log, "utf8")).split("\n").filter(line => line.includes('"type":"get_entries"'))
      .map(line => z.object({ tail: z.number(), maxBytes: z.number(), before: z.string().optional() }).parse(JSON.parse(line)));
    expect(calls).toEqual([{ tail: 40, maxBytes: 262144 }, { tail: 40, maxBytes: 262144, before: "entry-5" }]);
    expect(await readFile(log, "utf8")).not.toContain('"type":"get_tree"');
  });
});

test("tree singleton over the Native soft byte limit remains a bounded preview", async () => {
  await usingApp("tree-giant", async ({ app, cwd }) => {
    const response = await fetch(new URL("tree", await create(app, cwd)));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.length).toBeLessThan(512);
    expect(body).not.toContain("PRIVATE-DO-NOT-RETURN");
    expect(treePage.parse(JSON.parse(body)).nodes.map(node => node.id)).toEqual(["entry-44"]);
  });
});

test.each(["tree-bad-id", "tree-bad-next"])("tree rejects malformed Native page %s", async mode => {
  await usingApp(mode, async ({ app, cwd }) => {
    expect((await fetch(new URL("tree", await create(app, cwd)))).status).toBe(502);
  });
});

test.each([
  ["tree-repeat", 502], ["tree-cross-duplicate", 502], ["tree-replaced", 409], ["tree-leaf-changed", 409],
] as const)("tree continuation fails closed on %s", async (mode, status) => {
  await usingApp(mode, async ({ app, cwd }) => {
    const url = new URL("tree", await create(app, cwd));
    const { nextCursor } = treePage.parse(await (await fetch(url)).json());
    const response = await fetch(older(url, z.string().parse(nextCursor)));
    expect(response.status).toBe(status);
    if (status === 409) expect(await response.clone().json()).toMatchObject({ code: "tree_stale" });
    expect(await response.text()).not.toContain("entry-10");
  });
});

test("tree rejects malformed selectors, same-host foreign sessions, foreign hosts and a rebound workspace", async () => {
  await usingApp("tree-current", async ({ app, cwd, log }) => {
    const url = new URL("tree", await create(app, cwd));
    const before = await readFile(log, "utf8");
    for (const query of ["?cursor=", "?cursor=../x", "?cursor=a&cursor=b", "?limit=10", "?cursor=a&sessionId=foreign"]) {
      expect((await fetch(new URL(query, url))).status).toBe(400);
    }
    expect(await readFile(log, "utf8")).toBe(before);
    const cursor = z.string().parse(treePage.parse(await (await fetch(url)).json()).nextCursor);
    await usingApp("tree-current", async other => {
      const foreign = new URL("tree", await create(other.app, other.cwd));
      expect((await fetch(older(foreign, cursor))).status).toBe(409);
    });
    const sibling = new URL("tree", await create(app, cwd));
    expect((await fetch(older(sibling, cursor))).status).toBe(409);
    await rename(cwd, `${cwd}-original`);
    await mkdir(cwd);
    const beforeSwap = await readFile(log, "utf8");
    expect((await fetch(older(url, cursor))).status).toBe(403);
    expect(await readFile(log, "utf8")).toBe(beforeSwap);
  });
});

test("navigate compares expected leaf, invalidates cursors, and reads legacy leaf independently of append order", async () => {
  await usingApp("tree-current", async ({ app, cwd, log }) => {
    const url = new URL("tree", await create(app, cwd));
    const cursor = z.string().parse(treePage.parse(await (await fetch(url)).json()).nextCursor);
    expect((await postAction(url, { action: "navigate", targetId: "entry-1", expectedLeafId: "entry-44" })).status).toBe(409);
    const explicit = await postAction(url, { action: "navigate", targetId: "entry-1", expectedLeafId: "entry-42" });
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ result: { leafId: "entry-1" } });
    expect((await fetch(older(url, cursor))).status).toBe(409);
    const legacy = await postAction(url, { action: "navigate", targetId: "entry-42" });
    expect(legacy.status).toBe(200);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => z.object({
      type: z.string(), tail: z.number().optional(), expectedLeafId: z.string().optional(),
    }).parse(JSON.parse(line)));
    expect(requests.filter(call => call.type === "get_entries").map(call => call.tail)).toEqual([40, 1]);
    expect(requests.filter(call => call.type === "navigate_tree").map(call => call.expectedLeafId)).toEqual(["entry-44", "entry-42", "entry-1"]);
    expect(requests.some(call => call.type === "get_tree" || call.type === "prompt")).toBe(false);
    expect((await fetch(older(url, cursor))).status).toBe(409);
  });
});

test("navigate never writes for a pending question or a supplied foreign route", async () => {
  await usingApp("tree-busy", async ({ app, cwd, log }) => {
    const url = await create(app, cwd);
    expect((await postAction(url, { action: "navigate", targetId: "entry-1", expectedLeafId: "entry-42",
      sessionId: "foreign" })).status).toBe(400);
    expect((await postAction(url, { action: "navigate", targetId: "entry-1", expectedLeafId: "entry-42" })).status).toBe(409);
    expect(await readFile(log, "utf8")).not.toContain('"type":"navigate_tree"');
  });
});

test("explicit navigation evicts transcript cursors without rereading the old branch", async () => {
  await usingApp("tree-transcript", async ({ app, cwd, log }) => {
    const session = await create(app, cwd);
    const path = new URL(session.href.replace(/\/native-runtime$/u, ""));
    const initial = await (await fetch(path)).json();
    expect(initial.messages.at(-1).content).toBe("active leaf entry-42");
    expect((await postAction(session, { action: "navigate", targetId: "entry-1", expectedLeafId: "entry-42" })).status).toBe(200);
    const stale = new URL("transcript", session);
    stale.searchParams.set("cursor", initial.page.olderCursor);
    expect((await fetch(stale)).status).toBe(409);
    const current = await (await fetch(path)).json();
    expect(current.messages.at(-1).content).toBe("active leaf entry-1");
    expect(current.page.id).not.toBe(initial.page.id);
    const requests: { type: string }[] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(call => call.type === "get_messages")).toHaveLength(2);
    expect(requests.some(call => call.type === "get_tree" || call.type === "get_snapshot")).toBe(false);
  });
});

test("navigate forwards an explicit null expected leaf rather than substituting an appended id", async () => {
  await usingApp("tree-null-leaf", async ({ app, cwd, log }) => {
    const response = await postAction(await create(app, cwd), { action: "navigate", targetId: "entry-1", expectedLeafId: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { leafId: "entry-1" } });
    expect(await readFile(log, "utf8")).not.toContain('"type":"get_entries"');
  });
});

test.each([
  ["tree-current", { status: "ok", leafId: "entry-42", todo: { status: "ok", phases: [
    { name: "Checks", tasks: [{ content: "Paged Todo", status: "in_progress" }] },
  ] }, memory: { status: "ok", gate: { status: "skipped", consecutiveFailures: 1, candidateCount: 2 } } }, 2],
  ["tree-null-leaf", { status: "ok", leafId: null, todo: { status: "none" }, memory: { status: "none" } }, 2],
  ["tree-budget", unavailable("incomplete"), 4],
  ["tree-giant", unavailable("incomplete"), 1],
  ["tree-cross-duplicate", unavailable("malformed"), 2],
  ["tree-cycle", unavailable("malformed"), 2],
  ["tree-replaced", unavailable("ownership_changed"), 2],
  ["tree-leaf-changed", unavailable("ownership_changed"), 2],
  ["tree-unsupported", unavailable("unsupported"), 1],
] as const)("branch runtime %s requires complete bounded ancestry and no get_tree fallback", async (mode, expected, count) => {
  await usingApp(mode, async ({ app, cwd, log }) => {
    const url = new URL("branch-runtime", await create(app, cwd));
    expect((await fetch(new URL("?tail=400", url))).status).toBe(400);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    const trace = await readFile(log, "utf8");
    expect(trace).not.toContain('"type":"get_tree"');
    expect(trace.match(/"type":"get_entries"/g)).toHaveLength(count);
  });
});

async function listedDag(url: URL) {
  const body: unknown = await (await fetch(url)).json();
  const { dag: { rows: [row] } } = z.object({ dag: z.object({
    status: z.literal("ok"), rows: z.tuple([z.object({ key: z.string().regex(/^[a-f0-9]{64}$/u) })]),
  }) }).parse(body);
  return { body, detail: new URL(`${url.pathname}/dag/${row.key}`, url) };
}

test("native runtime DAG choice returns bounded local topology using only fixed read RPCs", async () => {
  await usingApp("select-current", async ({ app, cwd, log }) => {
    const url = await create(app, cwd);
    const before = (await readFile(log, "utf8")).length;
    const { body, detail } = await listedDag(url);
    expect(body).toEqual({
      tasks: { status: "ok", rows: [{ status: "error", createdAt: time, updatedAt: time,
        agent: "explore", executionMode: "in-process" }], omittedCount: 0 },
      dag: { status: "ok", rows: [{ status: "running", createdAt: time, updatedAt: time,
        nodeCount: 3, counts: { running: 1, completed: 2 }, key: detail.pathname.split("/").at(-1) }],
      limitReached: false },
      memory: { status: "ok", totalSteps: 8, reflectedSteps: 5 },
    });
    detail.search = "?runId=foreign&name=omo.dag.cancel";
    const response = await fetch(detail);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", runStatus: "running",
      waves: [{ index: 0, nodes: [0, 1] }, { index: 1, nodes: [2] }],
      nodes: [
        { id: 0, state: "completed", attempt: 1, upstream: [], agent: "explore" },
        { id: 1, state: "completed", attempt: 2, upstream: [] },
        { id: 2, state: "running", attempt: 1, upstream: [0, 1], category: "quick" },
      ],
    });
    const requests = (await readFile(log, "utf8")).slice(before).trim().split("\n").map(line =>
      z.object({ type: z.string(), name: z.string().optional(), data: z.unknown().optional() }).parse(JSON.parse(line)));
    expect(requests).toEqual([
      { type: "get_state" },
      { type: "extension_request", name: "omo.task.list", data: { parent_session_id: "native-private-durable" } },
      { type: "extension_request", name: "omo.dag.list", data: { limit: 256 } },
      { type: "extension_request", name: "omo.memory.status", data: {} },
      { type: "get_state" }, { type: "get_state" },
      { type: "extension_request", name: "omo.dag.list", data: { limit: 256 } },
      { type: "get_state" },
      { type: "extension_request", name: "omo.dag.snapshot", data: { runId: "dag_22222222-2222-4222-8222-222222222222" } },
      { type: "get_state" },
    ]);
  });
});

test.each([
  ["select-foreign", owned], ["select-release", owned],
  ["select-malformed", { status: "malformed" }], ["select-overbudget", { status: "malformed" }],
  ["select-bytes", { status: "malformed" }], ["select-delisted", { status: "not_found" }],
] as const)("native DAG detail fails closed for %s", async (mode, expected) => {
  await usingApp(mode, async ({ app, cwd, log }) => {
    const { detail } = await listedDag(await create(app, cwd));
    expect(await (await fetch(detail)).json()).toEqual(expected);
    if (mode === "select-delisted") expect(await readFile(log, "utf8")).not.toContain("omo.dag.snapshot");
  });
});

test("DAG selectors cannot cross a binding or name a raw run; replaced workspaces cannot be read", async () => {
  await usingApp("select-current", async ({ app, cwd, log }) => {
    const url = await create(app, cwd);
    const { detail } = await listedDag(url);
    const tampered = new URL(detail);
    tampered.pathname = `${detail.pathname.slice(0, -1)}${detail.pathname.endsWith("0") ? "1" : "0"}`;
    expect(await (await fetch(tampered)).json()).toEqual({ status: "not_found" });
    expect((await fetch(new URL(`${url.pathname}/dag/dag_22222222-2222-4222-8222-222222222222`, url))).status).toBe(404);
    await usingApp("select-current", async other => {
      const otherUrl = await create(other.app, other.cwd);
      const foreign = new URL(`${otherUrl.pathname}/dag/${detail.pathname.split("/").at(-1)}`, otherUrl);
      expect(await (await fetch(foreign)).json()).toEqual({ status: "not_found" });
      expect(await readFile(other.log, "utf8")).not.toContain("omo.dag.snapshot");
    });
    const before = await readFile(log, "utf8");
    expect(before).not.toContain("omo.dag.snapshot");
    await rename(cwd, `${cwd}-original`);
    await mkdir(cwd);
    expect((await fetch(detail)).status).toBe(403);
    expect((await fetch(new URL("workbench-status", url))).status).toBe(403);
    expect(await readFile(log, "utf8")).toBe(before);
  });
});

const nativeOmo = process.env.OMO_WEB_REAL_RUNTIME_BIN;
const realRuntime = nativeOmo ? test : test.skip;

realRuntime("reads two real Web bindings and seeded DAG/task records through isolated private stdio", async () => {
  if (!nativeOmo) throw new Error("Set OMO_WEB_REAL_RUNTIME_BIN to the installed OmO package entry");
  const root = await mkdtemp(join(tmpdir(), "omo-web-native-runtime-real-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const profile = join(root, "profile");
  const web = join(root, "web");
  const taskState = join(root, "task-state");
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await Promise.all([mkdir(cwd), mkdir(join(home, ".omo"), { recursive: true }), mkdir(profile),
      mkdir(join(taskState, "tasks"), { recursive: true }), mkdir(join(taskState, "dag", "runs"), { recursive: true })]);
    await writeFile(join(home, ".omo", "omo.json"), JSON.stringify({
      task: { state_dir: taskState },
    }));
    await writeFile(join(profile, "settings.json"), JSON.stringify({
      defaultProvider: "fixture", defaultModel: "fixture", quietStartup: true,
    }));
    await writeFile(join(profile, "models.json"), JSON.stringify({ providers: {
      fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-never-used",
        models: [{ id: "fixture", name: "Only for offline registry", contextWindow: 128000, maxTokens: 4096 }] },
    } }));
    app = await startApp({ dataDir: web, cliAgentDir: profile, workspaces: [cwd], port: 0,
      engineCommand: ["/usr/bin/bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/",
        "--dev", "/dev", "--proc", "/proc", "--bind", root, root, "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", home, "--setenv", "TMPDIR", root,
        "--setenv", "XDG_CONFIG_HOME", join(root, "config"), "--setenv", "XDG_CACHE_HOME", join(root, "cache"),
        "--setenv", "XDG_STATE_HOME", join(root, "state"), "--setenv", "XDG_DATA_HOME", join(root, "data"),
        "--setenv", "OMO_CODING_AGENT_DIR", profile, "--setenv", "SENPI_CODING_AGENT_DIR", profile,
        "--setenv", "PI_CODING_AGENT_DIR", profile, "--chdir", cwd,
        process.execPath, "--no-env-file", nativeOmo, "--mode", "rpc", "--multi-session", "--offline",
        "--no-approve", "--session-runtime", "in-process", "--omo-senpi-builtin-mcps-disabled"],
    });
    const boot = z.object({ engine: z.object({ online: z.boolean(), version: z.string() }) })
      .parse(await (await fetch(new URL("/api/bootstrap", app.url))).json());
    expect(boot.engine).toEqual({ online: true, version: "2026.11.23" });
    const a = await create(app, cwd);
    const b = await create(app, cwd);
    expect(a.pathname).not.toBe(b.pathname);
    for (const url of [a, b]) {
      const response = await fetch(url);
      const receipt = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(receipt)).toEqual({
        tasks: { status: "empty" }, dag: { status: "empty" },
        memory: { status: "ok", totalSteps: 0, reflectedSteps: 0 },
      });
      const snapshotUrl = new URL(url);
      snapshotUrl.pathname = snapshotUrl.pathname.slice(0, -"/native-runtime".length);
      const snapshot = await (await fetch(snapshotUrl)).json();
      expect(snapshot.messages).toEqual([]);
      expect(await (await fetch(new URL("workbench-status", url))).json()).toEqual({ status: "empty" });
    }

    // Storage layout from installed omo-task.js (createTaskRecord / DAG readCheckpoint).
    // Seed terminal records only; no prompt, native run creation, or child is needed.
    const webId = z.uuid().parse(a.pathname.split("/")[3]);
    const { nativeId: owner } = z.object({ nativeId: z.uuid() }).parse(
      JSON.parse(await readFile(join(web, "sessions", `${webId}.json`), "utf8")));
    const taskId = "st_11223344";
    const runId = `dag_${crypto.randomUUID()}`;
    const taskPath = join(taskState, "tasks", `${taskId}.json`);
    const dagPath = join(taskState, "dag", "runs", `${runId}.json`);
    const now = new Date().toISOString();
    const privateText = "PRIVATE-SEED /tmp/not-for-display";
    const nodes = [
      { id: "private-seed-build", label: "Verify build", state: "completed", attempt: 1, dependsOn: [],
        route: { kind: "category", category: "quick" }, prompt: privateText },
      { id: "private-seed-test", label: privateText, state: "completed", attempt: 1, dependsOn: ["private-seed-build"],
        route: { kind: "agent", agent: "explore", model: privateText }, prompt: privateText },
    ];
    const taskRecord = JSON.stringify({
      task_id: taskId, status: "completed", residency_state: "persisted_only", task_summary: "Run tests",
      parent_session_id: owner, root_session_id: owner, depth: 1, execution_mode: "in-process",
      model: "fixture/fixture", category: "quick", notify_on_terminal: false, created_at: now, updated_at: now,
      notification: { run_epoch: 0, notified_epoch: 0 }, final_response: privateText, description: privateText,
    });
    const dagRecord = JSON.stringify({
      schemaVersion: 1, checkpointSeq: 0, runId, runKey: "private-seed", name: "Verify build",
      parentSessionId: owner, rootSessionId: owner, status: "completed", generation: 1, createdAt: now, updatedAt: now,
      definitionFingerprint: "fixture", definition: { nodes }, nodes, diagnostics: [],
      edges: [{ from: "private-seed-build", to: "private-seed-test" }],
      waves: [{ index: 0, nodeIds: ["private-seed-build"] }, { index: 1, nodeIds: ["private-seed-test"] }],
      criticalPath: ["private-seed-build", "private-seed-test"], bottlenecks: [],
    });
    await Promise.all([writeFile(taskPath, taskRecord), writeFile(dagPath, dagRecord)]);
    const { body, detail } = await listedDag(a);
    expect(body).toMatchObject({
      tasks: { status: "ok", rows: [{ category: "quick", executionMode: "in-process" }] },
      dag: { status: "ok", rows: [{ nodeCount: 2, counts: { completed: 2 } }] },
    });
    expect(JSON.stringify(body)).not.toContain(privateText);
    expect(await (await fetch(detail)).json()).toEqual({ status: "ok", runStatus: "completed",
      waves: [{ index: 0, nodes: [0] }, { index: 1, nodes: [1] }],
      nodes: [{ id: 0, state: "completed", attempt: 1, category: "quick", upstream: [] },
        { id: 1, state: "completed", attempt: 1, agent: "explore", upstream: [0] }],
    });
    expect(await (await fetch(b)).json()).toEqual({
      tasks: { status: "empty" }, dag: { status: "empty" }, memory: { status: "ok", totalSteps: 0, reflectedSteps: 0 },
    });
    const cross = new URL(`${b.pathname}/dag/${detail.pathname.split("/").at(-1)}`, b);
    expect(await (await fetch(cross)).json()).toEqual({ status: "not_found" });
    expect(await Promise.all([readFile(taskPath, "utf8"), readFile(dagPath, "utf8")])).toEqual([taskRecord, dagRecord]);
    console.log("Native runtime HTTP verified: Senpi 2026.11.23, two private stdio bindings, seeded read-only topology");
  } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
