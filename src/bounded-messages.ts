// allow: SIZE_OK — the single-frame lexer, path validator and row fence share a streaming cursor.
import { WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { projectMessages } from "./terminal-view.ts";

export const MESSAGE_PREFIX_LIMIT = 256;
const head = /^[ \t\r\n]*\{[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*,[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*,/;

export function isMessagesResponsePrefix(prefix: string, requestId: string): boolean {
  const bounded = Buffer.from(prefix.slice(0, MESSAGE_PREFIX_LIMIT), "utf16le").toString("utf16le");
  const match = head.exec(bounded);
  if (!match) return false;
  const [key, value, otherKey, otherValue]: unknown[] = match.slice(1).map(part => JSON.parse(part));
  return (key === "id" && value === requestId && otherKey === "type" && otherValue === "response") ||
    (key === "type" && value === "response" && otherKey === "id" && otherValue === requestId);
}

export class MessagesFrameError extends WebError {
  constructor(readonly reason: "malformed" | "bytes" | "depth" | "work") {
    super(502, reason === "malformed" ? "messages_frame_malformed" : "messages_read_limit",
      reason === "malformed" ? "OmO 返回了无效的历史响应。" : "OmO 历史响应超过读取上限。");
  }
}

const KiB = 1024;
const MiB = 1024 * KiB;
const INPUT_BYTES = 64 * MiB;
const SCAN_SIZE = 16 * KiB;
const MAX_DEPTH = 64;
const MAX_TOKENS = 1_000_000;
const LIMITS = {
  web: { rows: 240, bytes: 5 * MiB, tokens: 65_536, rowBytes: 2 * MiB, rowTokens: 16_384, text: Infinity },
  terminal: { rows: 100, bytes: 768 * KiB, tokens: 16_384, rowBytes: 256 * KiB, rowTokens: 4_096, text: 128_000 },
} as const;
const ROOT_FIELDS = new Set(["id", "type", "command", "success", "data", "sessionId", "errorCode", "error"]);
const IDENTITY_FIELDS = new Set(["role", "display", "customType"]);
const WEB_FIELDS = ["role", "display", "content", "timestamp", "toolName", "toolCallId", "isError", "stopReason",
  "errorMessage", "usage", "provider", "model", "customType"] as const;
const BASH_FIELDS = ["command", "output", "exitCode", "cancelled", "truncated"] as const;
const TTY_FIELDS = ["role", "content", "timestamp", "display", "customType", "details"] as const;

type Surface = keyof typeof LIMITS;
type Location = "root" | "data" | "messages" | "row" | "other";
type State = "first-key" | "key" | "colon" | "first-value" | "value" | "next";
type Container = { readonly location: Location; readonly close: "}" | "]"; state: State; key?: string };
type NumberState = "sign" | "zero" | "int" | "dot" | "fraction" | "exponent" | "exp-sign" | "exp-digits";
type Lexeme =
  | { readonly kind: "string"; raw: string | undefined; escape: number }
  | { readonly kind: "word"; rest: string; readonly value: boolean | null }
  | { readonly kind: "number"; state: NumberState };
type Token = "{" | "[" | "}" | "]" | ":" | "," | "scalar" | "string";
type Row = {
  readonly identity: WireObject;
  start: number;
  units: number;
  tokens: number;
  dropped: boolean;
};
type Kept = { readonly raw: WireObject; readonly bytes: number; readonly tokens: number; readonly text: number };
export type HistoryRowSink = (row: WireObject) => void;

function malformed(): never { throw new MessagesFrameError("malformed"); }

function isObject(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visibleRole(row: WireObject, surface: Surface): boolean {
  if (row.role === "user" || row.role === "assistant") return true;
  if (row.role === "custom") {
    return row.display === true && (surface === "web" || row.customType === "session_control_delivery");
  }
  return surface === "web" && (row.role === "toolResult" || row.role === "bashExecution");
}

function allowedRow(row: WireObject, surface: Surface): WireObject {
  const keys = surface === "terminal" ? TTY_FIELDS : row.role === "bashExecution" ? [...WEB_FIELDS, ...BASH_FIELDS] : WEB_FIELDS;
  const raw: WireObject = {};
  for (const key of keys) if (Object.hasOwn(row, key)) raw[key] = row[key];
  if (surface === "terminal") {
    if (row.role !== "custom") delete raw.details;
    if (Array.isArray(raw.content)) raw.content = raw.content.flatMap((block: unknown) =>
      isObject(block) && block.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : []);
  }
  return raw;
}

/** Exactly one NDJSON frame, without its delimiter. The transport still owns request selection and draining. */
export class BoundedMessagesFrame {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  readonly #limits;
  readonly #onHistoryRow?: HistoryRowSink;
  readonly #stack: Container[] = [];
  readonly #envelope: WireObject = {};
  readonly #seen = new Set<string>();
  readonly #kept: Kept[] = [];
  readonly #space = /[ \t\r\n]+/y;
  readonly #stringRun = /[^"\\\x00-\x1f]+/y;
  readonly #digits = /[0-9]+/y;
  #inputBytes = 0;
  #tokens = 0;
  #keptBytes = 0;
  #keptTokens = 0;
  #keptText = 0;
  #text = "";
  #pos = 0;
  #surrogate = "";
  #binary = false;
  #lexeme: Lexeme | undefined;
  #scratch = Buffer.alloc(0);
  #row: Row | undefined;
  #hasArray = false;
  #seenMessages = false;
  #complete = false;
  #finished = false;
  #truncated = false;
  #omitted = false;
  #failed: WebError | undefined;

  /** A sink stages rows only. A later token or the transport's route check can still reject the frame. */
  constructor(readonly requestId: string, readonly surface: Surface, onHistoryRow?: HistoryRowSink) {
    this.#limits = LIMITS[surface];
    this.#onHistoryRow = onHistoryRow;
  }

  write(chunk: string | Uint8Array): void {
    if (this.#failed) throw this.#failed;
    if (this.#finished) malformed();
    if (!chunk.length) return;
    try {
      if (typeof chunk === "string") {
        if (this.#binary) this.#scan(this.#decode());
        this.#binary = false;
        for (let i = 0; i < chunk.length; i += SCAN_SIZE) {
          const part = this.#surrogate + chunk.slice(i, i + SCAN_SIZE);
          const last = part.charCodeAt(part.length - 1);
          const split = last >= 0xd800 && last <= 0xdbff;
          this.#surrogate = split ? String.fromCharCode(last) : "";
          this.#ingestText(split ? part.slice(0, -1) : part);
        }
      } else {
        this.#flushTextTail();
        this.#countBytes(chunk.byteLength);
        this.#binary = true;
        for (let i = 0; i < chunk.length; i += SCAN_SIZE) this.#scan(this.#decode(chunk.subarray(i, i + SCAN_SIZE)));
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  finish(): WireObject {
    if (this.#failed) throw this.#failed;
    if (this.#finished) malformed();
    try {
      if (this.#binary) this.#scan(this.#decode());
      this.#flushTextTail();
      const { type, id, command, success, sessionId, errorCode } = this.#envelope;
      if (!this.#complete || this.#lexeme || type !== "response" || id !== this.requestId ||
          command !== "get_messages" || typeof success !== "boolean" || (success && !this.#hasArray)) malformed();
      this.#finished = true;
      this.#scratch = Buffer.alloc(0);
      const response = { type, id, command, success, ...(typeof sessionId === "string" ? { sessionId } : {}) };
      const messages = success ? this.#kept.map(entry => entry.raw) : undefined;
      this.#kept.length = 0;
      if (messages) return { ...response, data: {
        messages, historyTruncated: this.#truncated || this.#omitted,
        ...(this.#onHistoryRow && this.#omitted ? { historyOmitted: true } : {}),
      } };
      // Native diagnostics can embed private contents. Preserve only a bounded machine code.
      return typeof errorCode === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(errorCode)
        ? { ...response, errorCode } : response;
    } catch (error) {
      return this.#fail(error);
    }
  }

  #fail(error: unknown): never {
    if (!(error instanceof WebError)) throw error;
    this.#failed = error;
    this.#row = undefined;
    this.#scratch = Buffer.alloc(0);
    this.#kept.length = 0;
    this.#lexeme = undefined;
    this.#stack.length = 0;
    this.#text = "";
    throw error;
  }

  #decode(bytes?: Uint8Array): string {
    try { return this.#decoder.decode(bytes, { stream: bytes !== undefined }); }
    catch (error) {
      if (error instanceof TypeError) return malformed();
      throw error;
    }
  }

  #countBytes(bytes: number): void {
    this.#inputBytes += bytes;
    if (this.#inputBytes > INPUT_BYTES) throw new MessagesFrameError("bytes");
  }

  #ingestText(text: string): void {
    if (text.length === 0) return;
    this.#countBytes(Buffer.byteLength(text));
    // Avoid giving a regex a short view backed by the caller's full frame.
    this.#scan(Buffer.from(text, "utf16le").toString("utf16le"));
  }

  #flushTextTail(): void {
    this.#ingestText(this.#surrogate);
    this.#surrogate = "";
  }

  #run(pattern: RegExp): boolean {
    pattern.lastIndex = this.#pos;
    if (!pattern.test(this.#text)) return false;
    this.#pos = pattern.lastIndex;
    return true;
  }

  #scan(text: string): void {
    this.#text = text;
    this.#pos = 0;
    while (this.#pos < text.length) {
      const lexeme = this.#lexeme;
      if (lexeme) {
        switch (lexeme.kind) {
          case "string": this.#string(lexeme); break;
          case "number": this.#number(lexeme); break;
          case "word":
            if (text[this.#pos++] !== lexeme.rest[0]) malformed();
            lexeme.rest = lexeme.rest.slice(1);
            if (lexeme.rest === "") {
              this.#lexeme = undefined;
              this.#token("scalar", this.#pos, lexeme.value);
            }
            break;
        }
        continue;
      }
      if (this.#run(this.#space)) continue;
      if (this.#complete) malformed();
      const start = this.#pos++;
      const char = text[start];
      switch (char) {
        case "{": case "[": case "}": case "]": case ":": case ",":
          this.#token(char, start); break;
        case '"': this.#lexeme = { kind: "string", raw: this.#needsString() ? "" : undefined, escape: 0 }; break;
        case "t": this.#lexeme = { kind: "word", rest: "rue", value: true }; break;
        case "f": this.#lexeme = { kind: "word", rest: "alse", value: false }; break;
        case "n": this.#lexeme = { kind: "word", rest: "ull", value: null }; break;
        case "-": this.#lexeme = { kind: "number", state: "sign" }; break;
        case "0": this.#lexeme = { kind: "number", state: "zero" }; break;
        default:
          if (char === undefined || char < "1" || char > "9") malformed();
          this.#lexeme = { kind: "number", state: "int" };
      }
    }
    this.#capture(text.length);
    if (this.#row) this.#row.start = 0;
    this.#text = "";
    // Regex engines can retain the most recent input in their legacy static matches; only slabs reach them.
  }

  #needsString(): boolean {
    const top = this.#stack.at(-1);
    return top !== undefined && top.location !== "other" && top.location !== "messages" &&
      (top.state === "key" || top.state === "first-key" ||
        (top.state === "value" && top.key !== undefined &&
          (top.location === "row" ? IDENTITY_FIELDS.has(top.key) :
            top.location === "root" && ROOT_FIELDS.has(top.key) && top.key !== "error" && top.key !== "data")));
  }

  #string(token: Extract<Lexeme, { kind: "string" }>): void {
    const start = this.#pos;
    while (this.#pos < this.#text.length) {
      if (token.escape === 0 && this.#run(this.#stringRun)) continue;
      const char = this.#text.charAt(this.#pos++);
      if (token.escape > 0) {
        if (!/[0-9a-fA-F]/.test(char)) malformed();
        token.escape--;
      } else if (token.escape === -1) {
        if (char === "u") token.escape = 4;
        else if ('"\\/bfnrt'.includes(char)) token.escape = 0;
        else malformed();
      } else if (char === '"') {
        this.#rememberString(token, start, this.#pos - 1);
        const value: unknown = token.raw === undefined ? undefined : JSON.parse(`"${token.raw}"`);
        this.#lexeme = undefined;
        this.#token("string", this.#pos, value);
        return;
      } else if (char === "\\") token.escape = -1;
      else malformed(); // A literal control character, rejected by the string run.
    }
    this.#rememberString(token, start, this.#pos);
  }

  #rememberString(token: Extract<Lexeme, { kind: "string" }>, start: number, end: number): void {
    if (token.raw === undefined || start === end) return;
    // Force an owned copy: a short key may be a view into a caller's much larger string.
    token.raw = token.raw.length + end - start > 1024 ? undefined :
      token.raw + Buffer.from(this.#text.slice(start, end), "utf16le").toString("utf16le");
  }

  #number(token: Extract<Lexeme, { kind: "number" }>): void {
    while (this.#pos < this.#text.length) {
      const char = this.#text.charAt(this.#pos);
      switch (token.state) {
        case "sign":
          if (char < "0" || char > "9") malformed();
          token.state = char === "0" ? "zero" : "int";
          break;
        case "zero": case "int": case "fraction": case "exp-digits":
          if (token.state !== "zero" && this.#run(this.#digits)) continue;
          if (char === "." && (token.state === "zero" || token.state === "int")) token.state = "dot";
          else if ((char === "e" || char === "E") && token.state !== "exp-digits") token.state = "exponent";
          else {
            this.#lexeme = undefined;
            this.#token("scalar", this.#pos);
            return;
          }
          break;
        case "dot":
          if (char < "0" || char > "9") malformed();
          token.state = "fraction";
          break;
        case "exponent":
          if (char === "+" || char === "-") token.state = "exp-sign";
          else if (char >= "0" && char <= "9") token.state = "exp-digits";
          else malformed();
          break;
        case "exp-sign":
          if (char < "0" || char > "9") malformed();
          token.state = "exp-digits";
          break;
      }
      this.#pos++;
    }
  }

  #token(token: Token, start: number, value?: unknown): void {
    if (++this.#tokens > MAX_TOKENS) throw new MessagesFrameError("work");
    if (this.#row && ++this.#row.tokens > this.#limits.rowTokens) this.#row.dropped = true;
    const parent = this.#stack.at(-1);
    if (!parent) {
      if (token !== "{" || this.#complete) return malformed();
      this.#open("{", "root");
      return;
    }
    if (token === parent.close && (parent.state === "next" || parent.state === "first-key" || parent.state === "first-value")) {
      this.#stack.pop();
      if (parent.location === "row") this.#endRow();
      if (parent.location === "root") this.#complete = true;
      return;
    }
    switch (parent.state) {
      case "first-key": case "key":
        if (token !== "string") return malformed();
        parent.key = typeof value === "string" ? value : undefined;
        this.#key(parent);
        parent.state = "colon";
        return;
      case "colon":
        if (token !== ":") return malformed();
        parent.state = "value";
        return;
      case "next":
        if (token !== ",") return malformed();
        parent.state = parent.close === "}" ? "key" : "value";
        return;
      case "first-value": case "value":
        if (token !== "string" && token !== "scalar" && token !== "{" && token !== "[") return malformed();
        parent.state = "next";
        this.#value(parent, token, start, value);
        return;
    }
  }

  #key(parent: Container): void {
    const key = parent.key;
    if (key === undefined) return;
    if (parent.location === "root" && ROOT_FIELDS.has(key)) {
      if (this.#seen.has(key)) malformed();
      this.#seen.add(key);
    }
    if (parent.location === "data" && key === "messages") {
      if (this.#seenMessages) malformed();
      this.#seenMessages = true;
    }
  }

  #value(parent: Container, token: Token, start: number, value: unknown): void {
    const key = parent.key;
    let location: Location = "other";
    if (parent.location === "root") {
      if (key === "data" && token === "{") location = "data";
      else if (key !== undefined && ROOT_FIELDS.has(key) && key !== "error") this.#envelope[key] = value;
    } else if (parent.location === "data" && key === "messages" && token === "[") {
      this.#hasArray = true;
      if (this.#envelope.success !== false) location = "messages";
    } else if (parent.location === "messages" && token === "{") {
      location = "row";
      this.#row = { identity: {}, dropped: false, tokens: 1, units: 0, start };
    } else if (parent.location === "row" && key !== undefined && IDENTITY_FIELDS.has(key) && this.#row) {
      this.#row.identity[key] = value;
    }
    if (token === "{" || token === "[") this.#open(token, location);
  }

  #open(token: "{" | "[", location: Location): void {
    if (this.#stack.length >= MAX_DEPTH) throw new MessagesFrameError("depth");
    this.#stack.push(token === "{" ? { location, close: "}", state: "first-key" } : { location, close: "]", state: "first-value" });
  }

  #capture(end: number): void {
    const row = this.#row;
    if (!row || row.dropped || row.start === end) return;
    const total = row.units + end - row.start;
    if (total > this.#limits.rowBytes) {
      row.dropped = true;
      return;
    }
    if (total * 2 > this.#scratch.length) {
      const buffer = Buffer.alloc(Math.min(this.#limits.rowBytes * 2, Math.max(total * 2, this.#scratch.length * 2, 1024)));
      this.#scratch.copy(buffer, 0, 0, row.units * 2);
      this.#scratch = buffer;
    }
    this.#scratch.write(this.#text.slice(row.start, end), row.units * 2, (total - row.units) * 2, "utf16le");
    row.units = total;
  }

  #endRow(): void {
    this.#capture(this.#pos);
    const row = this.#row;
    this.#row = undefined;
    if (!row || !visibleRole(row.identity, this.surface)) return;
    if (row.dropped) {
      this.#omitted = true;
      return;
    }
    const source = this.#scratch.toString("utf16le", 0, row.units * 2);
    const sourceBytes = Buffer.byteLength(source);
    if (sourceBytes > this.#limits.rowBytes) {
      this.#omitted = true;
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch (error) {
      if (error instanceof SyntaxError) return malformed();
      throw error;
    }
    if (!isObject(parsed)) return malformed();
    const raw = allowedRow(parsed, this.surface);
    const cli = this.surface === "terminal" ? projectMessages({ messages: [raw] })[0] : undefined;
    if (this.surface === "terminal" && !cli) return;
    // Charge retained source as well as serialized output: engines may share backing strings with JSON.parse values.
    const bytes = Math.max(sourceBytes, Buffer.byteLength(JSON.stringify(raw))) + 1;
    if (bytes > this.#limits.bytes) {
      this.#omitted = true;
      return;
    }
    if (this.#onHistoryRow &&
        (!this.#seen.has("command") || this.#envelope.command === "get_messages") &&
        (!this.#seen.has("success") || this.#envelope.success === true)) {
      try { this.#onHistoryRow(raw); }
      catch { throw new WebError(502, "history_capture_failed", "无法暂存 OmO 历史响应。"); }
    }
    const text = cli?.content.length ?? 0;
    this.#kept.push({ raw, bytes, tokens: row.tokens, text });
    this.#keptBytes += bytes;
    this.#keptTokens += row.tokens;
    this.#keptText += text;
    while (this.#kept.length > this.#limits.rows || this.#keptBytes > this.#limits.bytes ||
      this.#keptTokens > this.#limits.tokens || this.#keptText > this.#limits.text) {
      const oldest = this.#kept.shift();
      if (!oldest) return;
      this.#keptBytes -= oldest.bytes;
      this.#keptTokens -= oldest.tokens;
      this.#keptText -= oldest.text;
      this.#truncated = true;
    }
  }
}
