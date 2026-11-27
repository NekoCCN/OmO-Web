import { Api, RequestError, parseSession, parseSessions, sessionPath } from "./api.ts";
import type { Action, BranchSource, Image, Mode, Session } from "./api.ts";
import { byId, button, el, errorText, field, isImageType, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { Interactions, isRequest, requestId } from "./interactions.ts";
import type { Answer } from "./interactions.ts";
import { Transcript, messageKey, roleOf } from "./transcript.ts";
import type { ToolTrace, TranscriptEntry } from "./transcript.ts";
import { branchDialog, refreshDetailsActivity, renderDetails } from "./details.ts";
import { renderCapabilities, renderLocalCompatibility } from "./capabilities.ts";
import { canShowSnapshot, renderJournal, renderRuntimePane } from "./runtime-summary.ts";
import { cliHistory } from "./cli-history.ts";
import { cliLive } from "./cli-live.ts";
import { cliFollow } from "./cli-follow.ts";
import { workspaceBrowser, workspacePaths } from "./workspace-browser.ts";
import { opensReadOnlyView, parseBuiltinInput } from "./builtin-commands.ts";
import type { BuiltinCommand } from "./builtin-commands.ts";
import { commandCatalog, commandToken, inlineCommandCompletion } from "./command-completion.ts";
import { bindCommandListKeys } from "./command-list-keys.ts";
import { projectCacheRates, projectContextUsage } from "../runtime-metrics.ts";
import { bindProjectRules, readGenerationSpeed, thinkingLabels } from "./session-sidebar.ts";
import type { GenerationSpeed } from "../stream-speed.ts";
import { applyStaticLocale, saveUiLocale, tr, uiLocale } from "./locale.ts";

applyStaticLocale();

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
const completion = inlineCommandCompletion(prompt, box("inline-commands"));
const mode = sel("prompt-mode");
const modelSelect = sel("model");
const thinkingSelect = sel("thinking");
const applyModel = el("button", "button button--quiet", tr("应用模型", "Apply model"));
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
const composeToolbar = composeOptions.parentElement!;
const composeOptionsButton = btn("compose-options-button");
const composeSelectors = el("div", "row compose-selectors");
composeSelectors.append(...composeOptions.children);
const composeSettings = el("div", "stack stack--tight");
composeSettings.append(composeSelectors, modelStatus);
composeOptions.append(composeSettings);
const chooser = dialog("new-dialog");
const manager = dialog("manage-dialog");
const inspector = dialog("details-dialog");
const commandDialog = dialog("command-dialog");
const branchModal = dialog("branch-dialog");
const settingLabels = thinkingLabels;
const thinkingSources: Readonly<Record<string, string>> = {
  explicit: tr("显式指定", "Selected"), session: tr("会话内记录", "Session"), global: tr("设备记忆", "Saved on this device"),
  "model-default": tr("模型默认", "Model default"), default: tr("默认设置", "Default"), fallback: tr("回退档位", "Fallback"),
  clamped: tr("按模型能力调整", "Adjusted for this model"),
};
const approvalLabels: Readonly<Record<string, string>> = {
  ask: tr("审批：询问", "Ask first"),
  auto: tr("审批：Auto", "Auto"),
  "full-access": tr("审批：无审批", "No approval"),
};
const approvalChoices: ReadonlyArray<readonly [string, string]> = [
  ["ask", approvalLabels.ask],
  ["auto", approvalLabels.auto],
  ["full-access", approvalLabels["full-access"]],
];
type Attachment = Image & { readonly name: string; readonly url: string };
type Draft = {
  text: string; mode: Mode; images: Attachment[]; reading: number; error: string;
  commandMode: boolean; commandText: string; commandError: string; commandStatus?: string;
  commandAdmission?: { readonly text: string; readonly id: string };
  admission?: { readonly imageList: readonly Attachment[]; readonly text: string; readonly mode: Mode; readonly turn: string; readonly id: string };
};
type RequestChange =
  | { readonly type: "upsert"; readonly request: Wire }
  | { readonly type: "timing"; readonly ids: readonly string[]; readonly timing: Wire }
  | { readonly type: "resolve"; readonly ids: readonly string[] };
type View = {
  session: Session; status: "inactive" | "loading" | "ready" | "failed"; error: string; state: Wire;
  messages: TranscriptEntry[]; liveKey: string; tools: Map<string, ToolTrace>; requests: Map<string, Wire>;
  options: Wire; optionsError: string; handoff: Wire; queue: number | undefined; revision: number; serial: number;
  sync: number; optionSync: number; running: boolean; compacting: boolean;
  workbench?: Wire;
  consideredDesktopDock?: boolean;
  snapshotRequestChanges?: RequestChange[];
  detailData?: Wire;
  generationSpeed?: GenerationSpeed;
  modelSelection?: string;
  modelPreview?: { readonly key: string; result?: Wire };
};
type Release = { status: "pending" } | { status: "released"; command: string; copyStatus?: string }
  | { status: "failed" | "uncertain"; error: string };

let current: View | undefined;
const resetProjectRules = bindProjectRules(api,
  () => inspector.open && current?.status === "ready" ? current.session.id : undefined);
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
const cliTime = new Intl.DateTimeFormat(uiLocale, { dateStyle: "medium", timeStyle: "short" });
let workspaces: readonly string[] = [];
let workspaceRevision = 0;
let windowsWorkspaceLabels = false;
let directoryFilter = "";
let nextCreationDirectory = "";
const hasDirectory = (cwd: string) => workspaces.includes(cwd);
const matchesDirectoryFilter = (cwd: string) => hasDirectory(cwd) && (!directoryFilter || cwd === directoryFilter);
const languageReturnKey = "omo-web-language-return-session";
let archived = false;
let source: EventSource | undefined;
let bootSeq = 0;
let listSeq = 0;
let mutation = 0;
let refreshTimer = 0;
let workbenchRequest: AbortController | undefined;
let createPending = false;
let navOpen = false;
const railPreference = "omo-web-navigation-collapsed";
const inspectorPreference = "omo-web-desktop-inspector";
let railCollapsed = false;
let desktopInspectorOpen = true;
const writes = new Set<string>();
const sending = new Set<string>();
const drafts = new Map<string, Draft>();
const releases = new Map<string, Release>();
const mobile = matchMedia("(max-width: 760px)");
const compactInspector = matchMedia("(max-width: 1000px)");
const system = matchMedia("(prefers-color-scheme: dark)");
const countFormat = new Intl.NumberFormat(uiLocale);
const rateFormat = new Intl.NumberFormat(uiLocale, { maximumFractionDigits: 2 });
const focusCliLauncher = (id: string) => btn(mobile.matches ? "open-navigation" : railCollapsed ? "rail-toggle" : id).focus();
const showBranch = branchDialog(api, enterBranch);
const openBranch = (source: BranchSource) => {
  if (branchModal.open) return;
  branchModal.dataset.sourceKind = source.kind;
  showBranch(source);
};
const follow = cliFollow(api, hasDirectory, () => {
  renderSessions();
  renderCliSessions();
  renderView();
});
const live = cliLive(api, () => focusCliLauncher("cli-live-button"), openBranch, hasDirectory);
const browser = workspaceBrowser(api, () => ({ roots: workspaces, selected: nextCreationDirectory || current?.session.cwd || directoryFilter }), selectBrowsedWorkspace, () => {
  if (mobile.matches && !navOpen) btn("open-navigation").focus();
  else if (btn("workspace-browser-button").hidden) inp("search").focus();
  else btn("workspace-browser-button").focus();
});
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
}, hasDirectory);

function handoffReason(reason: unknown): string {
  switch (reason) {
    case "engine_offline": return tr("本机引擎未连接。", "The local engine is offline.");
    case "shared_transport": return tr("切换到 CLI 需要私有本机连接。", "Switching to the CLI requires a private local connection.");
    case "missing_capability": return tr("此 OmO 版本不支持换端。", "This version of OmO does not support handoff.");
    case "profile_mismatch": return tr("本机引擎与 CLI 会话使用不同配置。", "The local engine and the CLI session use different profiles.");
    case "session_busy": return tr("等本轮结束后再换端。", "Wait for this turn to finish before switching.");
    case "dialog_pending": return tr("先处理会话中的待答事项。", "Answer the pending request before switching.");
    default: return tr("这个会话暂时无法换端。", "This session cannot be switched right now.");
  }
}

function historyResumeUnavailable(): string {
  if (connection !== "online") return tr("连接断开，只能浏览记录。", "Offline. You can still browse the history.");
  return handoffSupport.supported === true ? "" : handoffReason(handoffSupport.reason);
}

function handoffUnavailable(view: View): string {
  if (!view.session.active || view.status !== "ready") return tr("先恢复此会话。", "Resume this session first.");
  if (connection !== "online") return tr("连接断开，无法换端。", "Reconnect before switching.");
  if (handoffSupport.supported !== true) return handoffReason(handoffSupport.reason);
  if (view.running || view.compacting) return handoffReason("session_busy");
  if (view.requests.size) return handoffReason("dialog_pending");
  if (view.queue) return tr("等队列里的消息发送后再换端。", "Wait for queued messages to finish before switching.");
  if (view.handoff.eligible !== true) return handoffReason(view.handoff.reason);
  if (writes.has(view.session.id) || sending.has(view.session.id)) return tr("正在提交，请稍候。", "Submitting…");
  return "";
}

