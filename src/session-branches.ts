import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CLI_HISTORY_LIMITS } from "./cli-history.ts";
import type { Engine } from "./engine.ts";
import { WebError, array, record } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { readNativeLeaf } from "./session-entry-pages.ts";
import type { EntryReadScope } from "./session-entry-pages.ts";

const entryKey = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const branchSelection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fork"), entryId: entryKey }),
  z.strictObject({ kind: z.literal("clone") }),
]);
export type BranchSelection = Readonly<z.infer<typeof branchSelection>>;
export type BranchOptions = {
  readonly canClone: boolean;
  readonly forkMessages: readonly { readonly entryId: string; readonly text: string }[];
};
const emptyOptions: BranchOptions = { canClone: false, forkMessages: [] };

/** Server-only. Use CliHistory.branchSource, never construct from browser fields.
 * When attached, set leafId from the authorized native runtime's current get_tree.
 * Omitted means offline/latest on disk; null hides all fork and clone options.
 * Only transcript JSONL is staged; external media sidecars are not copied. */
export type BranchSource = {
  readonly cwd: string;
  readonly sourcePath: string;
  readonly nativeSessionId: string;
  readonly leafId?: string | null;
};

const sessionHeader = z.object({
  type: z.literal("session"), id: z.string().max(200).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
  version: z.literal(3), cwd: z.string().min(1), timestamp: z.string().min(1),
});
const sessionEntry = z.object({
  type: z.string().min(1), id: entryKey, parentId: entryKey.nullable(),
});
type Entry = Readonly<z.infer<typeof sessionEntry>> & { readonly role: unknown; readonly preview?: string };
type Transcript = {
  readonly header: z.infer<typeof sessionHeader>;
  readonly body: string;
  readonly entries: ReadonlyMap<string, Entry>;
  readonly lastEntry: string | null;
};
type NativeBranch = { readonly nativeId: string; readonly transcript: string; readonly editorText?: string };
export type PreparedBranch = { readonly cancelled: true } | ({
  readonly cancelled?: false;
  readonly name?: string;
} & NativeBranch);

const invalidSource = () => new WebError(409, "branch_source_invalid", "会话记录无效，无法创建分支。");
const invalidOutput = () => new WebError(502, "branch_output_invalid", "OmO 没有生成可确认的独立分支。");
export const staleBranch = () => new WebError(409, "branch_stale", "会话或分支起点已改变，请刷新后重试。");
export const branchBusy = () => new WebError(409, "session_busy", "会话正在运行，请等待当前回合结束后再创建分支。");
export const nativeBranchError = (error: unknown): never => {
  if (!(error instanceof WebError)) throw error;
  // Native errors can contain absolute paths and raw transcript diagnostics.
  throw new WebError(error.status, error.status >= 500 ? "branch_engine_unavailable" : "branch_engine_refused",
    "OmO 未能完成分支操作，请刷新会话并重试。");
};

export async function readBranchLeaf(scope: EntryReadScope, invalidLeaf: () => WebError): Promise<string | null> {
  if (scope.engine.capabilities.has("entries_tail")) {
    try { return await readNativeLeaf(scope, 15_000); }
    catch (error) {
      if (error instanceof WebError) {
        if (error.code === "tree_stale") throw staleBranch();
        if (error.code === "tree_reply_invalid") throw invalidLeaf();
      }
      return nativeBranchError(error);
    }
  }
  // Only legacy hosts that did not advertise paging use the old read.
  const { leafId } = await scope.engine.requestExisting("get_tree", { sessionId: scope.target.route }, 15_000)
    .catch(nativeBranchError);
  if (leafId === null) return null;
  const parsed = entryKey.safeParse(leafId);
  if (!parsed.success) throw invalidLeaf();
  return parsed.data;
}

function fsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readTranscript(path: string, cwd: string, id: string | undefined, invalid: () => WebError): Promise<Transcript | undefined> {
  if (!path.endsWith(".jsonl") || resolve(path) !== path) throw invalid();
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || (process.getuid && before.uid !== BigInt(process.getuid())) ||
        before.size > BigInt(CLI_HISTORY_LIMITS.maxFileBytes)) throw invalid();
      const bound = async () => {
        // The descriptor must actually name the authorized path, including its parent directories.
        // On Linux this also detects a parent symlink swapped during open.
        const target = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
        return await realpath(target) === path && await realpath(path) === path;
      };
      if (!await bound()) throw invalid();
      const bytes = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw invalid();
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!await bound() || [after, named].some(stat => !stat.isFile() || stat.nlink !== 1n ||
        stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
        stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)) throw invalid();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const [first, ...lines] = text.split("\n");
      const header = sessionHeader.safeParse(JSON.parse(first));
      if (!header.success || header.data.cwd !== cwd || (id !== undefined && header.data.id !== id)) throw invalid();
      const entries = new Map<string, Entry>();
      let lastEntry: string | null = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        const raw = record(JSON.parse(line));
        const entry = sessionEntry.safeParse(raw);
        if (!entry.success || entry.data.type === "session" || entries.has(entry.data.id) ||
          (entry.data.parentId !== null && !entries.has(entry.data.parentId))) throw invalid();
        const { role, content } = record(raw.message);
        if (entry.data.type === "message" && typeof role !== "string") throw invalid();
        let preview: string | undefined;
        if (entry.data.type === "message" && role === "user") {
          preview = typeof content === "string" ? content.slice(0, 800) : array(content).map(record)
            .filter(part => part.type === "text" && typeof part.text === "string")
            .map(part => String(part.text).slice(0, 800)).join("\n").slice(0, 800);
        }
        entries.set(entry.data.id, { ...entry.data, role, preview });
        lastEntry = entry.data.id;
      }
      return { header: header.data, body: lines.join("\n"), entries, lastEntry };
    } finally { await handle.close(); }
  } catch (error) {
    if (fsCode(error, "ENOENT")) return undefined;
    if (error instanceof WebError) throw error;
    throw invalid();
  }
}

export type LoadedBranchSource = { readonly source: BranchSource; readonly transcript: Transcript };

export async function loadBranchSource(source: BranchSource): Promise<LoadedBranchSource>;
export async function loadBranchSource(source: BranchSource, allowUnsaved: true): Promise<LoadedBranchSource | undefined>;
export async function loadBranchSource(source: BranchSource, allowUnsaved = false): Promise<LoadedBranchSource | undefined> {
  const history = await readTranscript(source.sourcePath, source.cwd, source.nativeSessionId, invalidSource);
  if (!history) {
    if (allowUnsaved && source.leafId === null) return undefined;
    throw staleBranch();
  }
  if (typeof source.leafId === "string" && !history.entries.has(source.leafId)) throw staleBranch();
  return { source, transcript: history };
}

export async function loadSavedWebBranch(cwd: string, sourcePath: string): Promise<LoadedBranchSource | undefined> {
  const transcript = await readTranscript(sourcePath, cwd, undefined, invalidSource);
  if (transcript) return { source: { cwd, sourcePath, nativeSessionId: transcript.header.id }, transcript };
}

function serialize(transcript: Transcript, id = transcript.header.id): string {
  // A scratch id must not claim the source's durable writer. Also drop the native
  // child's parentSession, which points at the short-lived scratch file.
  return JSON.stringify({ ...transcript.header, id }) + "\n" + transcript.body;
}

function conversation(transcript: Transcript, leaf: string | null): string[] {
  const ids: string[] = [];
  for (let id = leaf; id !== null;) {
    const entry = transcript.entries.get(id);
    if (!entry) throw invalidOutput();
    if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) ids.push(id);
    id = entry.parentId;
  }
  return ids.reverse();
}

function isLinear(transcript: Transcript): boolean {
  let prior: string | null = null;
  for (const entry of transcript.entries.values()) {
    if (entry.parentId !== prior) return false;
    prior = entry.id;
  }
  return true;
}

type Scratch = {
  readonly source: Transcript;
  readonly nativeId: string;
  readonly leafId: string | null;
  readonly name?: string;
  readonly options: BranchOptions;
  readonly directory: string;
  readonly request: (method: string, fields?: WireObject) => Promise<WireObject>;
};

export class SessionBranches {
  #inProgress = false;

  constructor(readonly engine: Engine, readonly isWebRoute: (route: string) => boolean) {}

  options({ source, transcript }: LoadedBranchSource): BranchOptions {
    const leafId = source.leafId === undefined ? transcript.lastEntry : source.leafId;
    if (leafId === null) return emptyOptions;
    return {
      canClone: true,
      forkMessages: [...transcript.entries.values()].flatMap(entry => entry.preview?.trim()
        ? [{ entryId: entry.id, text: entry.preview }] : []),
    };
  }

