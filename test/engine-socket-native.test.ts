import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Engine } from "../src/engine.ts";
import { createPrivateSocketDir, SocketPeer } from "../src/engine-socket.ts";
import { startApp } from "../src/server.ts";

const live = process.env.OMO_WEB_REAL_ENGINE_TESTS === "1" ? test : test.skip;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  let first: unknown;
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (error) {
      first ??= error;
    }
  }
  if (first) throw first;
});

async function shippedRpcClientPath(): Promise<string> {
  const runtimes = join(homedir(), ".omo", "agent", "runtime");
  for (const entry of await readdir(runtimes)) {
    const candidate = join(runtimes, entry, "dist", "modes", "rpc", "rpc-client.js");
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`no shipped RpcClient under ${runtimes}`);
}

async function unauthenticatedProbe(socketPath: string): Promise<string> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let buf = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "probe", type: "get_protocol_info" })}\n`));
    socket.on("data", chunk => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        socket.destroy();
        resolve(buf);
      }
    });
    socket.on("error", error => resolve(`transport: ${error.message}`));
    setTimeout(() => {
      socket.destroy();
      resolve(`timeout: ${buf}`);
    }, 10_000);
  });
}

describe("private socket transport against the real engine", () => {
  live("opens, reads, and natively releases a real session through a project-owned socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-eng-native-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    const socketDir = await createPrivateSocketDir();
    cleanups.push(async () => rm(socketDir, { recursive: true, force: true }));
    const socketPath = join(socketDir, "engine.sock");

    const engine = new Engine(
      [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve"],
      workspace,
      () => undefined,
      () => undefined,
      { kind: "socket", socketPath, keyRoot: profile },
    );
    expect(engine.usesPrivateSocketTransport).toBe(true);
    cleanups.push(async () => engine.stop());
    await engine.probe();
    expect(engine.status.online).toBe(true);
    expect(engine.capabilities.has("multi_session")).toBe(true);

    const entry = await stat(socketPath);
    expect(entry.isSocket()).toBe(true);
    expect(entry.mode & 0o077).toBe(0);
    expect(await unauthenticatedProbe(socketPath)).toContain("auth_required");

    const { RpcClient } = await import(pathToFileURL(await shippedRpcClientPath()).href) as {
      RpcClient: new (options: { socketPath: string; keyRoot: string }) => {
        start(): Promise<void>;
        stop(): Promise<void>;
        send(command: Record<string, unknown>): Promise<{ data?: unknown } & Record<string, unknown>>;
        openSession(options: Record<string, unknown>): Promise<{ sessionId: string }>;
        closeSession(): Promise<void>;
      };
    };
    const parent = new RpcClient({ socketPath, keyRoot: profile });
    await parent.start();
    try {
      const info = await parent.send({ type: "get_protocol_info" });
      const protocol = (info.data ?? info) as { mode?: unknown; protocolVersion?: unknown };
      expect(protocol.mode).toBe("multi");
      expect(protocol.protocolVersion).toBe(1);
      const session = await parent.openSession({ cwd: workspace });
      expect(typeof session.sessionId).toBe("string");
      const state = await parent.send({ type: "get_state" });
      const data = state.data as { sessionId?: unknown; sessionFile?: unknown; cwd?: unknown; isStreaming?: unknown };
      expect(typeof data.sessionId).toBe("string");
      expect(data.cwd).toBe(workspace);
      expect(data.isStreaming).toBe(false);
      expect(typeof data.sessionFile).toBe("string");
      expect(String(data.sessionFile)).toContain(String(data.sessionId));
      const release = await parent.send({ type: "release_session", reason: "takeover" });
      const ack = release.data as { released?: unknown; session_path?: unknown; dropped?: unknown };
      expect(ack.released).toBe(true);
      expect(String(ack.session_path)).toContain(String(data.sessionId));
      expect((await stat(String(ack.session_path))).isFile()).toBe(true);
      const after = await parent.send({ type: "get_state" }).then(
        response => response as { success?: unknown; error?: unknown },
        (error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }),
      );
      const tornDown = ("success" in after && after.success === false) || "thrown" in after;
      expect(tornDown).toBe(true);
    } finally {
      await parent.stop();
    }

    await engine.stop();
    await expect(stat(socketPath)).rejects.toThrow();
    const keysDir = join(profile, "rpc", "keys");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const remaining = await readdir(keysDir).catch(() => ["unreadable"]);
      if (remaining.length === 0) break;
      if (Date.now() >= deadline) throw new Error(`native key records were not cleaned: ${remaining.join(",")}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }, 90_000);

  live("SocketPeer exposes the child identity it will signal on stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-eng-ident-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const profile = join(root, "profile");
    const socketDir = await createPrivateSocketDir();
    cleanups.push(async () => rm(socketDir, { recursive: true, force: true }));
    const socketPath = join(socketDir, "engine.sock");
    const peer = await SocketPeer.launch({
      command: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve",
        "--listen", `unix://${socketPath}`, "--session-runtime", "in-process"],
      cwd: root,
      socketPath,
      keyRoot: profile,
      env: { ...process.env, OMO_CODING_AGENT_DIR: profile, SENPI_CODING_AGENT_DIR: profile,
        PI_CODING_AGENT_DIR: profile, SENPI_RPC_REQUIRE_TOKEN: "1" },
    });
    cleanups.push(async () => {
      await peer.stop().catch(() => undefined);
    });
    expect(peer.socketPath).toContain(socketDir);
    expect(peer.childPid).toBeGreaterThan(0);
    process.kill(peer.childPid, 0);
    await peer.stop();
    expect(() => process.kill(peer.childPid, 0)).toThrow();
  }, 90_000);

  live("boots the production startApp wiring on a private socket", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "omo-eng-serv-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const app = await startApp({
      dataDir: join(root, "data"),
      workspaces: [workspace],
      port: 0,
      cliAgentDir: profile,
      engineSocketAgentDir: profile,
      engineCommand: [process.env.OMO_WEB_BIN || "omo", "--mode", "rpc", "--multi-session", "--offline", "--no-approve"],
    });
    cleanups.push(async () => app.stop());
    const boot = await (await fetch(new URL("/api/bootstrap", app.url))).json();
    expect(boot.engine.online).toBe(true);
    const created = await fetch(new URL("/api/sessions", app.url), {
      method: "POST",
      headers: { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": boot.token },
      body: JSON.stringify({ cwd: workspace }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { session: { id: string } };
    const handoffHeaders = { Origin: app.url.origin, "Content-Type": "application/json", "X-OmO-Token": boot.token };
    const handoff = await fetch(new URL(`/api/sessions/${createdBody.session.id}/handoff`, app.url), {
      method: "POST", headers: handoffHeaders, body: JSON.stringify({}),
    });
    expect(handoff.status).toBe(200);
    const receipt = await handoff.json();
    expect(receipt.session).toMatchObject({ id: createdBody.session.id, active: false, running: false });
    expect(receipt.command).toContain("omo --session");
    const resume = await fetch(new URL(`/api/cli-history/${"0".repeat(64)}/resume`, app.url), {
      method: "POST", headers: handoffHeaders, body: JSON.stringify({}),
    });
    expect(resume.status).toBe(404);
    await app.stop();
  }, 90_000);
});
