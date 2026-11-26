import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApp } from "../src/server.ts";

const omo = resolve(process.argv[2] ?? "");
assert(omo.endsWith("/omo-ai/bin/omo.js") && await Bun.file(omo).exists(), "Provide the installed OmO package entry.");
const root = await mkdtemp(join(tmpdir(), "omo-web-model-native-"));
const cwd = join(root, "workspace");
const home = join(root, "home");
const profile = join(root, "profile");
const dataDir = join(root, "web");
const config = { HOME: home, TMPDIR: root, PATH: "/usr/bin:/bin",
  XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
  OMO_CODING_AGENT_DIR: profile, SENPI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_DIR: profile };
const command = ["/usr/bin/bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  "--bind", root, root, "--clearenv", ...Object.entries(config).flatMap(([key, value]) => ["--setenv", key, value]),
  "--chdir", cwd, process.execPath, "--no-env-file", omo, "--mode", "rpc", "--multi-session",
  "--offline", "--no-approve", "--session-runtime", "in-process", "--omo-senpi-builtin-mcps-disabled"] as const;
const launch = () => startApp({ dataDir, workspaces: [cwd], port: 0, engineCommand: command });
let app: Awaited<ReturnType<typeof launch>> | undefined;
try {
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(profile)]);
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "reasoning",
    defaultThinkingLevel: "low", quietStartup: true }));
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-isolated-placeholder",
    models: [true, false].map(reasoning => ({ id: reasoning ? "reasoning" : "plain", reasoning,
      contextWindow: 128000, maxTokens: 4096 })),
  } } }));
  const server = app = await launch();
  const get = (path: string) => fetch(new URL(path, server.url));
  const bootstrap = await (await get("/api/bootstrap")).json();
  assert.equal(bootstrap.engine.online, true, bootstrap.engine.error);
  const post = (path: string, body: object) => fetch(new URL(path, server.url), { method: "POST",
    headers: { Origin: server.url.origin, "X-OmO-Token": bootstrap.token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function create(name: string) {
    const response = await post("/api/sessions", { cwd, name });
    assert.equal(response.status, 201, response.ok ? name : await response.text());
    return `/api/sessions/${(await response.json()).session.id}`;
  }
  const a = await create("native-preview-A");
  const b = await create("native-preview-B");
  const settings = () => Promise.all(["settings.json", "models.json"].map(file => readFile(join(profile, file), "utf8")));
  const journal = async () => {
    const dir = join(dataDir, "sessions");
    return Promise.all((await readdir(dir)).filter(file => file.endsWith(".jsonl")).map(file => readFile(join(dir, file), "utf8")));
  };
  const previewUrl = (path: string, id: string) => `${path}/model-preview?provider=fixture&modelId=${id}`;
  const preview = async (path: string, id: string) => {
    const response = await get(previewUrl(path, id));
    assert.equal(response.status, 200);
    return response.json();
  };
  const beforeSettings = await settings();
  const beforeJournal = await journal();
  const reasoning = await preview(a, "reasoning");
  assert.deepEqual(reasoning, { status: "ok", level: "low", source: "default",
    availableLevels: ["off", "minimal", "low", "medium", "high"] });
  const plain = await preview(a, "plain");
  assert.equal(plain.status, "ok");
  assert.equal(plain.level, "off");
  assert.deepEqual(plain.availableLevels, ["off"]);
  assert.deepEqual(await preview(b, "reasoning"), reasoning);
  assert.deepEqual(await journal(), beforeJournal);
  assert.deepEqual(await settings(), beforeSettings);
  assert.equal((await post(`${a}/actions`, { action: "thinking", level: "high" })).status, 200);
  assert.deepEqual(await preview(a, "reasoning"), { ...reasoning, level: "high", source: "explicit" });
  assert.equal((await post(`${a}/actions`, { action: "model", provider: "fixture", modelId: "plain" })).status, 200);
  assert.equal((await post(`${a}/actions`, { action: "thinking", level: "high" })).status, 400);
  assert.equal((await post(`${a}/actions`, { action: "thinking", level: "off", scope: "global" })).status, 400);
  assert.equal((await post(`${a}/actions`, { action: "model", provider: "fixture", modelId: "missing" })).status, 404);
  const aState = (await (await get(a)).json()).state;
  const bState = (await (await get(b)).json()).state;
  assert.deepEqual([aState.model.id, aState.thinkingLevel, bState.model.id, bState.thinkingLevel], ["plain", "off", "reasoning", "low"]);
  assert.deepEqual(await preview(b, "reasoning"), reasoning);
  assert.deepEqual(await settings(), beforeSettings);
  for (const path of [a, b]) {
    const { stats } = await (await get(`${path}/details`)).json();
    assert.deepEqual([stats.userMessages, stats.assistantMessages, stats.toolCalls], [0, 0, 0]);
  }
  await app.stop();
  const restarted = app = await launch();
  const inactive = await fetch(new URL(previewUrl(a, "reasoning"), restarted.url));
  assert.equal(inactive.status, 409);
  assert.equal((await inactive.json()).code, "session_not_open");
  console.log(JSON.stringify({ version: bootstrap.engine.version, reasoning, plain, unchangedProfile: true,
    readsPreservedJournal: true, switchedOnlyA: true, invalidRejected: true, noMessages: true, inactiveRejected: true }));
} finally {
  try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
}
