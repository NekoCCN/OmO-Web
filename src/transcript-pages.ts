import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebError, pick, record, transcriptMessage } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const KiB = 1024;
export const TRANSCRIPT_PAGE_BYTES = 256 * KiB;
export const TRANSCRIPT_CONTENT_BYTES = 64 * KiB;
export const TRANSCRIPT_PAGE_ROWS = 40;
export const TRANSCRIPT_CAPTURE_BYTES = 60 * 1024 * KiB;
export const TRANSCRIPT_CAPTURE_ROWS = 8192;
export const TRANSCRIPT_CACHE_COUNT = 4; // Includes staging: at most 240 MiB on disk.
export const TRANSCRIPT_STAGING_COUNT = 2;
export const TRANSCRIPT_TTL_MS = 5 * 60_000;
const INLINE_BYTES = 192 * KiB;
const COMPAT_ROW_BYTES = 2 * 1024 * KiB;
const TEXT_UNITS = 10 * KiB; // Worst-case JSON escaping is six bytes per UTF-16 unit.
const PREVIEW_UNITS = 2048;
const DIGEST_BYTES = 32;
const CURSOR_BYTES = 41;
const PAGE = 1;
const CONTENT = 2;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const staleTranscript = () => new WebError(409, "transcript_cursor_stale", "历史位置无效或已过期，请重新读取会话。");
export const snapshotStateTooLarge = () => new WebError(502, "snapshot_state_too_large", "会话状态超过 Web 读取上限，未返回不完整的交互状态。");
const captureFailed = () => new WebError(502, "history_capture_failed", "无法读取 Web 历史暂存。");

type Span = { offset: number; length: number }; // Offset is virtual, mapped modulo the file cap.
type TranscriptStatus = { status: "truncated" | "unavailable" };
type Page = { messages: WireObject[]; page: { id: string; olderCursor?: string }; transcript?: TranscriptStatus };
type Chunk = { text: string; nextCursor?: string };
type Cursor = { kind: typeof PAGE | typeof CONTENT; row: number; chunk: number };

function textEnd(text: string, start: number, units: number): number {
  const end = Math.min(text.length, start + units);
  const high = text.charCodeAt(end - 1);
  const low = text.charCodeAt(end);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? end - 1 : end;
}

function short(text: string, units: number): string {
  return text.slice(0, textEnd(text, 0, units));
}

function webRow(value: WireObject): { row: WireObject; omitted: boolean } | undefined {
  if (typeof value.role !== "string") return;
  const row = transcriptMessage(value);
  if (!row) return;
  let omitted = false;
  const rawContent = value.content;
  if (Array.isArray(rawContent)) {
    const content: WireObject[] = [];
    for (const raw of rawContent) {
      const block = record(raw);
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        content.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
        const args = block.arguments;
        content.push({ ...pick(block, ["type", "id", "name"]), ...(args === undefined ? {} : { arguments: args }) });
      } else if (block.type === "image" && typeof block.mimeType === "string" &&
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType) &&
          typeof block.data === "string" && block.data.length <= INLINE_BYTES &&
          block.data.length >= 4 && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) {
        content.push({ ...pick(block, ["type", "mimeType", "data"]),
          ...(typeof block.mediaId === "string" ? { mediaId: block.mediaId } : {}) });
      } else {
        omitted = true;
      }
    }
    row.content = content;
  } else if (rawContent !== undefined && typeof rawContent !== "string") {
    delete row.content;
    omitted = true;
  }
  // These fields are display scalars, not a place for nested Native response objects.
  for (const key of ["toolName", "toolCallId", "stopReason", "errorMessage", "provider", "model",
    "customType", "command", "output"]) {
    if (typeof row[key] !== "string") delete row[key];
  }
  if (typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp)) delete row.timestamp;
  if (row.usage !== undefined) {
    const usage = pick(row.usage, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
    if (Object.hasOwn(record(row.usage), "cost")) {
      usage.cost = Object.fromEntries(Object.entries(pick(record(row.usage).cost,
        ["input", "output", "cacheRead", "cacheWrite", "total"])).filter(([, v]) => typeof v === "number"));
    }
    row.usage = Object.fromEntries(Object.entries(usage).filter(([key, v]) => key === "cost" || typeof v === "number"));
  }
  for (const key of ["isError", "cancelled", "truncated"]) if (typeof row[key] !== "boolean") delete row[key];
  if (row.exitCode !== null && typeof row.exitCode !== "number") delete row.exitCode;
  return { row, omitted };
}

