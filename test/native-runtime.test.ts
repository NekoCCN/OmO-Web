import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const nativeOmo = process.env.OMO_WEB_REAL_RUNTIME_BIN;
const realRuntime = nativeOmo ? test : test.skip;

realRuntime("reads two real Web bindings through isolated private native stdio", async () => {
  if (!nativeOmo) throw new Error("Set OMO_WEB_REAL_RUNTIME_BIN to the installed OmO package entry");
  const root = await mkdtemp(join(tmpdir(), "omo-web-native-runtime-real-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const profile = join(root, "profile");
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(profile)]);
    await writeFile(join(profile, "settings.json"), JSON.stringify({
      defaultProvider: "fixture", defaultModel: "fixture", quietStartup: true,
    }));
    await writeFile(join(profile, "models.json"), JSON.stringify({ providers: {
      fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-never-used",
        models: [{ id: "fixture", name: "Only for offline registry", contextWindow: 128000, maxTokens: 4096 }] },
    } }));
    app = await startApp({ dataDir: join(root, "web"), workspaces: [cwd], port: 0,
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
    }
    console.log("Native runtime HTTP verified: Senpi 2026.11.23, two private stdio bindings, no messages");
  } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
