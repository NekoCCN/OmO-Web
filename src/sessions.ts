import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { composeMessage, projectCommands, resolveCommand } from "./commands.ts";
import { WebError, array, browserEvent, model, pick, record, sessionKey, state, transcriptMessage, transcriptTree } from "./protocol.ts";
import type { Action, SessionKey, WireObject } from "./protocol.ts";
import type { Engine } from "./engine.ts";
import { readOwnedJournalHeader } from "./cli-history.ts";
import { branchBusy, loadBranchSource, loadSavedWebBranch, nativeBranchError, SessionBranches, staleBranch } from "./session-branches.ts";
import type { BranchOptions, BranchSelection, BranchSource, LoadedBranchSource, PreparedBranch } from "./session-branches.ts";

const savedSession = z.strictObject({
  id: sessionKey,
  name: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
  archived: z.boolean(),
  settled: z.boolean(),
  nativeId: z.string().min(1).max(200).optional(),
  cliBookmark: z.boolean().optional(),
});
type SavedSession = Readonly<z.infer<typeof savedSession>>;
export type SessionView = Omit<SavedSession, "nativeId" | "cliBookmark"> & { readonly active: boolean; readonly running: boolean };
export type CliResumeSource = { readonly cwd: string; readonly nativeSessionId: string; readonly sourcePath: string };

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
export type BranchResult = { readonly cancelled: true; readonly session?: never; readonly editorText?: never } |
  { readonly session: SessionView; readonly editorText?: string; readonly cancelled?: false };

export async function authorizedRoots(roots: readonly string[]): Promise<readonly string[]> {
  const canonical = await Promise.all(roots.map(async root => {
    const target = await realpath(root);
    if (!(await lstat(target)).isDirectory()) throw new WebError(400, "invalid_workspace", `不是目录：${target}`);
    return target;
  }));
  return [...new Set(canonical)];
}

export class Sessions {
  readonly #rows = new Map<SessionKey, SavedSession>();
  readonly #live = new Map<SessionKey, { route: string; running: boolean }>();
  readonly #opening = new Map<SessionKey, Promise<void>>();
  readonly #writes = new Map<SessionKey, Promise<unknown>>();
  readonly #releasing = new Set<SessionKey>();
  readonly #cliOpening = new Map<string, Promise<SessionView>>();
  readonly #directory: string;
  readonly #branches: SessionBranches;