function preview(row: WireObject): WireObject {
  const small = pick(row, ["role", "timestamp", "toolName", "toolCallId", "isError", "stopReason",
    "errorMessage", "customType", "command", "output", "exitCode", "cancelled", "truncated"]);
  for (const key of Object.keys(small)) {
    const value = small[key];
    if (typeof value === "string") small[key] = short(value, key === "output" ? PREVIEW_UNITS : 256);
  }
  if (typeof row.content === "string") small.content = short(row.content, PREVIEW_UNITS);
  else if (Array.isArray(row.content)) small.content = row.content.slice(0, 12).flatMap<WireObject>((block: WireObject) => {
    if (typeof block.text === "string") return [{ type: "text", text: short(block.text, Math.floor(PREVIEW_UNITS / 4)) }];
    if (typeof block.thinking === "string") return [{ type: "thinking", thinking: short(block.thinking, 256) }];
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      return [{ type: "toolCall", id: short(block.id, 256), name: short(block.name, 256) }];
    }
    return [];
  });
  return small;
}

/** A per-capture ring: write projected rows in Native order, evict whole oldest rows on wrap.
 * Offsets, lengths and counters are the only retained history index; no Native raw row goes to disk. */
export class TranscriptCapture {
  readonly #identity = randomBytes(16);
  readonly id = this.#identity.toString("hex");
  readonly #directory: string;
  readonly #fd: number;
  readonly #rows = new Map<number, Span[]>();
  #oldest = 0;
  #next = 0;
  #head = 0;
  #closed = false;
  #omitted = false;
  seen = false;
  readonly expires = Date.now() + TRANSCRIPT_TTL_MS;

