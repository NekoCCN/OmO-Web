import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./model-options-engine-fixture.ts", import.meta.url));
const query = (modelId: string, suffix = "") => `/model-preview?provider=fixture&modelId=${modelId}${suffix}`;

async function withApp(run: (ctx: {
  open(name: string): Promise<string>;
  get(path: string): Promise<Response>;
  post(path: string, body: object): Promise<Response>;
  calls(): Promise<Record<string, unknown>[]>;
  profile(): Promise<string>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omo-web-model-options-"));
  const cwd = join(root, "workspace");
  const dataDir = join(root, "web");
  const log = join(root, "rpc.jsonl");
  const cliAgentDir = join(root, "profile");
  const settings = join(cliAgentDir, "settings.json");
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await Promise.all([mkdir(cwd), mkdir(cliAgentDir)]);
    await writeFile(settings, '{"sentinel":"fixture-profile"}');
    const server = app = await startApp({ dataDir, cliAgentDir, workspaces: [cwd], port: 0,
      engineCommand: [process.execPath, fixture, log] });
    const get = (path: string) => fetch(new URL(path, server.url));
    const { token } = await (await get("/api/bootstrap")).json();
    const post = (path: string, body: object) => fetch(new URL(path, server.url), { method: "POST",
      headers: { Origin: server.url.origin, "X-OmO-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const open = async (name: string) => {
      const response = await post("/api/sessions", { cwd, name });
      expect(response.status).toBe(201);
      return `/api/sessions/${(await response.json()).session.id}`;
    };
    await run({ open, get, post, profile: () => readFile(settings, "utf8"),
      calls: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) });
  } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("model previews use each registered model's actual profile without switching, writing, or prompting", async () => {
  await withApp(async ({ open, get, post, calls, profile }) => {
    const a = await open("A");
    const b = await open("B");
    expect((await calls()).filter(call => call.type === "get_model_thinking_level")).toEqual([]);
    const before = await profile();
    const alpha = await get(a + query("alpha"));
    expect(alpha.status).toBe(200);
    expect(alpha.headers.get("cache-control")).toBe("no-store");
    expect(await alpha.json()).toEqual({ status: "ok", level: "low", source: "default", availableLevels: ["off", "low", "high"] });
    expect(await (await get(a + query("beta"))).json()).toEqual({
      status: "ok", level: "medium", source: "default", availableLevels: ["off", "medium"],
    });
    expect((await calls()).filter(call => call.type === "get_model_thinking_level").map(call =>
      [call.sessionId, call.provider, call.modelId])).toEqual([["rpc-1", "fixture", "alpha"], ["rpc-1", "fixture", "beta"]]);
    expect((await calls()).filter(call => ["set_model", "set_thinking_level", "prompt"].includes(String(call.type)))).toEqual([]);
    expect(await profile()).toBe(before);
    expect((await post(a + "/actions", { action: "thinking", level: "high" })).status).toBe(200);
    expect(await (await get(a + query("alpha"))).json()).toMatchObject({ level: "high", source: "session" });
    expect(await (await get(b + query("alpha"))).json()).toMatchObject({ level: "low", source: "default" });
    expect((await post(a + "/actions", { action: "model", provider: "fixture", modelId: "beta" })).status).toBe(200);
    expect((await post(a + "/actions", { action: "thinking", level: "high" })).status).toBe(400);
    expect(await (await get(a + query("beta"))).json()).toMatchObject({ level: "medium", source: "default" });
    expect(await (await get(b + query("alpha"))).json()).toMatchObject({ level: "low", source: "default" });
    expect((await calls()).filter(call => ["set_model", "set_thinking_level", "prompt"].includes(String(call.type))).map(call =>
      [call.type, call.sessionId, call.scope])).toEqual([["set_thinking_level", "rpc-1", "turn"], ["set_model", "rpc-1", "session"]]);
    expect(await profile()).toBe(before);
  });
});

test("model reads and writes reject unauthorized targets, profile payloads and unstable routes", async () => {
  await withApp(async ({ open, get, post, calls }) => {
    const a = await open("A");
    expect((await get(a + query("unknown"))).status).toBe(404);
    expect((await get(a + query("alpha", "&cwd=/private"))).status).toBe(400);
    expect((await get(a + query("alpha", "&modelId=beta"))).status).toBe(400);
    expect((await get(`/api/sessions/${crypto.randomUUID()}` + query("alpha"))).status).toBe(404);
    expect((await post(a + "/actions", { action: "model", provider: "elsewhere", modelId: "alpha" })).status).toBe(404);
    for (const action of [{ action: "model", provider: "fixture", modelId: "beta", scope: "global" },
      { action: "thinking", level: "low", scope: "profile" }, { action: "scopedModels", models: [] }]) {
      expect((await post(a + "/actions", action)).status).toBe(400);
    }
    const pending = await open("pending");
    expect((await get(pending + query("alpha"))).status).toBe(409);
    for (const name of ["pending", "busy", "archived", "moving-write"]) {
      const target = name === "pending" ? pending : await open(name);
      expect((await post(target + "/actions", { action: "thinking", level: "off" })).status).toBe(409);
    }
    const moving = await open("moving");
    expect((await get(moving + query("alpha"))).status).toBe(409);
    expect((await get(moving + query("beta"))).status).toBe(409);
    expect((await calls()).filter(call => ["get_model_thinking_level", "set_model", "set_thinking_level", "prompt"].includes(String(call.type)))
      .map(call => call.type)).toEqual(["get_model_thinking_level"]);
  });
});

test("unsupported and unrecognized previews do not replace the existing option catalog", async () => {
  await withApp(async ({ open, get, post }) => {
    for (const name of ["old", "future"]) {
      const path = await open(name);
      expect(await (await get(path + query("alpha"))).json()).toEqual({ status: "unavailable" });
      expect(await (await get(path + "/options")).json()).toMatchObject({ levels: ["off", "low", "high"],
        models: [{ id: "alpha" }, { id: "beta" }] });
    }
    const old = await open("old");
    expect((await post(old + "/actions", { action: "model", provider: "fixture", modelId: "beta" })).status).toBe(200);
    expect((await post(old + "/actions", { action: "thinking", level: "off" })).status).toBe(200);
  });
});