  constructor(dataDir: string, readonly workspaces: readonly string[], readonly engine: Engine,
    readonly fanout: (value: WireObject) => void,
    readonly resolveCli?: (nativeSessionId: string, cwd: string) => Promise<{ sourcePath: string }>,
    readonly hostGuard?: { sameProfile: boolean; profileDir?: string }) {
    this.#directory = resolve(dataDir, "sessions");
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
    return [...this.#rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(row => this.#view(row));
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

  #route(id: SessionKey): string {
    this.#row(id);
    const live = this.#live.get(id);
    if (!live) throw new WebError(409, "session_not_open", "会话未接入引擎，请先恢复会话。");
    return live.route;
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

  async create(cwd: string, name = "新会话"): Promise<SessionView> {
    if (!this.workspaces.includes(cwd)) throw new WebError(403, "workspace_refused", "只能选择启动配置中允许的工作目录。");
    const id = sessionKey.parse(crypto.randomUUID());
    const row: SavedSession = { id, cwd, name, updatedAt: Date.now(), archived: false, settled: false };
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

  async #open(row: SavedSession, opts: { branchNativeId?: string; sourcePath?: string; durableId?: string; publishName?: boolean } = {}): Promise<WireObject> {
    let actual: string | undefined;
    try { actual = await realpath(row.cwd); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!this.workspaces.includes(row.cwd) || actual !== row.cwd) {
      throw new WebError(403, "workspace_refused", "工作目录已不在启动配置中，或目标路径已改变。");
    }
    const sessionPath = opts.sourcePath ?? join(this.#directory, `${row.id}.jsonl`);
    const fields: WireObject = {
      cwd: row.cwd,
      sessionPath,
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
    // Exact native identity checks apply only to native-bound opens (CLI bookmarks,
    // durable-verified reopens, branches). Plain Web opens keep the legacy contract
    // so older fixtures without a state projection still open.
    if (bound !== undefined) {
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
    this.#live.set(row.id, { route, running: initial.isStreaming === true });
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
    try {
      await this.engine.probe();
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError(503, "engine_unavailable", "OmO 连接已断开。");
    }
    if (!this.engine.usesPrivateSocketTransport) {
      throw new WebError(409, code, "顺序换端需要私有本机传输。");
    }
    if (!this.engine.capabilities.has("release_caller_aware") || !this.engine.capabilities.has("session_held")) {
      throw new WebError(409, code, "此 OmO 版本不支持顺序换端。");
    }
    if (this.hostGuard?.sameProfile !== true) {
      throw new WebError(409, code, "本机引擎与 CLI 会话目录不是同一配置，拒绝换端。");
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
    if (!this.workspaces.includes(source.cwd) || await realpath(source.cwd).catch(() => undefined) !== source.cwd ||
      !(await lstat(source.cwd).catch(() => undefined))?.isDirectory()) {
      throw new WebError(403, "workspace_refused", "此工作目录已不可用。");
    }
    if (!source.nativeSessionId || !source.sourcePath) {
      throw new WebError(400, "history_invalid", "这条 CLI 历史记录已损坏，无法读取。");
    }
    await this.#requirePrivateHost("resume_unsupported");
    const key = `${source.cwd}\n${source.nativeSessionId}`;
    const pending = this.#cliOpening.get(key);
    if (pending) return pending;
    const task = this.#resumeCliSource(source, nameHint);
    this.#cliOpening.set(key, task);
    try { return await task; } finally { if (this.#cliOpening.get(key) === task) this.#cliOpening.delete(key); }
  }

  async #resumeCliSource(source: CliResumeSource, nameHint: string): Promise<SessionView> {
    const existing = [...this.#rows.values()].find(row => row.cwd === source.cwd && row.nativeId === source.nativeSessionId);
    if (existing) {
      await this.#resume(existing);
      return this.#view(this.#row(existing.id));
    }
    const id = sessionKey.parse(crypto.randomUUID());
    const trimmed = nameHint.trim().slice(0, 120);
    const row: SavedSession = { id, cwd: source.cwd, name: trimmed || source.cwd,
      updatedAt: Date.now(), archived: false, settled: false,
      nativeId: source.nativeSessionId, cliBookmark: true };
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
  }

  event(frame: WireObject) {
    const target = [...this.#live.entries()].find(([, live]) => frame.sessionId === live.route);
    if (!target) return;
    const [sessionId, live] = target;
    if (frame.type === "agent_start" || frame.type === "agent_settled") {
      live.running = frame.type === "agent_start";
      this.fanout({ type: "sessions" });
    }
    if (frame.type === "session_closed") {
      this.#live.delete(sessionId);
      this.fanout({ type: "sessions" });
    }
    const event = browserEvent(frame);
    if (event) this.fanout({ ...event, sessionId });
  }

  async snapshot(id: SessionKey) {
    const route = this.#route(id);
    const [rawState, history] = await Promise.all([
      this.engine.requestExisting("get_state", { sessionId: route }),
      this.engine.requestExisting("get_messages", { sessionId: route }),
    ]);
    const session = this.#view(this.#row(id));
    return { session, state: { ...state(rawState), isStreaming: session.running || rawState.isStreaming === true },
      messages: array(history.messages).flatMap(m => transcriptMessage(m) ?? []),
      handoff: this.#handoffEligibility(record(rawState)) };
  }

  /** Durable native session id from `get_state`, for server-side integration only (never sent to the browser). */
  async nativeSessionId(id: SessionKey): Promise<string | undefined> {
    const raw = await this.engine.requestExisting("get_state", { sessionId: this.#route(id) });
    const durable = record(raw).sessionId;
    return typeof durable === "string" && durable.length > 0 ? durable : undefined;
  }

  /** Sequential handoff: quiet native release with reason takeover, then a local
   * `omo --session` command for the same journal. Never interrupts, forces,
   * kills, or copies the source. Refusals keep the session live; uncertain
   * transport outcomes drop the route without replay and reconcile on next resume. */
  async handoff(id: SessionKey): Promise<{ session: SessionView; command: string }> {
    const row = this.#row(id);
    const live = this.#live.get(id);
    if (!live) throw new WebError(409, "session_not_open", "会话未接入引擎，请先恢复会话。");
    if (this.#opening.has(id) || this.#releasing.has(id)) {
      throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    }
    await this.#requirePrivateHost("handoff_unsupported");
    this.#releasing.add(id);
    try {
      let expectedPath = join(this.#directory, `${id}.jsonl`);
      if (row.cliBookmark) {
        if (!row.nativeId || !this.resolveCli) {
          throw new WebError(409, "handoff_unavailable", "该 CLI 书签缺少可用的来源解析。");
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
      const projected = state(current);
      if (array(projected.pendingDialogs).length > 0 || array(projected.pendingQuestions).length > 0) {
        throw new WebError(409, "dialog_pending", "会话有待处理的交互，请先处理后再交接。");
      }
      if (row.nativeId === undefined) {
        await this.#persist(id, previous => ({ ...(previous ?? row), nativeId: durable }));
      }
      let ack: WireObject;
      try {
        ack = record(await this.engine.requestExisting("release_session",
          { sessionId: live.route, reason: "takeover" }));
      } catch (error) {
        if (error instanceof WebError && (error.status >= 500 || error.code === "engine_timeout" ||
          error.code === "engine_unavailable" || error.code === "unknown_session")) {
          if (this.#live.get(id)?.route === live.route) this.#live.delete(id);
          this.fanout({ type: "sessions" });
          if (error.code === "unknown_session") {
            throw new WebError(409, "session_not_open", "会话已不在引擎中，请重新恢复会话。");
          }
        }
        throw error;
      }
      if (ack.released !== true || ack.session_path !== sessionFile) {
        if (this.#live.get(id)?.route === live.route) this.#live.delete(id);
        this.fanout({ type: "sessions" });
        throw new WebError(502, "release_unverified", "OmO 释放确认与会话来源不一致，未返回可用命令。");
      }
      this.#live.delete(id);
      this.fanout({ type: "sessions" });
      return { session: this.#view(this.#row(id)), command: this.#handoffCommand(row.cwd, sessionFile) };
    } finally {
      this.#releasing.delete(id);
    }
  }

  async #guardedState(id: SessionKey, route: string): Promise<WireObject> {
    try {
      return record(await this.engine.requestExisting("get_state", { sessionId: route }));
    } catch (error) {
      if (error instanceof WebError && error.code === "unknown_session") {
        if (this.#live.get(id)?.route === route) this.#live.delete(id);
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
    if (!this.engine.usesPrivateSocketTransport) return { supported: false, reason: "shared_transport" };
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

  /** Web source; active sources use the native get_tree leaf, not the last line on disk.
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
    return this.#publishBranch(loaded.source.cwd, branch, this.#row(id).name, selection);
  }

  /** CLI history: use CliHistory.branchSource(id, cwd) after resolving the opaque key.
   * Attached CLI: also supply leafId from an authorized, idle native get_tree (omit only for offline history).
   * Do not serialize `source` or let the browser provide any part of it. */
  async branchOptionsFor(source: BranchSource): Promise<BranchOptions> {
    await this.#authorizeBranchSource(source.cwd);
    return this.#branches.options(await loadBranchSource(source));
  }

  /** See branchOptionsFor for source resolution. Returns the same result as branchWeb. */
  async branchFrom(source: BranchSource, selection: BranchSelection): Promise<BranchResult> {
    await this.#authorizeBranchSource(source.cwd);
    const branch = await this.#branches.prepare(this.#directory, await loadBranchSource(source), selection);
    return this.#publishBranch(source.cwd, branch, branch.cancelled ? undefined : branch.name, selection);
  }

  async #authorizeBranchSource(cwd: string) {
    if (!this.workspaces.includes(cwd) || await realpath(cwd).catch(() => undefined) !== cwd ||
      !(await lstat(cwd).catch(() => undefined))?.isDirectory()) {
      throw new WebError(403, "workspace_refused", "此工作目录已不可用。");
    }
    const store = await lstat(this.#directory);
    if (!store.isDirectory() || (store.mode & 0o077) !== 0 || (process.getuid && store.uid !== process.getuid()) ||
      await realpath(this.#directory) !== this.#directory) {
      throw new WebError(500, "invalid_store", "分支需要独立的 Web 会话目录。");
    }
  }

  async #webBranchSource(id: SessionKey): Promise<LoadedBranchSource | undefined> {
    const row = this.#row(id);
    const { cwd } = row;
    await this.#authorizeBranchSource(cwd);
    let sourcePath = join(this.#directory, `${id}.jsonl`);
    let bookmarked: string | undefined;
    if (row.cliBookmark) {
      if (!row.nativeId || !this.resolveCli) throw staleBranch();
      bookmarked = row.nativeId;
      sourcePath = (await this.resolveCli(row.nativeId, cwd)).sourcePath;
    }
    const route = this.#live.get(id)?.route;
    if (!route) {
      if (this.#opening.has(id)) throw branchBusy();
      const saved = bookmarked === undefined
        ? await loadSavedWebBranch(cwd, sourcePath)
        : await loadBranchSource({ cwd, sourcePath, nativeSessionId: bookmarked });
      if (this.#live.has(id) || this.#opening.has(id)) throw branchBusy();
      return saved;
    }
    const readSource = async () => {
      const live = this.#live.get(id);
      if (live?.route !== route) throw staleBranch();
      if (live.running) throw branchBusy();
      const request = (name: string) => this.engine.requestExisting(name, { sessionId: route }, 15_000).catch(nativeBranchError);
      const [source, tree] = await Promise.all([request("get_state"), request("get_tree")]);
      if (live.running || source.isStreaming === true || source.isCompacting === true ||
        source.isBashRunning === true || source.runPaused === true) throw branchBusy();
      if (this.#live.get(id) !== live || source.cwd !== cwd || source.sessionFile !== sourcePath ||
        typeof source.sessionId !== "string" || (bookmarked !== undefined && source.sessionId !== bookmarked) ||
        (tree.leafId !== null && typeof tree.leafId !== "string")) throw staleBranch();
      return { cwd, sourcePath, nativeSessionId: source.sessionId, leafId: tree.leafId };
    };
    const source = await readSource();
    const loaded = await loadBranchSource(source, true);
    const checked = await readSource();
    if (source.nativeSessionId !== checked.nativeSessionId || source.leafId !== checked.leafId) throw staleBranch();
    return loaded;
  }

  async #publishBranch(cwd: string, branch: PreparedBranch, name: string | undefined, selection: BranchSelection): Promise<BranchResult> {
    if (branch.cancelled) return { cancelled: true };
    await this.#authorizeBranchSource(cwd);
    const id = sessionKey.parse(crypto.randomUUID());
    const suffix = selection.kind === "fork" ? "分支" : "副本";
    const base = name?.trim().slice(0, 116);
    const row = { id, cwd, name: base ? `${base} · ${suffix}` : suffix, updatedAt: Date.now(), archived: false, settled: false };
    const path = join(this.#directory, `${id}.jsonl`);
    await writeFile(path, branch.transcript, { flag: "wx", mode: 0o600 });
    // An unconfirmed open (e.g. RPC timeout) might still be writing. Never unlink
    // its transcript or close an unverified route; no Web index is published.
    await this.#open(row, { branchNativeId: branch.nativeId, publishName: true });
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

  async details(id: SessionKey) {
    const params = { sessionId: this.#route(id) };
    const [stats, queue, tree] = await Promise.all([
      this.engine.requestExisting("get_session_stats", params),
      this.engine.requestExisting("get_pending_inputs", params),
      this.engine.requestExisting("get_tree", params),
    ]);
    return {
      stats: pick(stats, ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "tokens", "cost", "contextUsage", "failures"]),
      queue: pick(queue, ["lifetimeId", "throughCursor", "inputs", "outcomes"]),
      tree: transcriptTree(tree),
    };
  }

  async action(id: SessionKey, action: Action): Promise<{ result: WireObject; session: SessionView }> {
    // Inputs and UI answers must still work while compaction or a prompt is active.
    const row = this.#row(id);
    if (this.#releasing.has(id)) throw new WebError(409, "handoff_in_progress", "交接正在进行，请稍后再试。");
    if (action.action === "resume") {
      await this.#resume(row);
      return { result: {}, session: this.#view(this.#row(id)) };
    }
    const sessionId = this.#route(id);
    const request = (name: string, fields: WireObject = {}, timeout?: number) =>
      this.engine.requestExisting(name, { ...fields, sessionId }, timeout);
    let result: WireObject = {};
    switch (action.action) {
      case "prompt": {
        if (!action.message.trim() && !action.images?.length) throw new WebError(400, "empty_prompt", "请输入内容或添加图片。");
        result = pick(await request(action.mode, { message: action.message, images: action.images,
          clientMessageId: action.clientMessageId, expectedTurnId: action.expectedTurnId }, 90_000),
        ["disposition", "turnId", "clientMessageId", "duplicate"]);
        await this.#persist(id, previous => ({ ...(previous ?? row), updatedAt: Date.now() }));
        break;
      }
      case "command": {
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
        if (!this.engine.capabilities.has("session_model_scope")) throw new WebError(409, "unsupported", "此 OmO 版本不支持仅切换当前会话模型。");
        await request("set_model", { provider: action.provider, modelId: action.modelId, scope: "session" });
        break;
      case "thinking": await request("set_thinking_level", { level: action.level, scope: "turn" }); break;
      case "fast": await request("set_fast_mode", { enabled: action.enabled }); break;
      case "autoCompaction": await request("set_auto_compaction", { enabled: action.enabled }); break;
      case "compact": await request("compact", { customInstructions: action.instructions }, 180_000); break;
      case "clearQueue": await request("clear_queue"); break;
      case "navigate": {
        const current = await request("get_tree");
        result = pick(await request("navigate_tree", { targetId: action.targetId, expectedLeafId: current.leafId }),
          ["cancelled", "editorText", "leafId"]);
        break;
      }
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
