import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { CliHistory } from "./cli-history.ts";
import type { CliSessionSummary } from "./cli-history.ts";
import { Engine } from "./engine.ts";
import type { EngineStatus } from "./engine.ts";
import { modelTarget } from "./model-options.ts";
import { NativeActivity } from "./native-activity.ts";
import type { NativeActivityView } from "./native-activity.ts";
import { actions, emptyBody, openInput, sessionKey, WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { branchSelection } from "./session-branches.ts";
import { treeCursor } from "./session-entry-pages.ts";
import { Sessions } from "./sessions.ts";
import { TerminalSessions } from "./terminal-sessions.ts";
import { terminalInput } from "./terminal-view.ts";
import type { TerminalTranscript } from "./terminal-view.ts";
import { TRANSCRIPT_PAGE_BYTES } from "./transcript-pages.ts";
import { headers, loadWebAccess } from "./web-access.ts";
import { webAsset } from "./web-assets.ts";
import { WorkspaceAccess, workspacePlatform } from "./workspace-access.ts";

export type AppSettings = {
  readonly dataDir: string;
  readonly workspaces: readonly string[];
  readonly engineCommand: readonly [string, ...string[]];
  readonly port: number;
  readonly cliAgentDir?: string;
  readonly webEnv?: Readonly<NodeJS.ProcessEnv>;
};

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_SSE_FRAME_BYTES = 96 * 1024;
const MAX_STREAM_CLIENTS = 16;
const SSE_PREFIX = "event: omo\ndata: ";
const SSE_SUFFIX = "\n\n";
const LIVE_TRANSCRIPT_EVENTS = new Set([
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);
const encoder = new TextEncoder();
const workspacePath = z.strictObject({ path: z.string().min(1).max(4096) });
const workspaceDecision = z.strictObject({ confirmation: z.uuid(), allow: z.boolean() });
const cliLiveActions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("connect") }),
  z.strictObject({ action: z.literal("disconnect") }),
  terminalInput.omit({ expectedTurnId: true }).extend({ action: z.literal("input"), mode: z.literal("prompt") }),
  z.strictObject({ action: z.literal("stop"), expectedTurnId: terminalInput.shape.expectedTurnId.unwrap() }),
]);

function jsonText(value: unknown): string | undefined {
  try { return JSON.stringify(value); }
  catch (error) {
    // Native JSON may parse successfully but be too deeply nested to serialize.
    if (!(error instanceof RangeError)) throw error;
    return undefined;
  }
}