function markInactive(view: View): void {
  view.sync++;
  view.optionSync++;
  view.snapshotRequestChanges = undefined;
  view.status = "inactive";
  view.running = false;
  view.compacting = false;
  view.workbench = undefined;
  view.generationSpeed = undefined;
  if (view === current) workbenchRequest?.abort();
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

function startLanguage(): void {
  const select = sel("language-select");
  const feedback = box("language-feedback");
  select.value = uiLocale;
  select.addEventListener("change", () => {
    const next = select.value;
    if ((next !== "en" && next !== "zh-CN") || next === uiLocale) return;
    const refuse = (message: string) => {
      select.value = uiLocale;
      notice(feedback, message);
    };
    if ([...drafts.values()].some(draft => draft.text || draft.commandText || draft.images.length || draft.reading)) {
      refuse(tr("发送或清空草稿后，再切换语言。", "Send or clear your drafts before changing the language."));
      return;
    }
    if (createPending || sending.size || writes.size || current?.requests.size) {
      refuse(tr("先完成当前操作，再切换语言。", "Finish the current action before changing the language."));
      return;
    }
    if (follow.active) {
      refuse(tr("退出 CLI 跟随后，再切换语言。", "Stop following the CLI before changing the language."));
      return;
    }
    const id = current?.session.id;
    try {
      if (id) sessionStorage.setItem(languageReturnKey, id);
      else sessionStorage.removeItem(languageReturnKey);
    } catch {
      if (id) {
        refuse(tr("浏览器无法保留当前会话。关闭此会话页面后再切换语言。", "The browser could not preserve this session. Change the language from the start screen."));
        return;
      }
    }
    if (!saveUiLocale(next)) {
      try { sessionStorage.removeItem(languageReturnKey); } catch { /* No bookmark was stored. */ }
      refuse(tr("浏览器无法保存语言设置。", "The browser could not save your language setting."));
      return;
    }
    location.reload();
  });
}

function restoreLanguageSession(): void {
  let id: string | null;
  try {
    id = sessionStorage.getItem(languageReturnKey);
    sessionStorage.removeItem(languageReturnKey);
  } catch { return; }
  const session = id ? sessions.get(id) : undefined;
  if (!session || !hasDirectory(session.cwd)) return;
  archived = session.archived;
  openSession(session.id, false, false);
}

function readLayoutPreference(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return null;
  }
}

function saveLayoutPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