  constructor(directory: string, readonly owner: string, readonly key: Buffer,
    readonly check: () => void, readonly verify: () => Promise<void>) {
    this.#directory = mkdtempSync(join(directory, `.transcript-${process.pid}-`));
    try { this.#fd = openSync(join(this.#directory, "capture"), "wx+", 0o600); }
    catch (error) {
      rmSync(this.#directory, { recursive: true, force: true });
      throw error;
    }
  }

  markOmitted(): void { this.#omitted = true; }

  append(raw: WireObject, compatibility = false): void {
    this.seen = true;
    if (this.#closed) return; // An invalidated request may still be draining its Native reply.
    const projected = webRow(raw);
    if (!projected) return;
    let { row } = projected;
    if (projected.omitted) this.markOmitted();
    const chunks: Buffer[] = [];
    const size = jsonBytes(row);
    if (compatibility && size > COMPAT_ROW_BYTES) { this.markOmitted(); return; }
    if (size > INLINE_BYTES) {
      const role = row.role;
      const text = role === "user" || role === "assistant" || role === "custom"
        ? typeof row.content === "string" ? row.content
          : Array.isArray(row.content) && row.content.length === 1 ? record(row.content[0]).text : undefined
        : undefined;
      const small = preview(row);
      if (typeof text === "string" && text.length > PREVIEW_UNITS) {
        for (let start = 0; start < text.length;) {
          const end = textEnd(text, start, TEXT_UNITS);
          // JSON string records preserve lone surrogates as well as valid Unicode pairs.
          chunks.push(Buffer.from(JSON.stringify(text.slice(start, end))));
          start = end;
        }
        small.historyContent = { cursor: this.#token(CONTENT, this.#next, 0) };
        // Other large fields aren't expanded by this text cursor.
        if (Object.keys(small).some(key => key !== "content" && key !== "historyContent" && small[key] !== row[key])) {
          this.markOmitted();
        }
      } else {
        this.markOmitted();
      }
      row = small;
    }
    const buffers = [Buffer.from(JSON.stringify(row)), ...chunks];
    const total = buffers.reduce((n, bytes) => n + DIGEST_BYTES + bytes.length, 0);
    if (total > TRANSCRIPT_CAPTURE_BYTES) { this.markOmitted(); return; }
    const position = this.#head % TRANSCRIPT_CAPTURE_BYTES;
    if (position + total > TRANSCRIPT_CAPTURE_BYTES) this.#head += TRANSCRIPT_CAPTURE_BYTES - position;
    const end = this.#head + total;
    while (this.#oldest < this.#next) {
      const first = this.#rows.get(this.#oldest)?.[0];
      if (first && end - first.offset <= TRANSCRIPT_CAPTURE_BYTES && this.#rows.size < TRANSCRIPT_CAPTURE_ROWS) break;
      this.#rows.delete(this.#oldest++);
      this.markOmitted();
    }
    const spans = buffers.map(bytes => {
      const encoded = Buffer.concat([createHash("sha256").update(bytes).digest(), bytes]);
      const span = { offset: this.#head, length: encoded.length };
      if (writeSync(this.#fd, encoded, 0, encoded.length, this.#head % TRANSCRIPT_CAPTURE_BYTES) !== encoded.length) {
        throw captureFailed();
      }
      this.#head += encoded.length;
      return span;
    });
    this.#rows.set(this.#next++, spans);
  }

  #token(kind: Cursor["kind"], row: number, chunk: number): string {
    const payload = Buffer.alloc(25);
    this.#identity.copy(payload);
    payload[16] = kind;
    payload.writeUInt32BE(row, 17);
    payload.writeUInt32BE(chunk, 21);
    const mac = createHmac("sha256", this.key).update(payload).digest().subarray(0, 16);
    return Buffer.concat([payload, mac]).toString("base64url");
  }

  cursor(token: string, content: boolean): Cursor {
    if (!/^[A-Za-z0-9_-]{55}$/u.test(token)) throw staleTranscript();
    const bytes = Buffer.from(token, "base64url");
    const kind = content ? CONTENT : PAGE;
    if (bytes.length !== CURSOR_BYTES || bytes[16] !== kind || !bytes.subarray(0, 16).equals(this.#identity)) {
      throw staleTranscript();
    }
    const row = bytes.readUInt32BE(17);
    const chunk = bytes.readUInt32BE(21);
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(this.#token(kind, row, chunk)))) throw staleTranscript();
    return { kind, row, chunk };
  }

  #read(span: Span | undefined): unknown {
    if (!span || this.#closed) throw staleTranscript();
    try {
      const bytes = Buffer.alloc(span.length);
      if (readSync(this.#fd, bytes, 0, bytes.length, span.offset % TRANSCRIPT_CAPTURE_BYTES) !== bytes.length) throw captureFailed();
      const body = bytes.subarray(DIGEST_BYTES);
      if (!createHash("sha256").update(body).digest().equals(bytes.subarray(0, DIGEST_BYTES))) throw captureFailed();
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw captureFailed();
    }
  }

  page(until?: number): Page;
  page<T extends WireObject>(until: undefined, base: T): T & Page;
  page(until = this.#next, base: WireObject = {}): WireObject & Page {
    if (until < this.#oldest || until > this.#next) throw staleTranscript();
    const messages: WireObject[] = [];
    const page = { id: this.id, ...(until > this.#oldest ? { olderCursor: this.#token(PAGE, until, 0) } : {}) };
    const result = { ...base, messages, page, ...(this.#omitted ? { transcript: { status: "truncated" as const } } : {}) };
    let bytes = jsonBytes(result);
    // When mandatory state takes almost the whole budget, an initial envelope may
    // contain no rows but still has to retain a cursor for the exact same capture.
    if (bytes > TRANSCRIPT_PAGE_BYTES) throw snapshotStateTooLarge();
    let row = until;
    for (; row > this.#oldest && messages.length < TRANSCRIPT_PAGE_ROWS; row--) {
      const span = this.#rows.get(row - 1)?.[0];
      if (!span) throw captureFailed();
      const cost = span.length - DIGEST_BYTES + (messages.length > 0 ? 1 : 0);
      if (bytes + cost > TRANSCRIPT_PAGE_BYTES) break;
      messages.push(this.#read(span) as WireObject);
      bytes += cost;
    }
    messages.reverse();
    if (row > this.#oldest) page.olderCursor = this.#token(PAGE, row, 0);
    else delete page.olderCursor;
    return result;
  }

  content({ row, chunk }: Cursor): Chunk {
    const spans = this.#rows.get(row);
    if (!spans || chunk + 1 >= spans.length) throw staleTranscript();
    const text = this.#read(spans[chunk + 1]);
    if (typeof text !== "string") throw captureFailed();
    const result = { text, ...(chunk + 2 < spans.length ? { nextCursor: this.#token(CONTENT, row, chunk + 1) } : {}) };
    if (jsonBytes(result) > TRANSCRIPT_CONTENT_BYTES) throw captureFailed();
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rows.clear();
    try { closeSync(this.#fd); }
    finally { rmSync(this.#directory, { recursive: true, force: true }); }
  }
}

export class TranscriptCache {
  readonly #key = randomBytes(32);
  readonly #captures = new Map<TranscriptCapture, ReturnType<typeof setTimeout>>();
  readonly #published = new Map<string, TranscriptCapture>();
  #stopped = false;

  // Independent of mutable configured workspace roots.
  constructor(readonly directory = tmpdir()) {}

  begin(owner: string, check: () => void, verify: () => Promise<void>): TranscriptCapture {
    for (const capture of this.#captures.keys()) if (Date.now() >= capture.expires) this.drop(capture);
    if (this.#stopped || this.#captures.size - this.#published.size >= TRANSCRIPT_STAGING_COUNT) {
      throw new WebError(503, "history_capture_busy", "正在读取其他会话历史，请稍后再试。");
    }
    if (this.#captures.size >= TRANSCRIPT_CACHE_COUNT) {
      const oldest = [...this.#captures.keys()].find(capture => this.#published.get(capture.owner) === capture);
      if (oldest) this.drop(oldest);
    }
    let capture: TranscriptCapture;
    try { capture = new TranscriptCapture(this.directory, owner, this.#key, check, verify); }
    catch { throw captureFailed(); }
    const timer = setTimeout(() => this.drop(capture), TRANSCRIPT_TTL_MS);
    timer.unref();
    this.#captures.set(capture, timer);
    return capture;
  }

  commit(capture: TranscriptCapture): void {
    if (!this.#captures.has(capture) || Date.now() >= capture.expires) throw staleTranscript();
    const previous = this.#published.get(capture.owner);
    if (previous) this.drop(previous);
    this.#published.set(capture.owner, capture);
  }

  current(owner: string): TranscriptCapture {
    const capture = this.#published.get(owner);
    if (!capture) throw staleTranscript();
    this.assertCurrent(capture);
    return capture;
  }

  assertCurrent(capture: TranscriptCapture): void {
    if (Date.now() >= capture.expires) this.drop(capture);
    if (this.#published.get(capture.owner) !== capture) throw staleTranscript();
  }

  drop(capture: TranscriptCapture): void {
    const timer = this.#captures.get(capture);
    if (!timer) return;
    clearTimeout(timer);
    this.#captures.delete(capture);
    if (this.#published.get(capture.owner) === capture) this.#published.delete(capture.owner);
    try { capture.close(); } catch { console.error("OmO Web could not remove a private transcript capture"); }
  }

  invalidate(owner?: string): void {
    for (const capture of this.#captures.keys()) if (owner === undefined || capture.owner === owner) this.drop(capture);
  }

  stop(): void {
    this.#stopped = true;
    this.invalidate();
  }
}