  async prepare(directory: string, { source, transcript }: LoadedBranchSource, input: BranchSelection): Promise<PreparedBranch> {
    const selection = branchSelection.parse(input);
    if (source.leafId === null) throw staleBranch();
    return this.#scratch(directory, source, transcript, async scratch => {
      let selectedLeaf = scratch.leafId;
      if (selection.kind === "fork") {
        const selected = scratch.source.entries.get(selection.entryId);
        if (!selected || !scratch.options.forkMessages.some(row => row.entryId === selected.id)) throw staleBranch();
        selectedLeaf = selected.parentId;
      } else if (!scratch.options.canClone) {
        throw staleBranch();
      }
      const expected = conversation(transcript, selectedLeaf);
      const reply = selection.kind === "fork" ?
        await scratch.request("fork", { entryId: selection.entryId, position: "before" }) : await scratch.request("clone");
      if (reply.cancelled === true) return { cancelled: true };
      const editorText = selection.kind === "fork" ? reply.text : undefined;
      if (reply.cancelled !== false || (selection.kind === "fork" && typeof editorText !== "string")) throw invalidOutput();
      const native = await scratch.request("get_state");
      const { sessionFile, sessionId } = native;
      if (typeof sessionFile !== "string" || typeof sessionId !== "string" || !z.uuid().safeParse(sessionId).success ||
        sessionId === source.nativeSessionId || sessionId === scratch.nativeId || native.cwd !== source.cwd ||
        dirname(sessionFile) !== scratch.directory || !basename(sessionFile).endsWith(`_${sessionId}.jsonl`)) throw invalidOutput();
      let output = await readTranscript(sessionFile, source.cwd, sessionId, invalidOutput);
      if (!output && expected.length === 0) {
        // Native delays disk creation until a branch has a conversation. Export the
        // actual new runtime (including the root fork's native id), not the source.
        const path = join(scratch.directory, "empty-native-branch.jsonl");
        if ((await scratch.request("export_jsonl", { outputPath: path })).path !== path) throw invalidOutput();
        output = await readTranscript(path, source.cwd, sessionId, invalidOutput);
      }
      if (!output || !isLinear(output) ||
        JSON.stringify(conversation(output, output.lastEntry)) !== JSON.stringify(expected)) throw invalidOutput();
      return { nativeId: sessionId, transcript: serialize(output), name: scratch.name,
        ...(typeof editorText === "string" ? { editorText } : {}) };
    });
  }

  async #scratch<T>(store: string, source: BranchSource, transcript: Transcript, use: (scratch: Scratch) => Promise<T>): Promise<T> {
    if (this.#inProgress) throw new WebError(409, "branch_busy", "正在准备另一条分支，请稍后重试。");
    this.#inProgress = true;
    let directory: string | undefined;
    let route: string | undefined;
    try {
      directory = await mkdtemp(join(store, ".omo-web-branch-"));
      const sessionPath = join(directory, "source.jsonl");
      const scratchId = crypto.randomUUID();
      await writeFile(sessionPath, serialize(transcript, scratchId), { flag: "wx", mode: 0o600 });
      // The installed open_session constructs the SessionManager home from
      // dirname(sessionPath). All runtime replacement stays under this directory.
      const opened = await this.engine.request("open_session", { cwd: source.cwd, sessionPath,
        permissionPreset: "ask", kind: "interactive", auto_title: false }, 30_000).catch(nativeBranchError);
      const initial = record(opened.state);
      if (typeof opened.sessionId !== "string" || !opened.sessionId || opened.attached === true ||
        this.isWebRoute(opened.sessionId) || initial.sessionFile !== sessionPath ||
        initial.sessionId !== scratchId || initial.cwd !== source.cwd) throw invalidOutput();
      const scratchRoute = opened.sessionId;
      route = scratchRoute;
      if (opened.permissionPreset !== "ask" || opened.permissionPresetStatus !== "applied") {
        throw new WebError(409, "permission_mode_unconfirmed", "OmO 未确认分支的 ask 权限模式。");
      }
      const request = (method: string, fields: WireObject = {}) =>
        this.engine.requestExisting(method, { ...fields, sessionId: scratchRoute }, 15_000).catch(nativeBranchError);
      const host = this.engine.status;
      const actualLeaf = await readBranchLeaf({ engine: this.engine, target: { route: scratchRoute },
        isCurrent: () => this.engine.status === host && !this.isWebRoute(scratchRoute) }, invalidOutput);
      const leafId = source.leafId === undefined ? transcript.lastEntry : source.leafId;
      if (leafId !== null && leafId !== actualLeaf) {
        const moved = await request("navigate_tree", { targetId: leafId, intent: "resume", expectedLeafId: actualLeaf });
        if (moved.cancelled !== false || moved.leafId !== leafId) throw staleBranch();
      }
      const forkMessages = array((await request("get_fork_messages")).messages).map(record).flatMap(row => {
        if (typeof row.entryId !== "string" || typeof row.text !== "string" || !row.text) return [];
        const entry = transcript.entries.get(row.entryId);
        return entry?.type === "message" && entry.role === "user" ? [{ entryId: row.entryId, text: row.text }] : [];
      });
      return await use({ source: transcript, nativeId: scratchId, leafId, directory, request,
        options: { canClone: leafId !== null, forkMessages },
        name: typeof initial.sessionName === "string" ? initial.sessionName : undefined });
    } finally {
      try {
        if (route) await this.engine.requestExisting("close_session", { sessionId: route }, 5000).catch(nativeBranchError);
      } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        finally { this.#inProgress = false; }
      }
    }
  }
}