function renderRail(): void {
  box("workspace-shell").toggleAttribute("data-rail-collapsed", railCollapsed);
  const toggle = btn("rail-toggle");
  toggle.setAttribute("aria-expanded", String(!railCollapsed));
  const label = railCollapsed ? tr("展开会话导航", "Expand sessions") : tr("收起会话导航", "Collapse sessions");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
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
  box("connection-label").textContent = { online: tr("本机已连接", "Connected"), offline: tr("连接不可用", "Offline"),
    connecting: tr("正在连接", "Connecting") }[connection];
  const version = str(engine.version);
  notice(box("engine-version"), version && tr(`引擎 ${version}`, `Engine ${version}`));
  const message = bootError || (engine.online === false ? str(engine.error) || tr("Senpi 引擎未连接。检查引擎后再重连。",
    "The Senpi engine is offline. Check it and reconnect.")
    : transport === "lost" ? tr("实时连接已断开。正在重连，草稿会保留。", "Connection lost. Reconnecting; your drafts are kept.") : listError);
  box("banner").hidden = !message;
  notice(box("banner-text"), message);
  const available = connection === "online" && Boolean(workspaces.length);
  btn("new-sidebar").disabled = !available;
  btn("new-welcome").disabled = !available;
  box("welcome-copy").textContent = bootstrapped && !workspaces.length
    ? btn("workspace-browser-button").hidden
      ? tr("没有可用目录。请检查 OmO Web 的启动配置。", "No directories are available. Check your OmO Web startup settings.")
      : tr("还没有可用目录。打开侧栏的「目录」添加。", "No directories yet. Open Directories in the sidebar to add one.")
    : tr("从列表打开会话，或选个目录开始新会话。", "Open a session from the list, or choose a directory to start a new one.");
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
    cliError = data.available === true ? "" : tr("没有可读取的 CLI 历史。", "No CLI history is available.");
    cliRows = data.available === true ? list(data.sessions).map(object).flatMap(row => {
      const id = str(row.id);
      // Adopted rows already appear as Web aliases above; the sidebar only
      // discovers journals without one. Previewing one never opens a route,
      // and entering still goes through explicit resume under holder admission.
      return id && row.adopted !== true
        ? [{ id, name: str(row.name) || tr("未命名 CLI 会话", "Untitled CLI session"), cwd: str(row.cwd), updatedAt: num(row.updatedAt) ?? 0 }] : [];
    }) : [];
  } catch (error) {
    if (ticket !== cliSeq) return;
    cliError = tr(`无法读取 CLI 历史：${errorText(error)}`, `Couldn't load CLI history: ${errorText(error)}`);
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
    .filter(row => matchesDirectoryFilter(row.cwd) && (!query || `${row.name} ${row.cwd}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  section.hidden = matches.length === 0 && !cliError;
  host.replaceChildren();
  for (const row of matches) {
    const item = el("li");
    const open = button("", () => openCliHistory(row.id), "button--quiet session-link");
    open.dataset.cliSession = row.id;
    const stamp = Number.isFinite(new Date(row.updatedAt).getTime()) ? cliTime.format(row.updatedAt) : "";
    const path = el("span", "small muted path", workspaceLabel(row.cwd));
    path.title = row.cwd;
    open.append(el("span", "", row.name), path, el("small", "", stamp));
    item.append(open);
    host.append(item);
  }
  host.hidden = !matches.length;
  notice(box("cli-list-empty"), matches.length ? "" : cliError || (bootstrapped ? tr("没有本机 CLI 会话。", "No local CLI sessions.") : ""));
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
    if (ticket === listSeq) listError = tr(`无法读取会话列表：${errorText(error)}`, `Couldn't load sessions: ${errorText(error)}`);
  }
  updateConnection();
}

function workspaceLabel(cwd: string): string {
  const labelPath = (path: string) => windowsWorkspaceLabels ? path.replaceAll("\\", "/") : path;
  const parts = labelPath(cwd).split("/").filter(Boolean);
  if (windowsWorkspaceLabels && parts.length === 1) return cwd;
  for (let depth = 1; depth <= parts.length; depth++) {
    const suffix = parts.slice(-depth).join("/");
    if (!workspaces.some(root => root !== cwd && labelPath(root).endsWith(`/${suffix}`))) {
      return windowsWorkspaceLabels ? suffix.replaceAll("/", "\\") : suffix;
    }
  }
  return cwd;
}

function renderWorkspace(): void {
  const picker = sel("workspace-select");
  const all = tr("所有目录", "All directories");
  syncSelect(picker, workspaces.map(root => [root, workspaceLabel(root)]), directoryFilter, all);
  picker.title = directoryFilter || all;
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

function filterDirectory(cwd: string): void {
  if (cwd && !hasDirectory(cwd)) return;
  directoryFilter = cwd;
  renderWorkspace();
  renderSessions();
  renderCliSessions();
}

function selectBrowsedWorkspace(cwd: string, roots: readonly string[]): void {
  workspaceRevision++;
  workspaces = roots;
  nextCreationDirectory = hasDirectory(cwd) ? cwd : "";
  if (directoryFilter && !hasDirectory(directoryFilter)) directoryFilter = "";
  if (current && !hasDirectory(current.session.cwd)) clearCurrentView();
  follow.recheckWorkspace();
  renderWorkspace();
  live.scopeChanged();
  // The dialog's close handler restores focus using the updated drawer state.
  toggleNav(false);
  void fetchSessions();
  void fetchCliRows(true);
  updateConnection();
}

async function bootstrap(reconcile = false): Promise<void> {
  const ticket = ++bootSeq;
  const version = mutation;
  const rootRevision = workspaceRevision;
  try {
    const data = await api.request("/api/bootstrap");
    if (ticket !== bootSeq) return;
    const token = str(data.token);
    const tokenChanged = token !== api.token;
    api.token = token;
    engine = object(data.engine);
    handoffSupport = object(data.handoff);
    const fileBrowser = object(data.fileBrowser);
    windowsWorkspaceLabels = fileBrowser.platform === "win32";
    if (rootRevision === workspaceRevision || tokenChanged) workspaces = workspacePaths(data.workspaces);
    const firstBootstrap = !bootstrapped;
    if (directoryFilter && !hasDirectory(directoryFilter)) directoryFilter = "";
    if (nextCreationDirectory && !hasDirectory(nextCreationDirectory)) nextCreationDirectory = "";
    browser.update(fileBrowser, tokenChanged);
    if (current && !workspaces.includes(current.session.cwd)) clearCurrentView();
    follow.recheckWorkspace();
    renderWorkspace();
    live.scopeChanged();
    bootstrapped = true;
    bootError = "";
    listError = "";
    if (version === mutation) applySessions(parseSessions(data));
    if (!source) connectEvents();
    if (firstBootstrap) restoreLanguageSession();
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
    if (ticket === bootSeq) bootError = tr(`无法连接本机 Web 服务：${errorText(error)}`, `Couldn't connect to OmO Web: ${errorText(error)}`);
  }
  if (ticket === bootSeq) recovering = false;
  updateConnection();
}

function renderSessions(): void {
  const query = inp("search").value.trim().toLocaleLowerCase();
  const host = box("session-list");
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.dataset.session : undefined;
  const items = [...sessions.values()].filter(item => matchesDirectoryFilter(item.cwd) && item.archived === archived && (!query || `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query)))
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
      if (path instanceof HTMLElement) { path.textContent = workspaceLabel(session.cwd); path.title = session.cwd; path.hidden = !session.cwd; }
      const stamp = row.lastElementChild;
      if (stamp) stamp.textContent = releases.get(session.id)?.status === "released" ? tr("已释放", "Released")
        : session.running ? tr("运行中", "Running") : session.settled ? tr("已结清", "Done")
          : session.active ? tr("已打开", "Open") : tr("待恢复", "Resume");
      if (!follow.active && session.id === current?.session.id) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    if (li !== next) host.insertBefore(li, next);
    next = li.nextElementSibling;
    existing.delete(session.id);
  }
  for (const node of existing.values()) node.remove();
  if (focused && !items.some(item => item.id === focused)) inp("search").focus();
  notice(box("list-empty"), items.length ? "" : query ? tr("没有匹配的会话", "No matching sessions")
    : !bootstrapped ? bootError ? tr("暂时无法读取会话", "Couldn't load sessions") : tr("正在读取会话…", "Loading sessions…")
      : archived ? tr("没有已归档的会话", "No archived sessions") : tr("还没有最近会话", "No recent sessions"));
  btn("recent").setAttribute("aria-pressed", String(!archived));
  btn("archived").setAttribute("aria-pressed", String(archived));
}

function openSession(id: string, focusComposer = false, focusConversation = true): void {
  const session = sessions.get(id);
  if (!session || !workspaces.includes(session.cwd)) return;
  follow.stop();
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
  workbenchRequest?.abort();
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
  syncSelect(modelSelect, models.map(model => [modelKey(model), modelTitle(model)]), modelKey(staged ?? selected), tr("模型", "Model"));
  modelSelect.disabled = disabled || pending || !list(view.options.models).length;
  applyModel.hidden = !staged;
  applyModel.disabled = disabled || pending;

  let message = pending ? tr("正在切换模型。", "Changing model…") : "";
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
      const label = staged ? tr("切换后", "After switching") : tr("当前", "Current");
      const available = levels.map(item => settingLabels[item]).join(tr("、", ", "));
      message = tr(`${label}：${settingLabels[level]}（来源：${thinkingSources[source]}） · 可用：${available}`,
        `${label}: ${settingLabels[level]} (${thinkingSources[source]}) · Available: ${available}`);
    } else message = preview ? tr("无法预览此模型的思考档。", "Thinking preview is unavailable for this model.")
      : tr("正在读取模型档位…", "Loading thinking levels…");
  } else {
    view.modelPreview = undefined;
    if (canPreview && !pending && activeKey && !view.optionsError && list(view.options.models).length) {
      message = tr("此模型不在可用列表里。", "The current model is not available.");
    }
  }
  if (modelStatus.textContent !== message) modelStatus.textContent = message;
  modelStatus.classList.toggle("sr-only", !staged);
  modelStatus.hidden = !message;
  modelSelect.title = !staged && message ? message : tr("模型", "Model");
  thinkingSelect.title = !staged && message ? message : tr("思考档", "Thinking level");
  const activeProfile = staged ? undefined : profile;
  const selectedLevel = str(activeProfile?.level ?? view.state.thinkingLevel);
  const levels = list(activeProfile?.availableLevels ?? view.options.levels).map(str).filter(level => Object.hasOwn(settingLabels, level));
  const hasLevels = levels.length > 0;
  if (Object.hasOwn(settingLabels, selectedLevel) && !levels.includes(selectedLevel)) levels.unshift(selectedLevel);
  syncSelect(thinkingSelect, levels.map(level => [level, tr(`思考：${settingLabels[level]}`, `Thinking: ${settingLabels[level]}`)]),
    selectedLevel, tr("思考档", "Thinking"));
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

function renderQuestionShortcut(requests: ReadonlyMap<string, Wire>): void {
  const shortcut = btn("sidebar-question");
  let count = 0;
  for (const request of requests.values()) if (request.method === "question" && ++count === 100) break;
  if (!count) {
    if (shortcut === document.activeElement) inspector.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    shortcut.hidden = true;
    return;
  }
  const display = count === 100 ? "99+" : String(count);
  const label = tr(`Agent 提问 · ${display}`, `Agent questions · ${display}`);
  if (shortcut.textContent !== label) {
    shortcut.textContent = label;
    shortcut.setAttribute("aria-label", tr(`跳至首个 Agent 提问（${count === 100 ? "超过 99" : display} 个待答）`,
      `Jump to first Agent question (${count === 100 ? "over 99" : display} pending)`));
  }
  shortcut.hidden = false;
}

function renderView(): void {
  const following = follow.active;
  box("cli-follow-view").hidden = !following;
  box("transcript").hidden = following;
  btn("cli-follow-stop").hidden = !following;
  btn("cli-follow-button").setAttribute("aria-pressed", String(following));
  box("banner").hidden = following || !box("banner-text").textContent;
  if (following) {
    if (current) current.consideredDesktopDock = false;
    completion.reset();
    trace.hidden = true;
    box("composer-shell").hidden = true;
    btn("details-button").hidden = true;
    btn("web-branch-button").hidden = true;
    btn("manage-button").hidden = true;
    renderHeading(follow.target?.name ?? tr("跟随 CLI", "Follow CLI"), follow.target?.cwd ?? "");
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
    completion.reset();
    for (const control of Object.values(traceControls)) setTraceTarget(control);
  }
  box("composer-shell").hidden = !available;
  prompt.disabled = !available || session?.active !== true;
  renderHeading(session?.name ?? tr("会话工作台", "Workbench"), session?.cwd ?? "");
  btn("details-button").hidden = !available;
  if (!available) closeDetails(false);
  btn("web-branch-button").hidden = !session;
  btn("web-branch-button").disabled = pending;
  btn("manage-button").hidden = !available;
  if (!view) return;
  const draft = draftFor(view.session.id);
  if (manager.open) {
    const reason = pending ? tr("正在释放会话…", "Releasing session…") : handoffUnavailable(view);
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
  box("inactive-title").textContent = view.status === "loading" ? tr("正在读取会话…", "Loading session…")
    : view.status === "failed" ? tr("无法读取会话", "Couldn't load session") : tr("继续此会话", "Continue this session");
  const showReceipt = Boolean(receipt && view.status !== "loading");
  box("inactive-title").hidden = showReceipt;
  box("inactive-copy").hidden = showReceipt;
  box("inactive-copy").textContent = pending ? tr("等本机引擎确认释放。", "Waiting for the local engine to release the session.")
    : view.status === "loading" ? "" : view.status === "failed" ? tr("检查连接后重试。", "Check the connection and try again.")
      : view.session.archived ? tr("恢复已归档的会话，继续之前的对话。", "Restore this archived session to continue the conversation.")
        : tr("恢复后可继续之前的对话。", "Resume to pick up where you left off.");
  box("handoff-receipt").hidden = !showReceipt;
  const code = box("handoff-command").firstElementChild;
  if (code && code.textContent !== (receipt?.command ?? "")) code.textContent = receipt?.command ?? "";
  notice(box("handoff-copy-status"), receipt?.copyStatus);
  notice(box("handoff-draft-note"), !available && (receipt || pending || release?.status === "uncertain") &&
    (draft.text || draft.commandText || draft.images.length || draft.reading) ? tr("草稿仍在这页。", "Your draft is still on this page.") : "");
  notice(box("session-error"), view.error || (release?.status === "uncertain" && view.status !== "loading" ? release.error : ""));
  const resume = btn("resume");
  resume.hidden = available || view.status === "loading";
  resume.disabled = connection !== "online" || pending || writes.has(view.session.id);
  resume.classList.toggle("button--primary", !receipt);
  resume.textContent = !receipt && release?.status !== "uncertain" && active && view.session.active
    ? tr("重试读取", "Retry") : tr("恢复会话", "Resume session");
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
  const sendLabel = chosenMode === "follow_up" ? tr("排队", "Queue") : chosenMode === "steer" ? tr("发送引导", "Steer") : tr("发送", "Send");
  box("send-label").textContent = send.title = sendLabel;
  const execute = btn("send-command");
  execute.hidden = !commandInput;
  const commandText = commandMode ? draft.commandText : draft.text;
  const readOnlyCommand = opensReadOnlyView(commandText);
  execute.disabled = !online || !view.session.active || busy || (blocked && !readOnlyCommand) ||
    (!readOnlyCommand && (view.running || view.compacting || Boolean(view.queue) || posting)) || !commandText.trim();
  btn("command-mode").setAttribute("aria-pressed", String(commandMode));
  btn("command-picker").hidden = !commandMode;
  btn("command-picker").disabled = !online || blocked;
  box("prompt-label").textContent = commandMode ? tr("命令及参数", "Command and arguments") : tr("消息", "Message");
  prompt.placeholder = commandMode ? tr("输入 /命令 或 $技能，可加参数…", "Enter a /command or $skill…") : tr("输入消息…", "Write a message…");
  btn("attach").disabled = commandMode || blocked || draft.images.length + draft.reading >= 4 || busy;
  btn("attach").hidden = commandMode;
  (mode.closest("label") ?? mode).hidden = commandMode;
  mode.disabled = blocked || busy;
  renderModelOptions(view, !canSend || view.running || busy || posting, online && active && !pending);
  const preset = str(view.state.effectivePermissionPreset) || str(view.state.permissionPreset) || "ask";
  syncSelect(sel("approval"), [...approvalChoices], approvalChoices.some(([value]) => value === preset) ? preset : "ask", tr("审批", "Approval"));
  sel("approval").dataset.preset = sel("approval").value;
  sel("approval").disabled = !canSend || busy || posting;
  sel("approval").title = preset === "full-access"
    ? tr("无审批：工具默认放行。原生权限规则仍有效，用户问题仍需回答。",
      "Off: Tools are allowed by default. Native permission rules and user questions still apply.")
    : preset === "auto" ? tr("Auto：原生确认安全的项目内操作自动放行，其余询问。",
      "Auto: OmO allows safe project operations and asks about the rest.")
      : tr("询问：未被原生权限规则处理的工具操作需要批准。恢复会话会回到此模式。",
        "Ask: Approve tool calls not covered by native rules. Resuming a session returns to Ask.");
  const usage = projectContextUsage(view.state.contextUsage);
  const contextLabel = tr("上下文", "Context");
  notice(box("context-usage"), usage.status !== "ok" ? "" : usage.percent !== undefined ? `${contextLabel} ${countFormat.format(usage.percent)}%`
    : usage.tokens !== undefined && usage.window ? `${contextLabel} ${countFormat.format(usage.tokens)} / ${countFormat.format(usage.window)}` : "");
  const cache = projectCacheRates(view.state.usageTotals);
  const latestCache = cache.status === "ok" && cache.latest !== undefined ? rateFormat.format(cache.latest * 100) : "";
  notice(box("cache-usage"), online && latestCache ? tr(`最新缓存 ${latestCache}%`, `Latest cache ${latestCache}%`) : "");
  const hint = pending ? tr("正在换端，草稿不会发送。", "Switching clients. Your draft won't be sent.")
    : !online ? tr("离线时可以编辑，重连后再发送。", "You can edit offline and send when reconnected.")
      : blocked ? tr("先在会话管理里取消归档。", "Unarchive this session in Manage session.")
        : draft.commandStatus || (commandInput ? !readOnlyCommand && (view.running || view.compacting || view.queue)
          ? tr("等本轮和队列结束后再执行命令。", "Wait for this turn and queue to finish before running a command.")
          : tr("Ctrl / ⌘ + Enter 执行命令；开头加空格就按文字发送。", "Ctrl / ⌘ + Enter runs the command. Add a leading space to send it as text.")
          : view.compacting ? tr("等压缩完成后再发送。", "Send after compaction finishes.") : draft.reading ? tr("正在读取图片…", "Loading images…")
            : view.running && chosenMode === "prompt" ? tr("停止本轮，或选引导或排队。", "Stop this turn, or choose Steer or Queue.")
              : !view.running && chosenMode !== "prompt" ? tr("当前空闲，这条消息会在下一轮处理。", "No turn is running. This message will be handled in the next turn.")
                : tr("Ctrl / ⌘ + Enter 发送", "Ctrl / ⌘ + Enter to send"));
  box("composer-hint").textContent = hint;
  box("composer-hint").classList.toggle("sr-only", !draft.commandStatus && online && !pending && !blocked &&
    !draft.reading && !view.compacting && !commandInput && (chosenMode === "prompt" || view.running));
  const activity = [view.requests.size ? tr(`待答 ${view.requests.size}`, `Pending ${view.requests.size}`) : "",
    view.running ? tr("生成中", "Generating") : "", view.compacting ? tr("压缩中", "Compacting") : "",
    view.queue ? tr(`排队 ${view.queue}`, `Queued ${view.queue}`) : ""].filter(Boolean).join(" · ");
  box("activity-row").hidden = !activity;
  box("activity-row").dataset.pending = String(view.requests.size > 0);
  if (box("activity").textContent !== activity) box("activity").textContent = activity;
  const todo = btn("current-todo");
  const signal = view.workbench;
  const currentTodo = signal?.status === "ok" ? str(signal.currentTodo) : "";
  const pendingTodo = signal?.status === "ok" ? num(signal.pendingTodo) : undefined;
  const todoLabel = tr("待办", "Todo");
  const task = currentTodo ? `${todoLabel} · ${currentTodo}` : pendingTodo ? `${todoLabel} ${pendingTodo}` : "";
  todo.hidden = !online || !task;
  const label = box("current-todo-label");
  if (label.textContent !== task) label.textContent = task;
  todo.title = currentTodo && pendingTodo ? tr(`${task}；另有 ${pendingTodo} 项待处理`, `${task} · ${pendingTodo} more pending`) : task;
  notice(box("compose-error"), (commandMode ? draft.commandError : draft.error) || view.optionsError ||
    (!manager.open && release?.status === "failed" ? release.error : ""));
  interactions.render(view.requests, online && !pending, (id, answer) => answerRequest(view, id, answer));
  renderQuestionShortcut(view.requests);
  setTraceTarget(traceControls.request, interactions.first);
  completion.render(view.options.commands, online && !blocked && !pending);
  dockDetailsOnReady(view);
}

function renderHeading(name: string, cwd: string): void {
  const title = box("session-title");
  if (title.textContent !== name) title.textContent = name;
  title.title = name;
  const path = box("session-path");
  notice(path, cwd);
  path.title = cwd;
  notice(box("session-path-short"), cwd ? workspaceLabel(cwd) : "");
  btn("session-path-trigger").hidden = !cwd;
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
  const baseState = view.state;
  const baseSpeed = view.generationSpeed;
  const requestChanges: RequestChange[] = [];
  view.snapshotRequestChanges = requestChanges;
  const baseLiveKey = view.liveKey;
  const baseRunningTools = new Set([...view.tools].filter(([, tool]) => tool.stage === "running").map(([id]) => id));
  try {
    const data = await api.request(sessionPath(view.session.id));
    if (current !== view || ticket !== view.sync) return;
    const parsed = parseSession(data.session);
    if (requiresManualResume && !parsed?.active) throw new Error(tr("本机服务未确认已恢复此会话。", "The local engine did not confirm the session resumed."));
    const session = parsed ?? view.session;
    if (requiresManualResume) releases.delete(session.id);
    remember(session);
    const state = object(data.state);
    if (engine.online !== false) {
      if (data.generationSpeed === undefined && view.generationSpeed === baseSpeed) view.generationSpeed = undefined;
      else rememberGenerationSpeed(view, data.generationSpeed);
    }
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
      // If an event arrived during the HTTP read, preserve only the fields it changed.
      view.state = { ...state, ...Object.fromEntries(Object.entries(view.state).filter(([key, value]) => value !== baseState[key])) };
      const streaming = session.running || state.isStreaming === true;
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
    const requests = requestsFrom(state);
    // Replaying resolutions also covers requests that arrived and settled entirely during the GET.
    for (const change of requestChanges) applyRequestChange(requests, change);
    view.requests = requests;
    refreshModelOptions(view, previousModel);
    const becameReady = view.status !== "ready";
    view.status = "ready";
    view.error = "";
    renderView();
    renderMessages(view, bottom);
    renderLiveDetailsActivity(view);
    if (becameReady || !view.workbench) void loadWorkbenchStatus(view);
  } catch (error) {
    if (current !== view || ticket !== view.sync) return;
    if (releases.get(view.session.id)?.status === "pending") return;
    if (view.status !== "ready" || !view.session.active) {
      view.status = "failed";
      view.error = errorText(error);
    } else {
      draftFor(view.session.id).error = tr(`无法刷新会话：${errorText(error)}`, `Couldn't refresh the session: ${errorText(error)}`);
    }
    renderView();
  } finally {
    if (view.snapshotRequestChanges === requestChanges) view.snapshotRequestChanges = undefined;
  }
}

async function loadWorkbenchStatus(view: View): Promise<void> {
  if (view !== current || view.status !== "ready" || !view.session.active ||
      view.session.archived || connection !== "online" || follow.active ||
      releases.get(view.session.id)?.status === "pending") return;
  workbenchRequest?.abort();
  const request = workbenchRequest = new AbortController();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  try {
    const data = await api.request(`${sessionPath(view.session.id)}/workbench-status`, undefined, signal);
    if (request.signal.aborted || workbenchRequest !== request || view !== current || view.status !== "ready") return;
    view.workbench = data;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (request.signal.aborted || workbenchRequest !== request || view !== current) return;
    view.workbench = { status: "unavailable" };
  } finally {
    if (workbenchRequest === request) workbenchRequest = undefined;
  }
  renderView();
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
    view.optionsError = tr(`无法读取模型和运行选项：${errorText(error)}`, `Couldn't load models and settings: ${errorText(error)}`);
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

function applyRequestChange(requests: Map<string, Wire>, change: RequestChange): void {
  if (change.type === "upsert") {
    requests.set(requestId(change.request), change.request);
    return;
  }
  for (const [key, request] of requests) {
    if (!change.ids.includes(key) && !change.ids.includes(str(request.requestId))) continue;
    if (change.type === "resolve") requests.delete(key);
    else if (request.method === "question") requests.set(key, { ...request, ...change.timing });
  }
}

function changeRequests(view: View, change: RequestChange): void {
  applyRequestChange(view.requests, change);
  view.snapshotRequestChanges?.push(change);
}

function receiveRequest(view: View, raw: unknown): void {
  const request = object(raw);
  if (isRequest(request)) changeRequests(view, { type: "upsert", request });
}

function rememberGenerationSpeed(view: View, value: unknown): boolean {
  const speed = readGenerationSpeed(value);
  if (!speed || (view.generationSpeed && view.generationSpeed.measuredAt >= speed.measuredAt)) return false;
  view.generationSpeed = speed;
  return true;
}

function renderLiveDetailsActivity(view: View): void {
  if (inspector.open && view.detailData) refreshDetailsActivity(view.detailData, view.state, view.generationSpeed);
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
      if (!status.online && current) {
        current.generationSpeed = undefined;
        renderLiveDetailsActivity(current);
      }
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
  if (type === "generation_speed") {
    if (rememberGenerationSpeed(view, event.generationSpeed)) renderLiveDetailsActivity(view);
    return;
  }
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
      void loadWorkbenchStatus(view);
      if (view.status === "ready" && inspector.open) loadDetailStats(view);
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
      if (type === "tool_execution_end" && event.isError !== true && /^(?:todo|todowrite)$/u.test(str(event.toolName) || old?.name || "")) {
        void loadWorkbenchStatus(view);
      }
      break;
    }
    case "extension_ui_request":
      receiveRequest(view, event);
      break;
    case "ui_request_pending":
      receiveRequest(view, event.request);
      break;
    case "question_updated": {
      if (isRequest(event)) receiveRequest(view, event);
      else {
        const ids = [str(event.id), str(event.requestId)].filter(Boolean);
        const deadlineAtMs = num(event.deadlineAtMs);
        const remainingMs = num(event.remainingMs);
        if (!ids.length || (deadlineAtMs === undefined && remainingMs === undefined)) return;
        changeRequests(view, { type: "timing", ids, timing: {
          ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
          ...(remainingMs === undefined ? {} : { remainingMs }),
        } });
      }
      break;
    }
    case "question_resolved":
    case "ui_request_resolved":
    case "extension_ui_resolved":
    case "extension_ui_request_resolved": {
      const ids = [event.id, event.requestId, event.uiRequestId].map(str).filter(Boolean);
      if (ids.length) changeRequests(view, { type: "resolve", ids });
      scheduleSnapshot(view);
      break;
    }
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
      if (event.model) view.state = { ...view.state, model: event.model };
      if (typeof event.thinkingLevel === "string") view.state = { ...view.state, thinkingLevel: event.thinkingLevel };
      if (typeof event.fastMode === "boolean") view.state = { ...view.state, fastMode: event.fastMode };
      renderLiveDetailsActivity(view);
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
      scheduleSnapshot(view);
      break;
    case "session_replaced":
      workbenchRequest?.abort();
      view.workbench = undefined;
      view.generationSpeed = undefined;
      resetProjectRules();
      renderLiveDetailsActivity(view);
      if (inspector.open) loadDetails(view);
      scheduleSnapshot(view);
      break;
    case "transcript_write_failed":
    case "extension_error":
    case "retry_fallback_exhausted":
      draftFor(view.session.id).error = str(event.errorMessage) || str(event.error) || str(event.lastError) ||
        tr("本机引擎报告会话错误", "The local engine reported a session error.");
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
  if (connection !== "online") throw new Error(tr("连接断开。重连后重试。", "Offline. Reconnect and try again."));
  if (action.action !== "resume" && (view !== current || view.status !== "ready" || !view.session.active ||
    releases.get(view.session.id)?.status === "pending")) {
    throw new Error(tr("恢复会话后再试。", "Resume the session and try again."));
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
  const ids = [id, str(view.requests.get(id)?.requestId)].filter(Boolean);
  await write(view, { action: "answer", requestId: id, ...answer });
  changeRequests(view, { type: "resolve", ids });
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
    const remove = button(tr("移除", "Remove"), () => {
      draft.images = draft.images.filter(item => item !== image);
      renderAttachments();
      renderView();
      (host.querySelector("button") ?? btn("attach")).focus();
    }, "button--quiet");
    remove.setAttribute("aria-label", tr(`移除图片：${image.name}`, `Remove image: ${image.name}`));
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
    if (!isImageType(type)) { errors.push(tr(`不支持图片格式：${file.name}`, `Unsupported image format: ${file.name}`)); continue; }
    if (!file.size || file.size > 2_100_000) {
      errors.push(tr(`图片为空或超过 2.1 MB：${file.name}`, `Image is empty or larger than 2.1 MB: ${file.name}`)); continue;
    }
    if (draft.images.length + draft.reading >= 4) { errors.push(tr("最多可添加 4 张图片。", "You can attach up to 4 images.")); break; }
    draft.reading++;
    jobs.push(new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error(tr(`无法读取图片：${file.name}`, `Couldn't read image: ${file.name}`))), { once: true });
      reader.addEventListener("load", () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const encoded = url.slice(url.indexOf(",") + 1);
        if (!encoded || !url.startsWith(`data:${type};base64,`)) {
          reject(new Error(tr(`图片编码无效：${file.name}`, `Invalid image data: ${file.name}`))); return;
        }
        resolve({ type: "image", mimeType: type, data: encoded, name: file.name || tr("粘贴的图片", "Pasted image"), url });
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
    draft.error = tr(`未能发送：${errorText(error)}`, `Couldn't send: ${errorText(error)}`);
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
      : tr(`“/${parsed.name}”请在本机 OmO 终端重新发起。Web 没有转交输入，也没有发送给模型。`,
        `Run /${parsed.name} in the local OmO terminal. The Web app did not forward your input or send it to the model.`));
    renderView();
    return;
  }
  if (parsed.kind === "builtin") {
    fail("");
    try {
      if (await runBuiltin(view, parsed.command, fail)) clear();
    } catch (error) {
      fail(tr(`命令失败：${errorText(error)}`, `Command failed: ${errorText(error)}`));
    }
    if (current?.session.id === id) renderView();
    return;
  }
  const [, invocation, args] = /^(\S+)(?:[ \t]+([^\r\n]*))?$/.exec(text) ?? [];
  if (!invocation || !commandToken.test(invocation) || /[\r\n]/.test(text)) {
    fail(tr("请输入单行 /命令 或 $技能，可附加参数。", "Enter a /command or $skill on one line. Arguments are optional."));
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
    const label = code === "unknown_command" ? tr("未知命令", "Unknown command")
      : code === "session_busy" || code === "bridge_busy" ? tr("会话忙", "Session is busy")
        : code === "invalid_arguments" || code === "invalid_request" ? tr("命令输入无效", "Invalid command input")
          : tr("原生命令失败", "Native command failed");
    fail(tr(`${label}：${errorText(error)}`, `${label}: ${errorText(error)}`));
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
      return chooser.open;
    case "resume":
    case "sessions":
      btn("cli-history-button").click();
      return dialog("cli-history-dialog").open;
    case "name":
    case "rename":
      if (command.value !== undefined) return action({ action: "rename", name: command.value }, tr("重命名", "Rename"));
      btn("manage-button").click();
      manager.querySelector<HTMLInputElement>('[data-key="name"]')?.focus();
      return manager.open;
    case "session":
      openDetails();
      return inspector.open;
    case "tree":
      openDetails("overview", prompt, "tree");
      return inspector.open;
    case "todo":
      openDetails("todo", prompt, "todo");
      return inspector.open;
    case "tasks":
      openDetails("subagents", prompt);
      return inspector.open;
    case "dag":
      openDetails("dag", prompt);
      return inspector.open;
    case "help":
    case "hotkeys":
      await openCommandPicker(view, true);
      return commandDialog.open;
    case "reasoning":
    case "efforts": {
      const model = object(view.state.model);
      const level = str(view.state.thinkingLevel);
      if (!modelKey(model)) { fail(tr("没有已确认的模型。", "No model is selected yet.")); return false; }
      if (!level || !Object.hasOwn(settingLabels, level)) { fail(tr("当前思考档未知。", "The current thinking level is unknown.")); return false; }
      if (command.name === "reasoning") {
        draftFor(id).commandStatus = level === "off" ? tr("当前模型推理：关闭。", "Model reasoning: off.")
          : tr(`当前模型推理：开启（${level}）。`, `Model reasoning: on (${level}).`);
        return true;
      }
      const reported = list(view.options.levels).map(str).filter(value => Object.hasOwn(settingLabels, value));
      const levels = reported.filter(value => value !== "off");
      if (!reported.length) { fail(tr("暂时无法读取可用思考档。", "Thinking levels are unavailable.")); return false; }
      if (model.reasoning === false || !levels.length) { fail(tr("当前模型不支持推理。", "This model does not support reasoning.")); return false; }
      if (reported.includes("off") && levels.length === 1) {
        fail(tr("此模型只能开启或关闭推理。", "This model can only turn reasoning on or off.")); return false;
      }
      draftFor(id).commandStatus = tr(`当前档位：${level}。可用推理档：${levels.join("、")}。`,
        `Thinking: ${level}. Available levels: ${levels.join(", ")}.`);
      return true;
    }
    case "fork":
      btn("web-branch-button").click();
      return dialog("branch-dialog").open;
    case "compact":
      return action({ action: "compact", ...(command.instructions ? { instructions: command.instructions } : {}) },
        tr("压缩上下文", "Compact context"));
    case "model": {
      if (!command.reference) {
        if (usesComposeOptionsPopover() && !sel("model").disabled) setComposeOptions(true);
        sel("model").focus();
        if (document.activeElement === sel("model")) {
          try { sel("model").showPicker?.(); } catch (error) { if (!(error instanceof DOMException)) throw error; }
          return true;
        }
        fail(tr("没有可选模型。", "No models available."));
        return false;
      }
      const matches = list(view.options.models).map(object).filter(model =>
        [str(model.id), `${str(model.provider)}/${str(model.id)}`].includes(command.reference ?? ""));
      if (matches.length === 1) return action({ action: "model", provider: str(matches[0].provider), modelId: str(matches[0].id) },
        tr("切换模型", "Change model"));
      fail(matches.length ? tr("多个模型同名，请用 provider/model。", "Multiple models have that name. Use provider/model.")
        : tr("找不到此模型。用 /model 查看列表。", "Model not found. Use /model to list available models."));
      return false;
    }
    case "thinking": {
      if (!command.level) {
        if (usesComposeOptionsPopover() && !sel("thinking").disabled) setComposeOptions(true);
        sel("thinking").focus();
        if (document.activeElement === sel("thinking")) {
          try { sel("thinking").showPicker?.(); } catch (error) { if (!(error instanceof DOMException)) throw error; }
          return true;
        }
        fail(tr("没有可选思考档。", "No thinking levels available."));
        return false;
      }
      if (!list(view.options.levels).includes(command.level)) {
        fail(tr("此模型不支持这个思考档。", "This model does not support that thinking level."));
        return false;
      }
      return action({ action: "thinking", level: command.level }, tr("切换思考档", "Change thinking level"));
    }
    case "fast":
      if (typeof view.state.fastMode !== "boolean") { fail(tr("此模型没有快速模式。", "Fast mode is unavailable for this model.")); return false; }
      return action({ action: "fast", enabled: command.mode ? command.mode === "on" : !view.state.fastMode }, tr("切换快速模式", "Change fast mode"));
    case "clone":
    case "copy":
      writes.add(id);
      renderView();
      try {
        if (command.name === "copy") {
          const { text } = await api.request(`${sessionPath(id)}/last-assistant`);
          if (typeof text !== "string" || !text) { fail(tr("没有可复制的助手消息。", "No assistant message to copy.")); return false; }
          if (!navigator.clipboard) { fail(tr("浏览器无法访问剪贴板。", "The browser can't access the clipboard.")); return false; }
          await navigator.clipboard.writeText(text);
          draftFor(id).commandStatus = tr("已复制上一条助手消息。", "Copied the last assistant message.");
          return true;
        }
        const data = await api.request(`${sessionPath(id)}/branches`, { kind: "clone" });
        if (data.cancelled === true) { fail(tr("原生引擎取消了复制。", "OmO cancelled the clone.")); return false; }
        const session = parseSession(data.session);
        if (!session) throw new Error(tr("本机服务没有返回新会话。", "The local service did not return a new session."));
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
      workbenchRequest?.abort();
      view.workbench = undefined;
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
    if (view === current) onError(tr(`${label}失败：${errorText(error)}`, `${label} failed: ${errorText(error)}`));
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
  cwd.value = nextCreationDirectory || current?.session.cwd || workspaces[0] || "";
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
  if (name.length > 120) { notice(box("new-error"), tr("会话名称不能超过 120 个字符。", "Keep the session name to 120 characters or fewer.")); return; }
  createPending = true;
  btn("create").disabled = true;
  notice(box("new-error"));
  try {
    const data = await api.request("/api/sessions", { cwd, ...(name ? { name } : {}) });
    const session = parseSession(data.session);
    if (!session) throw new Error(tr("本机服务没有返回会话。", "The local service did not return a session."));
    nextCreationDirectory = "";
    remember(session);
    if (!follow.active) {
      archived = session.archived;
      if (chooser.open) chooser.close();
      openSession(session.id);
    }
  } catch (error) {
    notice(box("new-error"), tr(`创建失败：${errorText(error)}`, `Couldn't create session: ${errorText(error)}`));
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
    const message = tr(`无法转到 CLI：${errorText(error)}`, `Couldn't switch to the CLI: ${errorText(error)}`);
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
  const save = el("button", "button", tr("保存名称", "Save name"));
  save.type = "submit";
  save.dataset.write = "";
  save.dataset.key = "save";
  const renameRow = el("div", "row");
  renameRow.append(save);
  rename.append(field(tr("会话名称", "Session name"), name), renameRow);
  rename.addEventListener("submit", event => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) { fail(tr("请输入会话名称。", "Enter a session name.")); return; }
    if (value !== view.session.name) void runAction(view, { action: "rename", name: value }, tr("重命名", "Rename"), fail);
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
    row(view.session.archived ? tr("取消归档", "Unarchive") : tr("归档", "Archive"), "archive", { action: "archive", enabled: !view.session.archived }),
    row(view.session.settled ? tr("重新标为未结清", "Mark as open") : tr("标为已结清", "Mark as done"), "settle", { action: "settle", enabled: !view.session.settled }),
  );
  manage.append(el("h3", "", tr("会话状态", "Session status")),
    el("p", "small muted", view.session.archived ? tr("已归档", "Archived") : tr("未归档", "Not archived")), controls);
  const runtime = el("section", "subpanel stack stack--tight");
  const flags = el("div", "row");
  const fast = view.state.fastMode;
  const auto = view.state.autoCompactionEnabled;
  if (typeof fast === "boolean") flags.append(row(fast ? tr("关闭快速模式", "Turn off fast mode") : tr("开启快速模式", "Turn on fast mode"),
    "fast", { action: "fast", enabled: !fast }));
  if (typeof auto === "boolean") flags.append(row(auto ? tr("关闭自动压缩", "Turn off auto-compaction") : tr("开启自动压缩", "Turn on auto-compaction"),
    "auto", { action: "autoCompaction", enabled: !auto }));
  runtime.append(el("h3", "", tr("运行设置", "Run settings")));
  if (flags.childElementCount) runtime.append(flags);
  const compactForm = el("form", "stack stack--tight");
  const instructions = el("input");
  instructions.type = "text";
  instructions.maxLength = 6000;
  instructions.dataset.key = "instructions";
  const compact = el("button", "button", tr("压缩上下文", "Compact context"));
  compact.type = "submit";
  compact.dataset.write = "";
  compact.dataset.idle = "";
  compact.dataset.key = "compact";
  compact.disabled = connection !== "online" || view.running || view.compacting;
  const compactRow = el("div", "row");
  compactRow.append(compact);
  compactForm.append(field(tr("压缩说明（选填）", "Compaction instructions (optional)"), instructions), compactRow);
  compactForm.addEventListener("submit", event => {
    event.preventDefault();
    if (view.running || view.compacting || writes.has(id)) { fail(tr("等本轮结束后再压缩。", "Wait for this turn to finish before compacting.")); return; }
    const value = instructions.value.trim();
    void runAction(view, { action: "compact", ...(value ? { instructions: value } : {}) }, tr("压缩上下文", "Compact context"), fail);
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
  if (inspector.matches(":modal")) closeDetails(false);
  showCommandMode(view, true);
  prompt.setSelectionRange(invocation.length + 1, invocation.length + 1);
}

function renderCommandOptions(view: View): void {
  const query = inp("command-search").value.trim().toLocaleLowerCase();
  const nodes = commandOptions.flatMap(command => {
    const invocation = str(command.invocation);
    const description = str(command.description);
    const source = str(command.source);
    const sourceLabel = source === "builtin" ? tr("内置命令", "Built-in") : source === "skill" ? tr("技能", "Skill")
      : source === "prompt" ? tr("提示模板", "Prompt template") : tr("扩展", "Extension");
    if (!commandToken.test(invocation) || !`${invocation} ${description} ${sourceLabel} ${source}`.toLocaleLowerCase().includes(query)) return [];
    const row = el("li", "stack stack--tight");
    const insert = button(invocation, () => insertCommand(view, invocation), "button--quiet path");
    insert.dataset.invocation = invocation;
    insert.setAttribute("aria-label", tr(`插入命令：${invocation}`, `Insert command: ${invocation}`));
    row.append(insert, el("p", "small muted break", [sourceLabel, description].filter(Boolean).join(" · ")));
    return [row];
  });
  box("command-list").replaceChildren(...nodes);
  box("command-list").hidden = !nodes.length;
  notice(box("command-status"), nodes.length ? "" : query ? tr("没有匹配的命令。", "No matching commands.")
    : tr("此会话没有可用命令。", "This session has no listed commands."));
}

async function openCommandPicker(view: View, help = false): Promise<void> {
  if (commandDialog.open || btn("command-picker").disabled) return;
  commandRequest?.abort();
  const request = commandRequest = new AbortController();
  commandOptions = [];
  const filter = inp("command-search");
  const shortcuts = byId("command-shortcuts", HTMLDetailsElement);
  shortcuts.open = help;
  filter.value = "";
  box("command-list").replaceChildren();
  box("command-list").hidden = true;
  notice(box("command-error"));
  notice(box("command-status"), tr("正在读取命令…", "Loading commands…"));
  commandDialog.showModal();
  if (help) shortcuts.querySelector("summary")?.focus();
  const live = () => !request.signal.aborted && commandDialog.open && view === current;
  try {
    const data = await api.request(`${sessionPath(view.session.id)}/options`, undefined, request.signal);
    if (!live()) return;
    commandOptions = commandCatalog(data.commands);
    renderCommandOptions(view);
  } catch (error) {
    if (!live()) return;
    notice(box("command-status"));
    notice(box("command-error"), tr(`无法读取命令：${errorText(error)}。也可以直接输入。`,
      `Couldn't load commands: ${errorText(error)}. You can still type a command directly.`));
  } finally {
    if (commandRequest === request) commandRequest = undefined;
  }
}

let detailsRequest: AbortController | undefined;
let runtimeRequest: AbortController | undefined;
let dagRequest: AbortController | undefined;
let detailsOpener: HTMLElement | undefined;
type DetailReveal = "tree" | "todo";
let detailReveal: DetailReveal | undefined;
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
  status.textContent = tr("正在读取能力清单…", "Loading capabilities…");
  syncDetailsRefresh();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  void api.request(`${sessionPath(view.session.id)}/capabilities`, undefined, signal).then(data => {
    if (!currentRead()) return;
    content.replaceChildren(...renderCapabilities(data));
    status.className = "sr-only";
    status.textContent = tr("能力清单已加载。", "Capabilities loaded.");
  }, (error: unknown) => {
    if (!currentRead()) return;
    status.className = "notice error small";
    if (error instanceof RequestError && error.status === 404 && error.code === "not_found") {
      status.textContent = tr("此版本的 Web 服务不提供能力清单。", "This Web server does not list capabilities.");
    } else if (error instanceof RequestError && (error.code === "session_changed" || error.code === "session_not_open" || error.code === "session_not_found")) {
      status.textContent = tr("会话已断开。打开会话后重试。", "Session disconnected. Open it and try again.");
    } else {
      status.textContent = tr("无法读取能力清单。刷新重试。", "Couldn't load capabilities. Refresh to try again.");
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
    if (target === "runtime-todo" && !selected) resetProjectRules();
  }
  box("details-scroll").scrollTop = 0;
  detailReveal = undefined;
  if (capabilitiesSelected() && inspector.open && current?.status === "ready" && !capabilitiesAttempted) {
    loadCapabilities(current);
  } else syncDetailsRefresh();
}

function revealDetailsTarget(): void {
  if (!detailReveal) return;
  const root = detailReveal === "todo" ? "#runtime-todo [data-runtime-branch]" : "#runtime-tree";
  const fold = inspector.querySelector<HTMLDetailsElement>(`${root} details`);
  if (!fold) return;
  detailReveal = undefined;
  fold.open = true;
  const title = fold.querySelector("summary");
  title?.focus({ preventScroll: true });
  title?.scrollIntoView({ block: "start" });
}

function openDetails(tab = "overview", opener: HTMLElement = btn("details-button"), reveal?: DetailReveal): void {
  if (current?.status !== "ready") return;
  const target = btn(`runtime-open-${tab}`);
  selectDetailsView(target);
  detailsOpener = opener;
  detailReveal = reveal;
  if (!compactInspector.matches && !desktopInspectorOpen) {
    desktopInspectorOpen = true;
    saveLayoutPreference(inspectorPreference, "open");
  }
  if (!inspector.open) showDetails(current);
  target.focus({ preventScroll: true });
  revealDetailsTarget();
}

function showDetails(view: View): void {
  for (const panel of inspector.querySelectorAll('[role="tabpanel"]:not(#runtime-capabilities, #runtime-todo)')) panel.replaceChildren();
  box("runtime-todo").querySelector("[data-runtime-branch]")?.remove();
  box("runtime-memory-journal").replaceChildren();
  box("runtime-memory-branch-content").replaceChildren();
  byId("runtime-memory-branch", HTMLDetailsElement).open = false;
  // HTMLDialogElement.show() runs the dialog focusing steps even when non-modal.
  if (compactInspector.matches) inspector.showModal();
  else inspector.open = true;
  btn("details-button").setAttribute("aria-expanded", "true");
  box("details-scroll").scrollTop = 0;
  loadDetails(view);
}

function dockDetailsOnReady(view: View | undefined, enteringDesktop = false): void {
  if (!view || view.status !== "ready" || follow.active || (view.consideredDesktopDock && !enteringDesktop)) return;
  view.consideredDesktopDock = true;
  if (!desktopInspectorOpen || compactInspector.matches || inspector.open) return;
  selectDetailsView(btn("runtime-open-overview"));
  showDetails(view);
}

function closeDetails(restoreFocus = true): void {
  if (!inspector.open) return;
  inspector.close();
  detailsRequest?.abort();
  runtimeRequest?.abort();
  dagRequest?.abort();
  resetProjectRules();
  if (current) current.detailData = undefined;
  detailReveal = undefined;
  clearCapabilities();
  const trigger = btn("details-button");
  trigger.setAttribute("aria-expanded", "false");
  const opener = detailsOpener ?? trigger;
  detailsOpener = undefined;
  if (restoreFocus) (opener.getClientRects().length ? opener : trigger.hidden ? box("conversation") : trigger).focus({ preventScroll: true });
}

function dismissDetails(): void {
  if (!inspector.matches(":modal")) {
    desktopInspectorOpen = false;
    saveLayoutPreference(inspectorPreference, "closed");
  }
  closeDetails();
}

function syncDetailsPresentation(): void {
  const trigger = btn("details-button");
  if (compactInspector.matches) {
    trigger.setAttribute("aria-haspopup", "dialog");
    if (inspector.open && !inspector.matches(":modal")) closeDetails(inspector.contains(document.activeElement));
    return;
  }
  trigger.removeAttribute("aria-haspopup");
  if (!inspector.matches(":modal") || document.querySelector("dialog:modal:not(#details-dialog)")) return;
  const scroller = box("details-scroll");
  const scrollTop = scroller.scrollTop;
  const active = document.activeElement;
  // The user already opened this modal. Keep its contents when it becomes a dock.
  inspector.close();
  inspector.open = true;
  if (active instanceof HTMLElement && inspector.contains(active)) active.focus({ preventScroll: true });
  scroller.scrollTop = scrollTop;
}

function setComposeOptions(open: boolean): void {
  composeOptionsButton.setAttribute("aria-expanded", String(open));
}

function usesComposeOptionsPopover(): boolean {
  return getComputedStyle(composeToolbar).getPropertyValue("--compact-options").trim() === "1";
}

function syncComposeOptionsLayout(): void {
  const compact = usesComposeOptionsPopover();
  if (compact === composeToolbar.hasAttribute("data-compact")) return;
  const active = document.activeElement;
  if (!compact) setComposeOptions(false);
  composeToolbar.toggleAttribute("data-compact", compact);
  if (compact && composeOptions.contains(active) && composeOptionsButton.getAttribute("aria-expanded") !== "true") {
    composeOptionsButton.focus({ preventScroll: true });
  } else if (!compact && active === composeOptionsButton) {
    (composeOptions.querySelector<HTMLElement>("select:enabled:not([hidden] *)") ?? prompt).focus({ preventScroll: true });
  }
}

function loadDetailStats(view: View): void {
  detailsRequest?.abort();
  const request = detailsRequest = new AbortController();
  const live = () => !request.signal.aborted && inspector.open && view === current;
  const overview = box("runtime-metrics");
  const fail = (message: string) => notice(box("details-error"), message);
  if (!overview.childElementCount) overview.append(el("p", "muted", tr("正在读取运行详情…", "Loading run details…")));
  fail("");
  void api.request(`${sessionPath(view.session.id)}/details`, undefined, request.signal).then(data => {
    if (!live()) return;
    view.detailData = data;
    if (engine.online !== false) rememberGenerationSpeed(view, data.generationSpeed);
    renderDetails(data, view.state, view.options, {
      canWrite: connection === "online",
      canNavigate: connection === "online" && !view.running && !view.compacting && !sending.has(view.session.id),
      queueCount: view.queue,
      clearQueue: () => {
        if (window.confirm(tr("清空所有尚未发送的排队输入？", "Remove all unsent messages from the queue?"))) {
          void runAction(view, { action: "clearQueue" }, tr("清空队列", "Clear queue"), fail);
        }
      },
      navigate: targetId => {
        const draft = draftFor(view.session.id);
        const warning = draft.text.trim()
          ? tr("切换上下文位置？选中的消息可能替换当前草稿。", "Switch context? The selected message may replace your draft.")
          : tr("切换上下文位置？原有分支仍会保留。", "Switch context? Existing branches are kept.");
        if (!view.running && !view.compacting && window.confirm(warning)) {
          void runAction(view, { action: "navigate", targetId }, tr("切换上下文", "Switch context"), fail, result => {
            if (object(result.result).cancelled === true) fail(tr("本次切换已取消。", "Context switch cancelled."));
          });
        }
      },
      insertCommand: command => insertCommand(view, command),
    }, view.generationSpeed);
    revealDetailsTarget();
  }).catch(error => {
    if (!live()) return;
    if (!overview.querySelector("section")) overview.replaceChildren();
    fail(tr(`无法读取运行详情：${errorText(error)}`, `Couldn't load run details: ${errorText(error)}`));
  }).finally(() => {
    if (detailsRequest === request) detailsRequest = undefined;
  });
}

function loadDetails(view: View): void {
  loadDetailStats(view);
  runtimeRequest?.abort();
  const request = runtimeRequest = new AbortController();
  dagRequest?.abort();
  const dag = box("runtime-dag");
  const selectedRun = dag.querySelector<HTMLDetailsElement>(".dag-run[open]")?.dataset.dagKey;
  const focusedRun = document.activeElement?.closest<HTMLElement>(".dag-run")?.dataset.dagKey;
  const treeRequest = dagRequest = new AbortController();
  const live = () => !request.signal.aborted && inspector.open && view === current;
  const path = sessionPath(view.session.id);
  const journal = box("runtime-memory-journal");
  const setJournal = (data?: Wire) => {
    journal.replaceChildren(renderJournal(data));
  };
  const setActivity = (tasks?: Wire, dag?: Wire, snapshot?: "waiting" | Wire) => {
    box("runtime-subagent").replaceChildren(...renderRuntimePane("tasks", tasks, snapshot));
    const runs = box("runtime-dag");
    runs.replaceChildren(...renderRuntimePane("dag", dag, snapshot, async key => {
      const signal = AbortSignal.any([treeRequest.signal, AbortSignal.timeout(28_000)]);
      return api.request(`${path}/native-runtime/dag/${key}`, undefined, signal);
    }));
    for (const detail of runs.querySelectorAll<HTMLDetailsElement>(".dag-run")) {
      if (detail.dataset.dagKey === selectedRun) detail.open = true;
      if (focusedRun && detail.dataset.dagKey === focusedRun && document.activeElement === document.body) {
        detail.querySelector("summary")?.focus({ preventScroll: true });
      }
    }
  };
  if (!journal.childElementCount) setJournal();
  if (!dag.childElementCount) setActivity();
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
  void runtime().finally(() => {
    if (runtimeRequest === request) runtimeRequest = undefined;
  });
}

function openCliHistory(id?: string): void {
  follow.stop();
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
  railCollapsed = readLayoutPreference(railPreference) === "true";
  desktopInspectorOpen = readLayoutPreference(inspectorPreference) !== "closed";
  renderRail();
  btn("rail-toggle").addEventListener("click", () => {
    railCollapsed = !railCollapsed;
    saveLayoutPreference(railPreference, String(railCollapsed));
    renderRail();
  });
  mobile.addEventListener("change", () => {
    const active = document.activeElement;
    const restore = navOpen || active === btn("open-navigation") || active === btn("rail-toggle") || box("navigation").contains(active);
    toggleNav(false);
    if (restore && !document.querySelector("dialog:modal")) {
      btn(mobile.matches ? "open-navigation" : "rail-toggle").focus({ preventScroll: true });
    }
  });
  syncDetailsPresentation();
  compactInspector.addEventListener("change", () => {
    syncDetailsPresentation();
    if (!compactInspector.matches) dockDetailsOnReady(current, true);
  });
  document.addEventListener("close", event => {
    if (event.target !== inspector) syncDetailsPresentation();
  }, true);
  new ResizeObserver(syncComposeOptionsLayout).observe(form("composer"));
  const optionsOpen = () => composeOptionsButton.getAttribute("aria-expanded") === "true";
  composeOptionsButton.addEventListener("click", () => setComposeOptions(!optionsOpen()));
  const dismissOptionsOutside = (event: Event) => {
    if (optionsOpen() && event.target instanceof Node && !composeOptionsButton.contains(event.target)
      && !composeOptions.contains(event.target)) setComposeOptions(false);
  };
  document.addEventListener("click", dismissOptionsOutside);
  document.addEventListener("focusin", dismissOptionsOutside);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector("dialog:modal")) return;
    if (navOpen) toggleNav(false, true);
    else if (optionsOpen()) {
      setComposeOptions(false);
      composeOptionsButton.focus({ preventScroll: true });
    } else if (inspector.open) dismissDetails();
  });
  inp("search").addEventListener("input", () => { renderSessions(); renderCliSessions(); });
  sel("workspace-select").addEventListener("change", () => filterDirectory(sel("workspace-select").value));
  btn("recent").addEventListener("click", () => { archived = false; renderSessions(); renderCliSessions(); });
  btn("archived").addEventListener("click", () => { archived = true; renderSessions(); renderCliSessions(); });
  // CLI journals appear outside the engine event stream; re-check when the
  // page becomes visible so the sidebar discovers them without the dialog.
  // An open run view refreshes too, so metrics stay current while viewed.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void fetchSessions();
    if (current) void loadWorkbenchStatus(current);
    if (current && inspector.open) loadDetails(current);
  });
  window.setInterval(() => {
    if (!document.hidden && connection === "online") void fetchCliRows(true);
  }, CLI_REFRESH_MS);
  btn("new-welcome").addEventListener("click", openChooser);
  btn("new-sidebar").addEventListener("click", openChooser);
  form("new-form").addEventListener("submit", event => { event.preventDefault(); void createSession(); });
  const pathDialog = dialog("session-path-dialog");
  for (const modal of [chooser, manager, commandDialog, pathDialog]) {
    for (const close of modal.querySelectorAll("[data-close]")) close.addEventListener("click", () => modal.close());
  }
  btn("session-path-trigger").addEventListener("click", () => {
    const cwd = box("session-path").textContent;
    if (!cwd || pathDialog.open) return;
    box("session-path-full").textContent = cwd;
    notice(box("session-path-status"));
    pathDialog.showModal();
  });
  btn("session-path-copy").addEventListener("click", async () => {
    const path = box("session-path-full");
    const cwd = path.textContent;
    if (!cwd) return;
    let message = tr("已复制路径。", "Path copied.");
    try { await navigator.clipboard.writeText(cwd); }
    catch { message = tr("剪贴板不可用。可选中路径手动复制。", "Clipboard unavailable. Select and copy the path."); }
    if (pathDialog.open && path.textContent === cwd) notice(box("session-path-status"), message);
  });
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
      receipt.copyStatus = tr("已复制命令。", "Command copied.");
    } catch {
      receipt.copyStatus = tr("剪贴板不可用。可选中命令手动复制。", "Clipboard unavailable. Select and copy the command.");
    }
    if (current?.session.id === view.session.id && releases.get(view.session.id) === receipt) renderView();
  });
  btn("details-button").addEventListener("click", () => { if (inspector.open) dismissDetails(); else openDetails(); });
  btn("current-todo").addEventListener("click", () => openDetails("todo", btn("current-todo"), "todo"));
  box("runtime-metrics").addEventListener("click", event => {
    if (!(event.target instanceof Element) || !event.target.closest("#runtime-open-resources")) return;
    selectDetailsView(btn("runtime-open-todo"));
    const heading = box("runtime-resources-title");
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  });
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
  inspector.querySelector("[data-close]")?.addEventListener("click", dismissDetails);
  inspector.addEventListener("cancel", event => {
    event.preventDefault();
    dismissDetails();
  });
  btn("command-mode").addEventListener("click", () => {
    if (current) showCommandMode(current, !draftFor(current.session.id).commandMode);
  });
  btn("command-picker").addEventListener("click", () => { if (current) void openCommandPicker(current); });
  bindCommandListKeys(commandDialog, inp("command-search"), box("command-list"));
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
    void runAction(view, { action: "resume" }, tr("恢复会话", "Resume session"), text => { view.error = text; renderView(); }).then(() => {
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
    if (completion.key(event)) return;
    if (event.key === "Enter" && !event.isComposing && !completion.composing && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitComposer();
    }
  });
  prompt.addEventListener("focus", renderView);
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
    if (view) void runAction(view, { action: "abort" }, tr("停止", "Stop"), text => { draftFor(view.session.id).error = text; renderView(); });
  });
  stream.observeTrace(({ user, assistant, tool }) => {
    setTraceTarget(traceControls.user, user);
    setTraceTarget(traceControls.assistant, assistant);
    setTraceTarget(traceControls.tool, tool);
  });
  const traceMotion = matchMedia("(prefers-reduced-motion: no-preference) and (forced-colors: none)");
  let traceArrival: Animation | undefined;
  traceMotion.addEventListener("change", () => traceArrival?.cancel());
  const focusTraceTarget = (target: HTMLElement) => {
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
  };
  for (const control of Object.values(traceControls)) control.addEventListener("click", () => {
    const target = traceTargets.get(control);
    if (!trace.hidden && target?.isConnected) focusTraceTarget(target);
  });
  btn("sidebar-question").addEventListener("click", () => {
    const target = interactions.firstQuestion;
    if (!target?.isConnected) return;
    if (inspector.matches(":modal")) closeDetails(false);
    focusTraceTarget(target);
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
    await runAction(view, { action: "model", provider: str(model.provider), modelId: str(model.id) }, tr("切换模型", "Change model"),
      text => { draftFor(view.session.id).error = text; renderView(); });
    if (current !== view) return;
    view.modelSelection = undefined;
    renderView();
    if (document.activeElement === document.body || document.activeElement === applyModel) modelSelect.focus();
  });
  sel("thinking").addEventListener("change", () => {
    const view = current;
    const level = sel("thinking").value;
    if (view && level && !sel("thinking").disabled) void runAction(view, { action: "thinking", level }, tr("切换思考档", "Change thinking level"),
      text => { draftFor(view.session.id).error = text; renderView(); });
    else renderView();
  });
  sel("approval").addEventListener("change", () => {
    const view = current;
    const preset = sel("approval").value;
    if (!view || (preset !== "ask" && preset !== "auto" && preset !== "full-access")) { renderView(); return; }
    if (preset === "full-access" && !window.confirm(tr(
      "关闭此会话的审批？工具默认放行，包括删除文件或对外发送数据。原生权限规则仍有效，用户问题仍需回答。",
      "Turn off approval for this session? Tools can delete files or send data without asking. Native rules and user questions still apply."))) {
      renderView();
      return;
    }
    void runAction(view, { action: "preset", preset }, tr("切换审批模式", "Change approval mode"),
      text => { draftFor(view.session.id).error = text; renderView(); });
  });
}

startTheme();
startLanguage();
listen();
void bootstrap();
