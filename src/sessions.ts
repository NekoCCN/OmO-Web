import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { MessagesFrameError } from "./bounded-messages.ts";
import { composeMessage, projectCommands, refuseRuntimeCommandRelay, resolveCommand } from "./commands.ts";
import { modelProfile, registeredModel } from "./model-options.ts";
import type { ModelTarget } from "./model-options.ts";
import { bindNativeRuntime, navigateSessionTree, readBranchRuntime, readNativeDag, readNativeRuntime, readSessionTree,
  readWorkbenchStatus, unavailableNativeRuntime } from "./native-runtime.ts";
import type { NativeRuntimeBinding, RuntimeInactiveReason, RuntimeReadScope } from "./native-runtime.ts";
import { readNativeSurfaces } from "./native-surfaces.ts";
import { WebError, array, browserEvent, model, pick, record, sessionKey, state } from "./protocol.ts";
import type { Action, SessionKey, WireObject } from "./protocol.ts";
import type { Engine } from "./engine.ts";
import type { AttachmentBinding } from "./send-file.ts";
import { readOwnedJournalHeader, sessionDirName } from "./cli-history.ts";
import type { ScopedBranchSource } from "./cli-history.ts";
import { projectSessionMemory } from "./runtime-metrics.ts";
import { TreeCursors } from "./session-entry-pages.ts";
import { branchBusy, loadBranchSource, loadSavedWebBranch, nativeBranchError, readBranchLeaf, SessionBranches, staleBranch } from "./session-branches.ts";
import type { BranchOptions, BranchSelection, LoadedBranchSource, PreparedBranch } from "./session-branches.ts";
import { StreamSpeed } from "./stream-speed.ts";
import { jsonBytes, snapshotStateTooLarge, TranscriptCache, TRANSCRIPT_PAGE_BYTES } from "./transcript-pages.ts";
import { WorkspaceAccess } from "./workspace-access.ts";

const savedSession = z.strictObject({
  id: sessionKey,
  name: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
  archived: z.boolean(),
  settled: z.boolean(),
  nativeId: z.string().min(1).max(200).optional(),
  cliBookmark: z.boolean().optional(),
  workspaceKey: z.string().optional(),
  /** Web session whose journal lives in the shared native profile bucket (native-placed).
   * Legacy rows without this flag keep their private dataDir journal. */
  shared: z.boolean().optional(),
});
type SavedSession = Readonly<z.infer<typeof savedSession>>;
const INSTRUCTIONS_FILE = "AGENTS.md";
const INSTRUCTIONS_MAX_BYTES = 64 * 1024;
const QUEUE_PREVIEW_ROWS = 30;
const QUEUE_PREVIEW_TEXT = 240;
const QUEUE_SCAN_ROWS = QUEUE_PREVIEW_ROWS * 4;
const activeQueueStates = new Set(["held", "queued", "sending", "pending", "accepted"]);
const queueModes = new Set(["prompt", "steer", "followUp", "follow_up"]);
const instructionsReply = z.discriminatedUnion("exists", [
  z.object({ cwd: z.string(), path: z.string(), exists: z.literal(true), content: z.string() }),
  z.object({ cwd: z.string(), path: z.string(), exists: z.literal(false), content: z.null() }),
]);
type InstructionsResult =
  | { readonly status: "ok"; readonly file: typeof INSTRUCTIONS_FILE; readonly content: string }
  | { readonly status: "missing" | "unsupported" | "unavailable" | "refused" | "too_large" };
export type SessionView = Omit<SavedSession, "nativeId" | "cliBookmark" | "workspaceKey"> & { readonly active: boolean; readonly running: boolean };
export type CliResumeSource = { readonly cwd: string; readonly nativeSessionId: string; readonly sourcePath: string; readonly workspaceKey?: string };

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
export type BranchResult = { readonly cancelled: true; readonly session?: never; readonly editorText?: never } |
  { readonly session: SessionView; readonly editorText?: string; readonly cancelled?: false };
type Snapshot = {
  session: SessionView;
  state: WireObject;
  messages: WireObject[];
  page?: { id: string; olderCursor?: string };
  transcript?: { status: "truncated" | "unavailable" };
  handoff: { eligible: boolean; reason?: string };
  generationSpeed?: WireObject;
};
type SnapshotScope = {
  route: string;
  isCurrent: () => boolean;
  check: () => void;
  verifyWorkspace: () => Promise<void>;
  identify: (raw: WireObject) => void;
  verifySource: () => Promise<void>;
};
type PendingSnapshot = {
  scope: SnapshotScope;
  abort: AbortController;
  result: Promise<Snapshot>;
  waiters: number;
};
const sessionChanged = () => new WebError(409, "session_changed", "会话连接已切换，请重新读取。");
const snapshotAborted = () => new WebError(408, "snapshot_aborted", "本次会话读取已取消。");

