import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startApp } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import type { Engine } from "../src/engine.ts";

const fixture = fileURLToPath(new URL("./command-engine-fixture.ts", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function launch(restrictedCatalog = false) {
  const directory = await mkdtemp(join(tmpdir(), "omo-web-commands-test-"));
  const settings = {
    dataDir: join(directory, "data"),
    workspaces: [directory],
    engineCommand: [process.execPath, fixture, ...(restrictedCatalog ? ["--restricted-catalog"] : [])] as const,
    port: 0,
  };
  const app = await startApp(settings);
  cleanups.push(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const origin = app.url.origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const headers = { Origin: origin, "Content-Type": "application/json", "X-OmO-Token": bootstrap.token };
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, "X-OmO-Token": bootstrap.token }, body: JSON.stringify(body) });
  return { origin, settings, app, headers, post, directory };
}

async function create(client: Awaited<ReturnType<typeof launch>>) {
  const response = await client.post("/api/sessions", { cwd: client.directory });
  expect(response.status).toBe(201);
  return String((await response.json()).session.id);
}

const assistantTexts = async (client: Awaited<ReturnType<typeof launch>>, id: string): Promise<string[]> => {
  const snapshot = await (await fetch(`${client.origin}/api/sessions/${id}`)).json();
  return snapshot.messages
    .filter((m: { role: string }) => m.role === "assistant")
    .flatMap((m: { content: { type: string; text?: string }[] }) =>
      m.content.filter(part => part.type === "text").map(part => part.text ?? ""));
};

