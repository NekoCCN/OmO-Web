import { Api, RequestError, sessionPath } from "./api.ts";
import { list, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr } from "./locale.ts";
import { messageKey, roleOf } from "./transcript.ts";
import type { TranscriptEntry } from "./transcript.ts";

export type TranscriptStatus = "truncated" | "unavailable";
export type HistoryControl = {
  readonly activate: () => void;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly reload: boolean;
  readonly error?: string;
};
export type HistoryContent = {
  readonly key: string;
  readonly control?: HistoryControl;
  readonly chunks: readonly string[];
};
export type HistoryRender = {
  readonly older?: HistoryControl;
  readonly content: (message: Wire) => HistoryContent | undefined;
};

type Page = { readonly id: string; readonly olderCursor: string };
type Content = { next: string; readonly chunks: string[]; error?: string };
export function readPage(raw: unknown): Page | undefined {
  const page = object(raw);
  const id = str(page.id);
  if (id) return { id, olderCursor: str(page.olderCursor) };
}

export function readTranscriptStatus(raw: unknown): TranscriptStatus | undefined {
  const status = object(raw).status;
  if (status === "truncated" || status === "unavailable") return status;
}

export class TranscriptHistory {
  readonly id: string;
  entries: readonly TranscriptEntry[] = [];
  status?: TranscriptStatus;
  stale = false;
  reloading = false;
  private olderCursor: string;
  private olderError?: string;
  private readonly requests = new Map<string, AbortController>();
  private readonly contents = new Map<string, Content>();

  constructor(page: Page, private readonly api: Api, private readonly sessionId: string,
    private readonly current: () => boolean, private readonly enabled: () => boolean,
    private readonly tail: () => readonly TranscriptEntry[],
    private readonly changed: (added?: number) => void, private readonly reload: () => void) {
    this.id = page.id;
    this.olderCursor = page.olderCursor;
  }

  invalidate(): void {
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
  }

  clearExpansion(): void {
    this.invalidate();
    this.entries = [];
    this.status = undefined;
    this.contents.clear();
  }

  render(): HistoryRender {
    const control = (activate: () => void, cursor: string, error?: string): HistoryControl => ({
      activate: this.stale ? this.reload : activate,
      disabled: !this.enabled(),
      busy: this.reloading || this.requests.has(cursor),
      reload: this.stale, error,
    });
    return {
      older: this.olderCursor || this.stale
        ? control(() => { void this.loadOlder(); }, this.olderCursor, this.olderError) : undefined,
      content: message => {
        const cursor = str(object(message.historyContent).cursor);
        if (!cursor) return;
        const value = this.contents.get(cursor);
        const next = value?.next ?? cursor;
        return {
          key: cursor,
          chunks: value?.chunks ?? [],
          control: next ? control(() => { void this.loadContent(cursor, next); }, next, value?.error) : undefined,
        };
      },
    };
  }

  private async read(cursor: string, content: boolean, apply: (data: Wire) => number | undefined,
    fail: (error: string) => void): Promise<void> {
    if (!cursor || this.stale || !this.current() || !this.enabled() || this.requests.has(cursor)) return;
    const request = new AbortController();
    const ownsReply = () => this.current() && this.requests.get(cursor) === request && !request.signal.aborted;
    this.requests.set(cursor, request);
    this.changed();
    let added: number | undefined;
    try {
      const endpoint = `${sessionPath(this.sessionId)}/transcript${content ? "/content" : ""}`;
      const data = await this.api.request(`${endpoint}?${new URLSearchParams({ cursor })}`, undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]));
      if (ownsReply()) added = apply(data);
    } catch (error) {
      if (!ownsReply()) return;
      if (error instanceof RequestError &&
          (error.code.includes("cursor") || [400, 401, 403, 404, 409, 410].includes(error.status))) this.expire();
      else fail(tr("读取失败，请重试。", "Couldn't load this part. Try again."));
    } finally {
      if (ownsReply()) {
        this.requests.delete(cursor);
        this.changed(added);
      }
    }
  }

  private expire(): void {
    this.stale = true;
    this.olderError = tr("记录版本已失效，请重新加载。", "This transcript page expired. Reload the transcript.");
    this.invalidate();
    this.changed();
  }

  private async loadOlder(): Promise<void> {
    const cursor = this.olderCursor;
    await this.read(cursor, false, data => {
      const page = readPage(data.page);
      if (!page || page.id !== this.id || page.olderCursor === cursor || !Array.isArray(data.messages)) {
        this.expire();
        return;
      }
      const known = new Set([...this.entries, ...this.tail()].map(entry => entry.key));
      const entries = list(data.messages).map(object).filter(message => Boolean(roleOf(message))).flatMap((message, index) => {
        const base = messageKey(message);
        const existing = known.has(base);
        if (existing && (base.startsWith("id:") || base.startsWith("result:"))) return [];
        const key = base && !existing ? base : `older:${this.entries.length}:${index}`;
        known.add(key);
        return [{ key, message }];
      });
      this.entries = [...entries, ...this.entries];
      this.olderCursor = page.olderCursor;
      this.olderError = undefined;
      this.status = readTranscriptStatus(data.transcript) ?? this.status;
      return entries.length;
    }, error => { this.olderError = error; });
  }

  private async loadContent(cursor: string, next: string): Promise<void> {
    const value = this.contents.get(cursor) ?? { next: cursor, chunks: [] };
    this.contents.set(cursor, value);
    if (value.next !== next) return;
    await this.read(next, true, data => {
      const following = str(data.nextCursor);
      if (typeof data.text !== "string" || following === next || (following && following === cursor)) {
        this.expire();
        return;
      }
      value.chunks.push(data.text);
      value.next = following;
      value.error = undefined;
      return undefined;
    }, error => { value.error = error; });
  }
}
