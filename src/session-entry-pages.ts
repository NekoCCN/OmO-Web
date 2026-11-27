import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RuntimeReadScope } from "./native-runtime.ts";
import { entryId, record, WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const PAGE_TAIL = 40;
const PAGE_BYTES = 262_144;
const PAGE_TIMEOUT = 6_000;
const MAX_CURSORS = 128;
const MAX_CURSOR_IDS = 32_768;
const CURSOR_TTL = 10 * 60_000;
export const treeCursor = z.string().regex(/^[a-f0-9]{64}$/u);
export const staleTree = () => new WebError(409, "tree_stale", "会话或分支位置已变化，请重新加载会话树。");
const malformedPage = () => new WebError(502, "tree_reply_invalid", "OmO 返回了无效的会话分页。");
const pageTooLarge = () => new WebError(409, "tree_budget", "会话历史超过读取预算。");

const envelope = z.object({ entries: z.unknown(), leafId: entryId.nullable(), hasMore: z.boolean(),
  next_before: entryId.optional() });
const entryShape = z.object({ id: entryId, parentId: entryId.nullable(), type: z.string().min(1).max(80) });
type Entry = Readonly<z.infer<typeof entryShape>> & { readonly raw: WireObject };
type Position = { readonly before: string; readonly seen: ReadonlySet<string> };
type Page = { readonly entries: readonly Entry[]; readonly leafId: string | null;
  readonly next?: Position };
export type EntryReadScope = Pick<RuntimeReadScope, "engine" | "isCurrent"> &
  { readonly target: Pick<RuntimeReadScope["target"], "route"> };

export async function readNativeLeaf(scope: EntryReadScope, timeout = PAGE_TIMEOUT) {
  return (await readEntryPage(scope, { leafOnly: true, timeout })).leafId;
}

export async function readEntryPage(scope: EntryReadScope, options: {
  readonly position?: Position;
  readonly expectedLeafId?: Page["leafId"];
  readonly leafOnly?: boolean;
  readonly acceptLargeSingleton?: boolean;
  readonly timeout?: number;
} = {}): Promise<Page> {
  if (!scope.isCurrent()) throw staleTree();
  const { position } = options;
  const tail = options.leafOnly ? 1 : PAGE_TAIL;
  const raw = await scope.engine.requestExisting("get_entries", {
    sessionId: scope.target.route, tail, maxBytes: PAGE_BYTES, ...(position ? { before: position.before } : {}),
  }, options.timeout ?? PAGE_TIMEOUT);
  if (!scope.isCurrent()) throw staleTree();
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw malformedPage();
  const { entries, leafId, hasMore, next_before: nextBefore } = parsed.data;
  // A newly appended active leaf is absent from an older page by design.
  // Treat the changed selection as stale before testing complete membership.
  if (options.expectedLeafId !== undefined && options.expectedLeafId !== leafId) throw staleTree();
  if (!Array.isArray(entries) || entries.length > tail || raw.nextSince !== undefined ||
      (entries.length === 0 && (position !== undefined || hasMore || leafId !== null))) throw malformedPage();

  const seen = new Set(position?.seen);
  const page: Entry[] = [];
  let bytes = 0;
  for (const value of entries) {
    const fields = entryShape.safeParse(value);
    if (!fields.success) throw malformedPage();
    const { id, parentId } = fields.data;
    if (id === parentId || id === position?.before || seen.has(id)) throw malformedPage();
    seen.add(id);
    page.push({ ...fields.data, raw: record(value) });
    if (entries.length === 1 && (options.acceptLargeSingleton || options.leafOnly)) continue;
    try {
      bytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw pageTooLarge();
    }
    if (bytes > PAGE_BYTES) throw entries.length === 1 ? pageTooLarge() : malformedPage();
  }
  if (hasMore ? nextBefore === undefined || nextBefore !== page[0]?.id :
    nextBefore !== undefined || (leafId !== null && !seen.has(leafId))) throw malformedPage();
  return { entries: page, leafId, ...(nextBefore === undefined ? {} : { next: { before: nextBefore, seen } }) };
}

const displayTypes = new Set(["message", "custom", "custom_message", "compaction", "branch_summary",
  "model_change", "thinking_level_change", "session_info", "label"]);
const displayRoles = new Set(["user", "assistant", "toolResult", "bashExecution"]);

export function previewEntries(entries: Page["entries"]) {
  return entries.map(({ id, parentId, type, raw }) => {
    const { role } = record(raw.message);
    // Labels are separately appended changes, not authoritative on a sparse page.
    // Free text (even a prefix), tool data and hidden custom context are never previews.
    return { id, parentId, type: displayTypes.has(type) ? type : "other",
      ...(type === "message" && typeof role === "string" && displayRoles.has(role) ? { role } : {}) };
  });
}

type Cursor = {
  readonly host: RuntimeReadScope["engine"]["status"];
  readonly target: RuntimeReadScope["target"];
  readonly leafId: Page["leafId"];
  readonly position: Position;
  readonly expires: number;
};

/** Process-local, bounded opaque capabilities. Keep identities from previous
 * pages so a Native before walk cannot revisit an ID, even on nonadjacent pages. */
export class TreeCursors {
  readonly #cursors = new Map<string, Cursor>();
  #ids = 0;

  get(scope: RuntimeReadScope, key: string): Cursor {
    const cursor = this.#cursors.get(key);
    if (!cursor || cursor.expires <= Date.now() || cursor.target !== scope.target ||
        cursor.host !== scope.engine.status) throw staleTree();
    this.#cursors.delete(key);
    this.#cursors.set(key, cursor);
    return cursor;
  }

  put(scope: RuntimeReadScope, leafId: Page["leafId"], position: Position): string {
    const count = position.seen.size;
    if (count > MAX_CURSOR_IDS) throw pageTooLarge();
    for (const [key, cursor] of this.#cursors) {
      if (this.#cursors.size < MAX_CURSORS && this.#ids + count <= MAX_CURSOR_IDS) break;
      this.#delete(key, cursor);
    }
    const key = randomBytes(32).toString("hex");
    this.#cursors.set(key, { target: scope.target, host: scope.engine.status, leafId, position,
      expires: Date.now() + CURSOR_TTL });
    this.#ids += count;
    return key;
  }

  invalidate(target: RuntimeReadScope["target"]) {
    for (const [key, cursor] of this.#cursors) if (cursor.target === target) this.#delete(key, cursor);
  }

  #delete(key: string, cursor: Cursor) {
    this.#cursors.delete(key);
    this.#ids -= cursor.position.seen.size;
  }
}
