import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { z } from "zod";
import { BoundedMessagesFrame, isMessagesResponsePrefix, MESSAGE_PREFIX_LIMIT, MessagesFrameError } from "./bounded-messages.ts";
import { WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

export const TERMINAL_COMMANDS = [
  "get_protocol_info", "list_sessions", "get_state", "get_messages", "get_entries", "set_client_info",
  "attach_session", "release_attachment", "prompt", "steer", "follow_up", "interrupt",
] as const;

export const TERMINAL_ENTRY_BYTES = 2_097_152;
const FRAME_BYTES = TERMINAL_ENTRY_BYTES + 65_536;
const REQUEST_MS = 1_500;
const TRANSCRIPT_MS = 4_000;
// The parser stops at 64 MiB. Permit only a small additional drain to regain alignment.
const TRANSCRIPT_WIRE_BYTES = 64 * 1024 * 1024 + FRAME_BYTES;
const decoder = new TextDecoder("utf-8", { fatal: true });
const nativeTranscriptCommand = /^[ \t\r]*\{[ \t\r]*"[^"\\]*"[ \t\r]*:[ \t\r]*"[^"\\]*"[ \t\r]*,[ \t\r]*"[^"\\]*"[ \t\r]*:[ \t\r]*"[^"\\]*"[ \t\r]*,[ \t\r]*"command"[ \t\r]*:[ \t\r]*"get_messages"[ \t\r]*[,}]/;

export type TerminalRequest =
  | { readonly type: "get_protocol_info" | "list_sessions" | "get_state" | "get_messages"; readonly observe: true }
  | { readonly type: "get_entries"; readonly observe: true; readonly tail: 1; readonly maxBytes: typeof TERMINAL_ENTRY_BYTES }
  | { readonly type: "set_client_info"; readonly width: number; readonly capabilities: readonly [] }
  | { readonly type: "attach_session"; readonly sessionId: string; readonly durableSessionId: string; readonly expectedHostInstance: string }
  | { readonly type: "release_attachment"; readonly sessionId: string }
  | { readonly type: "interrupt"; readonly turnId: string }
  | {
    readonly type: "prompt" | "steer" | "follow_up";
    readonly message: string;
    readonly clientMessageId: string;
    readonly expected_turn_id: number;
    readonly whenIdle?: "queue";
  };

const frameSchema = z.looseObject({ type: z.string().max(100) });
const responseSchema = z.object({
  id: z.string(), command: z.string(), success: z.boolean(), data: z.unknown().optional(),
  errorCode: z.string().optional(),
});

export const terminalOffline = () => new WebError(409, "terminal_offline", "CLI 连接已断开，请重新连接。");
export const terminalProtocol = () => new WebError(502, "terminal_protocol", "CLI 返回了不兼容的终端会话响应。");
const timeoutError = () => new WebError(504, "terminal_timeout", "CLI 未在限定时间内响应。");
const readLimit = () => new WebError(502, "terminal_read_limit", "CLI 响应超过读取上限，连接已断开。");

export class TerminalTranscriptUnavailable extends WebError {
  constructor() {
    super(502, "terminal_transcript_unavailable", "CLI 历史响应超过读取上限。");
  }
}

// Only structured, recognized refusal codes leave this boundary, never native
// reason/action/error fields (which can contain prompt text or paths).
export class TerminalRefusal extends WebError {
  constructor(code: string | undefined) {
    const safe = safeRefusal(code);
    super(safe.status, safe.code, safe.message);
  }
}

function safeRefusal(code: string | undefined) {
  switch (code) {
    case "session_busy": return { status: 409, code, message: "CLI 正在运行，请等待，或选择明确的跟进方式。" };
    case "held_draft": return { status: 409, code, message: "CLI 刚提交了一条输入，尚未接收这条消息。" };
    case "turn_conflict": return { status: 409, code, message: "CLI 回合已变化，请刷新后再操作。" };
    case "client_message_id_conflict": return { status: 409, code, message: "此消息编号已经用于另一条输入。" };
    case "session_not_attached": return { status: 409, code: "terminal_not_attached", message: "请先连接 CLI 会话。" };
    case "unknown_session":
    case "session_identity_mismatch": return { status: 404, code: "terminal_not_found", message: "CLI 会话已变化，请刷新列表。" };
    case "response_too_large": return { status: 502, code: "terminal_read_limit", message: "CLI 响应超过读取上限。" };
    default: return { status: 409, code: "terminal_refused", message: "CLI 未接受该操作。" };
  }
}

type Pending = {
  readonly id: string;
  readonly command: TerminalRequest["type"];
  readonly started: number;
  timer: ReturnType<typeof setTimeout>;
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: WebError) => void;
};
type TranscriptFrame = {
  readonly pending: Pending;
  parser?: BoundedMessagesFrame;
  header: string;
  bytes: number;
};

/** A private one-request-at-a-time TUI wire. Its caller owns authentication and identity checks. */
export class TerminalPeer {
  readonly #socket: Socket;
  readonly #open = Promise.withResolvers<void>();
  readonly #connectDeadline: ReturnType<typeof setTimeout>;
  #pending: Pending | undefined;
  #closed = false;
  #nextId = 0;
  #partial = Buffer.alloc(0);
  #used = 0;
  #transcript?: TranscriptFrame;

  constructor(path: string, readonly onEvent: (event: WireObject) => void, readonly onClose: () => void) {
    this.#socket = createConnection({ path });
    this.#connectDeadline = setTimeout(() => this.close(timeoutError()), REQUEST_MS);
    this.#socket.once("connect", () => {
      clearTimeout(this.#connectDeadline);
      this.#open.resolve();
    });
    this.#socket.once("error", () => this.close());
    this.#socket.once("close", () => this.close());
    this.#socket.on("data", chunk => this.#receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  }

