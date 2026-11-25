import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, fstatSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebError, record } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

export type EngineSocketTransport = {
  readonly kind: "socket";
  readonly socketPath: string;
  readonly keyRoot: string;
};

export type SocketPeerLaunch = {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly socketPath: string;
  readonly keyRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly socketWaitMs?: number;
  readonly handshakeTimeoutMs?: number;
};

export type SocketPeerHooks = {
  readonly onEvent?: (event: WireObject) => void;
  readonly onClose?: (error: WebError) => void;
};

type Pending = {
  readonly resolve: (data: WireObject) => void;
  readonly reject: (error: WebError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const MAX_FRAME = 48 * 1024 * 1024;
const HANDSHAKE_MAX_LINE = 1024 * 1024;
const MAX_PENDING = 128;
const HEX64 = /^[a-f0-9]{64}$/;
const LAUNCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_KEY_RECORD_BYTES = 4096;
const KILL_TERM_MS = 3000;
const KILL_HARD_MS = 2000;

function offline(message = "OmO 连接已断开。请重试；不会自动重发你的输入。"): WebError {
  return new WebError(503, "engine_unavailable", message);
}

function refused(): WebError {
  return new WebError(503, "socket_auth_failed", "OmO 私有连接认证失败，请重试。");
}

function authProof(key: Buffer, label: "server" | "client", ...parts: string[]): string {
  return createHmac("sha256", key).update([`senpi-rpc-${label}`, ...parts].join("\n"), "utf8").digest("hex");
}

function matchHex(expected: string, received: unknown): boolean {
  return (
    typeof received === "string" &&
    HEX64.test(expected) &&
    HEX64.test(received) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
  );
}

type ChildWatch = {
  readonly dead: () => boolean;
  readonly exit: Promise<void>;
  killAndAwait(): Promise<void>;
};

function watchChild(child: ChildProcess): ChildWatch {
  let gone = false;
  const waiters = new Set<() => void>();
  const markGone = () => {
    if (gone) return;
    gone = true;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  child.once("error", markGone);
  child.once("close", markGone);
  const waitExit = (ms: number): Promise<boolean> => {
    if (gone) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        waiters.delete(done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(true);
      };
      waiters.add(done);
    });
  };
  return {
    dead: () => gone,
    exit: new Promise<void>(resolve => {
      if (gone) resolve();
      else waiters.add(() => resolve());
    }),
    killAndAwait: async () => {
      if (!gone) {
        try {
          child.kill("SIGTERM");
        } catch {
          return;
        }
        if (await waitExit(KILL_TERM_MS)) return;
      }
      if (!gone) {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
        await waitExit(KILL_HARD_MS);
      }
    },
  };
}

async function checkOwnedDir(path: string, exactMode: number | undefined): Promise<void> {
  const self = process.getuid?.();
  const entry = await stat(path);
  if (!entry.isDirectory() || (self !== undefined && entry.uid !== self)) throw refused();
  if (exactMode !== undefined) {
    if ((entry.mode & 0o7777) !== exactMode) throw refused();
  } else if ((entry.mode & 0o022) !== 0) {
    throw refused();
  }
}

async function assertLiveOwnedProcess(pid: unknown): Promise<void> {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw refused();
  const self = process.getuid?.();
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = content.slice(content.lastIndexOf(")") + 1).trim().charAt(0);
    if (state === "" || state === "Z" || state === "X" || state === "x") throw refused();
    if (self !== undefined && (await stat(`/proc/${pid}`)).uid !== self) throw refused();
  } catch (error) {
    if (error instanceof WebError) throw error;
    try {
      process.kill(pid, 0);
    } catch {
      throw refused();
    }
  }
}

async function readLaunchKey(keyRoot: string, launchId: string, expectedEndpoint: string): Promise<Buffer> {
  if (!LAUNCH_ID.test(launchId)) throw refused();
  const self = process.getuid?.();
  try {
    await checkOwnedDir(await realpath(keyRoot), undefined);
    await checkOwnedDir(await realpath(join(keyRoot, "rpc")), undefined);
    const keysDir = join(keyRoot, "rpc", "keys");
    const keysEntry = await lstat(keysDir);
    if (!keysEntry.isDirectory() || keysEntry.isSymbolicLink()) throw refused();
    if (self !== undefined && keysEntry.uid !== self) throw refused();
    if ((keysEntry.mode & 0o7777) !== 0o700) throw refused();
    const handle = await open(join(keysDir, launchId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (self !== undefined && info.uid !== self)) throw refused();
      if ((info.mode & 0o7777) !== 0o600 || info.size > MAX_KEY_RECORD_BYTES) throw refused();
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      const entry = record(parsed);
      if (entry.version !== 1 || entry.launch_id !== launchId || typeof entry.key !== "string" || !HEX64.test(entry.key)) {
        throw refused();
      }
      if (typeof entry.endpoint !== "string" || entry.endpoint !== expectedEndpoint) throw refused();
      await assertLiveOwnedProcess(entry.pid);
      return Buffer.from(entry.key, "hex");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw refused();
  }
}

export async function createPrivateSocketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omo-web-engine-"));
  await chmod(dir, 0o700);
  const self = process.getuid?.();
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (self !== undefined && entry.uid !== self) ||
      (entry.mode & 0o7777) !== 0o700) {
    await rm(dir, { recursive: true, force: true });
    throw new WebError(503, "socket_dir_unsafe", "OmO 私有目录不可用，请重试。");
  }
  return dir;
}

