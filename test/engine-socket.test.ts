import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/engine.ts";
import { createPrivateSocketDir, SocketPeer } from "../src/engine-socket.ts";

const fixture = fileURLToPath(new URL("./engine-socket-fixture.ts", import.meta.url));
const selfUid = () => process.getuid?.() ?? -1;
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

async function prepare(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "omo-eng-unit-"));
  const keyRoot = join(root, "profile");
  const socketPath = join(root, "engine.sock");
  const launch = () => SocketPeer.launch({
    command: [process.execPath, fixture, socketPath, keyRoot, mode],
    cwd: root,
    socketPath,
    keyRoot,
  });
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return { root, keyRoot, socketPath, launch };
}

async function launchPeer(mode: string) {
  const prepared = await prepare(mode);
  const peer = await prepared.launch();
  cleanups.push(async () => {
    await peer.stop().catch(() => undefined);
  });
  return { peer, ...prepared };
}

async function expectLaunchRejected(mode: string): Promise<unknown> {
  const prepared = await prepare(mode);
  return prepared.launch().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("private socket transport", () => {
  test("authenticates against a well-formed private socket and serves requests", async () => {
    const { peer, socketPath } = await launchPeer("ok");
    const info = await peer.request("get_protocol_info", {});
    expect(info.mode).toBe("multi");
    expect(info.protocolVersion).toBe(1);
    const opened = await peer.request("open_session", { cwd: "/tmp" });
    expect(typeof opened.sessionId).toBe("string");
    const state = await peer.request("get_state", { sessionId: opened.sessionId });
    expect(state.sessionId).toBe(opened.sessionId);
    await peer.request("close_session", { sessionId: opened.sessionId });
    const entry = await stat(socketPath);
    expect(entry.isSocket()).toBe(true);
    if (selfUid() !== -1) expect(entry.uid).toBe(selfUid());
    await peer.stop();
    await expect(stat(socketPath)).rejects.toThrow();
  });

  test("rejects a server proof built in the docs nonce order", async () => {
    const failure = await expectLaunchRejected("wrong-order");
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error)?.message)).not.toMatch(/[a-f0-9]{64}/);
  });

  test("rejects a success reply that carries no auth challenge", async () => {
    await expect(expectLaunchRejected("no-challenge").then(failure => {
      if (failure === undefined) throw new TypeError("expected launch to fail");
      return failure;
    })).resolves.toBeInstanceOf(Error);
  });

  test("rejects an oversized handshake record", async () => {
    await expect(expectLaunchRejected("oversized").then(failure => {
      if (failure === undefined) throw new TypeError("expected launch to fail");
      return failure;
    })).resolves.toBeInstanceOf(Error);
  });

  test("rejects a corrupt key record without leaking material", async () => {
    const failure = await expectLaunchRejected("corrupt-record");
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error)?.message)).not.toMatch(/[a-f0-9]{64}/);
  });

  test("refuses an unauthenticated first frame with auth_required", async () => {
    const { socketPath } = await launchPeer("ok");
    const reply = await new Promise<string>(resolve => {
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
      }, 8000);
    });
    expect(reply).toContain("auth_required");
  });

  test("stops only its own child and tolerates a second stop", async () => {
    const { peer } = await launchPeer("ok");
    const pid = peer.childPid;
    expect(pid).toBeGreaterThan(0);
    const { spawn } = await import("node:child_process");
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanups.push(async () => {
      sentinel.kill("SIGKILL");
    });
    await peer.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    sentinel.kill(0);
    await peer.stop();
    sentinel.kill(0);
  });

  test("creates a private socket directory owned by this user with mode 0700", async () => {
    const dir = await createPrivateSocketDir();
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    const entry = await stat(dir);
    expect(entry.isDirectory()).toBe(true);
    if (selfUid() !== -1) expect(entry.uid).toBe(selfUid());
    expect(entry.mode & 0o777).toBe(0o700);
    await chmod(dir, 0o755);
    await expect(stat(dir)).resolves.toBeDefined();
  });

  test("survives a missing executable with engine-unavailable and stays retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-eng-missing-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const engine = new Engine(
      ["/nonexistent/omo-h-missing-binary", "--mode", "rpc"], root, () => undefined, () => undefined,
      { kind: "socket", socketPath: join(root, "engine.sock"), keyRoot: join(root, "profile") },
    );
    cleanups.push(async () => engine.stop());
    const first = await engine.probe().then(() => undefined, (error: unknown) => error);
    expect(first).toMatchObject({ status: 503, code: "engine_unavailable" });
    expect(String((first as Error)?.message)).not.toContain("nonexistent");
    expect(String((first as Error)?.message)).not.toContain("ENOENT");
    expect(engine.status.online).toBe(false);
    const second = await engine.probe().then(() => undefined, (error: unknown) => error);
    expect(second).toMatchObject({ status: 503, code: "engine_unavailable" });
    await engine.stop();
  });

  test("reaps the child and unlinks the socket after refused authentication", async () => {
    const prepared = await prepare("wrong-order");
    const failure = await prepared.launch().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, code: "socket_auth_failed" });
    const pid = Number(await readFile(join(prepared.keyRoot, "fixture.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(stat(prepared.socketPath)).rejects.toThrow();
  });

  test("refuses a key record bound to a different endpoint", async () => {
    const prepared = await prepare("wrong-endpoint");
    const failure = await prepared.launch().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, code: "socket_auth_failed" });
    expect(String((failure as Error)?.message)).not.toMatch(/[a-f0-9]{64}/);
    const pid = Number(await readFile(join(prepared.keyRoot, "fixture.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(stat(prepared.socketPath)).rejects.toThrow();
  });

  test("concurrent probes share a single boot and child", async () => {
    const prepared = await prepare("ok");
    const engine = new Engine(
      [process.execPath, fixture, prepared.socketPath, prepared.keyRoot, "ok"],
      prepared.root, () => undefined, () => undefined,
      { kind: "socket", socketPath: prepared.socketPath, keyRoot: prepared.keyRoot },
    );
    cleanups.push(async () => engine.stop());
    const [first, second, info] = await Promise.all([
      engine.probe(),
      engine.probe(),
      engine.request("get_protocol_info", {}),
    ]);
    expect([first, second]).toEqual([undefined, undefined]);
    expect(info.mode).toBe("multi");
    expect(engine.status.online).toBe(true);
    const pid = Number(await readFile(join(prepared.keyRoot, "fixture.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    process.kill(pid, 0);
    const opened = await engine.request("open_session", { cwd: prepared.root });
    expect(typeof opened.sessionId).toBe("string");
    await engine.requestExisting("close_session", { sessionId: opened.sessionId });
    await engine.stop();
  });

  test("stop during boot awaits and settles the owned child", async () => {
    const prepared = await prepare("ok");
    const engine = new Engine(
      [process.execPath, fixture, prepared.socketPath, prepared.keyRoot, "ok"],
      prepared.root, () => undefined, () => undefined,
      { kind: "socket", socketPath: prepared.socketPath, keyRoot: prepared.keyRoot },
    );
    cleanups.push(async () => engine.stop());
    const probing = engine.probe().then(() => "resolved", () => "rejected");
    await engine.stop();
    const outcome = await probing;
    expect(["resolved", "rejected"]).toContain(outcome);
    const pid = Number(await readFile(join(prepared.keyRoot, "fixture.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(engine.probe()).rejects.toMatchObject({ status: 503, code: "engine_unavailable" });
    await engine.stop();
  });

  test("Engine reports failed auth and cleans up when the host proof is hostile", async () => {
    const prepared = await prepare("wrong-order");
    const engine = new Engine(
      [process.execPath, fixture, prepared.socketPath, prepared.keyRoot, "wrong-order"],
      prepared.root, () => undefined, () => undefined,
      { kind: "socket", socketPath: prepared.socketPath, keyRoot: prepared.keyRoot },
    );
    cleanups.push(async () => engine.stop());
    const failure = await engine.probe().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, code: "socket_auth_failed" });
    expect(engine.status.online).toBe(false);
    expect(String(engine.status.error ?? "")).not.toMatch(/[a-f0-9]{64}/);
    const pid = Number(await readFile(join(prepared.keyRoot, "fixture.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(stat(prepared.socketPath)).rejects.toThrow();
    await engine.stop();
  });

  test("a failed launch clears boot so the next probe retries with a fresh child", async () => {
    const prepared = await prepare("fail-once");
    const engine = new Engine(
      [process.execPath, fixture, prepared.socketPath, prepared.keyRoot, "fail-once"],
      prepared.root, () => undefined, () => undefined,
      { kind: "socket", socketPath: prepared.socketPath, keyRoot: prepared.keyRoot },
    );
    cleanups.push(async () => engine.stop());
    const first = await engine.probe().then(() => undefined, (error: unknown) => error);
    expect(first).toMatchObject({ status: 503, code: "engine_unavailable" });
    expect(engine.status.online).toBe(false);
    await engine.probe();
    expect(engine.status.online).toBe(true);
    const info = await engine.request("get_protocol_info", {});
    expect(info.mode).toBe("multi");
    await engine.stop();
  });

  test("overrides conflicting inherited agent dir aliases with one consistent profile", async () => {
    const aliasA = await mkdtemp(join(tmpdir(), "omo-eng-alias-a-"));
    const aliasB = await mkdtemp(join(tmpdir(), "omo-eng-alias-b-"));
    cleanups.push(async () => rm(aliasA, { recursive: true, force: true }));
    cleanups.push(async () => rm(aliasB, { recursive: true, force: true }));
    const saved = {
      OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR,
      SENPI_CODING_AGENT_DIR: process.env.SENPI_CODING_AGENT_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.OMO_CODING_AGENT_DIR = aliasA;
    process.env.SENPI_CODING_AGENT_DIR = aliasB;
    process.env.PI_CODING_AGENT_DIR = aliasA;
    try {
      const prepared = await prepare("ok");
      const engine = new Engine(
        [process.execPath, fixture, prepared.socketPath, prepared.keyRoot, "ok"],
        prepared.root, () => undefined, () => undefined,
        { kind: "socket", socketPath: prepared.socketPath, keyRoot: prepared.keyRoot },
      );
      cleanups.push(async () => engine.stop());
      await engine.probe();
      expect(engine.status.online).toBe(true);
      const seen = JSON.parse(await readFile(join(prepared.keyRoot, "fixture.env"), "utf8"));
      expect(seen).toEqual({
        OMO_CODING_AGENT_DIR: prepared.keyRoot,
        SENPI_CODING_AGENT_DIR: prepared.keyRoot,
        PI_CODING_AGENT_DIR: prepared.keyRoot,
      });
      await engine.stop();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("Engine marks private authenticated socket transport with a boolean", () => {
    const stdio = new Engine([process.execPath, fixture], "/tmp", () => undefined, () => undefined);
    expect(stdio.usesPrivateSocketTransport).toBe(false);
    const socketed = new Engine(
      [process.execPath, fixture], "/tmp", () => undefined, () => undefined,
      { kind: "socket", socketPath: join(tmpdir(), "unused.sock"), keyRoot: join(tmpdir(), "unused-profile") },
    );
    expect(socketed.usesPrivateSocketTransport).toBe(true);
  });
});