export class Sessions {
  readonly #rows = new Map<SessionKey, SavedSession>();
  readonly #live = new Map<SessionKey, { readonly route: string; readonly runtime?: NativeRuntimeBinding;
    readonly speed?: StreamSpeed; running: boolean; transcriptRevision?: number }>();
  readonly #opening = new Map<SessionKey, Promise<void>>();
  readonly #writes = new Map<SessionKey, Promise<unknown>>();
  readonly #releasing = new Set<SessionKey>();
  readonly #modelWrites = new Set<SessionKey>();
  readonly #treeCursors = new TreeCursors();
  readonly #treeWrites = new WeakMap<NativeRuntimeBinding, { pending: boolean }>();
  readonly #transcripts: TranscriptCache;
  readonly #snapshots = new Map<SessionKey, PendingSnapshot>();
  readonly #cliOpening = new Map<string, Promise<SessionView>>();
  readonly #directory: string;
  readonly #branches: SessionBranches;
  #stopping = false;

  constructor(dataDir: string, readonly workspaces: readonly string[] | WorkspaceAccess, readonly engine: Engine,
    readonly fanout: (value: WireObject) => void,
    readonly resolveCli?: (nativeSessionId: string, cwd: string) => Promise<{ sourcePath: string }>,
    readonly hostGuard?: { sameProfile: boolean; profileDir?: string }) {
    this.#directory = resolve(dataDir, "sessions");
    this.#transcripts = new TranscriptCache();
    this.#branches = new SessionBranches(engine, route => [...this.#live.values()].some(live => live.route === route));
  }

  async load() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.#directory)).isDirectory()) throw new WebError(500, "invalid_store", "会话目录不能是符号链接。");
    for (const file of await readdir(this.#directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const id = sessionKey.safeParse(file.name.slice(0, -5));
      if (!id.success) continue;
      const parsed = savedSession.parse(JSON.parse(await readFile(join(this.#directory, file.name), "utf8")));
      if (parsed.id !== id.data) throw new WebError(500, "invalid_store", `会话索引 ID 与文件不一致：${file.name}`);
      this.#rows.set(parsed.id, parsed);
    }
  }

  list(): SessionView[] {
    return this.#views([...this.#rows.values()]);
  }

  async scopedList(): Promise<SessionView[]> {
    const policy = this.workspaces;
    if (!(policy instanceof WorkspaceAccess)) return this.list();
    const rows = [...this.#rows.values()];
    const cwds = new Set(rows.filter(row => this.#workspaceKeyForRow(row) !== undefined).map(row => row.cwd));
    const keys = new Map(await Promise.all([...cwds].map(async cwd => [cwd, await policy.exact(cwd)] as const)));
    return this.#views(rows.filter(row => keys.get(row.cwd) !== undefined && keys.get(row.cwd) === this.#workspaceKeyForRow(row)));
  }

  #views(rows: SavedSession[]): SessionView[] {
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(row => this.#view(row));
  }

  #view(row: SavedSession): SessionView {
    const live = this.#live.get(row.id);
    return { id: row.id, name: row.name, cwd: row.cwd, updatedAt: row.updatedAt,
      archived: row.archived, settled: row.settled,
      active: Boolean(live), running: live?.running ?? false };
  }

  #row(id: SessionKey): SavedSession {
    const row = this.#rows.get(id);
    if (!row) throw new WebError(404, "session_not_found", "找不到这个会话。");
    return row;
  }

  async authorizeAttachment(id: SessionKey): Promise<void> {
    try { await this.#requireRowWorkspace(this.#row(id)); }
    catch (error) {
      if (error instanceof WebError && error.code === "workspace_refused") {
        throw new WebError(404, "session_not_found", "找不到这个会话。");
      }
      throw error;
    }
  }

  #route(id: SessionKey): string {
    return this.#binding(id).route;
  }

  #binding(id: SessionKey) {
    this.#row(id);
    const live = this.#live.get(id);
    if (!live) throw new WebError(409, "session_not_open", "会话未接入引擎，请先恢复会话。");
    return live;
  }

  async attachmentBinding(input: { readonly sessionId: string; readonly sessionFile: string; readonly cwd: string }): Promise<AttachmentBinding> {
    const matches = [...this.#live.entries()].filter(([, live]) =>
      live.runtime?.sessionId === input.sessionId && live.runtime.sessionFile === input.sessionFile && live.runtime.cwd === input.cwd);
    if (matches.length !== 1) throw new WebError(403, "attachment_refused", "无法从此会话发送该文件。");
    const [id, live] = matches[0];
    const row = this.#row(id);
    const verify = async () => {
      const current = () => !this.#stopping && this.engine.status.online && this.#live.get(id) === live &&
        this.#rows.get(id) === row && !this.#releasing.has(id) && live.runtime !== undefined &&
        !this.#treeWrites.get(live.runtime)?.pending;
      if (!current()) throw new WebError(403, "attachment_refused", "无法从此会话发送该文件。");
      await this.#requireRowWorkspace(row);
      if (!current()) throw new WebError(403, "attachment_refused", "无法从此会话发送该文件。");
    };
    await verify();
    return { id, verify };
  }

  #workspaceKeyForRow(row: SavedSession): string | undefined {
    return row.workspaceKey ?? (this.workspaces instanceof WorkspaceAccess ? this.workspaces.launchKey(row.cwd) : undefined);
  }

  async #requireRowWorkspace(row: SavedSession): Promise<string | undefined> {
    const expected = this.#workspaceKeyForRow(row);
    if (this.workspaces instanceof WorkspaceAccess && expected === undefined) {
      throw new WebError(403, "workspace_refused", "此旧会话不属于启动时获准的工作目录。");
    }
    return this.#requireWorkspace(row.cwd, expected);
  }

  async #requireWorkspace(cwd: string, expectedKey?: string): Promise<string | undefined> {
    if (this.workspaces instanceof WorkspaceAccess) {
      const key = await this.workspaces.exact(cwd);
      if (key !== undefined && (expectedKey === undefined || key === expectedKey)) return key;
    } else if (this.workspaces.includes(cwd) && await realpath(cwd).catch(() => undefined) === cwd &&
      (await lstat(cwd).catch(() => undefined))?.isDirectory()) {
      return undefined;
    }
    throw new WebError(403, "workspace_refused", "此工作目录未获授权或已不可用。");
  }

  async #persist(id: SessionKey, update: (previous: SavedSession | undefined) => SavedSession, exclusive = false) {
    const previousWrite = this.#writes.get(id);
    const write = async () => {
      const row = update(this.#rows.get(id));
      const temp = join(this.#directory, `${row.id}.${crypto.randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(row), { mode: 0o600, flag: "wx" });
      const path = join(this.#directory, `${row.id}.json`);
      if (exclusive) {
        try { await link(temp, path); }
        finally { await unlink(temp).catch(() => undefined); }
      } else {
        await rename(temp, path);
      }
      this.#rows.set(row.id, row);
      this.fanout({ type: "sessions" });
    };
    const queued = previousWrite ? previousWrite.then(write, write) : write();
    this.#writes.set(id, queued);
    try { await queued; } finally { if (this.#writes.get(id) === queued) this.#writes.delete(id); }
  }

  /** Default sharing primary: when the private host and profile layout are
   * available, the native runtime places the new journal itself (pathless open)
   * under the shared profile bucket and binds the durable id. Otherwise the
   * legacy private dataDir journal is used, never a silent half-shared mix. */
  async create(cwd: string, name = "新会话"): Promise<SessionView> {
    const key = await this.#requireWorkspace(cwd);
    const id = sessionKey.parse(crypto.randomUUID());
    const base = { id, cwd, name, updatedAt: Date.now(), archived: false, settled: false,
      ...(key === undefined ? {} : { workspaceKey: key }) };
    const sharedDir = await this.#sharedProfileDir().catch(() => undefined);
    if (sharedDir !== undefined) {
      const durable = crypto.randomUUID();
      const row: SavedSession = { ...base, nativeId: durable, shared: true };
      await this.#open(row, { durableId: durable, nativePlaced: { profileDir: sharedDir }, publishName: true });
      try {
        await this.#persist(id, () => row);
      } catch (error) {
        const route = this.#live.get(id)?.route;
        this.#live.delete(id);
        if (route) await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
        throw error;
      }
      return this.#view(row);
    }
    const row: SavedSession = base;
    await this.#open(row, { publishName: true });
    try {
      await this.#persist(id, () => row);
    } catch (error) {
      const route = this.#live.get(id)?.route;
      this.#live.delete(id);
      if (route) await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
      throw error;
    }
    return this.#view(row);
  }

  /** Profile directory eligible for native-placed journals, or undefined for
   * legacy private journals. Never throws: callers fall back to private mode. */
  async #sharedProfileDir(): Promise<string | undefined> {
    try {
      await this.#requirePrivateHost("resume_unsupported");
    } catch {
      return undefined;
    }
    const dir = this.hostGuard?.profileDir;
    if (this.hostGuard?.sameProfile !== true || !dir) return undefined;
    return dir;
  }

  async #open(row: SavedSession, opts: { branchNativeId?: string; sourcePath?: string; durableId?: string;
    publishName?: boolean; nativePlaced?: { profileDir: string } } = {}): Promise<WireObject> {
    if (this.workspaces instanceof WorkspaceAccess && !this.engine.status.online) await this.#requireWorkspace(this.engine.cwd);
    await this.#requireRowWorkspace(row);
    // Native-placed (shared) opens omit sessionPath: the runtime generates the
    // journal under the shared profile bucket. All other opens pin the path.
    const sessionPath = opts.nativePlaced ? undefined : (opts.sourcePath ?? join(this.#directory, `${row.id}.jsonl`));
    const fields: WireObject = {
      cwd: row.cwd,
      ...(sessionPath === undefined ? {} : { sessionPath }),
      permissionPreset: "ask",
      kind: "interactive",
      retain_on_disconnect: true,
      auto_title: false,
    };
    if (opts.durableId !== undefined) fields.durableSessionId = opts.durableId;
    const result = await this.engine.request("open_session", fields, 60_000).catch(error => {
      if (opts.branchNativeId !== undefined) nativeBranchError(error);
      throw error;
    });
    const route = result.sessionId;
    if (typeof route !== "string") throw new WebError(502, "invalid_engine_reply", "OmO 没有返回会话句柄。");
    const initial = record(result.state);
    const bound = opts.branchNativeId ?? opts.durableId;
    const trackedElsewhere = [...this.#live.values()].some(live => live.route === route);
    if (opts.nativePlaced === undefined && bound !== undefined) {
      if (typeof initial.sessionId !== "string" || !initial.sessionId || initial.sessionFile !== sessionPath ||
        initial.cwd !== row.cwd || initial.sessionId !== bound ||
        (opts.branchNativeId !== undefined && result.attached === true) || trackedElsewhere) {
        if (result.attached !== true && !trackedElsewhere) {
          await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
        }
        if (opts.branchNativeId !== undefined) {
          throw new WebError(502, "branch_output_invalid", "无法确认新分支的 OmO 会话身份。");
        }
        throw new WebError(502, "resume_unverified", "OmO 返回的会话身份与来源不一致，未打开该会话。");
      }
    }
    if (result.permissionPreset !== "ask" || result.permissionPresetStatus !== "applied") {
      if (bound === undefined || (result.attached !== true && !trackedElsewhere)) {
        await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
      }
      throw new WebError(409, "permission_mode_unconfirmed", "OmO 未确认 ask 权限模式，未开放该会话。");
    }
    if (opts.nativePlaced !== undefined) {
      const bucket = join(opts.nativePlaced.profileDir, "sessions", sessionDirName(row.cwd));
      const generated = initial.sessionFile;
      const durable = opts.durableId;
      const invalid = () => new WebError(502, "shared_placement_unsupported",
        "OmO 没有在默认共享目录生成可核验的会话日志。");
      let released = false;
      try {
        if (typeof generated !== "string" || generated !== resolve(generated) || dirname(generated) !== bucket ||
          durable === undefined || !generated.endsWith(`_${durable}.jsonl`) || initial.sessionId !== durable ||
          initial.cwd !== row.cwd || result.attached === true || trackedElsewhere ||
          await realpath(bucket).catch(() => undefined) !== bucket) throw invalid();
        const present = await lstat(generated).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (!present) {
          // OmO buffers an untouched journal (including its name) until a
          // conversation starts. Native quiet release can persist it without
          // a fake prompt; reopen the exact verified journal before publishing.
          if (opts.publishName && initial.sessionName !== row.name) {
            await this.engine.requestExisting("set_session_name", { sessionId: route, name: row.name });
          }
          await this.#releaseNative(route, row.cwd, durable, generated);
          released = true;
        }
        const header = await readOwnedJournalHeader(generated);
        if (!header || header.version !== 3 || header.sessionId !== durable || header.cwd !== row.cwd) throw invalid();
        if (released) return this.#open(row, { sourcePath: generated, durableId: durable });
      } catch (error) {
        if (!released && result.attached !== true && !trackedElsewhere) {
          await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
        }
        throw error;
      }
    }
    const runtime = result.attached === true ? undefined : bindNativeRuntime(initial, {
      route, cwd: row.cwd, sessionFile: opts.nativePlaced === undefined ? sessionPath : initial.sessionFile,
      durableId: bound ?? row.nativeId,
    });
    this.#transcripts.invalidate(row.id);
    this.#live.set(row.id, { route, runtime, speed: new StreamSpeed(initial.isCompacting === true),
      running: initial.isStreaming === true });
    if (opts.publishName && initial.sessionName !== row.name) {
      try { await this.engine.requestExisting("set_session_name", { sessionId: route, name: row.name }); }
      catch (error) {
        this.#live.delete(row.id);
        await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
        if (opts.branchNativeId !== undefined) nativeBranchError(error);
        throw error;
      }
    }
    return initial;
  }

  async #resume(row: SavedSession) {
    if (this.workspaces instanceof WorkspaceAccess) await this.#requireRowWorkspace(row);
    if (this.#live.has(row.id)) return;
    if (this.#releasing.has(row.id)) throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    const opening = this.#opening.get(row.id);
    if (opening) return opening;
    const pending = this.#resumeOpen(row);
    this.#opening.set(row.id, pending);
    try { await pending; } finally { if (this.#opening.get(row.id) === pending) this.#opening.delete(row.id); }
    this.fanout({ type: "sessions" });
  }

  async #resumeOpen(row: SavedSession) {
    if (row.cliBookmark) {
      if (!row.nativeId || !this.resolveCli) {
        throw new WebError(409, "resume_unavailable", "该 CLI 书签缺少可用的来源解析，请刷新 CLI 历史后重试。");
      }
      const resolved = await this.resolveCli(row.nativeId, row.cwd);
      await this.#requirePrivateHost("resume_unsupported");
      await this.#adoptOpen(row, { sourcePath: resolved.sourcePath, durableId: row.nativeId });
      return;
    }
    // Shared rows live in the native profile bucket: re-resolve the journal by
    // durable id on every open, never trust a stored path.
    if (row.shared === true) {
      if (!row.nativeId || !this.resolveCli) {
        throw new WebError(409, "resume_unavailable", "该共享会话缺少可用的来源解析，请刷新 CLI 历史后重试。");
      }
      // An existing alias always had a journal: an unresolvable source means
      // it was deleted, replaced, or unlinked, never a fresh id to mint.
      let sourcePath: string;
      try {
        sourcePath = (await this.resolveCli(row.nativeId, row.cwd)).sourcePath;
      } catch {
        throw new WebError(409, "resume_source_changed", "共享会话日志已不在，请刷新后重试。");
      }
      await this.#requirePrivateHost("resume_unsupported");
      await this.#verifySharedJournal(row, sourcePath);
      await this.#adoptOpen(row, { sourcePath, durableId: row.nativeId });
      return;
    }
    if (row.nativeId !== undefined) {
      await this.#requirePrivateHost("resume_unsupported");
      await this.#verifyWebJournal(row);
      await this.#adoptOpen(row, { durableId: row.nativeId });
      return;
    }
    await this.#open(row, { publishName: true });
  }

  /** Same private host, holder guard, and engine/profile configuration for every
   * sequential handoff or bookmarked reopen, including after a restart. Probes
   * the engine first so an unstarted or replaced host fails closed. */
  async #requirePrivateHost(code: "resume_unsupported" | "handoff_unsupported") {
    if (this.workspaces instanceof WorkspaceAccess && !this.engine.status.online) await this.#requireWorkspace(this.engine.cwd);
    try {
      await this.engine.probe();
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError(503, "engine_unavailable", "OmO 连接已断开。");
    }
    // Only the Web-owned private non-listening stdio host refuses a second
    // opener in both directions. Listening socket hosts admit stock TUI attach,
    // so they never qualify, even with the same profile configured.
    if (!this.engine.isPrivateHost || this.engine.usesListeningTransport) {
      throw new WebError(409, code, "顺序换端需要私有本机传输。");
    }
    if (!this.engine.capabilities.has("release_caller_aware") || !this.engine.capabilities.has("session_held")) {
      throw new WebError(409, code, "此 OmO 版本不支持顺序换端。");
    }
    if (this.hostGuard?.sameProfile !== true) {
      throw new WebError(409, code, "本机引擎与 CLI 会话目录不是同一配置，拒绝换端。");
    }
  }

  /** A shared-bucket journal re-resolved by durable id must still be the same
   * canonical owned v3 file before it reopens, so a deletion or replacement
   * can never silently mint an empty native session under the preserved id. */
  async #verifySharedJournal(row: SavedSession, sourcePath: string): Promise<void> {
    if (resolve(sourcePath) !== sourcePath || await realpath(sourcePath).catch(() => undefined) !== sourcePath) {
      throw new WebError(409, "resume_source_changed", "共享会话日志已不在，请刷新后重试。");
    }
    if (!row.nativeId) throw new WebError(409, "resume_source_changed", "共享会话日志已变化，无法恢复。");
    const header = await readOwnedJournalHeader(sourcePath);
    if (!header || header.version !== 3 || header.sessionId !== row.nativeId || header.cwd !== row.cwd) {
      throw new WebError(409, "resume_source_changed", "共享会话日志已变化，无法恢复。");
    }
  }

  /** A Web-origin journal bound to a durable id must still exist as the same
   * canonical owned v3 file before it reopens, so a deletion or replacement
   * can never silently mint an empty native session under the preserved id. */
  async #verifyWebJournal(row: SavedSession): Promise<void> {
    const path = join(this.#directory, `${row.id}.jsonl`);
    if (await realpath(path).catch(() => undefined) !== path) {
      throw new WebError(409, "resume_source_changed", "本地会话日志已不在，无法恢复。");
    }
    const header = await readOwnedJournalHeader(path);
    if (!header || header.version !== 3 || header.sessionId !== row.nativeId || header.cwd !== row.cwd) {
      throw new WebError(409, "resume_source_changed", "本地会话日志已变化，无法恢复。");
    }
  }

  async #adoptOpen(row: SavedSession, opts: { sourcePath?: string; durableId?: string }) {
    const initial = await this.#open(row, { ...opts, publishName: false });
    const adopted = this.#adoptedRow(row, initial);
    if (adopted !== row) await this.#persist(row.id, () => adopted);
  }

  /** Adopted journals keep the native rename and flags; stale Web metadata is never pushed back. */
  #adoptedRow(row: SavedSession, initial: WireObject): SavedSession {
    let next = row;
    const name = typeof initial.sessionName === "string" ? initial.sessionName.trim().slice(0, 120) : "";
    if (name && name !== row.name) next = { ...next, name };
    if (typeof initial.archived === "boolean" && initial.archived !== row.archived) {
      next = { ...next, archived: initial.archived };
    }
    if (typeof initial.settled === "boolean" && initial.settled !== row.settled) {
      next = { ...next, settled: initial.settled };
    }
    return next;
  }

  /** CLI history resume: open or reuse the persisted Web bookmark bound to the same
   * native durable id and log file. The transcript is never copied; the source file
   * is resolved through the current authorized profile on every open. */
  async resumeCli(source: CliResumeSource, nameHint = ""): Promise<SessionView> {
    const workspaceKey = await this.#requireWorkspace(source.cwd, source.workspaceKey);
    if (!source.nativeSessionId || !source.sourcePath) {
      throw new WebError(400, "history_invalid", "这条 CLI 历史记录已损坏，无法读取。");
    }
    await this.#requirePrivateHost("resume_unsupported");
    const key = `${source.cwd}\n${source.nativeSessionId}`;
    const pending = this.#cliOpening.get(key);
    if (pending) return pending;
    const task = this.#resumeCliSource({ ...source, ...(workspaceKey === undefined ? {} : { workspaceKey }) }, nameHint);
    this.#cliOpening.set(key, task);
    try { return await task; } finally { if (this.#cliOpening.get(key) === task) this.#cliOpening.delete(key); }
  }

  async #resumeCliSource(source: CliResumeSource, nameHint: string): Promise<SessionView> {
    const existing = this.findAlias(source.nativeSessionId, source.cwd, source.workspaceKey);
    if (existing !== undefined) {
      await this.#resume(this.#row(existing));
      return this.#view(this.#row(existing));
    }
    const id = sessionKey.parse(crypto.randomUUID());
    const trimmed = nameHint.trim().slice(0, 120);
    const row: SavedSession = { id, cwd: source.cwd, name: trimmed || source.cwd,
      updatedAt: Date.now(), archived: false, settled: false,
      nativeId: source.nativeSessionId, cliBookmark: true,
      ...(source.workspaceKey === undefined ? {} : { workspaceKey: source.workspaceKey }) };
    const initial = await this.#open(row, { sourcePath: source.sourcePath, durableId: source.nativeSessionId });
    const adopted = this.#adoptedRow(row, initial);
    try {
      await this.#persist(id, () => adopted, true);
    } catch (error) {
      const route = this.#live.get(id)?.route;
      this.#live.delete(id);
      if (route) await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
      throw error;
    }
    return this.#view(adopted);
  }

  disconnected() {
    this.#live.clear();
    this.#transcripts.invalidate();
  }

  stop() {
    this.#stopping = true;
    for (const pending of this.#snapshots.values()) pending.abort.abort();
    this.#transcripts.stop();
  }

  event(frame: WireObject) {
    const target = [...this.#live.entries()].find(([, live]) => frame.sessionId === live.route);
    if (!target) return;
    const [sessionId, live] = target;
    if (frame.type === "agent_start" || frame.type === "agent_settled") {
      live.running = frame.type === "agent_start";
      this.fanout({ type: "sessions" });
    }
    // session_parked / session_released end the route the same way a close does:
    // the session row stays, but the next enter must reopen against the holder.
    if (frame.type === "session_closed" || frame.type === "session_parked" || frame.type === "session_released") {
      this.#live.delete(sessionId);
      this.#transcripts.invalidate(sessionId);
      this.fanout({ type: "sessions" });
    }
    if (frame.type === "session_replaced") {
      // A stable route is not proof of a stable native journal.
      this.#live.set(sessionId, { route: live.route, running: live.running });
      this.#transcripts.invalidate(sessionId);
    }
    if (frame.type === "compaction_end" && frame.aborted !== true && frame.success !== false &&
        !frame.errorMessage && !frame.error) {
      live.transcriptRevision = (live.transcriptRevision ?? 0) + 1;
      this.#transcripts.invalidate(sessionId);
    }
    const event = browserEvent(frame);
    if (event) this.fanout({ ...event, sessionId });
    if (this.#live.get(sessionId) === live) {
      const generationSpeed = live.speed?.observe(frame);
      if (generationSpeed) this.fanout({ type: "generation_speed", generationSpeed, sessionId });
    }
  }

  #snapshotScope(id: SessionKey): SnapshotScope {
    const row = this.#row(id);
    const live = this.#binding(id);
    const host = this.engine.status;
    const revision = live.transcriptRevision;
    const treeWrite = () => live.runtime && this.#treeWrites.get(live.runtime);
    const navigation = treeWrite();
    const isCurrent = () => {
      const current = this.#rows.get(id);
      return !this.#stopping && this.engine.status === host && host.online && this.#live.get(id) === live &&
        current?.cwd === row.cwd && current.workspaceKey === row.workspaceKey && current.nativeId === row.nativeId &&
        !this.#opening.has(id) && !this.#releasing.has(id) && live.transcriptRevision === revision &&
        !navigation?.pending && treeWrite() === navigation &&
        ![...this.#live].some(([other, candidate]) => other !== id && candidate.route === live.route);
    };
    const check = () => { if (!isCurrent()) throw sessionChanged(); };
    let workspace: { key?: string } | undefined;
    const verifyWorkspace = async () => {
      check();
      const key = await this.#requireRowWorkspace(row);
      if (workspace && workspace.key !== key) throw sessionChanged();
      workspace ??= { key };
      check();
    };
    // Modern peers expose the exact active source in get_state. Old hosts
    // without these fields are fenced by their route, open incarnation and events.
    const runtime = live.runtime;
    let source = runtime && { sessionId: runtime.sessionId, sessionFile: runtime.sessionFile };
    const matches = (raw: WireObject) => !source ||
      (raw.cwd === row.cwd && raw.sessionId === source.sessionId && raw.sessionFile === source.sessionFile);
    const identify = (raw: WireObject) => {
      check();
      if (!matches(raw) || (typeof raw.cwd === "string" && raw.cwd !== row.cwd)) throw sessionChanged();
      if (raw.cwd === row.cwd && typeof raw.sessionId === "string" && raw.sessionId &&
          typeof raw.sessionFile === "string" && raw.sessionFile) {
        source = { sessionId: raw.sessionId, sessionFile: raw.sessionFile };
      }
    };
    const verifySource = async () => {
      await verifyWorkspace();
      if (source) {
        const raw = await this.engine.requestExisting("get_state", { sessionId: live.route }, 5000).catch(error => {
          if (!(error instanceof WebError)) throw error;
          throw sessionChanged();
        });
        if (!matches(raw)) throw sessionChanged();
        await verifyWorkspace();
      }
      check();
    };
    return { route: live.route, check, isCurrent, verifyWorkspace, identify, verifySource };
  }

  async snapshot(id: SessionKey, signal?: AbortSignal): Promise<Snapshot> {
    if (signal?.aborted) throw snapshotAborted();
    let pending = this.#snapshots.get(id);
    if (!pending?.scope.isCurrent() || pending.abort.signal.aborted) {
      const scope = this.#snapshotScope(id);
      scope.check();
      const abort = new AbortController();
      const attempt: PendingSnapshot = { scope, abort, waiters: 0,
        result: this.#readSnapshot(id, scope, abort.signal).finally(() => {
          if (this.#snapshots.get(id) === attempt) this.#snapshots.delete(id);
        }) };
      this.#snapshots.set(id, attempt);
      pending = attempt;
    }
    pending.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      const result = signal === undefined ? await pending.result : await Promise.race([
        pending.result,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(snapshotAborted());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (signal?.aborted) throw snapshotAborted();
      pending.scope.check();
      return result;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (--pending.waiters === 0 && this.#snapshots.get(id) === pending) pending.abort.abort();
    }
  }

  async #readSnapshot(id: SessionKey, scope: SnapshotScope, signal: AbortSignal): Promise<Snapshot> {
    const check = () => {
      if (signal.aborted) throw snapshotAborted();
      scope.check();
    };
    await scope.verifyWorkspace();
    check();
    const capture = this.#transcripts.begin(id, scope.check, scope.verifySource);
    const onAbort = () => this.#transcripts.drop(capture);
    signal.addEventListener("abort", onAbort, { once: true });
    let committed = false;
    try {
      const [rawState, history] = await Promise.all([
        this.engine.requestExisting("get_state", { sessionId: scope.route }),
        this.engine.requestExisting("get_messages", { sessionId: scope.route }, undefined, row => capture.append(row)).catch(error => {
          // Only a locally proven read limit may return the interaction state
          // without history. Native refusals and malformed receipts publish nothing.
          if (!(error instanceof MessagesFrameError) || error.reason === "malformed") throw error;
          return undefined;
        }),
      ]);
      check();
      scope.identify(rawState);
      await scope.verifySource();
      check();
      const session = this.#view(this.#row(id));
      const generationSpeed = this.#live.get(id)?.speed?.latest;
      const base = { session, state: { ...state(rawState), isStreaming: session.running || rawState.isStreaming === true },
        handoff: this.#handoffEligibility(rawState), ...(generationSpeed === undefined ? {} : { generationSpeed }) };
      if (!history) {
        this.#transcripts.invalidate(id);
        const result = { ...base, messages: [], transcript: { status: "unavailable" as const } };
        if (jsonBytes(result) > TRANSCRIPT_PAGE_BYTES) throw snapshotStateTooLarge();
        return result;
      }
      if (!capture.seen) {
        if (!Array.isArray(history.messages)) throw new MessagesFrameError("malformed");
        for (const row of history.messages) capture.append(record(row), true);
        if (history.historyTruncated === true) capture.markOmitted();
      }
      if (history.historyOmitted === true) capture.markOmitted();
      const result = capture.page(undefined, base);
      await scope.verifySource();
      check();
      this.#transcripts.commit(capture);
      committed = true;
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!committed) this.#transcripts.drop(capture);
    }
  }

  async transcript(id: SessionKey, token: string, content: boolean) {
    const capture = this.#transcripts.current(id);
    const cursor = capture.cursor(token, content);
    try {
      await capture.verify();
      this.#transcripts.assertCurrent(capture);
      const result = content ? capture.content(cursor) : capture.page(cursor.row);
      await capture.verify();
      this.#transcripts.assertCurrent(capture);
      capture.check();
      return result;
    } catch (error) {
      if (error instanceof WebError && ["history_capture_failed", "session_changed", "workspace_refused", "unknown_session",
        "session_not_attached"].includes(error.code)) this.#transcripts.drop(capture);
      throw error;
    }
  }

  #runtimeRead(id: SessionKey): RuntimeReadScope | RuntimeInactiveReason {
    const row = this.#row(id);
    const live = this.#live.get(id);
    if (row.archived || !live || this.#opening.has(id) || this.#releasing.has(id)) {
      return "inactive";
    }
    if (this.engine.usesListeningTransport) return "unsupported";
    if (!live.runtime) return "binding_unverified";
    const host = this.engine.status;
    return {
      engine: this.engine, target: live.runtime, verifyWorkspace: () => this.#requireRowWorkspace(row),
      isCurrent: () => {
        const current = this.#rows.get(id);
        return this.engine.status === host && this.#live.get(id) === live &&
          current?.archived === false && current.cwd === row.cwd && current.nativeId === row.nativeId &&
          current.workspaceKey === row.workspaceKey && !this.#opening.has(id) && !this.#releasing.has(id) &&
          ![...this.#live].some(([other, current]) => other !== id && current.route === live.route);
      },
    };
  }

  async nativeRuntime(id: SessionKey) {
    const scope = this.#runtimeRead(id);
    return typeof scope === "string" ? unavailableNativeRuntime(scope) : readNativeRuntime(scope);
  }

  async instructions(id: SessionKey): Promise<InstructionsResult> {
    const scope = this.#runtimeRead(id);
    if (typeof scope === "string") return { status: scope === "unsupported" ? "unsupported" : "unavailable" };
    const { target, isCurrent, verifyWorkspace } = scope;
    const checkBinding = () => {
      if (!isCurrent()) throw new WebError(409, "session_changed", "会话连接已切换。");
    };
    const verifyBinding = async () => {
      checkBinding();
      const state = await this.engine.requestExisting("get_state", { sessionId: target.route }, 5_000);
      if (state.cwd !== target.cwd || state.sessionId !== target.sessionId || state.sessionFile !== target.sessionFile ||
          state.archived === true) throw new WebError(409, "session_changed", "会话连接已切换。");
      await verifyWorkspace();
      checkBinding();
    };
    try {
      await verifyWorkspace();
      await verifyBinding();
      checkBinding();
      const raw = await this.engine.requestExisting("read_project_file", { sessionId: target.route, path: INSTRUCTIONS_FILE }, 5_000);
      await verifyBinding();
      checkBinding();
      const reply = instructionsReply.safeParse(raw);
      if (!reply.success) return { status: "unavailable" };
      const { cwd, path, exists, content } = reply.data;
      if (cwd !== target.cwd || path !== INSTRUCTIONS_FILE) return { status: "refused" };
      if (!exists) return { status: "missing" };
      if (Buffer.byteLength(content, "utf8") > INSTRUCTIONS_MAX_BYTES) return { status: "too_large" };
      return { status: "ok", file: INSTRUCTIONS_FILE, content };
    } catch (error) {
      if (!isCurrent()) return { status: "refused" };
      if (!(error instanceof WebError)) throw error;
      switch (error.code) {
        case "unknown_command": return { status: "unsupported" };
        case "project_file_too_large": return { status: "too_large" };
        case "project_file_not_allowed":
        case "project_file_permission_denied":
        case "workspace_refused":
        case "session_changed":
        case "session_not_attached":
        case "unknown_session": return { status: "refused" };
        default: return { status: "unavailable" };
      }
    }
  }

  workbenchStatus(id: SessionKey) {
    return readWorkbenchStatus(this.#historyRead(id));
  }

  #historyRead(id: SessionKey): RuntimeReadScope | RuntimeInactiveReason {
    const scope = this.#runtimeRead(id);
    if (typeof scope === "string") return scope;
    const write = this.#treeWrites.get(scope.target);
    if (write?.pending) return "inactive";
    return { ...scope, isCurrent: () => scope.isCurrent() && this.#treeWrites.get(scope.target) === write };
  }

  tree(id: SessionKey, cursor?: string) {
    return readSessionTree(this.#historyRead(id), this.#treeCursors, cursor);
  }

  branchRuntime(id: SessionKey) {
    return readBranchRuntime(this.#historyRead(id));
  }

  async #navigate(id: SessionKey, action: Extract<Action, { action: "navigate" }>) {
    const scope = this.#runtimeRead(id);
    let write: { pending: boolean } | undefined;
    try {
      return await navigateSessionTree(scope, action, target => {
        write = { pending: true };
        this.#treeWrites.set(target, write);
        this.#treeCursors.invalidate(target);
        this.#transcripts.invalidate(id);
      }, () => this.#live.get(id)?.running === true || this.#modelWrites.has(id) ||
        (typeof scope !== "string" && this.#treeWrites.get(scope.target)?.pending === true));
    } finally {
      if (write) write.pending = false;
    }
  }

  nativeDag(id: SessionKey, key: string) {
    return readNativeDag(this.#runtimeRead(id), key);
  }

  /** Web alias for this native session and authorized directory identity.
   * A stale bookmark in the same path must neither mark history as adopted
   * nor shadow the currently authorized journal on resume. */
  findAlias(nativeSessionId: string, cwd: string, workspaceKey?: string): SessionKey | undefined {
    for (const row of this.#rows.values()) {
      if (row.cwd === cwd && row.nativeId === nativeSessionId &&
        (!(this.workspaces instanceof WorkspaceAccess) ||
          (workspaceKey !== undefined && this.#workspaceKeyForRow(row) === workspaceKey))) return row.id;
    }
    return undefined;
  }

  /** Durable native session id from `get_state`, for server-side integration only (never sent to the browser). */
  async nativeSessionId(id: SessionKey): Promise<string | undefined> {
    if (this.workspaces instanceof WorkspaceAccess) await this.#requireRowWorkspace(this.#row(id));
    const raw = await this.engine.requestExisting("get_state", { sessionId: this.#route(id) });
    const durable = record(raw).sessionId;
    return typeof durable === "string" && durable.length > 0 ? durable : undefined;
  }

  /** Sequential handoff: quiet native release with reason takeover, then a local
   * `omo --session` command for the same journal. Never interrupts, kills, or
   * copies the source. Refusals keep the session live; uncertain
   * transport outcomes drop the route without replay and reconcile on next resume. */
  async handoff(id: SessionKey): Promise<{ session: SessionView; command: string }> {
    const row = this.#row(id);
    if (this.workspaces instanceof WorkspaceAccess) await this.#requireRowWorkspace(row);
    const live = this.#live.get(id);
    if (!live) throw new WebError(409, "session_not_open", "会话未接入引擎，请先恢复会话。");
    if (this.#opening.has(id) || this.#releasing.has(id)) {
      throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    }
    this.#releasing.add(id);
    this.#transcripts.invalidate(id);
    try {
      await this.#requirePrivateHost("handoff_unsupported");
      let expectedPath = join(this.#directory, `${id}.jsonl`);
      if (row.cliBookmark || row.shared === true) {
        if (!row.nativeId || !this.resolveCli) {
          throw new WebError(409, "handoff_unavailable", "该书签缺少可用的来源解析。");
        }
        expectedPath = (await this.resolveCli(row.nativeId, row.cwd)).sourcePath;
      }
      const current = await this.#guardedState(id, live.route);
      const sessionFile = current.sessionFile;
      const durable = current.sessionId;
      if (typeof sessionFile !== "string" || typeof durable !== "string" || !durable ||
        current.cwd !== row.cwd || sessionFile !== expectedPath ||
        (row.nativeId !== undefined && durable !== row.nativeId)) {
        throw new WebError(409, "handoff_source_changed", "会话来源已变化，请刷新后重试。");
      }
      if (current.isStreaming === true || current.isCompacting === true ||
        current.isBashRunning === true || current.runPaused === true) {
        throw new WebError(409, "session_busy", "会话正在运行，请等待当前回合结束后再交接。");
      }
      if (array(current.pendingDialogs).length > 0 || array(current.pendingQuestions).length > 0) {
        throw new WebError(409, "dialog_pending", "会话有待处理的交互，请先处理后再交接。");
      }
      if (row.nativeId === undefined) {
        await this.#persist(id, previous => ({ ...(previous ?? row), nativeId: durable }));
      }
      if (this.workspaces instanceof WorkspaceAccess) await this.#requireRowWorkspace(row);
      try {
        await this.#releaseNative(live.route, row.cwd, durable, sessionFile);
      } catch (error) {
        if (error instanceof WebError && (error.status >= 500 ||
          ["release_failed", "unknown_session"].includes(error.code))) {
          if (this.#live.get(id)?.route === live.route) this.#live.delete(id);
          this.fanout({ type: "sessions" });
          if (error.code === "unknown_session") {
            throw new WebError(409, "session_not_open", "会话已不在引擎中，请重新恢复会话。");
          }
        }
        throw error;
      }
      this.#live.delete(id);
      this.fanout({ type: "sessions" });
      return { session: this.#view(this.#row(id)), command: this.#handoffCommand(row.cwd, sessionFile) };
    } finally {
      this.#releasing.delete(id);
    }
  }

  async #releaseNative(route: string, cwd: string, durable: string, sessionFile: string): Promise<void> {
    const fields = { sessionId: route, reason: "takeover" };
    let ack: WireObject;
    try {
      ack = record(await this.engine.requestExisting("release_session", fields));
    } catch (error) {
      // Senpi 2026.11.19-5 counts the caller as another attachment over
      // stdio. Retry only for the exact sole holder of our non-listening
      // child. Never allow the force flag to interrupt a native turn.
      if (!(error instanceof WebError) || error.code !== "attached" ||
        !this.engine.isPrivateHost || this.engine.usesListeningTransport) throw error;
      const listing = await this.engine.requestExisting("list_sessions").catch(() => undefined);
      const exact = array(listing?.sessions).map(record).filter(entry => entry.sessionId === route);
      if (exact.length !== 1 || exact[0].sessionPath !== sessionFile || exact[0].cwd !== cwd ||
        exact[0].durableSessionId !== durable || exact[0].attachments !== 1) throw error;
      ack = record(await this.engine.requestExisting("release_session", { ...fields, force: true }));
    }
    const dropped = record(ack.dropped);
    if (ack.released !== true || ack.session_path !== sessionFile ||
      !Array.isArray(dropped.deliveries) || dropped.deliveries.length !== 0 ||
      !Array.isArray(dropped.user_messages) || dropped.user_messages.length !== 0) {
      throw new WebError(502, "release_unverified", "OmO 释放确认与会话来源不一致，未返回可用命令。");
    }
  }

  async #guardedState(id: SessionKey, route: string): Promise<WireObject> {
    try {
      return record(await this.engine.requestExisting("get_state", { sessionId: route }));
    } catch (error) {
      if (error instanceof WebError && error.code === "unknown_session") {
        if (this.#live.get(id)?.route === route) {
          this.#live.delete(id);
          this.#transcripts.invalidate(id);
        }
        this.fanout({ type: "sessions" });
        throw new WebError(409, "session_not_open", "会话已不在引擎中，请重新恢复会话。");
      }
      throw error;
    }
  }

  /** Exact native last-assistant text for an active session. Only the text travels. */
  async lastAssistant(id: SessionKey): Promise<{ text: string | null }> {
    const route = this.#route(id);
    const data = record(await this.engine.requestExisting("get_last_assistant_text", { sessionId: route }));
    return { text: typeof data.text === "string" ? data.text : null };
  }

  handoffSupport(): { supported: boolean; reason?: string } {
    if (!this.engine.status.online) return { supported: false, reason: "engine_offline" };
    if (!this.engine.isPrivateHost || this.engine.usesListeningTransport) {
      return { supported: false, reason: "shared_transport" };
    }
    if (!this.engine.capabilities.has("release_caller_aware") || !this.engine.capabilities.has("session_held")) {
      return { supported: false, reason: "missing_capability" };
    }
    if (this.hostGuard?.sameProfile !== true) return { supported: false, reason: "profile_mismatch" };
    return { supported: true };
  }

  /** The local command pins the selected engine profile when configured, so the
   * reopened CLI never runs under the terminal's ambient, potentially different
   * configuration. No credentials or socket information ever travel. */
  #handoffCommand(cwd: string, sessionFile: string): string {
    const invoke = `omo --session ${shellQuote(sessionFile)}`;
    const profile = this.hostGuard?.profileDir;
    const scoped = profile === undefined ? invoke :
      `OMO_CODING_AGENT_DIR=${shellQuote(profile)} SENPI_CODING_AGENT_DIR=${shellQuote(profile)} ` +
      `PI_CODING_AGENT_DIR=${shellQuote(profile)} ${invoke}`;
    return `cd ${shellQuote(cwd)} && ${scoped}`;
  }

  #handoffEligibility(current: WireObject): { eligible: boolean; reason?: string } {
    const support = this.handoffSupport();
    if (!support.supported) return { eligible: false, reason: support.reason };
    if (current.isStreaming === true || current.isCompacting === true ||
      current.isBashRunning === true || current.runPaused === true) {
      return { eligible: false, reason: "session_busy" };
    }
    if (array(current.pendingDialogs).length > 0 || array(current.pendingQuestions).length > 0) {
      return { eligible: false, reason: "dialog_pending" };
    }
    return { eligible: true };
  }

  /** Web source; active sources use the authoritative native leaf, not the last line on disk.
   * Options are browser-safe. A clone with no current entry is not available. */
  async webBranchOptions(id: SessionKey): Promise<BranchOptions> {
    const loaded = await this.#webBranchSource(id);
    return loaded ? this.#branches.options(loaded) : { canClone: false, forkMessages: [] };
  }

  /** Creates a separate active Web session. Apply editorText only to its composer;
   * it is never prompted by Sessions. A cancellation has no session to select. */
  async branchWeb(id: SessionKey, selection: BranchSelection): Promise<BranchResult> {
    if (this.#releasing.has(id)) throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    const loaded = await this.#webBranchSource(id);
    if (!loaded) throw staleBranch();
    const branch = await this.#branches.prepare(this.#directory, loaded, selection);
    const row = this.#row(id);
    return this.#publishBranch(loaded.source.cwd, branch, row.name, selection, loaded.source.sourcePath, this.#workspaceKeyForRow(row));
  }

  /** CLI history: use CliHistory.branchSource(id, cwd) after resolving the opaque key.
   * Attached CLI: also supply leafId from an authorized, idle native get_tree (omit only for offline history).
   * Do not serialize `source` or let the browser provide any part of it. */
  async branchOptionsFor(source: ScopedBranchSource): Promise<BranchOptions> {
    await this.#authorizeBranchSource(source.cwd, source.workspaceKey);
    return this.#branches.options(await loadBranchSource(source));
  }

  /** See branchOptionsFor for source resolution. Returns the same result as branchWeb. */
  async branchFrom(source: ScopedBranchSource, selection: BranchSelection): Promise<BranchResult> {
    const workspaceKey = await this.#authorizeBranchSource(source.cwd, source.workspaceKey);
    const branch = await this.#branches.prepare(this.#directory, await loadBranchSource(source), selection);
    return this.#publishBranch(source.cwd, branch, branch.cancelled ? undefined : branch.name,
      selection, source.sourcePath, workspaceKey);
  }

  async #authorizeBranchSource(cwd: string, expectedKey?: string) {
    const key = await this.#requireWorkspace(cwd, expectedKey);
    const store = await lstat(this.#directory);
    if (!store.isDirectory() || (store.mode & 0o077) !== 0 || (process.getuid && store.uid !== process.getuid()) ||
      await realpath(this.#directory) !== this.#directory) {
      throw new WebError(500, "invalid_store", "分支需要独立的 Web 会话目录。");
    }
    return key;
  }

  async #webBranchSource(id: SessionKey): Promise<LoadedBranchSource | undefined> {
    const row = this.#row(id);
    const { cwd } = row;
    await this.#authorizeBranchSource(cwd, await this.#requireRowWorkspace(row));
    let sourcePath = join(this.#directory, `${id}.jsonl`);
    let bookmarked: string | undefined;
    if (row.cliBookmark || row.shared === true) {
      if (!row.nativeId || !this.resolveCli) throw staleBranch();
      bookmarked = row.nativeId;
      sourcePath = (await this.resolveCli(row.nativeId, cwd)).sourcePath;
    }
    const live = this.#live.get(id);
    if (!live) {
      if (this.#opening.has(id)) throw branchBusy();
      const saved = bookmarked === undefined
        ? await loadSavedWebBranch(cwd, sourcePath)
        : await loadBranchSource({ cwd, sourcePath, nativeSessionId: bookmarked });
      if (this.#live.has(id) || this.#opening.has(id)) throw branchBusy();
      return saved;
    }
    const host = this.engine.status;
    const { route } = live;
    const isCurrent = () => this.engine.status === host && this.#live.get(id) === live;
    const readSource = async () => {
      if (!isCurrent()) throw staleBranch();
      if (live.running) throw branchBusy();
      const [source, leafId] = await Promise.all([
        this.engine.requestExisting("get_state", { sessionId: route }, 15_000).catch(nativeBranchError),
        readBranchLeaf({ engine: this.engine, target: { route }, isCurrent }, staleBranch),
      ]);
      if (live.running || source.isStreaming === true || source.isCompacting === true ||
        source.isBashRunning === true || source.runPaused === true) throw branchBusy();
      if (!isCurrent() || source.cwd !== cwd || source.sessionFile !== sourcePath ||
        typeof source.sessionId !== "string" || (bookmarked !== undefined && source.sessionId !== bookmarked)) throw staleBranch();
      return { cwd, sourcePath, nativeSessionId: source.sessionId, leafId };
    };
    const source = await readSource();
    const loaded = await loadBranchSource(source, true);
    const checked = await readSource();
    if (source.nativeSessionId !== checked.nativeSessionId || source.leafId !== checked.leafId) throw staleBranch();
    return loaded;
  }

  async #publishBranch(cwd: string, branch: PreparedBranch, name: string | undefined,
    selection: BranchSelection, placeNear?: string, expectedKey?: string): Promise<BranchResult> {
    if (branch.cancelled) return { cancelled: true };
    const workspaceKey = await this.#authorizeBranchSource(cwd, expectedKey);
    const id = sessionKey.parse(crypto.randomUUID());
    const suffix = selection.kind === "fork" ? "分支" : "副本";
    const base = name?.trim().slice(0, 116);
    // Shared-mode sources keep the branch next to the source journal in the
    // native profile bucket so the CLI picker discovers it without copying;
    // legacy sources keep the private dataDir journal. The identity guards in
    // #open apply unchanged to either placement.
    const profileDir = await this.#sharedProfileDir().catch(() => undefined);
    const bucket = profileDir === undefined ? undefined
      : join(profileDir, "sessions", sessionDirName(cwd));
    const sharedPlacement = bucket !== undefined && placeNear !== undefined && dirname(placeNear) === bucket;
    let row: SavedSession = { id, cwd, name: base ? `${base} · ${suffix}` : suffix,
      updatedAt: Date.now(), archived: false, settled: false, ...(workspaceKey === undefined ? {} : { workspaceKey }) };
    const path = sharedPlacement
      ? join(bucket as string, `${Date.now()}_${branch.nativeId}.jsonl`)
      : join(this.#directory, `${id}.jsonl`);
    await this.#requireWorkspace(cwd, workspaceKey);
    await writeFile(path, branch.transcript, { flag: "wx", mode: 0o600 });
    if (sharedPlacement) row = { ...row, nativeId: branch.nativeId, shared: true };
    // An unconfirmed open (e.g. RPC timeout) might still be writing. Never unlink
    // its transcript or close an unverified route; no Web index is published.
    await this.#open(row, { branchNativeId: branch.nativeId, sourcePath: path, publishName: true });
    try {
      await this.#persist(id, () => row, true);
    } catch (error) {
      const route = this.#live.get(id)?.route;
      this.#live.delete(id);
      if (route) {
        try {
          await this.engine.requestExisting("close_session", { sessionId: route }, 5_000);
          await unlink(path);
        } catch (cleanupError) {
          if (!(cleanupError instanceof Error)) throw cleanupError;
          // Preserve the original failure. The unpublished transcript is private.
        }
      }
      throw error;
    }
    return { session: this.#view(row), ...(branch.editorText !== undefined ? { editorText: branch.editorText } : {}) };
  }

  async capabilities(id: SessionKey) {
    const live = this.#binding(id);
    const inventory = await readNativeSurfaces(this.engine, live.route);
    if (this.#binding(id) !== live) {
      throw new WebError(409, "session_changed", "会话连接已切换，请重新读取。");
    }
    return inventory;
  }

  async options(id: SessionKey) {
    const params = { sessionId: this.#route(id) };
    const [models, levels, commands] = await Promise.all([
      this.engine.requestExisting("get_available_models", params),
      this.engine.requestExisting("get_available_thinking_levels", params),
      this.engine.requestExisting("get_commands", params),
    ]);
    return {
      models: array(models.models).map(model),
      levels: array(levels.levels),
      commands: projectCommands(commands.commands),
    };
  }

  #modelControl(id: SessionKey) {
    const live = this.#binding(id);
    const checkBinding = () => {
      if (this.#live.get(id) !== live || this.#releasing.has(id)) {
        throw new WebError(409, "session_changed", "会话连接已切换，请重新读取。");
      }
    };
    const request = (method: string, fields: WireObject = {}) => {
      checkBinding();
      return this.engine.requestExisting(method, { ...fields, sessionId: live.route }, 5_000);
    };
    const readState = async (writing: boolean) => {
      const current = await request("get_state");
      checkBinding();
      if ((typeof current.cwd === "string" && current.cwd !== this.#row(id).cwd) ||
          (live.runtime && (current.sessionId !== live.runtime.sessionId || current.sessionFile !== live.runtime.sessionFile)) ||
          (this.#row(id).nativeId !== undefined && current.sessionId !== this.#row(id).nativeId)) {
        throw new WebError(409, "session_changed", "会话连接已切换，请重新读取。");
      }
      if (current.pendingModelSwitch != null || (!writing && this.#modelWrites.has(id))) {
        throw new WebError(409, "model_switch_pending", "模型设置正在变更，请稍后再试。");
      }
      if (writing && (live.running || this.#row(id).archived || current.archived === true ||
          current.isStreaming === true || current.isCompacting === true)) {
        throw new WebError(409, "session_busy", "请在会话空闲且未归档时更改模型设置。");
      }
      return current;
    };
    const assertStable = async (before: WireObject, writing: boolean) => {
      const after = await readState(writing);
      const a = record(before.model), b = record(after.model);
      if (before.sessionId !== after.sessionId || before.sessionFile !== after.sessionFile || before.cwd !== after.cwd || a.provider !== b.provider ||
          a.id !== b.id || before.thinkingLevel !== after.thinkingLevel || before.thinkingLevelSource !== after.thinkingLevelSource) {
        throw new WebError(409, "session_changed", "会话或模型设置已变化，请重新读取。");
      }
    };
    const requireModel = async (target: ModelTarget) => {
      if (!registeredModel((await request("get_available_models")).models, target)) {
        throw new WebError(404, "model_not_found", "该模型不在当前会话的可用列表中。");
      }
    };
    return { request, checkBinding, readState, assertStable, requireModel };
  }

  async modelPreview(id: SessionKey, target: ModelTarget) {
    const control = this.#modelControl(id);
    const before = await control.readState(false);
    await control.requireModel(target);
    const profile = await control.request("get_model_thinking_level", target).catch(error => {
      if (!(error instanceof WebError)) throw error;
      return undefined;
    });
    await control.assertStable(before, false);
    return modelProfile(profile);
  }

  async #changeModelOptions(id: SessionKey, action: Extract<Action, { action: "model" | "thinking" }>) {
    if (this.#modelWrites.has(id)) throw new WebError(409, "model_switch_pending", "模型设置正在变更，请稍后再试。");
    const control = this.#modelControl(id);
    this.#modelWrites.add(id);
    try {
      const before = await control.readState(true);
      if (action.action === "model") {
        if (!this.engine.capabilities.has("session_model_scope")) throw new WebError(409, "unsupported", "此 OmO 版本不支持仅切换当前会话模型。");
        const target = { provider: action.provider, modelId: action.modelId };
        await control.requireModel(target);
        await control.assertStable(before, true);
        await control.request("set_model", { ...target, scope: "session" });
      } else {
        const { levels } = await control.request("get_available_thinking_levels");
        if (!array(levels).includes(action.level)) {
          throw new WebError(400, "unsupported_thinking_level", "当前模型不支持该思考档。");
        }
        await control.assertStable(before, true);
        await control.request("set_thinking_level", { level: action.level, scope: "turn" });
      }
      control.checkBinding();
    } finally {
      this.#modelWrites.delete(id);
    }
  }

  async details(id: SessionKey) {
    const live = this.#binding(id);
    const params = { sessionId: live.route };
    // Optional queue text, history, and branch panels do not gate the overview.
    const [stats, rawState, listing] = await Promise.all([
      this.engine.requestExisting("get_session_stats", params),
      this.engine.requestExisting("get_state", params).catch(() => undefined),
      this.engine.requestExisting("list_sessions").catch(() => undefined),
    ]);
    const safeState = rawState && state(rawState);
    const pendingCount = safeState?.pendingMessageCount;
    const generationSpeed = this.#live.get(id) === live ? live.speed?.latest : undefined;
    return {
      stats: pick(stats, ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "tokens", "cost", "contextUsage", "failures"]),
      state: safeState && {
        ...pick(safeState, ["model", "thinkingLevel", "thinkingLevelSource", "fastMode", "autoCompactionEnabled",
          "permissionPreset", "effectivePermissionPreset"]),
        ...(typeof pendingCount === "number" && Number.isSafeInteger(pendingCount) && pendingCount >= 0
          ? { pendingMessageCount: pendingCount } : {}),
        contextUsage: pick(safeState.contextUsage, ["tokens", "contextWindow", "percent"]),
        usageTotals: pick(safeState.usageTotals, ["input", "output", "cacheRead", "cacheWrite", "latestCacheHitRate"]),
      },
      sessionMemory: projectSessionMemory(listing, params.sessionId),
      ...(generationSpeed === undefined ? {} : { generationSpeed }),
    };
  }

  async queue(id: SessionKey) {
    const row = this.#row(id);
    const live = this.#binding(id);
    const host = this.engine.status;
    const verify = async () => {
      await this.#requireRowWorkspace(row);
      if (this.engine.status !== host || this.#live.get(id) !== live || this.#opening.has(id) || this.#releasing.has(id)) {
        throw new WebError(409, "session_changed", "会话连接已切换，请重新读取。");
      }
    };
    await verify();
    const queue = await this.engine.requestExisting("get_pending_inputs", { sessionId: live.route }, 8_000).catch(error => {
      if (!(error instanceof WebError)) throw error;
      if (error.status === 502 && error.code === "engine_frame_too_large") {
        throw new WebError(502, "queue_too_large", "原生队列响应超过读取上限。");
      }
      throw new WebError(502, "queue_read_failed", "无法读取待处理输入。");
    });
    await verify();
    if (!Array.isArray(queue.inputs)) throw new WebError(502, "queue_read_failed", "无法读取待处理输入。");
    const inputs: { readonly text: string; readonly state?: string; readonly requestedMode?: string }[] = [];
    let truncated = queue.inputs.length > QUEUE_SCAN_ROWS;
    for (const row of queue.inputs.slice(0, QUEUE_SCAN_ROWS)) {
      const input = record(row);
      if (input.state != null && (typeof input.state !== "string" || !activeQueueStates.has(input.state))) continue;
      if (inputs.length === QUEUE_PREVIEW_ROWS) {
        truncated = true;
        break;
      }
      const text = typeof input.text === "string" ? input.text : "";
      if (text.length > QUEUE_PREVIEW_TEXT) truncated = true;
      inputs.push({
        text: text.slice(0, QUEUE_PREVIEW_TEXT).replace(/[\uD800-\uDBFF]$/u, ""),
        ...(typeof input.state === "string" ? { state: input.state } : {}),
        ...(typeof input.requestedMode === "string" && queueModes.has(input.requestedMode)
          ? { requestedMode: input.requestedMode } : {}),
      });
    }
    return { inputs, truncated };
  }

  async action(id: SessionKey, action: Action): Promise<{ result: WireObject; session: SessionView }> {
    // Inputs and UI answers must still work while compaction or a prompt is active.
    const row = this.#row(id);
    if (this.#releasing.has(id)) throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    if (action.action === "resume") {
      await this.#resume(row);
      return { result: {}, session: this.#view(this.#row(id)) };
    }
    if (action.action === "navigate") {
      const result = await this.#navigate(id, action);
      return { result, session: this.#view(this.#row(id)) };
    }
    if (this.workspaces instanceof WorkspaceAccess && action.action !== "abort") {
      await this.#requireRowWorkspace(row);
    }
    const sessionId = this.#route(id);
    const request = (name: string, fields: WireObject = {}, timeout?: number) =>
      this.engine.requestExisting(name, { ...fields, sessionId }, timeout);
    let result: WireObject = {};
    switch (action.action) {
      case "prompt": {
        if (!action.message.trim() && !action.images?.length) throw new WebError(400, "empty_prompt", "请输入内容或添加图片。");
        refuseRuntimeCommandRelay(action.message);
        result = pick(await request(action.mode, { message: action.message, images: action.images,
          clientMessageId: action.clientMessageId, expectedTurnId: action.expectedTurnId }, 90_000),
        ["disposition", "turnId", "clientMessageId", "duplicate"]);
        await this.#persist(id, previous => ({ ...(previous ?? row), updatedAt: Date.now() }));
        break;
      }
      case "command": {
        refuseRuntimeCommandRelay(action.invocation);
        const catalog = projectCommands((await request("get_commands")).commands);
        const target = resolveCommand(catalog, action.invocation);
        if (!target) throw new WebError(400, "unknown_command", "该命令不存在或在此会话不可用，不会发送给模型。");
        if (state(await request("get_state")).isStreaming === true) {
          throw new WebError(409, "session_busy", "会话正在运行，请等待当前回合结束后再执行命令。");
        }
        const message = composeMessage(target, action.arguments);
        result = pick(await request("prompt", { message, clientMessageId: action.clientMessageId }, 90_000),
          ["disposition", "turnId", "clientMessageId", "duplicate"]);
        await this.#persist(id, previous => ({ ...(previous ?? row), updatedAt: Date.now() }));
        break;
      }
      case "abort": await request("abort"); break;
      case "rename":
        await request("set_session_name", { name: action.name });
        await this.#persist(id, previous => ({ ...(previous ?? row), name: action.name }));
        break;
      case "archive":
        await request("set_session_archived", { archived: action.enabled });
        await this.#persist(id, previous => ({ ...(previous ?? row), archived: action.enabled }));
        break;
      case "settle":
        await request("set_session_settled", { settled: action.enabled });
        await this.#persist(id, previous => ({ ...(previous ?? row), settled: action.enabled }));
        break;
      case "model":
      case "thinking": await this.#changeModelOptions(id, action); break;
      case "preset": {
        // Per-session preset only: open_session always pins ask, so every
        // reopen/ownership change reverts to ask until the user explicitly
        // switches again. Never touches the global profile or project trust
        // flags (`--no-approve` stays a launch-level project-trust setting).
        if (action.preset === "auto" && !this.engine.capabilities.has("permission_preset_auto")) {
          throw new WebError(409, "unsupported", "此 OmO 版本不支持自动批准。");
        }
        const applied = record(await request("set_permission_preset", { permissionPreset: action.preset }));
        if (applied.permissionPreset !== action.preset || applied.permissionPresetStatus !== "applied") {
          throw new WebError(502, "preset_unconfirmed", "OmO 未确认审批模式，请刷新检查生效状态。");
        }
        const current = state(await request("get_state"));
        const effective = current.effectivePermissionPreset;
        if (effective !== action.preset) {
          throw new WebError(502, "preset_unconfirmed", "OmO 未确认请求的审批模式已生效，请刷新检查。");
        }
        // Structured questions stay explicit under every preset: pendingQuestions
        // is still projected and the answer path still requires `answers` for
        // method question (see case "answer"). Secret/private prompts never
        // reach the browser (see dialog()).
        result = { preset: effective };
        break;
      }
      case "fast": await request("set_fast_mode", { enabled: action.enabled }); break;
      case "autoCompaction": await request("set_auto_compaction", { enabled: action.enabled }); break;
      case "compact": {
        const current = state(await request("get_state"));
        if (row.archived || current.isStreaming === true || current.isCompacting === true ||
          (typeof current.pendingMessageCount === "number" && current.pendingMessageCount > 0) || this.#live.get(id)?.running) {
          throw new WebError(409, "session_busy", "请等会话空闲且队列清空后再压缩，或先取消归档。");
        }
        const live = this.#live.get(id);
        const revision = live?.transcriptRevision;
        const result = await request("compact", { customInstructions: action.instructions }, 180_000);
        // Some compatible peers acknowledge a successful explicit compaction
        // without a compaction_end event.
        if (live && this.#live.get(id) === live && live.transcriptRevision === revision &&
            result.success !== false && result.aborted !== true && !result.error && !result.errorMessage) {
          live.transcriptRevision = (revision ?? 0) + 1;
          this.#transcripts.invalidate(id);
        }
        break;
      }
      case "clearQueue": await request("clear_queue"); break;
      case "answer": {
        const pending = state(await request("get_state"));
        const entry = [...array(pending.pendingQuestions), ...array(pending.pendingDialogs)].map(record).find(d => d.id === action.requestId);
        if (!entry) throw new WebError(409, "unknown_dialog", "这项交互已结束，或不能在 Web 端处理。");
        if (!action.cancelled) {
          const allowed = entry.method === "select" ? array(entry.options).includes(action.value) :
            entry.method === "confirm" ? action.confirmed !== undefined :
            entry.method === "question" ? action.answers !== undefined : action.value !== undefined;
          if (!allowed) throw new WebError(400, "invalid_answer", "回答与当前 OmO 交互不匹配。");
        }
        const { requestId, action: _kind, ...answer } = action;
        await request("extension_ui_response", { uiRequestId: requestId, ...answer });
        this.fanout({ type: "extension_ui_resolved", id: requestId, sessionId: id });
        break;
      }
    }
    return { result, session: this.#view(this.#row(id)) };
  }
}
