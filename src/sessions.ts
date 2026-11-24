import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WebError, array, browserEvent, model, pick, record, sessionKey, state, transcriptMessage, transcriptTree } from "./protocol.ts";
import type { Action, SessionKey, WireObject } from "./protocol.ts";
import type { Engine } from "./engine.ts";

const savedSession = z.strictObject({
  id: sessionKey,
  name: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
  archived: z.boolean(),
  settled: z.boolean(),
});
type SavedSession = Readonly<z.infer<typeof savedSession>>;
type SessionView = SavedSession & { readonly active: boolean; readonly running: boolean };

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
  readonly #directory: string;

  constructor(dataDir: string, readonly workspaces: readonly string[], readonly engine: Engine,
    readonly fanout: (value: WireObject) => void) {
    this.#directory = join(dataDir, "sessions");
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
    return { ...row, active: Boolean(live), running: live?.running ?? false };
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

  async #persist(id: SessionKey, update: (previous: SavedSession | undefined) => SavedSession) {
    const previousWrite = this.#writes.get(id);
    const write = async () => {
      const row = update(this.#rows.get(id));
      const temp = join(this.#directory, `${row.id}.${crypto.randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(row), { mode: 0o600, flag: "wx" });
      await rename(temp, join(this.#directory, `${row.id}.json`));
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
    const row = { id, cwd, name, updatedAt: Date.now(), archived: false, settled: false };
    await this.#open(row);
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

  async #open(row: SavedSession) {
    let actual: string | undefined;
    try { actual = await realpath(row.cwd); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!this.workspaces.includes(row.cwd) || actual !== row.cwd) {
      throw new WebError(403, "workspace_refused", "工作目录已不在启动配置中，或目标路径已改变。");
    }
    const result = await this.engine.request("open_session", {
      cwd: row.cwd,
      sessionPath: join(this.#directory, `${row.id}.jsonl`),
      permissionPreset: "ask",
      kind: "interactive",
      retain_on_disconnect: true,
      auto_title: false,
    }, 60_000);
    const route = result.sessionId;
    if (typeof route !== "string") throw new WebError(502, "invalid_engine_reply", "OmO 没有返回会话句柄。");
    const initial = record(result.state);
    if (result.permissionPreset !== "ask" || result.permissionPresetStatus !== "applied") {
      await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
      throw new WebError(409, "permission_mode_unconfirmed", "OmO 未确认 ask 权限模式，未开放该会话。");
    }
    this.#live.set(row.id, { route, running: initial.isStreaming === true });
    if (initial.sessionName !== row.name) {
      try { await this.engine.requestExisting("set_session_name", { sessionId: route, name: row.name }); }
      catch (error) {
        this.#live.delete(row.id);
        await this.engine.requestExisting("close_session", { sessionId: route }).catch(() => undefined);
        throw error;
      }
    }
  }

  async #resume(row: SavedSession) {
    if (this.#live.has(row.id)) return;
    const opening = this.#opening.get(row.id);
    if (opening) return opening;
    const pending = this.#open(row);
    this.#opening.set(row.id, pending);
    try { await pending; } finally { this.#opening.delete(row.id); }
    this.fanout({ type: "sessions" });
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
      messages: array(history.messages).flatMap(m => transcriptMessage(m) ?? []) };
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
      commands: array(commands.commands).map(command => pick(command, ["name", "description", "source"])),
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
          clientMessageId: action.clientMessageId, expectedTurnId: action.expectedTurnId, ...(action.mode === "prompt" ? { unknownCommandAsText: true } : {}) }, 90_000),
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
      case "thinking": await request("set_thinking_level", { level: action.level }); break;
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