function jsonWithin(value: unknown, limit: number, status = 200): Response | undefined {
  const text = jsonText(value);
  if (text === undefined || Buffer.byteLength(text) > limit) return;
  return new Response(text, { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function apiJson(value: unknown, status = 200, write = false): Response {
  return jsonWithin(value, MAX_JSON_BYTES, status) ?? Response.json(write ? {
    code: "response_too_large_outcome_unknown",
    error: "操作回复超出 Web 读取上限或无法安全序列化。操作可能已经执行；请刷新检查状态，不要重复提交。",
  } : {
    code: "response_too_large", error: "回复超出 Web 读取上限或无法安全序列化，未返回不完整的数据。",
  }, { status: 502, headers });
}

function terminalPayloadTooLarge() {
  return new WebError(502, "terminal_payload_too_large", "CLI 会话数据超出 Web 读取上限，请在本机终端查看。");
}

function terminalSnapshotJson(value: TerminalTranscript): Response {
  const original = jsonWithin(value, TRANSCRIPT_PAGE_BYTES);
  if (original) return original;
  const metadata = { ...value, messages: [], transcript: value.transcript ?? { status: "truncated" } };
  // Keep session, attach and turn identity untouched. Use a contiguous recent
  // suffix of already-projected display rows, with full JSON envelope overhead.
  let remaining = TRANSCRIPT_PAGE_BYTES - Buffer.byteLength(JSON.stringify(metadata));
  let start = value.messages.length;
  while (start > 0) {
    const cost = Buffer.byteLength(JSON.stringify(value.messages[start - 1])) + Number(start < value.messages.length);
    if (cost > remaining) break;
    remaining -= cost;
    start--;
  }
  const result = jsonWithin({ ...metadata, messages: value.messages.slice(start) }, TRANSCRIPT_PAGE_BYTES);
  if (!result) throw terminalPayloadTooLarge();
  return result;
}

function sseFrame(event: WireObject): Uint8Array | undefined {
  const text = jsonText(event);
  if (text === undefined || Buffer.byteLength(text) + SSE_PREFIX.length + SSE_SUFFIX.length > MAX_SSE_FRAME_BYTES) return;
  return encoder.encode(`${SSE_PREFIX}${text}${SSE_SUFFIX}`);
}

function browserEngineStatus(status: EngineStatus): EngineStatus {
  return sseFrame({ type: "engine", engine: status }) ? status : status.online ? { online: true }
    : { online: false, error: "OmO 状态详情超出 Web 读取上限，请查看本机终端。" };
}

function activityResponse(data: NativeActivityView): Response {
  if (data.status === "unavailable") return apiJson({ status: data.status, reason: data.reason });
  const { status, connected, language, updatedAt, runs, tasks } = data;
  return apiJson({ status, connected, language, updatedAt, runs, tasks });
}

async function payload(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.toLowerCase() !== "application/json") {
    throw new WebError(415, "json_required", "需要 application/json 请求体。");
  }
  try { return await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WebError(400, "invalid_json", "请求体不是有效 JSON。");
  }
}

export async function startApp(settings: AppSettings) {
  const access = await loadWebAccess(settings.webEnv ?? {}, settings.port);
  const workspaces = await WorkspaceAccess.fromConfig(settings.workspaces);
  const [root] = await workspaces.paths();
  if (!root) throw new WebError(400, "invalid_workspace", "至少需要一个允许的工作目录。");
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const tokenBytes = Buffer.from(secret);
  const profile = settings.cliAgentDir?.trim() || undefined;
  const history = new CliHistory(profile, workspaces);
  const native = new NativeActivity(profile);
  let historySessions = new Map<string, CliSessionSummary & { readonly nativeSessionId: string; readonly workspaceKey?: string }>();
  const historyKey = (session: CliSessionSummary & { readonly workspaceKey?: string }) =>
    createHmac("sha256", tokenBytes).update(JSON.stringify([session.cwd, session.id, session.workspaceKey])).digest("hex");
  async function activityFor(durableId: string, cwd: string): Promise<Response> {
    if (await workspaces.exact(cwd) === undefined) {
      throw new WebError(403, "workspace_refused", "此工作目录已不可用。");
    }
    return activityResponse(await native.read(durableId, cwd));
  }
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const disconnect = (client: ReadableStreamDefaultController<Uint8Array>) => {
    if (clients.delete(client)) client.close();
  };
  const publish = (chunk: Uint8Array) => {
    for (const client of clients) {
      if ((client.desiredSize ?? 0) <= 0) disconnect(client);
      else client.enqueue(chunk);
    }
  };
  const fanout = (event: WireObject) => {
    if (!clients.size) return;
    const chunk = sseFrame(event);
    if (chunk) return publish(chunk);
    // Sessions.event has already matched the Native route and substituted its
    // Web id. An unscoped overflow must not invalidate arbitrary sessions.
    const id = sessionKey.safeParse(event.sessionId);
    if (!id.success) return;
    const type = typeof event.type === "string" && LIVE_TRANSCRIPT_EVENTS.has(event.type)
      ? "transcript_refresh_required" : "state_refresh_required";
    const refresh = sseFrame({ type, sessionId: id.data });
    if (refresh) publish(refresh);
  };
  const terminals = new TerminalSessions(profile, workspaces, id => fanout({ type: "cli-live", id }));
  // Default sharing primary: the engine is a Web-owned private non-listening
  // stdio host whose profile env is pinned to the configured agent dir, so its
  // journals land in the same bucket CliHistory scans. Listening socket hosts
  // are not offered: a discoverable endpoint lets another stock TUI attach to
  // the Web host instead of being refused by the native holder guard.
  const cliProfileDir = profile === undefined ? undefined : resolve(profile);
  const { OMO_WEB_PASSWORD_FILE: _passwordFile, ...engineEnv } = process.env;
  const engine = new Engine(settings.engineCommand, root, event => sessions.event(event), status => {
    if (!status.online) sessions.disconnected();
    if (clients.size) fanout({ type: "engine", engine: browserEngineStatus(status) });
  }, undefined, cliProfileDir === undefined ? { env: engineEnv } : { privateHost: true, env: { ...engineEnv,
    OMO_CODING_AGENT_DIR: cliProfileDir, SENPI_CODING_AGENT_DIR: cliProfileDir, PI_CODING_AGENT_DIR: cliProfileDir,
    // Controlled client capability, not user config: private in-process stdio
    // ignores `question` from set_client_info, so native ask_user_question
    // would fall back to a select dialog and lose structured UI. Verified on
    // omo 5.1.81: this env restores real pendingQuestions with explicit settle.
    OMO_RPC_CLIENT_CAPABILITIES: "question", SENPI_RPC_CLIENT_CAPABILITIES: "question",
    PI_RPC_CLIENT_CAPABILITIES: "question" } });
  const sessions = new Sessions(settings.dataDir, workspaces, engine, fanout,
    async (nativeSessionId, cwd) => history.branchSource(nativeSessionId, cwd),
    { sameProfile: cliProfileDir !== undefined,
      ...(cliProfileDir === undefined ? {} : { profileDir: cliProfileDir }) });
  await sessions.load();
  async function selectedHistory(id: string | undefined) {
    const selected = id === undefined ? undefined : historySessions.get(id);
    if (!selected || selected.workspaceKey === undefined || await workspaces.exact(selected.cwd) !== selected.workspaceKey) {
      throw new WebError(404, "history_not_found", "找不到这条 CLI 历史，请刷新列表。");
    }
    return selected;
  }
  async function liveBranchSource(id: string) {
    const { nativeSessionId, cwd, leafId } = await terminals.branchIdentity(id);
    return { ...await history.branchSource(nativeSessionId, cwd), leafId };
  }

  const fetch = async (request: Request, listener?: Bun.Server<undefined>): Promise<Response> => {
    const json = (value: unknown, status = 200) => apiJson(value, status, request.method !== "GET");
    try {
      const challenge = access.authorize(request, url, tokenBytes, listener?.requestIP(request)?.address);
      if (challenge) return challenge;
      // Native compact can take up to 180 s. Rejected requests keep the short listener default.
      listener?.timeout(request, 240);
      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "GET") {
        const file = webAsset(pathname);
        if (file) {
          if (!(await file.exists())) throw new WebError(404, "missing_asset", "静态资源不存在，请先执行 bun run build。");
          return new Response(file, { headers: { ...headers, "Content-Type": file.type } });
        }
        if (pathname === "/api/bootstrap") {
          try { if (await workspaces.exact(root) !== undefined) await engine.probe(); } catch (error) {
            if (!(error instanceof WebError)) throw error;
          }
          return json({ token: secret, engine: browserEngineStatus(engine.status), workspaces: await workspaces.paths(), sessions: await sessions.scopedList(),
            handoff: sessions.handoffSupport(), fileBrowser: { platform: workspacePlatform }, unprotected: access.unprotected });
        }
        if (pathname === "/api/sessions") return json({ sessions: await sessions.scopedList() });
        if (pathname === "/api/cli-follow") {
          const follow = await terminals.follow();
          return follow.status === "ok" ? terminalSnapshotJson(follow) : json(follow);
        }
        if (pathname === "/api/cli-live") {
          const listing = jsonWithin(await terminals.list(), TRANSCRIPT_PAGE_BYTES);
          if (!listing) throw terminalPayloadTooLarge();
          return listing;
        }
        if (pathname === "/api/cli-history") {
          const { available, sessions: rows } = await history.listWithIds();
          historySessions = new Map(rows.map(row => [historyKey(row), row]));
          return json({
            available,
            sessions: [...historySessions].map(([id, { name, cwd, updatedAt, nativeSessionId, workspaceKey }]) => ({
              id, name, cwd, updatedAt,
              // Coalesce logical aliases by native id and cwd: an adopted row
              // enters the existing Web alias (holder admission still applies).
              adopted: sessions.findAlias(nativeSessionId, cwd, workspaceKey) !== undefined,
            })),
          });
        }
        const historyRoute = /^\/api\/cli-history\/([a-f0-9]{64})(\/activity)?$/.exec(pathname);
        if (historyRoute) {
          const [, id, activity] = historyRoute;
          const selected = await selectedHistory(id);
          const { session, messages, internal } = await history.read(selected.id, selected.cwd, selected.workspaceKey);
          if (session.cwd !== selected.cwd) throw new WebError(404, "history_not_found", "找不到这条 CLI 历史，请刷新列表。");
          if (activity) return await activityFor(internal.nativeSessionId, session.cwd);
          const { name, cwd, updatedAt } = session;
          const preview = jsonWithin({ session: { id, name, cwd, updatedAt,
            adopted: sessions.findAlias(internal.nativeSessionId, session.cwd, selected.workspaceKey) !== undefined }, messages },
          TRANSCRIPT_PAGE_BYTES);
          if (!preview) {
            throw new WebError(413, "history_preview_too_large", "CLI 历史预览超出 Web 读取上限或无法安全序列化，请在本机 OmO 查看原记录。");
          }
          return preview;
        }
        if (pathname === "/api/events") {
          if (clients.size >= MAX_STREAM_CLIENTS) throw new WebError(429, "too_many_streams", "打开的页面太多，请关闭部分页面后重试。");
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(client) {
              controller = client;
              clients.add(client);
              const ready = sseFrame({ type: "ready", engine: browserEngineStatus(engine.status) });
              if (ready) client.enqueue(ready);
            },
            cancel() { if (controller) clients.delete(controller); },
          }, { highWaterMark: 1024 * 1024, size: chunk => chunk?.byteLength ?? 0 });
          request.signal.addEventListener("abort", () => { if (controller) disconnect(controller); }, { once: true });
          listener?.timeout(request, 0);
          return new Response(stream, { headers: { ...headers, Connection: "close",
            "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
        }
      } else if (pathname === "/api/sessions") {
        const { cwd, name } = openInput.parse(await payload(request));
        return json({ session: await sessions.create(cwd, name) }, 201);
      } else if (pathname === "/api/workspaces/browse") {
        const { path } = workspacePath.parse(await payload(request));
        return apiJson(await workspaces.browse(path));
      } else if (pathname === "/api/workspaces/prepare") {
        const { path } = workspacePath.parse(await payload(request));
        return json(await workspaces.prepare(path));
      } else if (pathname === "/api/workspaces/confirm") {
        const { confirmation, allow } = workspaceDecision.parse(await payload(request));
        return json(await workspaces.confirm(confirmation, allow));
      }

      const live = /^\/api\/cli-live\/([a-f0-9]{64})(?:\/(actions|branch-options|branches))?$/.exec(pathname);
      if (live?.[1]) {
        const [, id, resource] = live;
        if (request.method === "GET" && !resource) return terminalSnapshotJson(await terminals.snapshot(id));
        if (request.method === "GET" && resource === "branch-options") {
          return json(await sessions.branchOptionsFor(await liveBranchSource(id)));
        }
        if (request.method === "POST" && resource === "branches") {
          const selection = branchSelection.parse(await payload(request));
          const result = await sessions.branchFrom(await liveBranchSource(id), selection);
          return json(result, result.cancelled ? 200 : 201);
        }
        if (request.method === "POST" && resource === "actions") {
          const command = cliLiveActions.parse(await payload(request));
          switch (command.action) {
            case "connect": return terminalSnapshotJson(await terminals.attach(id));
            case "disconnect": return json(await terminals.detach(id));
            case "input": {
              const { mode, message, clientMessageId } = command;
              return json(await terminals.input(id, { mode, message, clientMessageId }));
            }
            case "stop": return json(await terminals.interrupt(id, command.expectedTurnId));
          }
        }
      }
      const historyResume = /^\/api\/cli-history\/([a-f0-9]{64})\/resume$/.exec(pathname);
      if (historyResume) {
        if (request.method === "POST") {
          emptyBody.parse(await payload(request));
          const selected = await selectedHistory(historyResume[1]);
          const source = await history.branchSource(selected.id, selected.cwd, selected.workspaceKey);
          return json({ session: await sessions.resumeCli(source, selected.name) });
        }
      }
      const historyBranch = /^\/api\/cli-history\/([a-f0-9]{64})\/(branch-options|branches)$/.exec(pathname);
      if (historyBranch) {
        const [, id, resource] = historyBranch;
        if (request.method === "GET" && resource === "branch-options") {
          const selected = await selectedHistory(id);
          return json(await sessions.branchOptionsFor(await history.branchSource(selected.id, selected.cwd, selected.workspaceKey)));
        }
        if (request.method === "POST" && resource === "branches") {
          const selection = branchSelection.parse(await payload(request));
          const selected = await selectedHistory(id);
          const result = await sessions.branchFrom(await history.branchSource(selected.id, selected.cwd, selected.workspaceKey), selection);
          return json(result, result.cancelled ? 200 : 201);
        }
      }
      const dag = /^\/api\/sessions\/([a-z0-9-]+)\/native-runtime\/dag\/([a-f0-9]{64})$/u.exec(pathname);
      if (request.method === "GET" && dag?.[2]) return json(await sessions.nativeDag(sessionKey.parse(dag[1]), dag[2]));
      const route = /^\/api\/sessions\/([a-z0-9-]+)(?:\/(options|model-preview|details|queue|tree|branch-runtime|instructions|capabilities|activity|native-runtime|workbench-status|actions|branch-options|branches|handoff|last-assistant|transcript(?:\/content)?))?$/i.exec(pathname);
      if (route) {
        const id = sessionKey.parse(route[1]);
        if (request.method === "POST" && route[2] === "actions") {
          const action = actions.parse(await payload(request));
          if (action.action === "navigate" && searchParams.size > 0) {
            throw new WebError(400, "invalid_request", "请求参数不正确。");
          }
          return json(await sessions.action(id, action));
        }
        if (request.method === "POST" && route[2] === "branches") {
          const result = await sessions.branchWeb(id, branchSelection.parse(await payload(request)));
          return json(result, result.cancelled ? 200 : 201);
        }
        if (request.method === "POST" && route[2] === "handoff") {
          emptyBody.parse(await payload(request));
          const { session, command } = await sessions.handoff(id);
          return json({ session, command });
        }
        if (request.method === "GET") {
          if (route[2] === "options") return json(await sessions.options(id));
          if (route[2] === "model-preview") {
            if (searchParams.size !== 2 || searchParams.getAll("provider").length !== 1 || searchParams.getAll("modelId").length !== 1) {
              throw new WebError(400, "invalid_request", "请求参数不正确。");
            }
            return json(await sessions.modelPreview(id, modelTarget.parse({
              provider: searchParams.get("provider"), modelId: searchParams.get("modelId"),
            })));
          }
          if (route[2] === "branch-options") return json(await sessions.webBranchOptions(id));
          if (route[2] === "transcript" || route[2] === "transcript/content") {
            const cursor = searchParams.get("cursor");
            if (searchParams.size !== 1 || cursor === null) throw new WebError(400, "invalid_request", "请求参数不正确。");
            return json(await sessions.transcript(id, cursor, route[2] === "transcript/content"));
          }
          if (route[2] === "tree") {
            if (searchParams.size === 0) return json(await sessions.tree(id));
            if (searchParams.size !== 1) throw new WebError(400, "invalid_request", "请求参数不正确。");
            return json(await sessions.tree(id, treeCursor.parse(searchParams.get("cursor"))));
          }
          if ((route[2] === "details" || route[2] === "queue" || route[2] === "branch-runtime" || route[2] === "workbench-status") &&
              searchParams.size > 0) throw new WebError(400, "invalid_request", "请求参数不正确。");
          if (route[2] === "details") return json(await sessions.details(id));
          if (route[2] === "queue") return json(await sessions.queue(id));
          if (route[2] === "branch-runtime") return json(await sessions.branchRuntime(id));
          if (route[2] === "instructions") return json(await sessions.instructions(id));
          if (route[2] === "capabilities") return json(await sessions.capabilities(id));
          if (route[2] === "native-runtime") return json(await sessions.nativeRuntime(id));
          if (route[2] === "workbench-status") return json(await sessions.workbenchStatus(id));
          if (route[2] === "last-assistant") {
            const copy = jsonWithin(await sessions.lastAssistant(id), TRANSCRIPT_PAGE_BYTES);
            if (!copy) throw new WebError(502, "last_assistant_too_large", "最后一条回复超出 Web 复制上限，未复制任何部分；请在本机 OmO 复制。");
            return copy;
          }
          if (route[2] === "activity") {
            const row = (await sessions.scopedList()).find(session => session.id === id);
            if (!row) throw new WebError(404, "session_not_found", "找不到这个会话。");
            if (!row.active) throw new WebError(409, "session_not_open", "会话未接入引擎，请先恢复会话。");
            if (!profile) return json({ status: "unavailable", reason: "no-agent-dir" });
            const durable = await sessions.nativeSessionId(id).catch(error => {
              if (!(error instanceof WebError)) throw error;
              return undefined;
            });
            return durable ? await activityFor(durable, row.cwd) : json({ status: "unavailable", reason: "session-unavailable" });
          }
          if (!route[2]) return json(await sessions.snapshot(id, request.signal));
        }
      }
      throw new WebError(404, "not_found", "找不到这个地址。");
    } catch (error) {
      if (error instanceof WebError) return json({ code: error.code, error: error.message }, error.status);
      if (error instanceof ZodError) return json({ code: "invalid_request", error: "请求参数不正确。" }, 400);
      console.error("OmO Web request failed", error);
      return json({ code: "internal_error", error: "OmO Web 出现错误；请查看本机终端。" }, 500);
    }
  };

  const server = Bun.serve({
    hostname: access.hostname,
    port: settings.port,
    ...(access.tls === undefined ? {} : { tls: access.tls }),
    idleTimeout: 10,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    fetch,
  });
  const url = access.origin === undefined ? server.url : new URL(access.origin);
  const heartbeat = setInterval(() => publish(encoder.encode(": keepalive\n\n")), 15_000);
  let closing: Promise<void> | undefined;
  return {
    url: new URL(url),
    unprotected: access.unprotected,
    weakPassword: access.weakPassword,
    proxyOrigin: access.proxyOrigin?.origin,
    fetch,
    stop() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        terminals.stop();
        sessions.stop();
        for (const client of clients) disconnect(client);
        await Promise.all([server.stop(true), engine.stop()]);
      })();
      return closing;
    },
  };
}