  get closed(): boolean { return this.#closed; }
  connected(): Promise<void> { return this.#open.promise; }

  authenticate(secret: Buffer): void {
    if (this.#closed) throw terminalOffline();
    this.#socket.write(secret);
  }

  request(request: TerminalRequest): Promise<unknown> {
    if (this.#closed) return Promise.reject(terminalOffline());
    if (this.#pending) return Promise.reject(terminalProtocol());
    const id = `web-${++this.#nextId}`;
    const result = Promise.withResolvers<unknown>();
    const timeout = request.type === "interrupt" ? 8_000 : REQUEST_MS;
    const started = performance.now();
    const timer = setTimeout(() => this.close(timeoutError()), timeout);
    this.#pending = { id, command: request.type, started, timer, resolve: result.resolve, reject: result.reject };
    this.#socket.write(`${JSON.stringify({ ...request, id })}\n`);
    return result.promise;
  }

  close(error = terminalOffline()): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#connectDeadline);
    this.#open.reject(error);
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = undefined;
    }
    this.#partial = Buffer.alloc(0);
    this.#used = 0;
    this.#transcript = undefined;
    this.#socket.destroy();
    this.onClose();
  }

  #receive(chunk: Buffer): void {
    for (let start = 0; start < chunk.length && !this.#closed;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      start = end + 1;
      if (this.#transcript || this.#startTranscript(part)) {
        this.#readTranscript(part, newline !== -1);
        continue;
      }
      const total = this.#used + part.length;
      if (total > FRAME_BYTES) return this.close(readLimit());
      if (newline !== -1 && this.#used === 0) this.#frame(part);
      else {
        if (total > this.#partial.length) {
          const grown = Buffer.alloc(Math.min(FRAME_BYTES, Math.max(1024, total, this.#partial.length * 2)));
          this.#partial.copy(grown, 0, 0, this.#used);
          this.#partial = grown;
        }
        part.copy(this.#partial, this.#used);
        this.#used = total;
        if (newline !== -1) {
          const frame = this.#partial.subarray(0, this.#used);
          this.#partial = Buffer.alloc(0);
          this.#used = 0;
          this.#frame(frame);
        }
      }
    }
  }

  #startTranscript(part: Buffer): boolean {
    const pending = this.#pending;
    if (pending?.command !== "get_messages" || this.#used >= MESSAGE_PREFIX_LIMIT) return false;
    const before = this.#partial.subarray(0, this.#used);
    const next = part.subarray(0, MESSAGE_PREFIX_LIMIT - this.#used);
    const prefix = before.toString("utf8") + next.toString("utf8");
    if (!isMessagesResponsePrefix(prefix, pending.id)) return false;
    const elapsed = performance.now() - pending.started;
    if (elapsed >= REQUEST_MS) {
      this.close(timeoutError());
      return true;
    }
    clearTimeout(pending.timer);
    // A matched prefix gets a fixed total budget, including any drain, not a refreshed idle timer.
    pending.timer = setTimeout(() => this.close(timeoutError()), TRANSCRIPT_MS - elapsed);
    this.#transcript = { pending, parser: new BoundedMessagesFrame(pending.id, "terminal"), header: "", bytes: 0 };
    this.#partial = Buffer.alloc(0);
    this.#used = 0;
    this.#readTranscript(before, false);
    return true;
  }

  #readTranscript(part: Buffer, ended: boolean): void {
    const frame = this.#transcript;
    if (!frame || this.#closed) return;
    if (performance.now() - frame.pending.started >= TRANSCRIPT_MS) return this.close(timeoutError());
    frame.bytes += part.length;
    if (frame.bytes > TRANSCRIPT_WIRE_BYTES) return this.close(readLimit());
    if (frame.header.length < MESSAGE_PREFIX_LIMIT) {
      frame.header += part.toString("latin1", 0, Math.min(part.length, MESSAGE_PREFIX_LIMIT - frame.header.length));
    }
    try {
      frame.parser?.write(part);
      if (ended && frame.parser) {
        const response = frame.parser.finish();
        if (performance.now() - frame.pending.started >= TRANSCRIPT_MS) return this.close(timeoutError());
        this.#transcript = undefined;
        return this.#dispatch(response);
      }
    } catch (error) {
      if (!(error instanceof MessagesFrameError)) throw error;
      if (error.reason === "malformed") return this.close(terminalProtocol());
      // A partial envelope can lose its parser only if the Native header already names this RPC.
      if (!nativeTranscriptCommand.test(frame.header)) return this.close(terminalProtocol());
      frame.parser = undefined;
    }
    if (ended) {
      if (performance.now() - frame.pending.started >= TRANSCRIPT_MS) return this.close(timeoutError());
      this.#transcript = undefined;
      this.#pending = undefined;
      clearTimeout(frame.pending.timer);
      frame.pending.reject(new TerminalTranscriptUnavailable());
    }
  }

  #frame(bytes: Buffer): void {
    const frame = frameSchema.safeParse(parseFrame(bytes));
    if (!frame.success) return this.close(terminalProtocol());
    this.#dispatch(frame.data);
  }

  #dispatch(frame: WireObject): void {
    if (frame.type !== "response") return this.onEvent(frame);
    const response = responseSchema.safeParse(frame);
    const pending = this.#pending;
    if (!response.success || !pending || response.data.id !== pending.id ||
        response.data.command !== pending.command) return this.close(terminalProtocol());
    this.#pending = undefined;
    clearTimeout(pending.timer);
    if (response.data.success) pending.resolve(response.data.data);
    else pending.reject(new TerminalRefusal(response.data.errorCode));
  }
}

function parseFrame(bytes: Buffer): unknown {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
}
