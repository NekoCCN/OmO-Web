import { Api, RequestError, parseSession, parseSessions, sessionPath } from "./api.ts";
import type { Action, BranchSource, Image, Mode, Session } from "./api.ts";
import { byId, button, el, errorText, field, isImageType, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { Interactions, isRequest, requestId } from "./interactions.ts";
import type { Answer } from "./interactions.ts";
import { Transcript, messageKey, roleOf } from "./transcript.ts";
import type { ToolTrace, TranscriptEntry } from "./transcript.ts";
import { branchDialog, renderDetails } from "./details.ts";
import { renderCapabilities, renderLocalCompatibility } from "./capabilities.ts";
import { canShowSnapshot, renderJournal, renderRuntimePane } from "./runtime-summary.ts";
import { cliHistory } from "./cli-history.ts";
import { cliLive } from "./cli-live.ts";
import { cliFollow } from "./cli-follow.ts";
import { BUILTIN_COMMANDS, parseBuiltinInput } from "./builtin-commands.ts";
import type { BuiltinCommand } from "./builtin-commands.ts";

const box = (id: string) => byId(id, HTMLElement);
const btn = (id: string) => byId(id, HTMLButtonElement);
const sel = (id: string) => byId(id, HTMLSelectElement);
const inp = (id: string) => byId(id, HTMLInputElement);
const form = (id: string) => byId(id, HTMLFormElement);
const dialog = (id: string) => byId(id, HTMLDialogElement);
const api = new Api();
const stream = new Transcript(box("messages"), box("transcript"), box("no-messages"));
const interactions = new Interactions(box("interactions"));
const trace = box("session-trace");
const traceControls = {
  user: btn("trace-jump-user"), assistant: btn("trace-jump-assistant"),
  tool: btn("trace-jump-tool"), request: btn("jump-to-request"),
};
const traceTargets = new Map<HTMLButtonElement, HTMLElement>();
const prompt = byId("prompt", HTMLTextAreaElement);
const mode = sel("prompt-mode");
const modelSelect = sel("model");
const thinkingSelect = sel("thinking");
const applyModel = el("button", "button button--quiet", "应用模型");
applyModel.id = "apply-model";
applyModel.type = "button";
applyModel.hidden = true;
const modelStatus = el("p", "small muted sr-only");
modelStatus.id = "model-preview";
modelStatus.setAttribute("role", "status");
modelStatus.hidden = true;
modelSelect.setAttribute("aria-describedby", modelStatus.id);
thinkingSelect.setAttribute("aria-describedby", modelStatus.id);
modelSelect.parentElement?.after(applyModel);
const composeOptions = box("compose-options");
const composeSelectors = el("div", "row");
composeSelectors.append(...composeOptions.children);
const composeSettings = el("div", "stack stack--tight");
composeSettings.append(composeSelectors, modelStatus);
composeOptions.append(composeSettings);
const chooser = dialog("new-dialog");
const manager = dialog("manage-dialog");
const inspector = dialog("details-dialog");
const commandDialog = dialog("command-dialog");
const branchModal = dialog("branch-dialog");
const settingLabels: Readonly<Record<string, string>> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const thinkingSources: Readonly<Record<string, string>> = {
  explicit: "显式指定", session: "会话内记录", global: "设备记忆", "model-default": "模型默认",
  default: "默认设置", fallback: "回退档位", clamped: "按模型能力调整",
};
const approvalLabels: Readonly<Record<string, string>> = {
  ask: "审批：询问",
  auto: "审批：Auto",
  "full-access": "审批：无审批",
};
const approvalChoices: ReadonlyArray<readonly [string, string]> = [
  ["ask", approvalLabels.ask],
  ["auto", approvalLabels.auto],
  ["full-access", approvalLabels["full-access"]],
];
const commandToken = /^(?:\/(?:[A-Za-z0-9_-]{1,64}|skill:[A-Za-z0-9-]{1,64})|\$[A-Za-z0-9-]{1,64})$/;
type Attachment = Image & { readonly name: string; readonly url: string };
type Draft = {
  text: string; mode: Mode; images: Attachment[]; reading: number; error: string;
  commandMode: boolean; commandText: string; commandError: string; commandStatus?: string;
  commandAdmission?: { readonly text: string; readonly id: string };
  admission?: { readonly imageList: readonly Attachment[]; readonly text: string; readonly mode: Mode; readonly turn: string; readonly id: string };
};
type View = {
  session: Session; status: "inactive" | "loading" | "ready" | "failed"; error: string; state: Wire;
  messages: TranscriptEntry[]; liveKey: string; tools: Map<string, ToolTrace>; requests: Map<string, Wire>;
  options: Wire; optionsError: string; handoff: Wire; queue: number | undefined; revision: number; serial: number;
  sync: number; optionSync: number; running: boolean; compacting: boolean;
  modelSelection?: string;
  modelPreview?: { readonly key: string; result?: Wire };
};
type Release = { status: "pending" } | { status: "released"; command: string; copyStatus?: string }
  | { status: "failed" | "uncertain"; error: string };

let current: View | undefined;
let engine: Wire = {};
let handoffSupport: Wire = {};
let connection: "connecting" | "online" | "offline" = "connecting";
let transport: "waiting" | "open" | "lost" = "waiting";
let recovering = false;
let bootstrapped = false;
let bootError = "";
let listError = "";
let sessions = new Map<string, Session>();
type CliRow = { readonly id: string; readonly name: string; readonly cwd: string; readonly updatedAt: number };
let cliRows: readonly CliRow[] = [];
let cliError = "";
// Never fetched: the first update after bootstrap must not be throttled.
let cliAt = Number.NEGATIVE_INFINITY;
let cliSeq = 0;
const CLI_REFRESH_MS = 30_000;
const cliTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
let workspaces: readonly string[] = [];
const workspaceKey = "omo-web-workspace";
let workspace = "";
const workspaceSessions = new Map<string, string>();
const displayedWorkspace = () => follow.workspace || workspace;
const inWorkspace = (cwd: string) => workspaces.includes(cwd) && (!displayedWorkspace() || cwd === displayedWorkspace());
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
const releases = new Map<string, Release>();
const mobile = matchMedia("(max-width: 760px)");
const compactInspector = matchMedia("(max-width: 1000px)");
const system = matchMedia("(prefers-color-scheme: dark)");
const countFormat = new Intl.NumberFormat("zh-CN");
const focusCliLauncher = (id: string) => btn(mobile.matches ? "open-navigation" : id).focus();
const showBranch = branchDialog(api, enterBranch);
const openBranch = (source: BranchSource) => {
  if (branchModal.open) return;
  branchModal.dataset.sourceKind = source.kind;
  showBranch(source);
};
const follow = cliFollow(api, cwd => workspaces.includes(cwd), () => {
  renderWorkspace();
  renderSessions();
  renderCliSessions();
  renderView();
});
const live = cliLive(api, () => focusCliLauncher("cli-live-button"), openBranch, inWorkspace);
let leavingHistory = false;
const history = cliHistory(api, () => {
  if (!leavingHistory && !document.querySelector("dialog:modal")) focusCliLauncher("cli-history-button");
  leavingHistory = false;
}, openBranch, historyResumeUnavailable, (session, show) => {
  // Adoption changed: a CLI journal gained (or will gain) a Web alias.
  void fetchCliRows(true);
  if (!show) { void fetchSessions(); return; }
  leavingHistory = true;
  dialog("cli-history-dialog").close();
  archived = session.archived;
  if (releases.get(session.id)?.status === "pending" && current?.session.id === session.id) markInactive(current);
  releases.delete(session.id);
  remember(session);
  openSession(session.id, true);
}, inWorkspace);

function handoffReason(reason: unknown): string {
  switch (reason) {
    case "engine_offline": return "本机引擎未连接。";
    case "shared_transport": return "顺序换端需要私有本机传输。";
    case "missing_capability": return "此 OmO 版本不支持顺序换端。";
    case "profile_mismatch": return "本机引擎与 CLI 会话目录不是同一配置。";
    case "session_busy": return "会话正在运行，请等待当前回合结束后再交接。";
    case "dialog_pending": return "会话有待处理的交互，请先处理后再交接。";
    default: return "本机服务未确认可顺序换端。";
  }
}

function historyResumeUnavailable(): string {
  if (connection !== "online") return "本机连接不可用，暂时只能浏览记录。";
  return handoffSupport.supported === true ? "" : handoffReason(handoffSupport.reason);
}

function handoffUnavailable(view: View): string {
  if (!view.session.active || view.status !== "ready") return "请先恢复此会话。";
  if (connection !== "online") return "本机连接不可用，无法交接。";
  if (handoffSupport.supported !== true) return handoffReason(handoffSupport.reason);
  if (view.running || view.compacting) return handoffReason("session_busy");
  if (view.requests.size) return handoffReason("dialog_pending");
  if (view.queue) return "还有排队输入，请先等待处理完成。";
  if (view.handoff.eligible !== true) return handoffReason(view.handoff.reason);
  if (writes.has(view.session.id) || sending.has(view.session.id)) return "正在提交操作，请稍候。";
  return "";
}

function markInactive(view: View): void {
  view.sync++;
  view.optionSync++;
  view.status = "inactive";
  view.running = false;
  view.compacting = false;
}

function enterBranch(session: Session, editorText: string, source: BranchSource): void {
  if (!workspaces.includes(session.cwd)) return;
  if (source.kind === "live") live.closeAfterBranch();
  if (source.kind === "history") {
    leavingHistory = true;
    dialog("cli-history-dialog").close();
  }
  archived = false;
  draftFor(session.id).text = editorText;
  remember(session);
  void fetchCliRows(true);
  openSession(session.id, true);
}

function draftFor(id: string): Draft {
  let draft = drafts.get(id);
  if (!draft) {
    draft = { text: "", mode: "prompt", images: [], reading: 0, error: "", commandMode: false, commandText: "", commandError: "" };
    drafts.set(id, draft);
  }
  return draft;
}

function composerCommand(text: string): boolean {
  return parseBuiltinInput(text).kind !== "plain" || commandToken.test(text.split(/\s/, 1)[0] ?? "");
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
  live.setTransport(transport);
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
  history.update();
  renderSessions();
  // CLI discovery refreshes on every connection-level update (throttled),
  // so newly CLI-created journals appear without opening the history dialog.
  void fetchCliRows();
  renderCliSessions();
  renderView();
}

async function fetchCliRows(force = false): Promise<void> {
  // The sidebar list is only meaningful once bootstrap has provided the token
  // and workspace state; earlier connection updates must not spend a fetch.
  if (!bootstrapped) return;
  if (!force && performance.now() - cliAt < CLI_REFRESH_MS) return;
  const ticket = ++cliSeq;
  cliAt = performance.now();
  try {
    const data = await api.request("/api/cli-history");
    if (ticket !== cliSeq) return;
    cliError = data.available === true ? "" : "CLI 历史不可用：未启用或未找到本地历史记录。";
    cliRows = data.available === true ? list(data.sessions).map(object).flatMap(row => {
      const id = str(row.id);
      // Adopted rows already appear as Web aliases above; the sidebar only
      // discovers journals without one. Previewing one never opens a route,
      // and entering still goes through explicit resume under holder admission.
      return id && row.adopted !== true
        ? [{ id, name: str(row.name) || "未命名 CLI 会话", cwd: str(row.cwd), updatedAt: num(row.updatedAt) ?? 0 }] : [];
    }) : [];
  } catch (error) {
    if (ticket !== cliSeq) return;
    cliError = `无法读取 CLI 历史：${errorText(error)}`;
  }
  renderCliSessions();
}

function renderCliSessions(): void {
  const section = box("cli-sessions");
  const host = box("cli-session-list");
  const focused = document.activeElement instanceof HTMLButtonElement && host.contains(document.activeElement)
    ? document.activeElement.dataset.cliSession : undefined;
  const query = inp("search").value.trim().toLocaleLowerCase();
  const matches = archived ? [] : cliRows
    .filter(row => inWorkspace(row.cwd) && (!query || `${row.name} ${row.cwd}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  section.hidden = matches.length === 0 && !cliError;
  host.replaceChildren();
  for (const row of matches) {
    const item = el("li");
    const open = button("", () => openCliHistory(row.id), "button--quiet session-link");
    open.dataset.cliSession = row.id;
    const stamp = Number.isFinite(new Date(row.updatedAt).getTime()) ? cliTime.format(row.updatedAt) : "";
    open.append(el("span", "", row.name), el("span", "small muted path", row.cwd), el("small", "", stamp));
    item.append(open);
    host.append(item);
  }
  host.hidden = !matches.length;
  notice(box("cli-list-empty"), matches.length ? "" : cliError || (bootstrapped ? "暂无本机 CLI 会话。" : ""));
  if (focused) [...host.querySelectorAll("button")].find(row => row.dataset.cliSession === focused)?.focus({ preventScroll: true });
}

function applySessions(items: readonly Session[]): void {
  sessions = new Map(items.map(session => [session.id, session]));
  if (current) {
    current.session = sessions.get(current.session.id) ?? current.session;
    if (!workspaces.includes(current.session.cwd)) clearCurrentView();
    else if (!current.session.active && current.status === "ready" && releases.get(current.session.id)?.status !== "pending") {
      markInactive(current);
      if (manager.open) manager.close();
    }
  }
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

function storeWorkspace(cwd: string): void {
  workspace = cwd;
  try { localStorage.setItem(workspaceKey, cwd); }
  catch { /* The current page can still scope navigation without storage. */ }
}

function workspaceLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  for (let depth = 1; depth <= parts.length; depth++) {
    const suffix = parts.slice(-depth).join("/");
    if (!workspaces.some(root => root !== cwd && root.endsWith(`/${suffix}`))) return suffix;
  }
  return cwd;
}

function renderWorkspace(): void {
  const picker = sel("workspace-select");
  const cwd = displayedWorkspace();
  syncSelect(picker, workspaces.map(root => [root, workspaceLabel(root)]), cwd, "所有工作区");
  picker.title = cwd || "所有工作区";
  box("workspace-field").hidden = workspaces.length < 2;
}

function clearCurrentView(): void {
  current = undefined;
  clearTimeout(refreshTimer);
  stream.reset();
  interactions.reset();
  prompt.value = "";
  renderAttachments();
  if (manager.open) manager.close();
  closeDetails(false);
  setComposeOptions(false);
  if (commandDialog.open) { commandRequest?.abort(); commandDialog.close(); }
  if (branchModal.open && branchModal.dataset.sourceKind === "web") branchModal.close();
}

function selectWorkspace(cwd: string): void {
  if (cwd && !workspaces.includes(cwd)) return;
  const wasFollowing = follow.active;
  follow.stop();
  if (cwd === workspace) {
    if (wasFollowing) toggleNav(false, true);
    return;
  }
  storeWorkspace(cwd);
  renderWorkspace();
  const saved = workspaceSessions.get(workspace);
  const session = saved ? sessions.get(saved) : undefined;
  if (session && inWorkspace(session.cwd)) {
    archived = session.archived;
    openSession(session.id, false, false);
  } else if (current && inWorkspace(current.session.cwd)) {
    workspaceSessions.set(workspace, current.session.id);
  } else clearCurrentView();
  live.scopeChanged();
  toggleNav(false, true);
  renderSessions();
  renderCliSessions();
  renderView();
}

async function bootstrap(reconcile = false): Promise<void> {
  const ticket = ++bootSeq;
  const version = mutation;
  try {
    const data = await api.request("/api/bootstrap");
    if (ticket !== bootSeq) return;
    api.token = str(data.token);
    engine = object(data.engine);
    handoffSupport = object(data.handoff);
    workspaces = [...new Set(list(data.workspaces).filter((cwd): cwd is string => typeof cwd === "string" && Boolean(cwd)))];
    if (!bootstrapped) {
      try { workspace = localStorage.getItem(workspaceKey) ?? ""; }
      catch { /* The default is all workspaces. */ }
    }
    if (workspace && (workspaces.length < 2 || !workspaces.includes(workspace))) storeWorkspace("");
    if (current && !workspaces.includes(current.session.cwd)) clearCurrentView();
    follow.recheckWorkspace();
    renderWorkspace();
    live.scopeChanged();
    bootstrapped = true;
    bootError = "";
    listError = "";
    if (version === mutation) applySessions(parseSessions(data));
    if (!source) connectEvents();
    const release = current && releases.get(current.session.id);
    if (reconcile && current && (!release || release.status === "failed")) {
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
  const items = [...sessions.values()].filter(item => inWorkspace(item.cwd) && item.archived === archived && (!query || `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query)))
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
      if (stamp) stamp.textContent = releases.get(session.id)?.status === "released" ? "已释放"
        : session.running ? "运行中" : session.settled ? "已结清" : session.active ? "已打开" : "待恢复";
      if (!follow.active && session.id === current?.session.id) row.setAttribute("aria-current", "true");
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

function openSession(id: string, focusComposer = false, focusConversation = true): void {
  const session = sessions.get(id);
  if (!session || !workspaces.includes(session.cwd)) return;
  follow.stop();
  if (!inWorkspace(session.cwd)) {
    // Explicitly entering a new or adopted session may choose another authorized root.
    storeWorkspace(session.cwd);
    renderWorkspace();
    renderCliSessions();
    live.scopeChanged();
  }
  workspaceSessions.set(workspace, id);
  if (focusConversation) {
    toggleNav(false);
    box("conversation").focus();
  }
  if (id === current?.session.id) {
    if (!focusComposer) return;
    if (current.status === "ready") { prompt.focus(); return; }
  }
  if (manager.open) manager.close();
  closeDetails(false);
  setComposeOptions(false);
  if (commandDialog.open) { commandRequest?.abort(); commandDialog.close(); }
  if (focusConversation) box("conversation").focus({ preventScroll: true });
  const release = releases.get(id);
  const load = session.active && release?.status !== "released" && release?.status !== "uncertain";
  const view: View = {
    session, status: load ? "loading" : "inactive", error: "", state: {}, messages: [], liveKey: "",
    tools: new Map(), requests: new Map(), options: {}, optionsError: "", handoff: {}, queue: undefined, revision: 0, serial: 0,
    sync: 0, optionSync: 0, running: session.running, compacting: false,
  };
  current = view;
  stream.reset();
  interactions.reset();
  const draft = draftFor(id);
  prompt.value = draft.commandMode ? draft.commandText : draft.text;
  mode.value = draft.mode;
  renderAttachments();
  renderSessions();
  renderView();
  if (load) {
    void snapshot(view, true).then(() => {
      if (focusComposer && view === current && view.status === "ready" && document.activeElement === box("conversation")) prompt.focus();
    });
    void loadOptions(view);
  } else if (focusConversation && release?.status === "released" && !document.querySelector("dialog:modal")) box("handoff-title").focus();
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

function renderModelOptions(view: View, disabled: boolean, canPreview: boolean): void {
  const selected = object(view.state.model);
  const activeKey = modelKey(selected);
  const models = list(view.options.models).map(object).filter(model => Boolean(modelKey(model)));
  const pending = view.state.pendingModelSwitch != null;
  if (!canPreview || pending || view.modelSelection === activeKey) view.modelSelection = undefined;
  const staged = models.find(model => modelKey(model) === view.modelSelection);
  const target = staged ?? models.find(model => modelKey(model) === activeKey);
  if (activeKey && !models.some(model => modelKey(model) === activeKey)) models.unshift(selected);
  syncSelect(modelSelect, models.map(model => [modelKey(model), modelTitle(model)]), modelKey(staged ?? selected), "模型");
  modelSelect.disabled = disabled || pending || !list(view.options.models).length;
  applyModel.hidden = !staged;
  applyModel.disabled = disabled || pending;

  let message = pending ? "模型切换待完成。" : "";
  let profile: Wire | undefined;
  if (canPreview && !pending && target) {
    const key = JSON.stringify([activeKey, modelKey(target), view.state.thinkingLevel]);
    if (view.modelPreview?.key !== key && !writes.has(view.session.id)) {
      const ticket = { key, result: undefined as Wire | undefined };
      view.modelPreview = ticket;
      const params = new URLSearchParams({ provider: str(target.provider), modelId: str(target.id) });
      void api.request(`${sessionPath(view.session.id)}/model-preview?${params}`).catch(() => ({})).then(result => {
        if (current !== view || view.modelPreview !== ticket) return;
        ticket.result = result;
        renderView();
      });
    }
    const preview = view.modelPreview?.key === key ? view.modelPreview.result : undefined;
    const source = str(preview?.source);
    const level = str(preview?.level);
    if (preview?.status === "ok" && Object.hasOwn(thinkingSources, source) && Object.hasOwn(settingLabels, level)) {
      profile = preview;
      const levels = list(profile.availableLevels).map(str).filter(item => Object.hasOwn(settingLabels, item));
      message = `${staged ? "切换后" : "当前"}：${settingLabels[level]}（来源：${thinkingSources[source]}） · 可用：${levels.map(item => settingLabels[item]).join("、")}`;
    } else message = preview ? "此模型的档位预览和来源不可用。" : "正在读取模型档位…";
  } else {
    view.modelPreview = undefined;
    if (canPreview && !pending && activeKey && !view.optionsError && list(view.options.models).length) {
      message = "当前模型不在可用列表中，无法预览档位。";
    }
  }
  if (modelStatus.textContent !== message) modelStatus.textContent = message;
  modelStatus.classList.toggle("sr-only", !staged);
  modelStatus.hidden = !message;
  modelSelect.title = !staged && message ? message : "模型";
  thinkingSelect.title = !staged && message ? message : "思考档";
  const activeProfile = staged ? undefined : profile;
  const selectedLevel = str(activeProfile?.level ?? view.state.thinkingLevel);
  const levels = list(activeProfile?.availableLevels ?? view.options.levels).map(str).filter(level => Object.hasOwn(settingLabels, level));
  const hasLevels = levels.length > 0;
  if (Object.hasOwn(settingLabels, selectedLevel) && !levels.includes(selectedLevel)) levels.unshift(selectedLevel);
  syncSelect(thinkingSelect, levels.map(level => [level, `思考：${settingLabels[level]}`]), selectedLevel, "思考档");
  thinkingSelect.disabled = disabled || pending || Boolean(staged) || !hasLevels;
}

function refreshModelOptions(view: View, previousKey: string): void {
  if (!previousKey || previousKey === modelKey(object(view.state.model))) return;
  view.modelSelection = undefined;
  view.modelPreview = undefined;
  view.options = { ...view.options, levels: [] };
  void loadOptions(view);
}

function setTraceTarget(control: HTMLButtonElement, target?: HTMLElement): void {
  const before = traceTargets.get(control);
  if (before === target) return;
  before?.removeAttribute("id");
  if (target) {
    const destination = control.getAttribute("aria-controls");
    if (destination) target.id = destination;
    traceTargets.set(control, target);
  } else traceTargets.delete(control);
  control.hidden = !target;
  trace.hidden = box("active-session").hidden || !traceTargets.size;
}

function renderView(): void {
  const following = follow.active;
  box("cli-follow-view").hidden = !following;
  box("transcript").hidden = following;
  btn("cli-follow-stop").hidden = !following;
  btn("cli-follow-button").setAttribute("aria-pressed", String(following));
  box("banner").hidden = following || !box("banner-text").textContent;
  if (following) {
    trace.hidden = true;
    box("composer-shell").hidden = true;
    btn("details-button").hidden = true;
    btn("web-branch-button").hidden = true;
    btn("manage-button").hidden = true;
    renderHeading(follow.target?.name ?? "跟随 CLI", follow.target?.cwd ?? "");
    return;
  }
  const view = current;
  const session = view?.session;
  const release = session && releases.get(session.id);
  const pending = release?.status === "pending";
  const receipt = release?.status === "released" ? release : undefined;
  const available = Boolean(view && view.status === "ready");
  box("welcome").hidden = Boolean(view);
  box("inactive-session").hidden = !view || available;
  box("active-session").hidden = !available;
  trace.hidden = !available || !traceTargets.size;
  if (!available) {
    for (const control of Object.values(traceControls)) setTraceTarget(control);
  }
  box("composer-shell").hidden = !available;
  prompt.disabled = !available || session?.active !== true;
  renderHeading(session?.name ?? "会话工作台", session?.cwd ?? workspace);
  btn("details-button").hidden = !available;
  if (!available) closeDetails(false);
  btn("web-branch-button").hidden = !session;
  btn("web-branch-button").disabled = pending;
  btn("manage-button").hidden = !available;
  if (!view) return;
  const draft = draftFor(view.session.id);
  if (manager.open) {
    const reason = pending ? "正在释放当前会话…" : handoffUnavailable(view);
    btn("manage-handoff").disabled = Boolean(reason);
    notice(box("manage-handoff-status"), reason);
    notice(box("manage-handoff-error"), release?.status === "failed" ? release.error : "");
  }
  for (const modal of [manager, inspector]) if (modal.open) {
    modal.querySelectorAll<HTMLButtonElement>("[data-write]").forEach(node => {
      node.disabled = connection !== "online" || pending || writes.has(view.session.id) || node.hasAttribute("data-unavailable")
        || (node.hasAttribute("data-idle") && (view.running || view.compacting || sending.has(view.session.id)));
    });
  }
  const active = view.status !== "inactive";
  box("inactive-title").textContent = view.status === "loading" ? "正在读取会话…" : view.status === "failed" ? "无法读取会话" : "继续此会话";
  const showReceipt = Boolean(receipt && view.status !== "loading");
  box("inactive-title").hidden = showReceipt;
  box("inactive-copy").hidden = showReceipt;
  box("inactive-copy").textContent = pending ? "正在释放当前会话，请等待本机确认。"
    : view.status === "loading" ? "正在向本机引擎请求会话记录。"
    : view.status === "failed" ? "请检查连接后重试。"
      : `${view.session.archived ? "此会话已归档。" : ""}恢复后可查看此前的对话并继续。`;
  box("handoff-receipt").hidden = !showReceipt;
  const code = box("handoff-command").firstElementChild;
  if (code && code.textContent !== (receipt?.command ?? "")) code.textContent = receipt?.command ?? "";
  notice(box("handoff-copy-status"), receipt?.copyStatus);
  notice(box("handoff-draft-note"), !available && (receipt || pending || release?.status === "uncertain") &&
    (draft.text || draft.commandText || draft.images.length || draft.reading) ? "未发送的文字和图片草稿仍保留在此页面。" : "");
  notice(box("session-error"), view.error || (release?.status === "uncertain" && view.status !== "loading" ? release.error : ""));
  const resume = btn("resume");
  resume.hidden = available || view.status === "loading";
  resume.disabled = connection !== "online" || pending || writes.has(view.session.id);
  resume.classList.toggle("button--primary", !receipt);
  resume.textContent = !receipt && release?.status !== "uncertain" && active && view.session.active ? "重试读取" : "恢复会话";
  if (!available) {
    view.modelSelection = undefined;
    view.modelPreview = undefined;
    return;
  }

  const online = connection === "online";
  const busy = pending || writes.has(view.session.id);
  const posting = sending.has(view.session.id);
  const blocked = view.session.archived;
  const canSend = online && view.session.active && !blocked && !view.compacting;
  const chosenMode = mode.value;
  const commandMode = draft.commandMode;
  const commandInput = commandMode || composerCommand(draft.text);
  const primaryStop = view.running && (chosenMode === "prompt" || blocked || commandInput);
  btn("stop").hidden = !view.running;
  btn("stop").disabled = !online || busy;
  btn("stop").classList.toggle("button--primary", primaryStop);
  btn("stop").classList.toggle("button--danger", !primaryStop);
  const send = btn("send");
  send.hidden = commandInput || (view.running && (chosenMode === "prompt" || blocked));
  send.disabled = !canSend || busy || posting || draft.reading > 0 || (!draft.text.trim() && !draft.images.length);
  send.textContent = chosenMode === "follow_up" ? "排队" : chosenMode === "steer" ? "发送引导" : "发送";
  const execute = btn("send-command");
  execute.hidden = !commandInput;
  execute.disabled = !canSend || view.running || Boolean(view.queue) || busy || posting ||
    !(commandMode ? draft.commandText : draft.text).trim();
  btn("command-mode").setAttribute("aria-pressed", String(commandMode));
  btn("command-picker").hidden = !commandMode;
  btn("command-picker").disabled = !online || blocked;
  box("prompt-label").textContent = commandMode ? "命令及参数" : "消息";
  prompt.placeholder = commandMode ? "输入 /命令 或 $技能，可加参数…" : "输入消息…";
  btn("attach").disabled = commandMode || blocked || draft.images.length + draft.reading >= 4 || busy;
  btn("attach").hidden = commandMode;
  (mode.closest("label") ?? mode).hidden = commandMode;
  mode.disabled = blocked || busy;
  renderModelOptions(view, !canSend || view.running || busy || posting, online && active && !pending);
  const preset = str(view.state.effectivePermissionPreset) || str(view.state.permissionPreset) || "ask";
  syncSelect(sel("approval"), [...approvalChoices], approvalChoices.some(([value]) => value === preset) ? preset : "ask", "审批");
  sel("approval").dataset.preset = sel("approval").value;
  sel("approval").disabled = !canSend || busy || posting;
  sel("approval").title = preset === "full-access"
    ? "无审批：默认允许工具操作；原生权限规则仍有效。用户问题仍需回答。"
    : preset === "auto" ? "Auto：原生确认安全的项目内操作自动放行，其余询问。"
      : "询问：未被原生权限规则处理的工具操作需要批准。恢复会话后回到此模式。";
  const usage = object(view.state.contextUsage);
  const percent = num(usage.percent);
  const tokens = num(usage.tokens);
  const limit = num(usage.contextWindow);
  notice(box("context-usage"), percent !== undefined ? `上下文 ${countFormat.format(percent)}%` : tokens !== undefined && limit ? `上下文 ${countFormat.format(tokens)} / ${countFormat.format(limit)}` : "");
  const hint = pending ? "正在交接，草稿不会发送。" : !online ? "离线：可继续编辑草稿，恢复连接后再发送。" : blocked
    ? "此会话已归档；可在会话管理中取消归档。"
    : draft.commandStatus || (commandInput ? view.running || view.compacting || view.queue ? "会话忙：请等待当前运行和队列结束再执行命令。"
      : "Ctrl / ⌘ + Enter 执行命令；命令前加空格可按文字发送。"
    : view.compacting ? "上下文压缩完成后可发送。" : draft.reading ? "正在读取图片…"
      : view.running && chosenMode === "prompt" ? "可停止当前轮，或切换发送方式以引导或排队。"
        : !view.running && chosenMode !== "prompt" ? "当前没有运行中的轮次；此输入将在下一轮处理。" : "Ctrl / ⌘ + Enter 发送");
  box("composer-hint").textContent = hint;
  const activity = [view.running ? "正在生成" : "", view.compacting ? "正在压缩上下文" : "", view.queue ? `${view.queue} 条输入待处理` : "",
    view.requests.size ? `${view.requests.size} 项等待你的决定` : ""].filter(Boolean).join(" · ");
  box("activity-row").hidden = !activity;
  box("activity-row").dataset.pending = String(view.requests.size > 0);
  if (box("activity").textContent !== activity) box("activity").textContent = activity;
  notice(box("compose-error"), (commandMode ? draft.commandError : draft.error) || view.optionsError ||
    (!manager.open && release?.status === "failed" ? release.error : ""));
  interactions.render(view.requests, online && !pending, (id, answer) => answerRequest(view, id, answer));
  setTraceTarget(traceControls.request, interactions.first);
}

function renderHeading(name: string, cwd: string): void {
  const title = box("session-title");
  if (title.textContent !== name) title.textContent = name;
  title.title = name;
  const path = box("session-path");
  notice(path, cwd);
  path.title = cwd;
  if (follow.active && cwd) path.dataset.workspaceLabel = workspaceLabel(cwd);
  else delete path.dataset.workspaceLabel;
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
  const release = releases.get(view.session.id);
  const requiresManualResume = release?.status === "released" || release?.status === "uncertain";
  if (requiresManualResume && (view.status !== "loading" || !writes.has(view.session.id))) return;
  const ticket = ++view.sync;
  const revision = view.revision;
  const baseRequests = new Set(view.requests.keys());
  const baseLiveKey = view.liveKey;
  const baseRunningTools = new Set([...view.tools].filter(([, tool]) => tool.stage === "running").map(([id]) => id));
  try {
    const data = await api.request(sessionPath(view.session.id));
    if (current !== view || ticket !== view.sync) return;
    const parsed = parseSession(data.session);
    if (requiresManualResume && !parsed?.active) throw new Error("本机服务未确认已恢复此会话。");
    const session = parsed ?? view.session;
    if (requiresManualResume) releases.delete(session.id);
    remember(session);
    const state = object(data.state);
    const previousModel = modelKey(object(view.state.model));
    view.handoff = object(data.handoff);
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
      const streaming = session.running || state.isStreaming === true;
      const liveAdded = [...view.requests].filter(([id]) => !baseRequests.has(id));
      view.requests = new Map([...requestsFrom(state), ...liveAdded]);
      if (!streaming && !view.running) {
        view.liveKey = "";
        if (baseLiveKey && !keys.has(baseLiveKey)) view.messages = view.messages.filter(entry => entry.key !== baseLiveKey);
        for (const id of baseRunningTools) if (view.tools.get(id)?.stage === "running") view.tools.delete(id);
      }
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
    refreshModelOptions(view, previousModel);
    view.status = "ready";
    view.error = "";
    renderView();
    renderMessages(view, bottom);
  } catch (error) {
    if (current !== view || ticket !== view.sync) return;
    if (releases.get(view.session.id)?.status === "pending") return;
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
  if (type === "cli-live") { live.invalidate(str(event.id)); return; }
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
    case "service_tier_changed": {
      const previousModel = modelKey(object(view.state.model));
      if (event.model) view.state = { ...view.state, model: event.model, thinkingLevel: event.thinkingLevel ?? view.state.thinkingLevel };
      if (!previousModel || previousModel === modelKey(object(view.state.model))) {
        view.modelPreview = undefined;
        void loadOptions(view);
      } else refreshModelOptions(view, previousModel);
      scheduleSnapshot(view);
      break;
    }
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
      if (releases.get(view.session.id)?.status !== "pending") markInactive(view);
      remember({ ...view.session, active: false, running: false });
      break;
    default: return;
  }
  renderView();
  renderMessages(view);
}

async function write(view: View, action: Action): Promise<Wire> {
  if (connection !== "online") throw new Error("实时连接不可用，请重新连接后重试。");
  if (action.action !== "resume" && (view !== current || view.status !== "ready" || !view.session.active ||
    releases.get(view.session.id)?.status === "pending")) {
    throw new Error("当前会话不可写，请在恢复后再试。");
  }
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
  host.hidden = !draft?.images.length || draft.commandMode;
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
  if (!view || view.status !== "ready" || view.session.archived || draftFor(view.session.id).commandMode) return;
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
      if (view === current && !draft.commandMode) prompt.value = "";
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

async function sendCommand(view: View): Promise<void> {
  if (btn("send-command").disabled || btn("send-command").hidden) return;
  const id = view.session.id;
  const draft = draftFor(id);
  const textField = draft.commandMode ? "commandText" : "text";
  const errorField = draft.commandMode ? "commandError" : "error";
  const text = draft[textField];
  const fail = (message: string) => { draft[errorField] = message; };
  const clear = () => {
    if (draft[textField] !== text) return;
    draft[textField] = "";
    if (current?.session.id === id && draft.commandMode === (textField === "commandText")) prompt.value = "";
  };
  draft.commandStatus = undefined;
  const parsed = parseBuiltinInput(text);
  if (parsed.kind === "malformed" || parsed.kind === "tui-only") {
    fail(parsed.kind === "malformed" ? parsed.message
      : `“/${parsed.name}”请在本机 OmO 终端重新发起。Web 没有转交输入，也没有发送给模型。`);
    renderView();
    return;
  }
  if (parsed.kind === "builtin") {
    fail("");
    try {
      if (await runBuiltin(view, parsed.command, fail)) clear();
    } catch (error) {
      fail(`命令失败：${errorText(error)}`);
    }
    if (current?.session.id === id) renderView();
    return;
  }
  const [, invocation, args] = /^(\S+)(?:[ \t]+([^\r\n]*))?$/.exec(text) ?? [];
  if (!invocation || !commandToken.test(invocation) || /[\r\n]/.test(text)) {
    fail("请输入单行 /命令 或 $技能，可附加参数。");
    renderView();
    return;
  }
  const clientMessageId = draft.commandAdmission?.text === text ? draft.commandAdmission.id : crypto.randomUUID();
  draft.commandAdmission = { text, id: clientMessageId };
  fail("");
  sending.add(id);
  renderView();
  try {
    await write(view, { action: "command", invocation, ...(args ? { arguments: args } : {}), clientMessageId });
    draft.commandAdmission = undefined;
    clear();
  } catch (error) {
    if (error instanceof RequestError && error.status >= 400 && error.status < 500) draft.commandAdmission = undefined;
    const code = error instanceof RequestError ? error.code : "";
    const label = code === "unknown_command" ? "未知命令" : code === "session_busy" || code === "bridge_busy" ? "会话忙"
      : code === "invalid_arguments" || code === "invalid_request" ? "命令输入无效" : "原生命令失败";
    fail(`${label}：${errorText(error)}`);
  } finally {
    sending.delete(id);
    if (current?.session.id === id) {
      renderView();
      scheduleSnapshot(current);
    }
  }
}

async function runBuiltin(view: View, command: BuiltinCommand, fail: (text: string) => void): Promise<boolean> {
  const id = view.session.id;
  const action = (value: Action, label: string) => runAction(view, value, label, fail);
  switch (command.name) {
    case "new":
      openChooser();
      if (!workspace && chooser.open && workspaces.includes(view.session.cwd)) sel("new-cwd").value = view.session.cwd;
      return chooser.open;
    case "resume":
    case "sessions":
      btn("cli-history-button").click();
      return dialog("cli-history-dialog").open;
    case "name":
    case "rename":
      if (command.value !== undefined) return action({ action: "rename", name: command.value }, "重命名");
      btn("manage-button").click();
      manager.querySelector<HTMLInputElement>('[data-key="name"]')?.focus();
      return manager.open;
    case "session":
    case "tree":
      openDetails();
      return inspector.open;
    case "fork":
      btn("web-branch-button").click();
      return dialog("branch-dialog").open;
    case "compact":
      return action({ action: "compact", ...(command.instructions ? { instructions: command.instructions } : {}) }, "压缩上下文");
    case "model": {
      if (!command.reference) {
        if (mobile.matches && !sel("model").disabled) setComposeOptions(true);
        sel("model").focus();
        if (document.activeElement === sel("model")) {
          try { sel("model").showPicker?.(); } catch (error) { if (!(error instanceof DOMException)) throw error; }
          return true;
        }
        fail("当前没有可选择的模型。");
        return false;
      }
      const matches = list(view.options.models).map(object).filter(model =>
        [str(model.id), `${str(model.provider)}/${str(model.id)}`].includes(command.reference ?? ""));
      if (matches.length === 1) return action({ action: "model", provider: str(matches[0].provider), modelId: str(matches[0].id) }, "切换模型");
      fail(matches.length ? "模型名称不唯一，请使用 provider/model。" : "未找到此模型，请用 /model 查看可选模型。");
      return false;
    }
    case "thinking": {
      if (!command.level) {
        if (mobile.matches && !sel("thinking").disabled) setComposeOptions(true);
        sel("thinking").focus();
        if (document.activeElement === sel("thinking")) {
          try { sel("thinking").showPicker?.(); } catch (error) { if (!(error instanceof DOMException)) throw error; }
          return true;
        }
        fail("当前没有可选择的思考档。");
        return false;
      }
      if (!list(view.options.levels).includes(command.level)) {
        fail("当前模型不支持这个思考档位。");
        return false;
      }
      return action({ action: "thinking", level: command.level }, "切换思考档");
    }
    case "fast":
      if (typeof view.state.fastMode !== "boolean") { fail("当前模型没有可用的快速模式。"); return false; }
      return action({ action: "fast", enabled: command.mode ? command.mode === "on" : !view.state.fastMode }, "切换快速模式");
    case "clone":
    case "copy":
      writes.add(id);
      renderView();
      try {
        if (command.name === "copy") {
          const { text } = await api.request(`${sessionPath(id)}/last-assistant`);
          if (typeof text !== "string" || !text) { fail("没有可复制的助手消息。"); return false; }
          if (!navigator.clipboard) { fail("当前浏览器无法访问剪贴板。"); return false; }
          await navigator.clipboard.writeText(text);
          draftFor(id).commandStatus = "已复制上一条助手消息。";
          return true;
        }
        const data = await api.request(`${sessionPath(id)}/branches`, { kind: "clone" });
        if (data.cancelled === true) { fail("原生引擎取消了复制。"); return false; }
        const session = parseSession(data.session);
        if (!session) throw new Error("本机服务没有返回新会话。");
        if (view === current) enterBranch(session, "", { kind: "web", id, name: view.session.name });
        else remember(session);
        return true;
      } finally {
        writes.delete(id);
      }
  }
}

function submitComposer(): void {
  if (!current || current.status !== "ready" || !current.session.active || releases.get(current.session.id)?.status === "pending") return;
  const draft = draftFor(current.session.id);
  if (draft.commandMode || composerCommand(draft.text)) void sendCommand(current);
  else void sendPrompt();
}

async function runAction(view: View, action: Action, label: string, onError: (text: string) => void, after?: (data: Wire) => void): Promise<boolean> {
  const id = view.session.id;
  if (writes.has(id) || releases.get(id)?.status === "pending") return false;
  writes.add(id);
  onError("");
  renderView();
  manager.setAttribute("aria-busy", "true");
  inspector.setAttribute("aria-busy", "true");
  try {
    const data = await write(view, action);
    if (view !== current) return true;
    after?.(data);
    if (action.action === "navigate") {
      if (object(data.result).cancelled === true) return false;
      view.revision++;
      view.messages = [];
      view.liveKey = "";
      view.tools.clear();
      stream.reset();
      const editor = str(object(data.result).editorText);
      if (editor) {
        const draft = draftFor(id);
        draft.text = editor;
        if (!draft.commandMode) prompt.value = editor;
      }
    }
    if (action.action === "resume") view.status = "loading";
    if (action.action === "model" || action.action === "thinking") view.modelPreview = undefined;
    await snapshot(view, action.action === "resume" || action.action === "navigate");
    if (view !== current) return true;
    if (action.action === "resume") void loadOptions(view);
    if (manager.open) renderManager(view);
    if (inspector.open && action.action !== "abort") void loadDetails(view);
    return true;
  } catch (error) {
    if (view === current) onError(`${label}失败：${errorText(error)}`);
    return false;
  } finally {
    writes.delete(id);
    manager.removeAttribute("aria-busy");
    inspector.removeAttribute("aria-busy");
    if (view === current) renderView();
  }
}

function openChooser(): void {
  if (connection !== "online" || !workspaces.length || chooser.open) return;
  follow.stop();
  const cwd = sel("new-cwd");
  cwd.replaceChildren(...workspaces.map(root => option(root, root)));
  cwd.value = workspace || workspaces[0] || "";
  const chooseDirectory = workspaces.length > 1;
  box("new-cwd-field").hidden = !chooseDirectory;
  box("new-cwd-fixed").hidden = chooseDirectory;
  box("new-cwd-path").textContent = cwd.value;
  inp("new-name").value = "";
  notice(box("new-error"));
  chooser.showModal();
  if (!chooseDirectory) inp("new-name").focus();
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
    if (!follow.active) {
      archived = session.archived;
      if (chooser.open) chooser.close();
      openSession(session.id);
    }
  } catch (error) {
    notice(box("new-error"), `创建失败：${errorText(error)}`);
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) void bootstrap(true);
  } finally {
    createPending = false;
    updateConnection();
  }
}

async function releaseToCli(view: View): Promise<void> {
  const id = view.session.id;
  if (view !== current || !manager.open || releases.get(id)?.status === "pending" || handoffUnavailable(view)) return;
  const attempt: Release = { status: "pending" };
  releases.set(id, attempt);
  renderView();
  box("manage-handoff-status").focus();
  const selected = () => current?.session.id === id ? current : undefined;
  const ownsFocus = () => manager.open || document.activeElement === btn("manage-button") ||
    box("composer-shell").contains(document.activeElement);
  const finish = (target: View, focus: string) => {
    const shouldFocus = ownsFocus();
    markInactive(target);
    target.error = "";
    if (manager.open) manager.close();
    renderView();
    if (shouldFocus && !document.querySelector("dialog:modal")) box(focus).focus();
  };
  try {
    const { session, command } = await api.handoff(id);
    if (releases.get(id) !== attempt) return;
    releases.set(id, { status: "released", command });
    remember(session);
    void fetchCliRows(true);
    const target = selected();
    if (target) finish(target, "handoff-title");
  } catch (error) {
    if (releases.get(id) !== attempt) return;
    const uncertain = !(error instanceof RequestError) || error.status >= 500 || error.code === "session_not_open";
    const message = `无法转到 CLI：${errorText(error)}`;
    const target = selected();
    if (uncertain || (target && !target.session.active)) {
      releases.set(id, { status: "uncertain", error: message });
      const session = target?.session ?? sessions.get(id);
      if (session) remember({ ...session, active: false, running: false });
      if (target) finish(target, "session-error");
      void fetchSessions();
    } else {
      releases.set(id, { status: "failed", error: message });
      if (target) {
        renderView();
        if (manager.open && document.activeElement === box("manage-handoff-status")) box("manage-handoff-error").focus();
      }
    }
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) void bootstrap(true);
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

let commandRequest: AbortController | undefined;
let commandOptions: readonly Wire[] = [];

function showCommandMode(view: View, enabled: boolean): void {
  if (view !== current) return;
  const draft = draftFor(view.session.id);
  draft.commandMode = enabled;
  prompt.value = enabled ? draft.commandText : draft.text;
  renderAttachments();
  renderView();
  prompt.focus();
}

function insertCommand(view: View, invocation: string): void {
  if (view !== current || !commandToken.test(invocation)) return;
  const draft = draftFor(view.session.id);
  const [head = ""] = draft.commandText.split(/\s/, 1);
  const rest = commandToken.test(head) ? draft.commandText.slice(head.length) : "";
  draft.commandText = `${invocation}${rest || " "}`;
  draft.commandError = "";
  if (commandDialog.open) commandDialog.close();
  closeDetails(false);
  showCommandMode(view, true);
  prompt.setSelectionRange(invocation.length + 1, invocation.length + 1);
}

function renderCommandOptions(view: View): void {
  const query = inp("command-search").value.trim().toLocaleLowerCase();
  const nodes = commandOptions.flatMap(command => {
    const invocation = str(command.invocation);
    const description = str(command.description);
    const source = str(command.source);
    const sourceLabel = source === "builtin" ? "内置命令" : source === "skill" ? "技能" : source === "prompt" ? "提示模板" : "扩展";
    if (!commandToken.test(invocation) || !`${invocation} ${description} ${sourceLabel} ${source}`.toLocaleLowerCase().includes(query)) return [];
    const row = el("li", "stack stack--tight");
    const insert = button(invocation, () => insertCommand(view, invocation), "button--quiet path");
    insert.dataset.invocation = invocation;
    insert.setAttribute("aria-label", `插入命令：${invocation}`);
    row.append(insert, el("p", "small muted break", [sourceLabel, description].filter(Boolean).join(" · ")));
    return [row];
  });
  box("command-list").replaceChildren(...nodes);
  box("command-list").hidden = !nodes.length;
  notice(box("command-status"), nodes.length ? "" : query ? "没有匹配的命令。" : "此会话未列出可用命令。");
}

async function openCommandPicker(view: View): Promise<void> {
  if (commandDialog.open || btn("command-picker").disabled) return;
  commandRequest?.abort();
  const request = commandRequest = new AbortController();
  commandOptions = [];
  const filter = inp("command-search");
  filter.value = "";
  box("command-list").replaceChildren();
  box("command-list").hidden = true;
  notice(box("command-error"));
  notice(box("command-status"), "正在读取当前会话的命令…");
  commandDialog.showModal();
  const live = () => !request.signal.aborted && commandDialog.open && view === current;
  try {
    const data = await api.request(`${sessionPath(view.session.id)}/options`, undefined, request.signal);
    if (!live()) return;
    commandOptions = [...BUILTIN_COMMANDS.map(command => ({ ...command, source: "builtin" })),
      ...list(data.commands).map(object).filter(command => parseBuiltinInput(str(command.invocation)).kind === "plain")];
    renderCommandOptions(view);
  } catch (error) {
    if (!live()) return;
    notice(box("command-status"));
    notice(box("command-error"), `无法读取当前会话的命令：${errorText(error)}。可关闭后重试，或直接输入命令。`);
  } finally {
    if (commandRequest === request) commandRequest = undefined;
  }
}

let detailsRequest: AbortController | undefined;
let capabilitiesRequest: AbortController | undefined;
let capabilitiesAttempted = false;
const detailsTabs = () => [...inspector.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const capabilitiesSelected = () => !box("runtime-capabilities").hidden;

function syncDetailsRefresh(): void {
  const refresh = btn("details-refresh");
  if (capabilitiesSelected() && capabilitiesRequest) refresh.setAttribute("aria-disabled", "true");
  else refresh.removeAttribute("aria-disabled");
}

function clearCapabilities(): void {
  capabilitiesRequest?.abort();
  capabilitiesRequest = undefined;
  capabilitiesAttempted = false;
  const status = box("capabilities-status");
  status.textContent = "";
  status.className = "sr-only";
  box("capabilities-content").replaceChildren();
  syncDetailsRefresh();
}

function loadCapabilities(view: View): void {
  if (capabilitiesRequest) return;
  const request = capabilitiesRequest = new AbortController();
  const currentRead = () => capabilitiesRequest === request && inspector.open && current === view;
  const status = box("capabilities-status");
  const content = box("capabilities-content");
  const compatibility = renderLocalCompatibility();
  capabilitiesAttempted = true;
  content.replaceChildren(compatibility);
  status.className = "small muted";
  status.textContent = "正在读取能力清单…";
  syncDetailsRefresh();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  void api.request(`${sessionPath(view.session.id)}/capabilities`, undefined, signal).then(data => {
    if (!currentRead()) return;
    content.replaceChildren(...renderCapabilities(data));
    status.className = "sr-only";
    status.textContent = "已读取当前会话的能力清单。";
  }, (error: unknown) => {
    if (!currentRead()) return;
    status.className = "notice error small";
    if (error instanceof RequestError && error.status === 404 && error.code === "not_found") {
      status.textContent = "当前 Web 服务不支持能力清单入口。";
    } else if (error instanceof RequestError && (error.code === "session_changed" || error.code === "session_not_open" || error.code === "session_not_found")) {
      status.textContent = "无法读取能力清单：会话连接已变化。请确认当前会话已打开。";
    } else {
      status.textContent = "无法读取能力清单。可手动刷新重试。";
    }
  }).finally(() => {
    if (capabilitiesRequest !== request) return;
    capabilitiesRequest = undefined;
    syncDetailsRefresh();
  });
}

function selectDetailsView(tab: HTMLButtonElement): void {
  if (tab.getAttribute("aria-selected") === "true") return;
  for (const button of detailsTabs()) {
    const selected = button === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const target = button.getAttribute("aria-controls");
    if (target) box(target).hidden = !selected;
  }
  box("details-scroll").scrollTop = 0;
  if (capabilitiesSelected() && inspector.open && current?.status === "ready" && !capabilitiesAttempted) {
    loadCapabilities(current);
  } else syncDetailsRefresh();
}

function openDetails(): void {
  if (current?.status !== "ready") return;
  const overview = btn("runtime-open-overview");
  selectDetailsView(overview);
  if (!inspector.open) {
    for (const panel of inspector.querySelectorAll('[role="tabpanel"]:not(#runtime-capabilities)')) panel.replaceChildren();
    if (compactInspector.matches) inspector.showModal();
    else inspector.show();
    btn("details-button").setAttribute("aria-expanded", "true");
    box("details-scroll").scrollTop = 0;
    loadDetails(current);
  }
  overview.focus({ preventScroll: true });
}

function closeDetails(restoreFocus = true): void {
  if (!inspector.open) return;
  inspector.close();
  detailsRequest?.abort();
  clearCapabilities();
  const trigger = btn("details-button");
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) (trigger.hidden ? box("conversation") : trigger).focus({ preventScroll: true });
}

function syncDetailsPresentation(): void {
  const compact = compactInspector.matches;
  if (!inspector.open || inspector.matches(":modal") === compact || document.querySelector("dialog:modal:not(#details-dialog)")) return;
  const scroller = box("details-scroll");
  const scrollTop = scroller.scrollTop;
  const active = document.activeElement;
  // Reopen the same node in the other native mode without invoking closeDetails.
  inspector.close();
  if (compact) inspector.showModal();
  else inspector.show();
  if (active instanceof HTMLElement && (inspector.contains(active) || !compact)) active.focus({ preventScroll: true });
  else inspector.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  scroller.scrollTop = scrollTop;
}

function setComposeOptions(open: boolean): void {
  btn("compose-options-button").setAttribute("aria-expanded", String(open));
}

function loadDetails(view: View): void {
  detailsRequest?.abort();
  const request = detailsRequest = new AbortController();
  const live = () => !request.signal.aborted && inspector.open && view === current;
  const path = sessionPath(view.session.id);
  const overview = box("runtime-metrics");
  const todo = box("runtime-todo");
  const fail = (message: string) => notice(box("details-error"), message);
  if (!overview.childElementCount) overview.append(el("p", "muted", "正在读取上下文与运行详情…"));
  const setJournal = (data?: Wire) => {
    const next = renderJournal(data);
    const previous = todo.querySelector("#runtime-journal");
    if (previous) previous.replaceWith(next);
    else todo.prepend(next);
  };
  const setActivity = (tasks?: Wire, dag?: Wire, snapshot?: "waiting" | Wire) => {
    box("runtime-subagent").replaceChildren(...renderRuntimePane("tasks", tasks, snapshot));
    box("runtime-dag").replaceChildren(...renderRuntimePane("dag", dag, snapshot));
  };
  setJournal();
  setActivity();
  fail("");
  const stats = api.request(`${path}/details`, undefined, request.signal).then(data => {
    if (!live()) return;
    renderDetails(data, view.state, view.options, {
      canWrite: connection === "online",
      canNavigate: connection === "online" && !view.running && !view.compacting && !sending.has(view.session.id),
      queueCount: view.queue,
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
      insertCommand: command => insertCommand(view, command),
    });
  }).catch(error => {
    if (!live()) return;
    if (!overview.querySelector("section")) overview.replaceChildren();
    fail(`无法读取运行详情：${errorText(error)}`);
  });
  const runtime = async () => {
    let data: Wire;
    try {
      // The host can fence the three parallel reads with two state requests.
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      data = await api.request(`${path}/native-runtime`, undefined, signal);
    } catch (error: unknown) {
      const reason = error instanceof RequestError && error.status === 404 && error.code === "not_found"
        ? "web_unsupported"
        : error instanceof RequestError && error.status >= 400 && error.status < 500 ? "read_refused" : "read_failed";
      const failure = { status: "unavailable", reason };
      data = { tasks: failure, dag: failure, memory: failure };
    }
    if (!live()) return;
    const tasks = object(data.tasks);
    const dag = object(data.dag);
    setJournal(object(data.memory));
    const fallback = canShowSnapshot(tasks) || canShowSnapshot(dag);
    setActivity(tasks, dag, fallback ? "waiting" : undefined);
    if (fallback) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
      const snapshot = await api.request(`${path}/activity`, undefined, signal)
        .catch(() => ({ status: "unavailable" }));
      if (live()) setActivity(tasks, dag, snapshot);
    }
  };
  void Promise.all([stats, runtime()]).then(() => {
    if (detailsRequest === request) detailsRequest = undefined;
  });
}

function openCliHistory(id?: string): void {
  // A sidebar record may belong to the followed root rather than the manual scope.
  if (id && follow.workspace && workspace && follow.workspace !== workspace) selectWorkspace(follow.workspace);
  else follow.stop();
  toggleNav(false);
  history.open(id);
}

function listen(): void {
  const stopFollowing = () => {
    follow.stop();
    toggleNav(false);
    focusCliLauncher("cli-follow-button");
  };
  btn("cli-follow-button").addEventListener("click", () => {
    if (follow.active) { stopFollowing(); return; }
    toggleNav(false);
    closeDetails(false);
    setComposeOptions(false);
    follow.start();
    btn("cli-follow-stop").focus({ preventScroll: true });
  });
  btn("cli-follow-stop").addEventListener("click", stopFollowing);
  btn("cli-history-button").addEventListener("click", () => openCliHistory());
  btn("cli-live-button").addEventListener("click", () => { follow.stop(); toggleNav(false); live.open(); });
  btn("web-branch-button").addEventListener("click", () => {
    if (current && releases.get(current.session.id)?.status !== "pending") {
      openBranch({ kind: "web", id: current.session.id, name: current.session.name });
    }
  });
  btn("open-navigation").addEventListener("click", () => toggleNav(true));
  btn("close-navigation").addEventListener("click", () => toggleNav(false, true));
  btn("nav-scrim").addEventListener("click", () => toggleNav(false, true));
  mobile.addEventListener("change", () => { toggleNav(false); setComposeOptions(false); });
  compactInspector.addEventListener("change", syncDetailsPresentation);
  document.addEventListener("close", event => {
    if (event.target !== inspector) syncDetailsPresentation();
  }, true);
  const composeOptionsButton = btn("compose-options-button");
  const optionsOpen = () => composeOptionsButton.getAttribute("aria-expanded") === "true";
  composeOptionsButton.addEventListener("click", () => setComposeOptions(!optionsOpen()));
  document.addEventListener("click", event => {
    if (optionsOpen() && event.target instanceof Node && !composeOptionsButton.contains(event.target)
      && !box("compose-options").contains(event.target)) setComposeOptions(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector("dialog:modal")) return;
    if (navOpen) toggleNav(false, true);
    else if (optionsOpen()) {
      setComposeOptions(false);
      composeOptionsButton.focus({ preventScroll: true });
    } else if (inspector.open) closeDetails();
  });
  inp("search").addEventListener("input", () => { renderSessions(); renderCliSessions(); });
  sel("workspace-select").addEventListener("change", () => selectWorkspace(sel("workspace-select").value));
  btn("recent").addEventListener("click", () => { archived = false; renderSessions(); renderCliSessions(); });
  btn("archived").addEventListener("click", () => { archived = true; renderSessions(); renderCliSessions(); });
  // CLI journals appear outside the engine event stream; re-check when the
  // page becomes visible so the sidebar discovers them without the dialog.
  // An open run view refreshes too, so metrics stay current while viewed.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void fetchSessions();
    if (current && inspector.open) loadDetails(current);
  });
  window.setInterval(() => {
    if (!document.hidden && connection === "online") void fetchCliRows(true);
  }, CLI_REFRESH_MS);
  btn("new-welcome").addEventListener("click", openChooser);
  btn("new-sidebar").addEventListener("click", openChooser);
  form("new-form").addEventListener("submit", event => { event.preventDefault(); void createSession(); });
  for (const modal of [chooser, manager, commandDialog]) {
    for (const close of modal.querySelectorAll("[data-close]")) close.addEventListener("click", () => modal.close());
  }
  btn("manage-button").addEventListener("click", () => {
    if (!current || manager.open) return;
    notice(box("manage-error"));
    renderManager(current);
    manager.showModal();
    renderView();
  });
  manager.addEventListener("close", renderView);
  btn("manage-handoff").addEventListener("click", () => { if (current) void releaseToCli(current); });
  btn("handoff-copy").addEventListener("click", async () => {
    const view = current;
    if (!view) return;
    const receipt = releases.get(view.session.id);
    if (receipt?.status !== "released") return;
    try {
      await navigator.clipboard.writeText(receipt.command);
      receipt.copyStatus = "已复制命令。";
    } catch {
      receipt.copyStatus = "无法访问剪贴板；可选中命令手动复制。";
    }
    if (current?.session.id === view.session.id && releases.get(view.session.id) === receipt) renderView();
  });
  btn("details-button").addEventListener("click", () => { if (inspector.open) closeDetails(); else openDetails(); });
  for (const tab of detailsTabs()) tab.addEventListener("click", () => selectDetailsView(tab));
  box("runtime-shortcuts").addEventListener("keydown", event => {
    const tabs = detailsTabs();
    const index = tabs.findIndex(tab => tab === event.target);
    if (index < 0) return;
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
      : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
        : event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : undefined;
    if (!next) return;
    event.preventDefault();
    selectDetailsView(next);
    next.focus({ preventScroll: true });
  });
  btn("details-refresh").addEventListener("click", () => {
    if (!current || !inspector.open) return;
    if (capabilitiesSelected()) loadCapabilities(current);
    else loadDetails(current);
  });
  inspector.querySelector("[data-close]")?.addEventListener("click", () => closeDetails());
  inspector.addEventListener("cancel", event => {
    event.preventDefault();
    closeDetails();
  });
  btn("command-mode").addEventListener("click", () => {
    if (current) showCommandMode(current, !draftFor(current.session.id).commandMode);
  });
  btn("command-picker").addEventListener("click", () => { if (current) void openCommandPicker(current); });
  commandDialog.addEventListener("close", () => { if (!commandDialog.open) commandRequest?.abort(); });
  inp("command-search").addEventListener("input", () => {
    if (current && !commandRequest && box("command-error").hidden) renderCommandOptions(current);
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
    if (!view || btn("resume").disabled) return;
    const release = releases.get(view.session.id);
    const manual = release?.status === "released" || release?.status === "uncertain";
    if (view.session.active && !manual) {
      view.status = "loading";
      view.error = "";
      renderView();
      void snapshot(view, true);
      void loadOptions(view);
      return;
    }
    const main = box("conversation");
    main.focus();
    void runAction(view, { action: "resume" }, "恢复会话", text => { view.error = text; renderView(); }).then(() => {
      if (view !== current || document.activeElement !== main || document.querySelector("dialog:modal")) return;
      if (view.status === "ready") prompt.focus();
      else if (!box("session-error").hidden) box("session-error").focus();
    });
  });
  form("composer").addEventListener("submit", event => { event.preventDefault(); submitComposer(); });
  prompt.addEventListener("input", () => {
    if (!current) return;
    const draft = draftFor(current.session.id);
    draft.commandStatus = undefined;
    if (draft.commandMode) {
      draft.commandText = prompt.value;
      draft.commandError = "";
    } else {
      draft.text = prompt.value;
      draft.error = "";
    }
    renderView();
  });
  prompt.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitComposer();
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
  stream.observeTrace(({ user, assistant, tool }) => {
    setTraceTarget(traceControls.user, user);
    setTraceTarget(traceControls.assistant, assistant);
    setTraceTarget(traceControls.tool, tool);
  });
  const traceMotion = matchMedia("(prefers-reduced-motion: no-preference) and (forced-colors: none)");
  let traceArrival: Animation | undefined;
  traceMotion.addEventListener("change", () => traceArrival?.cancel());
  for (const control of Object.values(traceControls)) control.addEventListener("click", () => {
    const target = traceTargets.get(control);
    if (trace.hidden || !target?.isConnected) return;
    if (target.tagName !== "SUMMARY") target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    traceArrival?.cancel();
    if (!traceMotion.matches) return;
    const arrival = target.animate([{ backgroundColor: "var(--trace-arrival)" }, {}], {
      duration: 460, easing: "ease-out",
    });
    traceArrival = arrival;
    arrival.onfinish = arrival.oncancel = () => {
      if (traceArrival === arrival) traceArrival = undefined;
    };
  });
  modelSelect.addEventListener("change", () => {
    const view = current;
    if (!view || modelSelect.disabled) return;
    view.modelSelection = modelSelect.value || undefined;
    renderView();
  });
  applyModel.addEventListener("click", async () => {
    const view = current;
    const model = list(view?.options.models).map(object).find(item => modelKey(item) === view?.modelSelection);
    if (!view || !model || applyModel.disabled) return;
    await runAction(view, { action: "model", provider: str(model.provider), modelId: str(model.id) }, "切换模型",
      text => { draftFor(view.session.id).error = text; renderView(); });
    if (current !== view) return;
    view.modelSelection = undefined;
    renderView();
    if (document.activeElement === document.body || document.activeElement === applyModel) modelSelect.focus();
  });
  sel("thinking").addEventListener("change", () => {
    const view = current;
    const level = sel("thinking").value;
    if (view && level && !sel("thinking").disabled) void runAction(view, { action: "thinking", level }, "切换思考档",
      text => { draftFor(view.session.id).error = text; renderView(); });
    else renderView();
  });
  sel("approval").addEventListener("change", () => {
    const view = current;
    const preset = sel("approval").value;
    if (!view || (preset !== "ask" && preset !== "auto" && preset !== "full-access")) { renderView(); return; }
    if (preset === "full-access" && !window.confirm("无审批会默认允许工具操作，包括删除文件或对外发送数据。原生权限规则仍有效，用户问题仍需你回答。仅对当前打开的会话生效。确定切换吗？")) {
      renderView();
      return;
    }
    void runAction(view, { action: "preset", preset }, "切换审批模式",
      text => { draftFor(view.session.id).error = text; renderView(); });
  });
}

startTheme();
listen();
void bootstrap();
