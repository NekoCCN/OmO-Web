import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";
import type { AppSettings } from "../src/server.ts";

const live = process.env.OMO_WEB_REAL_SEND_FILE_TEST === "1" ? test : test.skip;

live("production Native exposes send_file to its model in an isolated Web session", async () => {
  if (process.env.OMO_WEB_SEND_FILE_TEST_CHILD !== "1") {
    const child = Bun.spawn([process.execPath, "test", "--timeout", "60000", fileURLToPath(import.meta.url)], {
      env: { ...process.env, OMO_WEB_SEND_FILE_TEST_CHILD: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      timeout: 75_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const receipt = stdout.split("\n").find(line => line.startsWith("REAL_NATIVE_ATTACHMENT "));
    expect(receipt, `${stdout}\n${stderr}`).toBeDefined();
    console.log(receipt);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "omo-web-send-file-native-"));
  const cwd = join(root, "workspace");
  const profile = join(root, "profile");
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: originalEnv.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root,
    XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`,
    XDG_DATA_HOME: `${root}/data` });
  let report: (tools: readonly string[]) => void = () => {};
  const observed = new Promise<readonly string[]>(resolve => { report = resolve; });
  let requests = 0;
  let requestedPath = "example.txt";
  const modelRequests: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      modelRequests.push(JSON.stringify(body));
      report((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      requests++;
      if (requests % 2 === 1) {
        return new Response(chunk({ role: "assistant", tool_calls: [{
          index: 0, id: `call_send_file_${requests}`, type: "function",
          function: { name: "send_file", arguments: JSON.stringify({ path: requestedPath }) },
        }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(chunk({ role: "assistant", content: "fixture" }, null) +
        chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await Promise.all([mkdir(cwd), mkdir(profile)]);
    await writeFile(join(cwd, "example.txt"), "attachment fixture\n");
    await writeFile(join(root, "password"), "isolated-fixture-password", { mode: 0o600 });
    const authorization = `Basic ${Buffer.from("omo:isolated-fixture-password").toString("base64")}`;
    await writeFile(join(root, "outside.txt"), "outside fixture");
    const large = await open(join(cwd, "large.txt"), "w");
    try { await large.truncate(1025); } finally { await large.close(); }
    await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `${provider.url.origin}/v1`, api: "openai-completions", apiKey: "local-fixture",
      models: [{ id: "fixture", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    } } }));
    await writeFile(join(profile, "settings.json"), JSON.stringify({
      defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false },
    }));
    const settings: AppSettings = {
      dataDir: join(root, "web"), workspaces: [cwd], cliAgentDir: profile, port: 0, sendFile: true,
      webEnv: { OMO_WEB_PASSWORD_FILE: join(root, "password"), OMO_WEB_ATTACHMENT_QUOTA_BYTES: "1024" },
      engineCommand: ["omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve", "--session-runtime", "in-process"],
    };
    app = await startApp(settings);
    const server = app;
    const boot = await (await fetch(new URL("/api/bootstrap", server.url), { headers: { Authorization: authorization } })).json();
    expect(boot.engine.online).toBe(true);
    const post = (path: string, body: object) => fetch(new URL(path, server.url), {
      method: "POST", headers: { Authorization: authorization, Origin: server.url.origin,
        "X-OmO-Token": boot.token, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const created = await post("/api/sessions", { cwd });
    expect(created.status).toBe(201);
    const session = (await created.json()).session;
    async function turn(path: string) {
      requestedPath = path;
      const events = await fetch(new URL("/api/events", server.url), {
        headers: { Authorization: authorization }, signal: AbortSignal.timeout(30_000),
      });
      const reader = events.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (!reader) throw new Error("Event stream unavailable");
      let wire = "";
      let pending = "";
      try {
        const submitted = await post(`/api/sessions/${session.id}/actions`, { action: "prompt", message: `Send ${path}` });
        expect(submitted.status).toBe(200);
        while (!wire.includes('"type":"agent_settled"')) {
          const part = await reader.read();
          if (part.done) throw new Error("Event stream closed before settlement");
          wire += part.value;
          pending += part.value;
          const frames = pending.split("\n\n");
          pending = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find(line => line.startsWith("data: "));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            if (event.type === "extension_ui_request" && event.method === "select") {
              expect(event.options).toContain("Allow once");
              expect((await post(`/api/sessions/${session.id}/actions`,
                { action: "answer", requestId: event.id, value: "Allow once" })).status).toBe(200);
            }
          }
        }
      } finally {
        await reader.cancel();
      }
      const snapshot = await (await fetch(new URL(`/api/sessions/${session.id}`, server.url),
        { headers: { Authorization: authorization } })).json();
      const results = snapshot.messages.filter((message: { role: string; toolName?: string }) =>
        message.role === "toolResult" && message.toolName === "send_file");
      return { wire, snapshot, result: results.at(-1) };
    }
    const { wire, snapshot, result } = await turn("example.txt");
    expect(await observed).toContain("send_file");
    expect(result?.isError).toBe(false);
    const receipt = JSON.parse(result.content[0].text);
    expect(receipt).toEqual({ omoWebAttachment: 1, id: expect.any(String), name: "example.txt", size: 19 });
    expect(receipt.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
    const liveResult = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      .find(event => event.type === "tool_execution_end" && event.toolName === "send_file");
    expect(JSON.parse(liveResult.result.content[0].text)).toEqual(receipt);
    expect(wire).not.toContain("attachment fixture");
    expect(JSON.stringify(snapshot)).not.toContain("attachment fixture");
    expect(modelRequests.join("\n")).not.toContain("attachment fixture");
    for (const path of ["../outside.txt", "missing.txt", "large.txt"]) {
      const refusal = await turn(path);
      expect(refusal.result?.isError).toBe(true);
      expect(JSON.stringify(refusal.result)).not.toContain("omoWebAttachment");
    }
    const another = await post("/api/sessions", { cwd });
    expect(another.status).toBe(201);
    const other = (await another.json()).session;
    expect((await fetch(new URL(`/api/sessions/${other.id}/attachments/${receipt.id}`, server.url),
      { headers: { Authorization: authorization } })).status).toBe(404);
    const downloadUrl = new URL(`/api/sessions/${session.id}/attachments/${receipt.id}`, server.url);
    expect((await fetch(new URL("/public/native/web-send-file.mjs", server.url),
      { headers: { Authorization: authorization } })).status).toBe(404);
    expect((await fetch(new URL("/native/web-send-file.mjs", server.url),
      { headers: { Authorization: authorization } })).status).toBe(404);
    expect((await fetch(downloadUrl)).status).toBe(401);
    const download = await fetch(downloadUrl, { headers: { Authorization: authorization } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("attachment fixture\n");
    await writeFile(join(cwd, "example.txt"), "workspace changed");
    await server.stop();
    app = await startApp(settings);
    const persisted = await fetch(new URL(`/api/sessions/${session.id}/attachments/${receipt.id}`, app.url),
      { headers: { Authorization: authorization } });
    expect(persisted.status).toBe(200);
    expect(await persisted.text()).toBe("attachment fixture\n");
    const restartedBoot = await (await fetch(new URL("/api/bootstrap", app.url), { headers: { Authorization: authorization } })).json();
    const resumed = await fetch(new URL(`/api/sessions/${session.id}/actions`, app.url), {
      method: "POST", headers: { Authorization: authorization, Origin: app.url.origin,
        "X-OmO-Token": restartedBoot.token, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    expect(resumed.status).toBe(200);
    const history = await (await fetch(new URL(`/api/sessions/${session.id}`, app.url),
      { headers: { Authorization: authorization } })).json();
    expect(JSON.stringify(history)).toContain(JSON.stringify(receipt).replaceAll('"', '\\"'));
    console.log("REAL_NATIVE_ATTACHMENT", JSON.stringify(receipt));
  } finally {
    try { await app?.stop(); }
    finally {
      provider.stop(true);
      await rm(root, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  }
}, 60_000);
