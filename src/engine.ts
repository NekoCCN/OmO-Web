import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { BoundedMessagesFrame, MESSAGE_PREFIX_LIMIT, MessagesFrameError, isMessagesResponsePrefix } from "./bounded-messages.ts";
import type { HistoryRowSink } from "./bounded-messages.ts";
import { SocketPeer } from "./engine-socket.ts";
import type { EngineSocketTransport } from "./engine-socket.ts";
import { WebError, array, record } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const MAX_FRAME = 48 * 1024 * 1024;
const MAX_PENDING = 128;
const ENVELOPE_PROBE = 256;
// Native writes id/type first; older peers may write type/id. No search inside payloads.
const RESPONSE_ENVELOPE = /^[ \t\r]*\{[ \t\r]*(?:"id"[ \t\r]*:[ \t\r]*"(web-[1-9][0-9]{0,15})"[ \t\r]*,[ \t\r]*"type"[ \t\r]*:[ \t\r]*"response"|"type"[ \t\r]*:[ \t\r]*"response"[ \t\r]*,[ \t\r]*"id"[ \t\r]*:[ \t\r]*"(web-[1-9][0-9]{0,15})")[ \t\r]*,[ \t\r]*"(?:command|success|data|error|errorCode|sessionId)"[ \t\r]*:/;

type Pending = {
  readonly type: string;
  readonly route?: string;
  readonly onHistoryRow?: HistoryRowSink;
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
  #parts: string[] = [];
  #length = 0;
  readonly #prefix = Buffer.alloc(MESSAGE_PREFIX_LIMIT);
  #prefixLength = 0;
  #ordinary: StringDecoder | undefined;
  #transcript: BoundedMessagesFrame | undefined;
  #framing: "read" | "discard" | "fatal" = "read";
  #failure: WebError | undefined;
  readonly #exit: Promise<void>;

  constructor(command: readonly [string, ...string[]], cwd: string,
    onEvent: (frame: WireObject) => void, onExit: (error: WebError) => void, env?: NodeJS.ProcessEnv) {
    const [program, ...args] = command;
    this.#proc = spawn(program, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    // The engine can print local paths and provider diagnostics to stderr. Drain it without forwarding it to the browser.
    this.#proc.stderr.resume();
    this.#proc.stdout.on("data", (chunk: Buffer) => {
      for (let start = 0; start < chunk.length;) {
        if (this.#framing === "fatal") return;
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        start = end + 1;
        if (this.#framing === "read") {
          const frame = this.#readPart(part, newline !== -1);
          if (frame?.type === "response") this.#receive(frame);
          else if (typeof frame?.type === "string") onEvent(frame);
        }
        // Reset at the physical delimiter even if a local guard already rejected the frame.
        if (newline !== -1) this.#resetFrame();
      }
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

  #resetFrame(): void {
    if (this.#framing === "fatal") return;
    this.#prefixLength = 0;
    this.#parts = [];
    this.#length = 0;
    this.#ordinary = undefined;
    this.#transcript = undefined;
    this.#framing = "read";
  }

  #readPart(part: Buffer, complete: boolean): WireObject | undefined {
    let prefix: Buffer | undefined;
    if (!this.#ordinary && !this.#transcript) {
      const take = Math.min(part.length, MESSAGE_PREFIX_LIMIT - this.#prefixLength);
      part.copy(this.#prefix, this.#prefixLength, 0, take);
      this.#prefixLength += take;
      prefix = this.#prefix.subarray(0, this.#prefixLength);
      const probe = prefix.toString("utf8");
      for (const [id, request] of this.#pending) {
        if (request.type === "get_messages" && isMessagesResponsePrefix(probe, id)) {
          // Recheck pending at emission: the request can expire between stdout chunks.
          this.#transcript = new BoundedMessagesFrame(id, "web", request.onHistoryRow
            ? row => this.#pending.get(id)?.onHistoryRow?.(row) : undefined);
          break;
        }
      }
      if (!this.#transcript && !complete && this.#prefixLength < MESSAGE_PREFIX_LIMIT) return;
      part = part.subarray(take);
    }
    const transcript = this.#transcript;
    if (transcript) {
      try {
        if (prefix) transcript.write(prefix);
        transcript.write(part);
        if (complete) return transcript.finish();
      } catch (error) {
        if (!(error instanceof WebError)) throw error;
        this.#takePending(transcript.requestId)?.reject(error);
        this.#transcript = undefined;
        this.#framing = "discard";
      }
      return;
    }
    // Other frames retain the previous UTF-16 units cap and UTF-8 replacement semantics.
    const decoder = this.#ordinary ??= new StringDecoder("utf8");
    const text = (prefix ? decoder.write(prefix) : "") + (complete ? decoder.end(part) : decoder.write(part));
    if (this.#length + text.length > MAX_FRAME) {
      if (this.#rejectOversized(text.slice(0, ENVELOPE_PROBE))) this.#framing = "discard";
      else this.#failFraming();
      return;
    }
    if (text) this.#parts.push(text);
    this.#length += text.length;
    if (!complete) return;
    const line = this.#parts.join("");
    if (!line.trimStart().startsWith("{")) return;
    let frame: WireObject;
    try { frame = record(JSON.parse(line)); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.#failFraming();
      return;
    }
    // Unusual field order still uses the old frame limit. Don't accept a last-key-wins
    // get_messages receipt without validating that its original identity was unambiguous.
    if (frame.type === "response" && typeof frame.id === "string" &&
        this.#pending.get(frame.id)?.type === "get_messages") {
      const validator = new BoundedMessagesFrame(frame.id, "web");
      try {
        validator.write(line);
        return validator.finish();
      } catch (error) {
        if (!(error instanceof MessagesFrameError)) throw error;
        this.#takePending(frame.id)?.reject(new MessagesFrameError("malformed"));
        return;
      }
    }
    return frame;
  }

  #failFraming(): void {
    this.#framing = "fatal";
    this.#proc.kill();
  }

  #takePending(id: string): Pending | undefined {
    const waiting = this.#pending.get(id);
    if (!waiting) return;
    this.#pending.delete(id);
    clearTimeout(waiting.timer);
    return waiting;
  }

  #receive(frame: WireObject): void {
    if (typeof frame.id !== "string") return;
    const waiting = this.#takePending(frame.id);
    if (!waiting) return;
    const data = record(frame.data);
    if (waiting.type === "get_messages" && (frame.command !== waiting.type || typeof frame.success !== "boolean" ||
        (frame.success && !Array.isArray(data.messages)) ||
        (typeof frame.sessionId === "string" && waiting.route !== undefined && frame.sessionId !== waiting.route))) {
      waiting.reject(new MessagesFrameError("malformed"));
    } else if (frame.success === true) waiting.resolve(data);
    else {
      const code = typeof frame.errorCode === "string" ? frame.errorCode : "engine_refused";
      waiting.reject(new WebError(409, code, typeof frame.error === "string" ? frame.error : "OmO 未接受该操作。"));
    }
  }

  #rejectOversized(tail: string): boolean {
    let prefix = "";
    for (const part of this.#parts) {
      prefix += part.slice(0, ENVELOPE_PROBE - prefix.length);
      if (prefix.length === ENVELOPE_PROBE) break;
    }
    prefix += tail.slice(0, ENVELOPE_PROBE - prefix.length);
    this.#parts = [];
    this.#length = 0;
    const envelope = RESPONSE_ENVELOPE.exec(prefix);
    const id = envelope?.[1] ?? envelope?.[2];
    // IDs are contiguous and never reused on this peer, even after a timeout.
    const issued = id === undefined ? NaN : Number(id.slice(4));
    if (id === undefined || !Number.isSafeInteger(issued) || issued > this.#counter) return false;
    this.#takePending(id)?.reject(new WebError(502, "engine_frame_too_large", "本次 OmO 操作的响应超过大小限制，无法读取结果。请勿直接重复提交。"));
    return true;
  }

  request(type: string, fields: WireObject = {}, timeout = 30_000, onHistoryRow?: HistoryRowSink): Promise<WireObject> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(new WebError(429, "bridge_busy", "操作过多，请稍后重试。"));
    const id = `web-${++this.#counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WebError(504, "engine_timeout", "OmO 未及时确认操作。请刷新确认状态后再试，不要直接重复提交。"));
      }, timeout);
      this.#pending.set(id, {
        type, route: typeof fields.sessionId === "string" ? fields.sessionId : undefined, resolve, reject, timer,
        onHistoryRow: type === "get_messages" ? onHistoryRow : undefined,
      });
      this.#proc.stdin.write(JSON.stringify({ ...fields, id, type }) + "\n");
    });
  }

  async stop(): Promise<void> {
    this.#proc.stdin.end();
    const kill = setTimeout(() => this.#proc.kill("SIGKILL"), 5000);
    try { await this.#exit; } finally { clearTimeout(kill); }
  }
}

type Connection = {
  request(type: string, fields?: WireObject, timeout?: number, onHistoryRow?: HistoryRowSink): Promise<WireObject>;
  stop(): Promise<void>;
};

export class Engine {
  #peer: Connection | undefined;
  #boot: Promise<Connection> | undefined;
  #stopped = false;
  status: EngineStatus = { online: false };
  capabilities: ReadonlySet<unknown> = new Set();

  constructor(readonly command: readonly [string, ...string[]], readonly cwd: string,
    readonly onEvent: (event: WireObject) => void, readonly onStatus: (status: EngineStatus) => void,
    readonly transport?: EngineSocketTransport,
    readonly scope: { readonly privateHost?: boolean; readonly env?: NodeJS.ProcessEnv } = {}) {}

  /** Web-owned private non-listening stdio host. Socket hosts are never private:
   * a discoverable endpoint lets another stock TUI attach instead of refusing. */
  get isPrivateHost(): boolean {
    return this.scope.privateHost === true;
  }

  /** A listening host publishes an attach endpoint; scoped force release never applies there. */
  get usesListeningTransport(): boolean {
    return this.transport?.kind === "socket";
  }

  get usesPrivateSocketTransport(): boolean {
    return this.transport?.kind === "socket";
  }

  request(type: string, fields?: WireObject, timeout?: number): Promise<WireObject> {
    return this.#connect().then(peer => peer.request(type, fields, timeout));
  }

  /** Stage read-only rows provisionally; publish only after the receipt and live-binding checks succeed.
   * Compatibility transports may return a recent window without invoking the sink. */
  requestExisting(type: string, fields?: WireObject, timeout?: number, onHistoryRow?: HistoryRowSink): Promise<WireObject> {
    if (!this.#peer || !this.status.online) return Promise.reject(offline());
    return this.#peer.request(type, fields, timeout, onHistoryRow);
  }

  async probe(): Promise<void> {
    await this.#connect();
  }

  async #connect(): Promise<Connection> {
    if (this.#stopped) throw offline();
    if (this.#boot) return this.#boot;
    if (this.#peer && this.status.online) return this.#peer;
    const onExit = (error: WebError) => {
      if (this.#peer !== peer) return;
      this.#peer = undefined;
      this.capabilities = new Set();
      this.status = { online: false, error: error.message };
      this.onStatus(this.status);
    };
    const socket = this.transport?.kind === "socket" ? this.transport : undefined;
    let peer: Connection | undefined;
    const launchSocket = async (): Promise<Connection> => {
      if (!socket) return new Peer(this.command, this.cwd, this.onEvent, onExit, this.scope.env);
      try {
        return await SocketPeer.launch({
          command: [...this.command, "--listen", `unix://${socket.socketPath}`, "--session-runtime", "in-process"],
          cwd: this.cwd,
          socketPath: socket.socketPath,
          keyRoot: socket.keyRoot,
          env: { ...process.env, OMO_CODING_AGENT_DIR: socket.keyRoot, SENPI_CODING_AGENT_DIR: socket.keyRoot, PI_CODING_AGENT_DIR: socket.keyRoot, SENPI_RPC_REQUIRE_TOKEN: "1" },
        }, { onEvent: this.onEvent, onClose: onExit });
      } catch (error) {
        if (!(error instanceof WebError)) throw error;
        this.status = { online: false, error: error.message };
        this.onStatus(this.status);
        throw error;
      }
    };
    this.#boot = (async () => {
      try {
        peer = await launchSocket();
        this.#peer = peer;
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
        if (peer) await peer.stop();
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
    const boot = this.#boot;
    if (boot) await boot.then(() => undefined, () => undefined);
    await this.#peer?.stop();
  }
}
