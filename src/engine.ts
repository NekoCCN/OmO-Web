import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { WebError, array, record } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const MAX_FRAME = 48 * 1024 * 1024;
const MAX_PENDING = 128;

type Pending = {
  readonly resolve: (data: WireObject) => void;
  readonly reject: (error: WebError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};
export type EngineStatus = { readonly online: boolean; readonly version?: string; readonly error?: string };

function offline(message = "OmO 连接已断开。请重试；不会自动重发你的输入。"): WebError {
  return new WebError(503, "engine_unavailable", message);
}

class Peer {
  readonly #pending = new Map<string, Pending>();
  readonly #proc: ChildProcessWithoutNullStreams;
  #counter = 0;
  #line = "";
  #failure: WebError | undefined;
  readonly #exit: Promise<void>;

  constructor(command: readonly [string, ...string[]], cwd: string,
    onEvent: (frame: WireObject) => void, onExit: (error: WebError) => void) {
    const [program, ...args] = command;
    this.#proc = spawn(program, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    // The engine can print local paths and provider diagnostics to stderr. Drain it without forwarding it to the browser.
    this.#proc.stderr.resume();
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => {
      this.#line += chunk;
      let start = 0;
      for (let end = this.#line.indexOf("\n"); end !== -1; end = this.#line.indexOf("\n", start)) {
        if (end - start > MAX_FRAME) { this.#proc.kill(); return; }
        const line = this.#line.slice(start, end);
        start = end + 1;
        if (!line.trimStart().startsWith("{")) continue;
        let frame: WireObject;
        try { frame = record(JSON.parse(line)); } catch (error) {
          if (error instanceof SyntaxError) { this.#proc.kill(); return; }
          throw error;
        }
        if (frame.type !== "response") {
          if (typeof frame.type === "string") onEvent(frame);
          continue;
        }
        if (typeof frame.id !== "string") continue;
        const waiting = this.#pending.get(frame.id);
        if (!waiting) continue;
        this.#pending.delete(frame.id);
        clearTimeout(waiting.timer);
        if (frame.success === true) waiting.resolve(record(frame.data));
        else {
          const code = typeof frame.errorCode === "string" ? frame.errorCode : "engine_refused";
          waiting.reject(new WebError(409, code, typeof frame.error === "string" ? frame.error : "OmO 未接受该操作。"));
        }
      }
      this.#line = this.#line.slice(start);
      if (this.#line.length > MAX_FRAME) this.#proc.kill();
    });
    const invalidate = (error: WebError) => {
      if (this.#failure) return;
      this.#failure = error;
      for (const request of this.#pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.#pending.clear();
      onExit(error);
    };
    this.#proc.stdin.on("error", () => {
      invalidate(offline());
      this.#proc.kill();
    });
    this.#proc.once("error", error => invalidate(offline(
      "code" in error && error.code === "ENOENT" ? "找不到 omo 命令。请安装 OmO Native 或设置 OMO_WEB_BIN。" : "OmO 进程无法启动。",
    )));
    this.#exit = new Promise(resolve => this.#proc.once("close", () => { invalidate(offline()); resolve(); }));
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
      this.#proc.stdin.write(JSON.stringify({ ...fields, id, type }) + "\n");
    });
  }

  async stop(): Promise<void> {
    this.#proc.stdin.end();
    const kill = setTimeout(() => this.#proc.kill("SIGKILL"), 5000);
    try { await this.#exit; } finally { clearTimeout(kill); }
  }
}

export class Engine {
  #peer: Peer | undefined;
  #boot: Promise<Peer> | undefined;
  #stopped = false;
  status: EngineStatus = { online: false };
  capabilities: ReadonlySet<unknown> = new Set();

  constructor(readonly command: readonly [string, ...string[]], readonly cwd: string,
    readonly onEvent: (event: WireObject) => void, readonly onStatus: (status: EngineStatus) => void) {}

  request(type: string, fields?: WireObject, timeout?: number): Promise<WireObject> {
    return this.#connect().then(peer => peer.request(type, fields, timeout));
  }

  requestExisting(type: string, fields?: WireObject, timeout?: number): Promise<WireObject> {
    if (!this.#peer || !this.status.online) return Promise.reject(offline());
    return this.#peer.request(type, fields, timeout);
  }

  async probe(): Promise<void> {
    await this.#connect();
  }

  async #connect(): Promise<Peer> {
    if (this.#stopped) throw offline();
    if (this.#boot) return this.#boot;
    if (this.#peer && this.status.online) return this.#peer;
    const peer = new Peer(this.command, this.cwd, this.onEvent, error => {
      if (this.#peer !== peer) return;
      this.#peer = undefined;
      this.capabilities = new Set();
      this.status = { online: false, error: error.message };
      this.onStatus(this.status);
    });
    this.#peer = peer;
    this.#boot = (async () => {
      try {
        const info = await peer.request("get_protocol_info", {}, 12_000);
        if (info.mode !== "multi" || info.protocolVersion !== 1) {
          throw new WebError(503, "incompatible_engine", "需要支持多会话 RPC v1 的 OmO Native。");
        }
        await peer.request("set_client_info", { width: 96, capabilities: ["interactive_user", "question"] });
        this.capabilities = new Set(array(info.capabilities));
        this.status = { online: true, version: typeof info.serverVersion === "string" ? info.serverVersion : undefined };
        this.onStatus(this.status);
        return peer;
      } catch (error) {
        if (!(error instanceof WebError)) throw error;
        await peer.stop();
        this.status = { online: false, error: error.message };
        this.onStatus(this.status);
        throw error;
      } finally {
        this.#boot = undefined;
      }
    })();
    return this.#boot;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#peer?.stop();
  }
}
