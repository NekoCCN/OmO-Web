import { Api, RequestError, parseSession, parseSessions, sessionPath } from "./api.ts";
import type { Action, Image, Mode, Session } from "./api.ts";
import { byId, button, el, errorText, field, isImageType, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { Interactions, isRequest, requestId } from "./interactions.ts";
import type { Answer } from "./interactions.ts";
import { Transcript, messageKey, roleOf } from "./transcript.ts";
import type { ToolTrace, TranscriptEntry } from "./transcript.ts";
import { renderDetails } from "./details.ts";

const box = (id: string) => byId(id, HTMLElement);
const btn = (id: string) => byId(id, HTMLButtonElement);
const sel = (id: string) => byId(id, HTMLSelectElement);
const inp = (id: string) => byId(id, HTMLInputElement);
const form = (id: string) => byId(id, HTMLFormElement);
const dialog = (id: string) => byId(id, HTMLDialogElement);
const api = new Api();
const stream = new Transcript(box("messages"), box("transcript"), box("no-messages"));
const interactions = new Interactions(box("interactions"));
const prompt = byId("prompt", HTMLTextAreaElement);
const mode = sel("prompt-mode");
const chooser = dialog("new-dialog");
const manager = dialog("manage-dialog");
const inspector = dialog("details-dialog");
const settingLabels: Readonly<Record<string, string>> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
type Attachment = Image & { readonly name: string; readonly url: string };
type Draft = { text: string; mode: Mode; images: Attachment[]; reading: number; error: string; admission?: { readonly imageList: readonly Attachment[]; readonly text: string; readonly mode: Mode; readonly turn: string; readonly id: string } };
type View = {
  session: Session; status: "inactive" | "loading" | "ready" | "failed"; error: string; state: Wire;
  messages: TranscriptEntry[]; liveKey: string; tools: Map<string, ToolTrace>; requests: Map<string, Wire>;
  options: Wire; optionsError: string; queue: number | undefined; revision: number; serial: number;
  sync: number; optionSync: number; running: boolean; compacting: boolean;
};

let current: View | undefined;
let engine: Wire = {};
let connection: "connecting" | "online" | "offline" = "connecting";
let transport: "waiting" | "open" | "lost" = "waiting";
let recovering = false;
let bootstrapped = false;
let bootError = "";
let listError = "";
let sessions = new Map<string, Session>();
let workspaces: readonly string[] = [];
let archived = false;
let source: EventSource | undefined;
let bootSeq = 0;
let listSeq = 0;
let mutation = 0;
let refreshTimer = 0;
let createPending = false;
let navOpen = false;
const writes = new Set<string>();
const sending = new Set<string>();
const drafts = new Map<string, Draft>();
const mobile = matchMedia("(max-width: 760px)");
const system = matchMedia("(prefers-color-scheme: dark)");
const countFormat = new Intl.NumberFormat("zh-CN");

function draftFor(id: string): Draft {
  let draft = drafts.get(id);
  if (!draft) {
    draft = { text: "", mode: "prompt", images: [], reading: 0, error: "" };
    drafts.set(id, draft);
  }
  return draft;
}

function startTheme(): void {
  const theme = sel("theme");
  try {
    const saved = localStorage.getItem("omo-web-theme");
    if (saved === "dark" || saved === "light") theme.value = saved;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
  const apply = () => {
    document.documentElement.dataset.theme = theme.value === "system" ? (system.matches ? "dark" : "light") : theme.value;
  };
  theme.addEventListener("change", () => {
    apply();
    try { localStorage.setItem("omo-web-theme", theme.value); }
    catch (error) { if (!(error instanceof DOMException)) throw error; }
  });
  system.addEventListener("change", apply);
  apply();
}

function toggleNav(open: boolean, restoreFocus = false): void {
  navOpen = open && mobile.matches;
  box("navigation").classList.toggle("is-open", navOpen);
  box("nav-scrim").hidden = !navOpen;
  box("conversation").inert = navOpen;
  box("skip-link").inert = navOpen;
  btn("open-navigation").setAttribute("aria-expanded", String(navOpen));
  if (navOpen) inp("search").focus();
  else if (restoreFocus && mobile.matches) btn("open-navigation").focus();
}

function updateConnection(): void {
  connection = bootError || engine.online === false || transport === "lost" ? "offline"
    : bootstrapped && transport === "open" && !recovering && engine.online === true ? "online" : "connecting";
  box("connection").dataset.state = connection;
  box("connection-label").textContent = { online: "本机已连接", offline: "连接不可用", connecting: "正在连接" }[connection];
  const version = str(engine.version);
  notice(box("engine-version"), version && `引擎 ${version}`);
  const message = bootError || (engine.online === false ? str(engine.error) || "本机 Senpi 引擎不可用。请检查引擎后重新连接。"
    : transport === "lost" ? "实时连接已断开。正在重连，未发送的内容会保留。" : listError);
  box("banner").hidden = !message;
  notice(box("banner-text"), message);
  const available = connection === "online" && Boolean(workspaces.length);
  btn("new-sidebar").disabled = !available;
  btn("new-welcome").disabled = !available;
  box("welcome-copy").textContent = bootstrapped && !workspaces.length
    ? "没有可选的工作目录。请检查本机 Web 服务的工作目录配置。"
    : "选择工作目录后开始新会话，或从会话列表继续此前的工作。";
  btn("create").disabled = !available || createPending;
  renderSessions();
  renderView();
}

function applySessions(items: readonly Session[]): void {
  sessions = new Map(items.map(session => [session.id, session]));
  if (current) current.session = sessions.get(current.session.id) ?? current.session;
  renderSessions();
  renderView();
}

function remember(session: Session): void {
  mutation++;
  sessions.set(session.id, session);
  if (current?.session.id === session.id) current.session = session;
  renderSessions();
}

async function fetchSessions(): Promise<void> {
  const ticket = ++listSeq;
  const version = mutation;
  try {
    const data = await api.request("/api/sessions");
    if (ticket !== listSeq || version !== mutation) return;
    listError = "";
    applySessions(parseSessions(data));
  } catch (error) {
    if (ticket === listSeq) listError = `无法读取会话列表：${errorText(error)}`;
  }
  updateConnection();
}

async function bootstrap(reconcile = false): Promise<void> {
  const ticket = ++bootSeq;
  const version = mutation;
  try {
    const data = await api.request("/api/bootstrap");
    if (ticket !== bootSeq) return;
    api.token = str(data.token);
    engine = object(data.engine);
    workspaces = list(data.workspaces).filter((cwd): cwd is string => typeof cwd === "string" && Boolean(cwd));
    bootstrapped = true;
    bootError = "";
    listError = "";
    if (version === mutation) applySessions(parseSessions(data));
    if (!source) connectEvents();
    if (reconcile && current) {
      if (!current.session.active && current.status !== "loading" && engine.online === true) {
        current.status = "inactive";
        current.error = "";
      } else if (current.session.active && engine.online === true) {
        const view = current;
        await snapshot(view);
        if (view === current) void loadOptions(view);
      }
    }
  } catch (error) {
    if (ticket === bootSeq) bootError = `无法连接本机 Web 服务：${errorText(error)}`;
  }
  if (ticket === bootSeq) recovering = false;
  updateConnection();
}

function renderSessions(): void {
  const query = inp("search").value.trim().toLocaleLowerCase();
  const host = box("session-list");
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.dataset.session : undefined;
  const items = [...sessions.values()].filter(item => item.archived === archived && (!query || `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const existing = new Map([...host.children].flatMap(node => node instanceof HTMLLIElement && node.dataset.session ? [[node.dataset.session, node] as const] : []));
  let next = host.firstElementChild;
  for (const session of items) {
    let li = existing.get(session.id);
    if (!li) {
      li = el("li");
      li.dataset.session = session.id;
      const row = button("", () => openSession(session.id), "button--quiet session-link");
      row.dataset.session = session.id;
      row.append(el("span"), el("span", "small muted path"), el("small"));
      li.append(row);
    }
    const row = li.firstElementChild;
    if (row instanceof HTMLButtonElement) {
      row.firstElementChild && (row.firstElementChild.textContent = session.name);
      const path = row.children.item(1);
      if (path instanceof HTMLElement) { path.textContent = session.cwd; path.title = session.cwd; path.hidden = !session.cwd; }
      const stamp = row.lastElementChild;
      if (stamp) stamp.textContent = session.running ? "运行中" : session.settled ? "已结清" : session.active ? "已打开" : "待恢复";
      if (session.id === current?.session.id) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    if (li !== next) host.insertBefore(li, next);
    next = li.nextElementSibling;
    existing.delete(session.id);
  }
  for (const node of existing.values()) node.remove();
  if (focused && !items.some(item => item.id === focused)) inp("search").focus();
  notice(box("list-empty"), items.length ? "" : query ? "没有匹配的会话" : !bootstrapped ? bootError ? "暂时无法读取会话" : "正在读取会话…" : archived ? "没有已归档的会话" : "还没有最近会话");
  btn("recent").setAttribute("aria-pressed", String(!archived));
  btn("archived").setAttribute("aria-pressed", String(archived));
}

function openSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  toggleNav(false);
  box("conversation").focus();
  if (id === current?.session.id) return;
  if (manager.open) manager.close();
  if (inspector.open) inspector.close();
  const view: View = {
    session, status: session.active ? "loading" : "inactive", error: "", state: {}, messages: [], liveKey: "",
    tools: new Map(), requests: new Map(), options: {}, optionsError: "", queue: undefined, revision: 0, serial: 0,
    sync: 0, optionSync: 0, running: session.running, compacting: false,
  };
  current = view;
  stream.reset();
  interactions.reset();
  const draft = draftFor(id);
  prompt.value = draft.text;
  mode.value = draft.mode;
  renderAttachments();
  renderSessions();
  renderView();
  if (session.active) { void snapshot(view, true); void loadOptions(view); }
}

function modelKey(value: Wire): string {
  return str(value.id) ? JSON.stringify([str(value.provider), str(value.id)]) : "";
}

function modelTitle(model: Wire): string {
  const name = str(model.name) || str(model.id);
  return name ? [str(model.provider), name].filter(Boolean).join(" · ") : "";
}

function syncSelect(node: HTMLSelectElement, choices: readonly (readonly [string, string])[], value: string, placeholder: string): void {
  const signature = JSON.stringify(choices);
  if (node.dataset.options !== signature) {
    node.replaceChildren(option(placeholder, ""), ...choices.map(([id, label]) => option(label, id)));
    node.dataset.options = signature;
  }
  node.value = value;
  if (node.selectedIndex < 0) node.value = "";
}

function renderView(): void {
  const view = current;
  const session = view?.session;
  const available = Boolean(view && view.status === "ready");
  box("welcome").hidden = Boolean(view);
  box("inactive-session").hidden = !view || available;
  box("active-session").hidden = !available;
  box("composer-shell").hidden = !available;
  const title = box("session-title");
  title.textContent = session?.name ?? "会话工作台";
  title.title = title.textContent;
  const cwd = session?.cwd ?? "";
  const path = box("session-path");
  notice(path, cwd);
  path.title = cwd;
  btn("details-button").hidden = !available;
  btn("manage-button").hidden = !available;
  if (!view) return;
  for (const modal of [manager, inspector]) if (modal.open) {
    modal.querySelectorAll<HTMLButtonElement>("[data-write]").forEach(node => {
      node.disabled = connection !== "online" || writes.has(view.session.id) || node.hasAttribute("data-unavailable")
        || (node.hasAttribute("data-idle") && (view.running || view.compacting || sending.has(view.session.id)));
    });
  }
  const active = view.status !== "inactive";
  box("inactive-title").textContent = view.status === "loading" ? "正在读取会话…" : view.status === "failed" ? "无法读取会话" : "继续此会话";
  box("inactive-copy").textContent = view.status === "loading" ? "正在向本机引擎请求会话记录。"
    : view.status === "failed" ? "请检查连接后重试。"
      : `${view.session.archived ? "此会话已归档。" : ""}恢复后可查看此前的对话并继续。`;
  notice(box("session-error"), view.error);
  const resume = btn("resume");
  resume.hidden = available || view.status === "loading";
  resume.disabled = connection !== "online" || writes.has(view.session.id);
  resume.textContent = active && view.session.active ? "重试读取" : "恢复会话";
  if (!available) return;

  const draft = draftFor(view.session.id);
  const online = connection === "online";
  const busy = writes.has(view.session.id);
  const posting = sending.has(view.session.id);
  const blocked = view.session.archived;
  const canSend = online && !blocked && !view.compacting;
  const chosenMode = mode.value;
  const primaryStop = view.running && (chosenMode === "prompt" || blocked);
  btn("stop").hidden = !view.running;
  btn("stop").disabled = !online || busy;
  btn("stop").classList.toggle("button--primary", primaryStop);
  btn("stop").classList.toggle("button--danger", !primaryStop);
  const send = btn("send");
  send.hidden = view.running && (chosenMode === "prompt" || blocked);
  send.disabled = !canSend || busy || posting || draft.reading > 0 || (!draft.text.trim() && !draft.images.length);
  send.textContent = chosenMode === "follow_up" ? "排队" : chosenMode === "steer" ? "发送引导" : "发送";
  btn("attach").disabled = blocked || draft.images.length + draft.reading >= 4 || busy;
  mode.disabled = blocked || busy;
  const selected = object(view.state.model);
  const models = list(view.options.models).map(object).filter(model => Boolean(modelKey(model)));
  if (modelKey(selected) && !models.some(model => modelKey(model) === modelKey(selected))) models.unshift(selected);
  syncSelect(sel("model"), models.map(model => [modelKey(model), modelTitle(model)]), modelKey(selected), "模型");
  sel("model").disabled = !canSend || !list(view.options.models).length || view.running || busy || posting;
  const selectedLevel = str(view.state.thinkingLevel);
  const levels = list(view.options.levels).map(str).filter(Boolean);
  if (selectedLevel && !levels.includes(selectedLevel)) levels.unshift(selectedLevel);
  syncSelect(sel("thinking"), levels.map(level => [level, Object.hasOwn(settingLabels, level) ? `思考：${settingLabels[level]}` : level]), selectedLevel, "思考档");
  sel("thinking").disabled = !canSend || !list(view.options.levels).length || view.running || busy || posting;
  const usage = object(view.state.contextUsage);
  const percent = num(usage.percent);
  const tokens = num(usage.tokens);
  const limit = num(usage.contextWindow);
  notice(box("context-usage"), percent !== undefined ? `上下文 ${countFormat.format(percent)}%` : tokens !== undefined && limit ? `上下文 ${countFormat.format(tokens)} / ${countFormat.format(limit)}` : "");
  const hint = !online ? "离线：可继续编辑草稿，恢复连接后再发送。" : blocked
    ? "此会话已归档；可在会话管理中取消归档。"
    : view.compacting ? "上下文压缩完成后可发送。" : draft.reading ? "正在读取图片…"
      : view.running && chosenMode === "prompt" ? "可停止当前轮，或切换发送方式以引导或排队。"
        : !view.running && chosenMode !== "prompt" ? "当前没有运行中的轮次；此输入将在下一轮处理。" : "Ctrl / ⌘ + Enter 发送";
  box("composer-hint").textContent = hint;
  const activity = [view.running ? "正在生成" : "", view.compacting ? "正在压缩上下文" : "", view.queue ? `${view.queue} 条输入待处理` : "",
    view.requests.size ? `${view.requests.size} 项等待你的决定` : ""].filter(Boolean).join(" · ");
  box("activity-row").hidden = !activity;
  if (box("activity").textContent !== activity) box("activity").textContent = activity;
  btn("jump-to-request").hidden = !view.requests.size;
  notice(box("compose-error"), draft.error || view.optionsError);
  interactions.render(view.requests, online, (id, answer) => answerRequest(view, id, answer));
}

function requestsFrom(state: Wire): Map<string, Wire> {
  const result = new Map<string, Wire>();
  for (const raw of [...list(state.pendingDialogs), ...list(state.pendingQuestions)]) {
    const request = object(raw);
    if (isRequest(request)) result.set(requestId(request), request);
  }
  return result;
}

function renderMessages(view: View, bottom = false): void {
  if (view !== current || view.status !== "ready") return;
  stream.render(view.messages, view.liveKey, view.tools, bottom);
}

async function snapshot(view: View, bottom = false): Promise<void> {
  const ticket = ++view.sync;
  const revision = view.revision;
  try {
    const data = await api.request(sessionPath(view.session.id));
    if (current !== view || ticket !== view.sync) return;
    const session = parseSession(data.session) ?? view.session;
    remember(session);
    const state = object(data.state);
    const messages = list(data.messages).map(object);
    const changed = revision !== view.revision;
    const oldKeys = new Map(view.messages.map(entry => [entry.key, entry.message]));
    const keys = new Set<string>();
    const entries = messages.filter(message => Boolean(roleOf(message))).map((message, index) => {
      const base = messageKey(message) || `snapshot:${index}`;
      const key = keys.has(base) ? `${base}:${index}` : base;
      keys.add(key);
      const old = oldKeys.get(key);
      return { key, message: old && JSON.stringify(old) === JSON.stringify(message) ? old : message };
    });
    if (changed) {
      const newer = new Map(view.messages.map(entry => [entry.key, entry]));
      view.messages = [...entries.map(entry => newer.get(entry.key) ?? entry), ...view.messages.filter(entry => !keys.has(entry.key))];
      view.state = { ...state, ...view.state };
    } else {
      view.messages = entries;
      view.state = state;
      view.running = session.running || state.isStreaming === true;
      view.compacting = state.isCompacting === true;
      view.requests = requestsFrom(state);
      view.queue = num(state.pendingMessageCount);
      if (!view.running) {
        view.liveKey = "";
        for (const [id, tool] of view.tools) if (tool.stage === "running") view.tools.delete(id);
      }
      else if (view.liveKey && !keys.has(view.liveKey)) {
        const live = oldKeys.get(view.liveKey);
        if (live) view.messages.push({ key: view.liveKey, message: live });
      }
    }
    view.status = "ready";
    view.error = "";
    renderView();
    renderMessages(view, bottom);
  } catch (error) {
    if (current !== view || ticket !== view.sync) return;
    if (view.status !== "ready" || !view.session.active) {
      view.status = "failed";
      view.error = errorText(error);
    } else {
      draftFor(view.session.id).error = `无法刷新会话：${errorText(error)}`;
    }
    renderView();
  }
}

async function loadOptions(view: View): Promise<void> {
  const ticket = ++view.optionSync;
  try {
    const data = await api.request(`${sessionPath(view.session.id)}/options`);
    if (current !== view || ticket !== view.optionSync) return;
    view.options = data;
    view.optionsError = "";
  } catch (error) {
    if (current !== view || ticket !== view.optionSync) return;
    view.optionsError = `无法读取模型和运行选项：${errorText(error)}`;
  }
  renderView();
}

function connectEvents(): void {
  if (source) return;
  const events = new EventSource("/api/events");
  source = events;
  events.addEventListener("open", () => {
    if (events !== source) return;
    const reconnected = transport === "lost";
    recovering = reconnected;
    transport = "open";
    updateConnection();
    if (reconnected) {
      if (engine.online === false) {
        recovering = false;
        void fetchSessions();
      } else void bootstrap(true);
    }
  });
  events.addEventListener("error", () => {
    if (events !== source) return;
    transport = "lost";
    updateConnection();
  });
  events.addEventListener("omo", event => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string" || events !== source) return;
    try {
      const data: unknown = JSON.parse(event.data);
      onEvent(object(data));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (current?.session.active) scheduleSnapshot(current);
    }
  });
}

function updateMessage(view: View, event: Wire, type: string): void {
  const message = object(event.message);
  const role = roleOf(message);
  if (!role) return;
  const before = view.messages[view.messages.length - 1];
  const base = messageKey(message);
  const active = role === "assistant" && view.liveKey;
  let key = (type !== "message_start" && active) || base || "";
  if (!key && type !== "message_start" && before && role === roleOf(before.message)) key = before.key;
  if (!key) key = `live:${++view.serial}`;
  const index = view.messages.findIndex(entry => entry.key === key);
  if (index < 0) view.messages.push({ key, message });
  else view.messages[index] = { key, message };
  if (role === "assistant") {
    view.liveKey = type === "message_end" ? "" : key;
    if (type !== "message_end") view.running = true;
  }
}

function scheduleSnapshot(view: View): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => { if (current === view && view.session.active) void snapshot(view); }, 120);
}

function receiveRequest(view: View, raw: unknown): void {
  const request = object(raw);
  if (isRequest(request)) view.requests.set(requestId(request), request);
}

function onEvent(event: Wire): void {
  const type = str(event.type);
  if (type === "ready" || type === "engine") {
    if (type === "engine") {
      const status = object(event.engine);
      if (typeof status.online !== "boolean") return;
      recovering = status.online && engine.online === false;
      engine = status;
      updateConnection();
      if (status.online) void bootstrap(true);
      else void fetchSessions();
    }
    else if (recovering) return;
    else if (current && engine.online !== false) void bootstrap(true);
    else void fetchSessions();
    return;
  }
  if (type === "sessions") { void fetchSessions(); return; }
  const view = current;
  if (!view || event.sessionId !== view.session.id) return;
  if (view.status !== "ready" && view.status !== "loading") return;
  view.revision++;
  switch (type) {
    case "agent_start":
      view.running = true;
      break;
    case "turn_start": {
      const turn = str(event.turnId);
      if (turn) view.state = { ...view.state, currentTurnId: turn };
      break;
    }
    case "agent_end":
      if (event.willRetry === true) break;
      view.liveKey = "";
      scheduleSnapshot(view);
      break;
    case "agent_settled":
      view.running = false;
      view.liveKey = "";
      view.state = { ...view.state, currentTurnId: undefined };
      scheduleSnapshot(view);
      break;
    case "agent_idle":
      scheduleSnapshot(view);
      break;
    case "message_start":
    case "message_update":
    case "message_end":
      updateMessage(view, event, type);
      break;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const id = str(event.toolCallId);
      if (!id) break;
      const old = view.tools.get(id);
      const result = object(event.result ?? event.partialResult);
      view.tools.set(id, {
        id, name: str(event.toolName) || old?.name || "", args: event.args ?? old?.args, output: result.content ?? old?.output,
        stage: event.isError === true ? "error" : type === "tool_execution_end" ? "done" : "running",
      });
      break;
    }
    case "extension_ui_request":
      receiveRequest(view, event);
      break;
    case "ui_request_pending":
      receiveRequest(view, event.request);
      break;
    case "question_updated":
      if (isRequest(event)) receiveRequest(view, event);
      break;
    case "question_resolved":
    case "ui_request_resolved":
    case "extension_ui_resolved":
    case "extension_ui_request_resolved":
      for (const [id, request] of view.requests) {
        const values = [event.id, event.requestId, event.uiRequestId].map(str).filter(Boolean);
        if (values.includes(id) || values.includes(str(request.requestId))) view.requests.delete(id);
      }
      scheduleSnapshot(view);
      break;
    case "compaction_start":
      view.compacting = true;
      break;
    case "compaction_end":
      view.compacting = false;
      if (event.aborted !== true && str(event.errorMessage)) draftFor(view.session.id).error = str(event.errorMessage);
      scheduleSnapshot(view);
      break;
    case "queue_update":
      view.queue = list(event.steering).length + list(event.followUp).length;
      if (inspector.open) void loadDetails(view);
      break;
    case "pending_input_update":
      scheduleSnapshot(view);
      break;
    case "model_changed":
    case "service_tier_changed":
      if (event.model) view.state = { ...view.state, model: event.model, thinkingLevel: event.thinkingLevel ?? view.state.thinkingLevel };
      void loadOptions(view);
      scheduleSnapshot(view);
      break;
    case "commands_changed":
    case "loaded_surfaces_changed":
      void loadOptions(view);
      break;
    case "auto_retry_start":
      view.running = true;
      break;
    case "auto_retry_end":
    case "session_replaced":
      scheduleSnapshot(view);
      break;
    case "transcript_write_failed":
    case "extension_error":
    case "retry_fallback_exhausted":
      draftFor(view.session.id).error = str(event.errorMessage) || str(event.error) || str(event.lastError) || "本机引擎报告会话错误";
      break;
    case "session_closed":
    case "session_parked":
    case "session_released":
      view.status = "inactive";
      view.running = false;
      remember({ ...view.session, active: false, running: false });
      break;
    default: return;
  }
  renderView();
  renderMessages(view);
}

async function write(view: View, action: Action): Promise<Wire> {
  if (connection !== "online") throw new Error("实时连接不可用，请重新连接后重试。");
  try {
    const data = await api.action(view.session.id, action);
    const session = parseSession(data.session);
    if (session) remember(session);
    return data;
  } catch (error) {
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) void bootstrap(true);
    throw error;
  }
}

async function answerRequest(view: View, id: string, answer: Answer): Promise<void> {
  await write(view, { action: "answer", requestId: id, ...answer });
  view.requests.delete(id);
  if (view === current) renderView();
  scheduleSnapshot(view);
}

function renderAttachments(): void {
  const view = current;
  const host = box("attachments");
  const draft = view && draftFor(view.session.id);
  host.hidden = !draft?.images.length;
  host.replaceChildren();
  if (!draft) return;
  for (const image of draft.images) {
    const node = el("div", "attachment");
    const thumb = el("img");
    thumb.alt = image.name;
    thumb.src = image.url;
    const remove = button("移除", () => {
      draft.images = draft.images.filter(item => item !== image);
      renderAttachments();
      renderView();
      (host.querySelector("button") ?? btn("attach")).focus();
    }, "button--quiet");
    remove.setAttribute("aria-label", `移除图片：${image.name}`);
    node.append(thumb, remove);
    host.append(node);
  }
}

async function addImages(files: readonly File[]): Promise<void> {
  const view = current;
  if (!view || view.status !== "ready" || view.session.archived) return;
  const draft = draftFor(view.session.id);
  const errors: string[] = [];
  const jobs: Promise<Attachment>[] = [];
  for (const file of files) {
    const type = file.type;
    if (!isImageType(type)) { errors.push(`不支持图片格式：${file.name}`); continue; }
    if (!file.size || file.size > 2_100_000) { errors.push(`图片为空或超过 2.1 MB：${file.name}`); continue; }
    if (draft.images.length + draft.reading >= 4) { errors.push("最多可添加 4 张图片。"); break; }
    draft.reading++;
    jobs.push(new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error(`无法读取图片：${file.name}`)), { once: true });
      reader.addEventListener("load", () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const encoded = url.slice(url.indexOf(",") + 1);
        if (!encoded || !url.startsWith(`data:${type};base64,`)) { reject(new Error(`图片编码无效：${file.name}`)); return; }
        resolve({ type: "image", mimeType: type, data: encoded, name: file.name || "粘贴的图片", url });
      }, { once: true });
      reader.readAsDataURL(file);
    }));
  }
  if (view === current) renderView();
  const results = await Promise.allSettled(jobs);
  draft.reading -= jobs.length;
  for (const result of results) {
    if (result.status === "fulfilled") draft.images = [...draft.images, result.value];
    else errors.push(errorText(result.reason));
  }
  draft.error = [...new Set(errors)].join(" ");
  if (view === current) { renderAttachments(); renderView(); }
}

async function sendPrompt(): Promise<void> {
  const view = current;
  if (!view || btn("send").disabled || btn("send").hidden) return;
  const id = view.session.id;
  const draft = draftFor(id);
  const { text, mode: selectedMode, images } = draft;
  const turn = selectedMode === "prompt" ? "" : str(view.state.currentTurnId);
  const old = draft.admission;
  const clientMessageId = old && old.text === text && old.mode === selectedMode && old.turn === turn && old.imageList === images
    ? old.id : crypto.randomUUID();
  draft.admission = { id: clientMessageId, text, mode: selectedMode, turn, imageList: images };
  draft.error = "";
  sending.add(id);
  renderView();
  try {
    await write(view, {
      action: "prompt", message: text, mode: selectedMode, clientMessageId,
      ...(turn ? { expectedTurnId: turn } : {}),
      ...(images.length ? { images: images.map(({ type, mimeType, data }) => ({ type, mimeType, data })) } : {}),
    });
    draft.admission = undefined;
    if (draft.text === text) {
      draft.text = "";
      if (view === current) prompt.value = "";
    }
    draft.images = draft.images.filter(image => !images.includes(image));
    if (view === current) renderAttachments();
    scheduleSnapshot(view);
  } catch (error) {
    draft.error = `未能发送：${errorText(error)}`;
    if (error instanceof RequestError && error.status >= 400 && error.status < 500) draft.admission = undefined;
    scheduleSnapshot(view);
  } finally {
    sending.delete(id);
    if (view === current) renderView();
  }
}

async function runAction(view: View, action: Action, label: string, onError: (text: string) => void, after?: (data: Wire) => void): Promise<void> {
  const id = view.session.id;
  if (writes.has(id)) return;
  writes.add(id);
  onError("");
  renderView();
  manager.setAttribute("aria-busy", "true");
  inspector.setAttribute("aria-busy", "true");
  try {
    const data = await write(view, action);
    if (view !== current) return;
    after?.(data);
    if (action.action === "navigate") {
      if (object(data.result).cancelled === true) return;
      view.revision++;
      view.messages = [];
      view.liveKey = "";
      view.tools.clear();
      stream.reset();
      const editor = str(object(data.result).editorText);
      if (editor) {
        const draft = draftFor(id);
        draft.text = editor;
        prompt.value = editor;
      }
    }
    if (action.action === "resume") view.status = "loading";
    await snapshot(view, action.action === "resume" || action.action === "navigate");
    if (action.action === "resume" || action.action === "model") void loadOptions(view);
    if (manager.open) renderManager(view);
    if (inspector.open && action.action !== "abort") void loadDetails(view);
  } catch (error) {
    if (view === current) onError(`${label}失败：${errorText(error)}`);
  } finally {
    writes.delete(id);
    manager.removeAttribute("aria-busy");
    inspector.removeAttribute("aria-busy");
    if (view === current) renderView();
  }
}

function openChooser(): void {
  if (connection !== "online" || !workspaces.length || chooser.open) return;
  sel("new-cwd").replaceChildren(...workspaces.map(cwd => option(cwd, cwd)));
  inp("new-name").value = "";
  notice(box("new-error"));
  chooser.showModal();
}

async function createSession(): Promise<void> {
  if (createPending || connection !== "online") return;
  const cwd = sel("new-cwd").value;
  if (!workspaces.includes(cwd)) return;
  const name = inp("new-name").value.trim();
  if (name.length > 120) { notice(box("new-error"), "会话名称不能超过 120 个字符。"); return; }
  createPending = true;
  btn("create").disabled = true;
  notice(box("new-error"));
  try {
    const data = await api.request("/api/sessions", { cwd, ...(name ? { name } : {}) });
    const session = parseSession(data.session);
    if (!session) throw new Error("本机服务没有返回会话。");
    remember(session);
    archived = session.archived;
    if (chooser.open) chooser.close();
    openSession(session.id);
  } catch (error) {
    notice(box("new-error"), `创建失败：${errorText(error)}`);
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) void bootstrap(true);
  } finally {
    createPending = false;
    updateConnection();
  }
}

function renderManager(view: View): void {
  const body = box("manage-body");
  const previously = document.activeElement;
  const focusedKey = previously instanceof HTMLElement && body.contains(previously) ? previously.dataset.key : undefined;
  const id = view.session.id;
  const fail = (message: string) => notice(box("manage-error"), message);
  const name = el("input");
  name.type = "text";
  name.required = true;
  name.maxLength = 120;
  name.value = view.session.name;
  name.dataset.key = "name";
  const rename = el("form", "stack stack--tight");
  const save = el("button", "button", "保存名称");
  save.type = "submit";
  save.dataset.write = "";
  save.dataset.key = "save";
  const renameRow = el("div", "row");
  renameRow.append(save);
  rename.append(field("会话名称", name), renameRow);
  rename.addEventListener("submit", event => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) { fail("请输入会话名称。"); return; }
    if (value !== view.session.name) void runAction(view, { action: "rename", name: value }, "重命名", fail);
  });

  const row = (label: string, key: string, action: Action, disabled = false) => {
    const control = button(label, () => void runAction(view, action, label, fail));
    control.dataset.key = key;
    control.dataset.write = "";
    control.disabled = disabled || connection !== "online";
    return control;
  };
  const manage = el("section", "subpanel stack stack--tight");
  const controls = el("div", "row");
  controls.append(
    row(view.session.archived ? "取消归档" : "归档", "archive", { action: "archive", enabled: !view.session.archived }),
    row(view.session.settled ? "重新标为未结清" : "标为已结清", "settle", { action: "settle", enabled: !view.session.settled }),
  );
  manage.append(el("h3", "", "会话状态"), el("p", "small muted", view.session.archived ? "已归档" : "未归档"), controls);
  const runtime = el("section", "subpanel stack stack--tight");
  const flags = el("div", "row");
  const fast = view.state.fastMode;
  const auto = view.state.autoCompactionEnabled;
  if (typeof fast === "boolean") flags.append(row(fast ? "关闭快速模式" : "开启快速模式", "fast", { action: "fast", enabled: !fast }));
  if (typeof auto === "boolean") flags.append(row(auto ? "关闭自动压缩" : "开启自动压缩", "auto", { action: "autoCompaction", enabled: !auto }));
  runtime.append(el("h3", "", "运行设置"));
  if (flags.childElementCount) runtime.append(flags);
  const compactForm = el("form", "stack stack--tight");
  const instructions = el("input");
  instructions.type = "text";
  instructions.maxLength = 6000;
  instructions.dataset.key = "instructions";
  const compact = el("button", "button", "压缩上下文");
  compact.type = "submit";
  compact.dataset.write = "";
  compact.dataset.idle = "";
  compact.dataset.key = "compact";
  compact.disabled = connection !== "online" || view.running || view.compacting;
  const compactRow = el("div", "row");
  compactRow.append(compact);
  compactForm.append(field("压缩说明（选填）", instructions), compactRow);
  compactForm.addEventListener("submit", event => {
    event.preventDefault();
    if (view.running || view.compacting || writes.has(id)) { fail("请在当前运行结束后压缩。"); return; }
    const value = instructions.value.trim();
    void runAction(view, { action: "compact", ...(value ? { instructions: value } : {}) }, "压缩上下文", fail);
  });
  runtime.append(compactForm);
  save.disabled = connection !== "online";
  body.replaceChildren(rename, manage, runtime);
  if (focusedKey) [...body.querySelectorAll<HTMLElement>("[data-key]")].find(node => node.dataset.key === focusedKey)?.focus();
}

let detailsSeq = 0;
async function loadDetails(view: View): Promise<void> {
  const ticket = ++detailsSeq;
  const body = box("details-body");
  const fail = (message: string) => notice(box("details-error"), message);
  if (!body.childElementCount) body.append(el("p", "muted", "正在读取运行详情…"));
  fail("");
  try {
    const data = await api.request(`${sessionPath(view.session.id)}/details`);
    if (ticket !== detailsSeq || view !== current || !inspector.open) return;
    renderDetails(body, data, view.state, view.options, {
      canWrite: connection === "online",
      canNavigate: connection === "online" && !view.running && !view.compacting && !sending.has(view.session.id),
      queueCount: view.queue,
      refresh: () => void loadDetails(view),
      clearQueue: () => {
        if (window.confirm("清空所有尚未发送的排队输入？")) void runAction(view, { action: "clearQueue" }, "清空队列", fail);
      },
      navigate: targetId => {
        const draft = draftFor(view.session.id);
        const warning = draft.text.trim()
          ? "切换上下文位置？此操作可能把所选历史输入放入编辑器，替换当前草稿。"
          : "切换上下文位置？原有分支仍会保留。";
        if (!view.running && !view.compacting && window.confirm(warning)) {
          void runAction(view, { action: "navigate", targetId }, "切换上下文", fail, result => {
            if (object(result.result).cancelled === true) fail("本次切换已取消。");
          });
        }
      },
      insertCommand: command => {
        const draft = draftFor(view.session.id);
        const start = prompt.selectionStart;
        const end = prompt.selectionEnd;
        const spacer = start > 0 && !/\s/.test(draft.text[start - 1] ?? "") ? " " : "";
        draft.text = `${draft.text.slice(0, start)}${spacer}${command} ${draft.text.slice(end)}`;
        prompt.value = draft.text;
        const caret = start + spacer.length + command.length + 1;
        inspector.close();
        prompt.focus();
        prompt.setSelectionRange(caret, caret);
        renderView();
      },
    });
  } catch (error) {
    if (ticket === detailsSeq && inspector.open && view === current) {
      body.replaceChildren(button("重试读取", () => void loadDetails(view)));
      fail(`无法读取运行详情：${errorText(error)}`);
    }
  }
}

function listen(): void {
  btn("open-navigation").addEventListener("click", () => toggleNav(true));
  btn("close-navigation").addEventListener("click", () => toggleNav(false, true));
  btn("nav-scrim").addEventListener("click", () => toggleNav(false, true));
  mobile.addEventListener("change", () => toggleNav(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && navOpen && !chooser.open) toggleNav(false, true);
  });
  inp("search").addEventListener("input", renderSessions);
  btn("recent").addEventListener("click", () => { archived = false; renderSessions(); });
  btn("archived").addEventListener("click", () => { archived = true; renderSessions(); });
  btn("new-welcome").addEventListener("click", openChooser);
  btn("new-sidebar").addEventListener("click", openChooser);
  form("new-form").addEventListener("submit", event => { event.preventDefault(); void createSession(); });
  for (const modal of [chooser, manager, inspector]) {
    for (const close of modal.querySelectorAll("[data-close]")) close.addEventListener("click", () => modal.close());
  }
  btn("manage-button").addEventListener("click", () => {
    if (!current || manager.open) return;
    notice(box("manage-error"));
    renderManager(current);
    manager.showModal();
  });
  btn("details-button").addEventListener("click", () => {
    if (!current || inspector.open) return;
    box("details-body").replaceChildren();
    inspector.showModal();
    void loadDetails(current);
  });
  btn("retry").addEventListener("click", () => {
    source?.close();
    source = undefined;
    transport = "waiting";
    recovering = false;
    bootError = "";
    listError = "";
    updateConnection();
    void bootstrap(true);
  });
  btn("resume").addEventListener("click", () => {
    const view = current;
    if (!view) return;
    if (view.session.active) {
      view.status = "loading";
      view.error = "";
      renderView();
      void snapshot(view, true);
      void loadOptions(view);
      return;
    }
    void runAction(view, { action: "resume" }, "恢复会话", text => { view.error = text; renderView(); });
  });
  form("composer").addEventListener("submit", event => { event.preventDefault(); void sendPrompt(); });
  prompt.addEventListener("input", () => {
    if (!current) return;
    draftFor(current.session.id).text = prompt.value;
    renderView();
  });
  prompt.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendPrompt();
    }
  });
  prompt.maxLength = 200_000;
  prompt.addEventListener("paste", event => {
    const images = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
    if (images.length) void addImages(images);
  });
  btn("attach").addEventListener("click", () => inp("files").click());
  inp("files").addEventListener("change", event => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) {
      void addImages([...input.files ?? []]);
      input.value = "";
    }
  });
  mode.addEventListener("change", () => {
    if (!current) return;
    draftFor(current.session.id).mode = mode.value === "steer" || mode.value === "follow_up" ? mode.value : "prompt";
    renderView();
  });
  btn("stop").addEventListener("click", () => {
    const view = current;
    if (view) void runAction(view, { action: "abort" }, "停止", text => { draftFor(view.session.id).error = text; renderView(); });
  });
  btn("jump-to-request").addEventListener("click", () => {
    const first = box("interactions").querySelector("form");
    if (!first) return;
    first.tabIndex = -1;
    first.focus();
    first.scrollIntoView({ block: "nearest" });
  });
  sel("model").addEventListener("change", () => {
    const view = current;
    const selected = sel("model").value;
    const model = list(view?.options.models).map(object).find(item => modelKey(item) === selected);
    if (view && model) void runAction(view, { action: "model", provider: str(model.provider), modelId: str(model.id) }, "切换模型",
      text => { draftFor(view.session.id).error = text; renderView(); });
    else renderView();
  });
  sel("thinking").addEventListener("change", () => {
    const view = current;
    const level = sel("thinking").value;
    if (view && level) void runAction(view, { action: "thinking", level }, "切换思考档",
      text => { draftFor(view.session.id).error = text; renderView(); });
    else renderView();
  });
}

startTheme();
listen();
void bootstrap();