describe("native command contracts", () => {
  test("options projects safe rows with canonical invocations and no paths", async () => {
    const client = await launch();
    const id = await create(client);
    const response = await fetch(`${client.origin}/api/sessions/${id}/options`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.commands).toEqual([
      { name: "echo", description: "Echo command", source: "extension", invocation: "/echo" },
      { name: "fix-tests", description: "Fix failing tests", source: "prompt", invocation: "/fix-tests" },
      { name: "skill:pdf-tools", description: "PDF tools", source: "skill", invocation: "$pdf-tools" },
      { name: "hang-start", description: "Hanging command for busy tests", source: "extension", invocation: "/hang-start" },
    ]);
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("sourceInfo");
    expect(raw).not.toContain("/etc/secret");
    expect(raw).not.toContain("/tmp/echo.ts");
  });

  test("explicit command with arguments reaches native exactly once", async () => {
    const client = await launch();
    const id = await create(client);
    const messageId = randomUUID();
    const response = await client.post(`/api/sessions/${id}/actions`,
      { action: "command", invocation: "/echo", arguments: "hello world", clientMessageId: messageId });
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ disposition: "handled", clientMessageId: messageId });
    expect(await assistantTexts(client, id)).toEqual(["Ran #1: /echo hello world"]);
  });

  test("legacy skill invocation resolves to the canonical dollar form", async () => {
    const client = await launch();
    const id = await create(client);
    const response = await client.post(`/api/sessions/${id}/actions`,
      { action: "command", invocation: "/skill:pdf-tools", arguments: "extract report.pdf" });
    expect(response.status).toBe(200);
    expect(await assistantTexts(client, id)).toEqual(["Ran #1: $pdf-tools extract report.pdf"]);
  });

  test("forged, TUI-only, path-like, and multiline inputs are rejected without model input", async () => {
    const client = await launch();
    const id = await create(client);
    for (const body of [
      { action: "command", invocation: "/nope" },
      { action: "command", invocation: "/settings" },
      { action: "command", invocation: "$ghost" },
      { action: "command", invocation: "/tmp/foo" },
      { action: "command", invocation: "/echo; rm -rf /" },
      { action: "command", invocation: "/echo", arguments: "one\n/two" },
    ]) {
      const response = await client.post(`/api/sessions/${id}/actions`, body);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(await assistantTexts(client, id)).toEqual([]);
  });

  test("registered runtime-view names cannot relay native task, DAG or persistent reasoning commands", async () => {
    const client = await launch(true);
    const id = await create(client);
    for (const [invocation, args] of [
      ["/reasoning", "off"], ["/efforts", "high"], ["/todo", "rm"], ["/tasks", "--all"], ["/dag", "any"], ["/task-kill", ""],
    ]) {
      const command = await client.post(`/api/sessions/${id}/actions`, { action: "command", invocation, arguments: args });
      const direct = await client.post(`/api/sessions/${id}/actions`, { action: "prompt", message: `${invocation} ${args}` });
      expect([command.status, direct.status]).toEqual([400, 400]);
    }
    expect(await assistantTexts(client, id)).toEqual([]);
    const escaped = await client.post(`/api/sessions/${id}/actions`, { action: "prompt", message: " /reasoning off" });
    expect(escaped.status).toBe(200);
    expect(await assistantTexts(client, id)).toEqual([expect.stringContaining("Echo:  /reasoning off")]);
  });

  test("dedicated command is refused while busy instead of being queued", async () => {
    const client = await launch();
    const id = await create(client);
    expect((await client.post(`/api/sessions/${id}/actions`, { action: "command", invocation: "/hang-start" })).status).toBe(200);
    const busy = await client.post(`/api/sessions/${id}/actions`, { action: "command", invocation: "/echo", arguments: "late" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe("session_busy");
    expect((await client.post(`/api/sessions/${id}/actions`, { action: "abort" })).status).toBe(200);
    expect((await client.post(`/api/sessions/${id}/actions`, { action: "command", invocation: "/echo", arguments: "after" })).status).toBe(200);
    expect(await assistantTexts(client, id)).toEqual(["Ran #1: /echo after"]);
  });

  test("plain prompts still flow as text without the legacy fallback flag", async () => {
    const client = await launch();
    const id = await create(client);
    for (const message of ["hello", " /echo hi", "/tmp/foo"]) {
      const response = await client.post(`/api/sessions/${id}/actions`, { action: "prompt", message });
      expect(response.status).toBe(200);
    }
    const texts = await assistantTexts(client, id);
    expect(texts).toHaveLength(3);
    for (const text of texts) {
      expect(text).toContain("[keys:");
      expect(text).not.toContain("unknownCommandAsText");
      expect(text).not.toContain("Ran #");
    }
    const before = (await (await fetch(`${client.origin}/api/sessions/${id}`)).json()).messages.length;
    const rejected = await client.post(`/api/sessions/${id}/actions`, { action: "prompt", message: "/nope" });
    expect(rejected.status).toBe(409);
    const after = (await (await fetch(`${client.origin}/api/sessions/${id}`)).json()).messages.length;
    expect(after).toBe(before);
  });

  test("durable native id stays server-side and never reaches the browser", async () => {
    const client = await launch();
    const id = await create(client);
    await client.post(`/api/sessions/${id}/actions`, { action: "command", invocation: "/echo", arguments: "witness" });
    for (const path of [`/api/sessions/${id}`, `/api/sessions/${id}/options`, `/api/sessions/${id}/details`]) {
      const raw = await (await fetch(`${client.origin}${path}`)).text();
      expect(raw).not.toContain("durable-");
    }
  });
});

describe("Sessions.nativeSessionId", () => {
  test("returns the durable id from get_state, or undefined when absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omo-web-native-id-test-"));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    let durable: unknown = "durable-route-1";
    const engine = {
      request: async (type: string) => {
        if (type === "open_session") {
          return { sessionId: "route-1", state: {}, permissionPreset: "ask", permissionPresetStatus: "applied" };
        }
        return {};
      },
      requestExisting: async (type: string) => {
        if (type === "get_state") return { sessionId: durable, isStreaming: false };
        return {};
      },
    } as unknown as Engine;
    const sessions = new Sessions(join(directory, "data"), [directory], engine, () => {});
    await sessions.load();
    const created = await sessions.create(directory, "native id");
    expect(await sessions.nativeSessionId(created.id)).toBe("durable-route-1");
    durable = undefined;
    expect(await sessions.nativeSessionId(created.id)).toBeUndefined();
  });
});