async function waitForSocket(dead: () => boolean, socketPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  const modeDeadline = Date.now() + 2000;
  const parent = await lstat(dirname(socketPath)).catch(() => undefined);
  const self = process.getuid?.();
  if (!parent || !parent.isDirectory() || parent.isSymbolicLink() ||
      (self !== undefined && parent.uid !== self) || (parent.mode & 0o7777) !== 0o700) {
    throw refused();
  }
  for (;;) {
    let entry;
    try {
      entry = await lstat(socketPath);
    } catch {
      if (dead()) throw offline("OmO 进程启动失败，请重试。");
      if (Date.now() >= deadline) throw offline("OmO 私有连接超时，请重试。");
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    if (!entry.isSocket()) throw refused();
    if (self !== undefined && entry.uid !== self) throw refused();
    if ((entry.mode & 0o077) === 0) return;
    if (Date.now() >= modeDeadline || dead()) throw refused();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function frame(data: WireObject): string {
  return `${JSON.stringify(data)}\n`;
}

export class SocketPeer {
  readonly childPid: number;
  readonly socketPath: string;
  readonly #child: ChildProcess;
  readonly #watch: ChildWatch;
  readonly #socket: Socket;
  readonly #pending = new Map<string, Pending>();
  readonly #onEvent: (event: WireObject) => void;
  readonly #onClose: (error: WebError) => void;
  #counter = 0;
  #line = "";
  #failure: WebError | undefined;
  #armed = false;

  private constructor(child: ChildProcess, watch: ChildWatch, socket: Socket, socketPath: string, hooks: SocketPeerHooks) {
    this.#child = child;
    this.#watch = watch;
    this.#socket = socket;
    this.socketPath = socketPath;
    this.#onEvent = hooks.onEvent ?? (() => undefined);
    this.#onClose = hooks.onClose ?? (() => undefined);
    this.childPid = child.pid ?? -1;
    socket.setEncoding("utf8");
    const invalidate = (error: WebError) => {
      if (this.#failure) return;
      this.#failure = error;
      for (const request of this.#pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.#pending.clear();
      this.#onClose(error);
    };
    socket.on("error", () => {
      invalidate(offline());
      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    });
    socket.on("close", () => invalidate(offline()));
    void watch.exit.then(() => invalidate(offline()));
  }

  static async launch(options: SocketPeerLaunch, hooks: SocketPeerHooks = {}): Promise<SocketPeer> {
    const [program, ...args] = options.command;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const watch = watchChild(child);
    const fail = async (error: WebError): Promise<never> => {
      await watch.killAndAwait();
      await unlink(options.socketPath).catch(() => undefined);
      throw error;
    };
    try {
      await waitForSocket(watch.dead, options.socketPath, options.socketWaitMs ?? 20_000);
    } catch (error) {
      if (!(error instanceof WebError)) throw error;
      return fail(error);
    }
    const socket = createConnection(options.socketPath);
    try {
      const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      if (typeof fd === "number" && !fstatSync(fd).isSocket()) throw refused();
    } catch (error) {
      if (error instanceof WebError) {
        socket.destroy();
        return fail(error);
      }
    }
    const peer = new SocketPeer(child, watch, socket, options.socketPath, hooks);
    try {
      await peer.#authenticate(options.keyRoot, options.handshakeTimeoutMs ?? 15_000);
    } catch (error) {
      socket.destroy();
      if (!(error instanceof WebError)) throw error;
      console.error("OmO socket engine authentication failed");
      return fail(error);
    }
    peer.#armed = true;
    socket.on("data", chunk => peer.#onData(String(chunk)));
    return peer;
  }

  #onData(chunk: string): void {
    if (!this.#armed) return;
    this.#line += chunk;
    if (this.#line.length > MAX_FRAME) {
      this.#socket.destroy();
      return;
    }
    let start = 0;
    for (let end = this.#line.indexOf("\n"); end !== -1; end = this.#line.indexOf("\n", start)) {
      if (end - start > MAX_FRAME) {
        this.#socket.destroy();
        return;
      }
      const line = this.#line.slice(start, end);
      start = end + 1;
      if (!line.trimStart().startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#socket.destroy();
        return;
      }
      const message = record(parsed);
      if (message.type !== "response") {
        if (typeof message.type === "string") this.#onEvent(message);
        continue;
      }
      if (typeof message.id !== "string") continue;
      const waiting = this.#pending.get(message.id);
      if (!waiting) continue;
      this.#pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.success === true) waiting.resolve(record(message.data));
      else {
        const code = typeof message.errorCode === "string" ? message.errorCode : "engine_refused";
        waiting.reject(new WebError(409, code, "OmO 未接受该操作。"));
      }
    }
    this.#line = this.#line.slice(start);
  }

  #authenticate(keyRoot: string, timeoutMs: number): Promise<WireObject> {
    return new Promise((resolve, reject) => {
      const socket = this.#socket;
      const clientNonce = randomBytes(32).toString("hex");
      const id = "omo-web-auth";
      let line = "";
      let settled = false;
      const done = (error?: WebError, data?: WireObject) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve(data ?? {});
        }
      };
      const timer = setTimeout(() => done(refused()), timeoutMs);
      const onClose = () => done(refused());
      const onData = (chunk: string) => {
        line += chunk;
        if (line.length > HANDSHAKE_MAX_LINE) {
          done(refused());
          return;
        }
        let end: number;
        while ((end = line.indexOf("\n")) !== -1) {
          const text = line.slice(0, end);
          line = line.slice(end + 1);
          if (!text.trimStart().startsWith("{")) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            done(refused());
            return;
          }
          const message = record(parsed);
          if (message.id !== id || message.type !== "response") continue;
          socket.off("data", onData);
          void (async () => {
            try {
              if (message.success !== true) throw refused();
              const challenge = record(record(message.data).auth);
              if (typeof challenge.launch_id !== "string" || typeof challenge.server_nonce !== "string" ||
                  typeof challenge.server_proof !== "string") {
                throw refused();
              }
              const key = await readLaunchKey(keyRoot, challenge.launch_id, this.socketPath);
              const expectedServer = authProof(key, "server", challenge.launch_id, clientNonce, challenge.server_nonce);
              if (!matchHex(expectedServer, challenge.server_proof)) throw refused();
              const clientProof = authProof(key, "client", challenge.launch_id, challenge.server_nonce, clientNonce);
              const replyId = "omo-web-auth-reply";
              const authed = await this.#exchange(
                { id: replyId, type: "authenticate", client_proof: clientProof },
                replyId,
                HANDSHAKE_MAX_LINE,
                timeoutMs,
              );
              if (authed.success !== true) throw refused();
              done(undefined, record(message.data));
            } catch (error) {
              done(error instanceof WebError ? error : refused());
            }
          })();
          return;
        }
      };
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.once("error", () => done(refused()));
      socket.write(frame({ id, type: "get_protocol_info", auth: { client_nonce: clientNonce } }));
    });
  }

  #exchange(message: WireObject, id: string, maxLine: number, timeoutMs: number): Promise<WireObject> {
    return new Promise((resolve, reject) => {
      const socket = this.#socket;
      let line = "";
      let settled = false;
      const done = (error?: WebError, data?: WireObject) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        if (error) reject(error);
        else resolve(data ?? {});
      };
      const timer = setTimeout(() => done(refused()), timeoutMs);
      const onClose = () => done(refused());
      const onData = (chunk: string) => {
        line += chunk;
        if (line.length > maxLine) {
          socket.destroy();
          done(refused());
          return;
        }
        let end: number;
        while ((end = line.indexOf("\n")) !== -1) {
          const text = line.slice(0, end);
          line = line.slice(end + 1);
          if (!text.trimStart().startsWith("{")) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            socket.destroy();
            done(refused());
            return;
          }
          const result = record(parsed);
          if (result.id !== id || result.type !== "response") continue;
          done(undefined, result);
        }
      };
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.write(frame(message));
    });
  }

  request(type: string, fields: WireObject = {}, timeout = 30_000): Promise<WireObject> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(new WebError(429, "bridge_busy", "操作过多，请稍后重试。"));
    const id = `web-${++this.#counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WebError(504, "engine_timeout", "OmO 未及时确认操作。请刷新确认状态后再试，不要直接重复提交。"));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(frame({ ...fields, id, type }));
    });
  }

  async stop(): Promise<void> {
    this.#socket.destroy();
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(offline());
    }
    this.#pending.clear();
    await this.#watch.killAndAwait();
    await unlink(this.socketPath).catch(() => undefined);
  }
}
