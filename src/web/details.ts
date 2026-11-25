import { branchPath, parseSession, RequestError } from "./api.ts";
import type { Api, BranchChoice, BranchSource, Session } from "./api.ts";
import { byId, button, el, errorText, fold, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { renderNativeActivity } from "./native-activity.ts";

type Controls = {
  readonly canWrite: boolean;
  readonly canNavigate: boolean;
  readonly queueCount?: number;
  readonly clearQueue: () => void;
  readonly navigate: (id: string | null) => void;
  readonly insertCommand: (value: string) => void;
};

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 5 });
const format = (value: unknown): string => {
  const n = num(value);
  return n === undefined ? "" : number.format(n);
};
const bool = (value: unknown): string => typeof value === "boolean" ? value ? "开启" : "关闭" : "";

function values(pairs: readonly (readonly [string, string])[]): HTMLElement {
  const result = el("dl", "details-list small numerical");
  for (const [label, value] of pairs) if (value) result.append(el("dt", "", label), el("dd", "", value));
  return result.childElementCount ? result : el("p", "small muted", "当前没有可用数据。");
}

function part(title: string, ...children: Node[]): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", title), ...children);
  return section;
}

function activity(stats: Wire, state: Wire): HTMLElement {
  const model = object(state.model);
  const tokens = object(stats.tokens ?? state.usageTotals);
  const context = object(stats.contextUsage ?? state.contextUsage);
  const percent = format(context.percent);
  const cost = num(stats.cost);
  const failures = object(stats.failures);
  return part("运行状态与用量", values([
    ["模型", [str(model.provider), str(model.name) || str(model.id)].filter(Boolean).join(" · ")],
    ["权限预设", str(state.effectivePermissionPreset) || str(state.permissionPreset)],
    ["快速模式", bool(state.fastMode)],
    ["自动压缩", bool(state.autoCompactionEnabled)],
    ["用户消息", format(stats.userMessages)],
    ["助手消息", format(stats.assistantMessages)],
    ["工具调用", format(stats.toolCalls)],
    ["输入 token", format(tokens.input)],
    ["输出 token", format(tokens.output)],
    ["缓存读取 token", format(tokens.cacheRead)],
    ["缓存写入 token", format(tokens.cacheWrite)],
    ["总 token", format(tokens.total ?? tokens.totalTokens)],
    ["上下文", [format(context.tokens), format(context.contextWindow)].filter(Boolean).join(" / ") + (percent ? ` (${percent}%)` : "")],
    ["估算费用", cost === undefined ? "" : dollars.format(cost)],
    ["失败请求", format(failures.erroredRequests)],
  ]));
}

function queuePanel(queue: Wire, controls: Controls): HTMLElement {
  const active = new Set(["held", "queued", "sending", "pending", "accepted"]);
  const inputs = list(queue.inputs).map(object).filter(item => !item.state || active.has(str(item.state)));
  const items = el("ul", "inline-list");
  for (const input of inputs) {
    const mode = str(input.requestedMode);
    const state = ({ queued: "排队中", sending: "正在发送", held: "等待中", pending: "等待中", accepted: "已接收" })[str(input.state)] || "";
    const label = [mode === "steer" ? "引导" : mode === "followUp" || mode === "follow_up" ? "后续" : "", state].filter(Boolean).join(" · ");
    const entry = el("li", "stack stack--tight");
    if (label) entry.append(el("span", "small muted", label));
    entry.append(el("p", "plain", str(input.text) || "（无文本）"));
    items.append(entry);
  }
  const clear = button("清空队列", controls.clearQueue, "button--danger");
  clear.disabled = !controls.canWrite || !((controls.queueCount ?? 0) > 0 || inputs.length > 0);
  clear.dataset.write = "";
  if (clear.disabled && controls.canWrite) clear.dataset.unavailable = "";
  const actions = el("div", "row");
  actions.append(clear);
  const count = controls.queueCount ?? inputs.length;
  return part("输入队列", el("p", "small muted", count ? `${count} 条待处理输入` : "没有排队的输入。"), ...(inputs.length ? [items] : []), actions);
}

function commandPanel(options: Wire, controls: Controls): HTMLElement {
  const commands = list(options.commands).map(object).filter(command => Boolean(str(command.invocation)));
  const section = part("可用命令");
  if (!commands.length) {
    section.append(el("p", "muted small", "未读取到可用命令。"));
    return section;
  }
  const result = el("ul", "command-list");
  for (const command of commands) {
    const syntax = str(command.invocation);
    const action = button(syntax, () => controls.insertCommand(syntax), "button--quiet path");
    action.title = "插入输入框，不会立即发送";
    action.setAttribute("aria-label", `插入命令：${syntax}`);
    const item = el("li", "stack stack--tight");
    item.append(action);
    if (str(command.description)) item.append(el("p", "small muted break", str(command.description)));
    result.append(item);
  }
  section.append(fold(`${commands.length} 项 · 展开后可插入输入框`, result));
  return section;
}

function entryTitle(node: Wire): string {
  const entry = object(node.entry);
  const message = object(entry.message);
  const content = message.content;
  const summary = (str(content) || list(content).map(object).filter(block => block.type === "text").map(block => str(block.text)).join(" ")).replace(/\s+/g, " ").trim();
  const role = str(message.role);
  const type = str(entry.type);
  const label = str(node.label) || str(entry.label);
  const titles: Readonly<Record<string, string>> = {
    user: "你", assistant: "助手", toolResult: "工具结果", bashExecution: "命令输出", message: "消息",
    compaction: "上下文压缩", branch_summary: "分支摘要", model_change: "模型变更",
    thinking_level_change: "思考档变更", custom: "会话记录", session_info: "会话信息",
  };
  const id = str(entry.id);
  const name = Object.hasOwn(titles, role || type) ? titles[role || type] : role || type || "节点";
  return `${label || name}${summary ? ` · ${summary.slice(0, 88)}` : id ? ` · ${id.slice(0, 12)}` : ""}`;
}

function treePanel(data: Wire, controls: Controls): HTMLElement {
  const leaf = str(data.leafId);
  const roots = list(data.tree);
  const table = el("ul", "tree");
  const stack = [...roots].reverse().map(node => ({ raw: node, list: table, depth: 0 }));
  while (stack.length) {
    const task = stack.pop();
    if (!task) break;
    const node = object(task.raw);
    const id = str(object(node.entry).id);
    const children = list(node.children);
    const item = el("li");
    if (id) {
      const action = button(entryTitle(node), () => controls.navigate(id), "button--quiet");
      action.disabled = !controls.canNavigate;
      action.dataset.write = "";
      action.dataset.idle = "";
      if (leaf === id) action.setAttribute("aria-current", "true");
      item.append(action);
    } else item.append(el("span", "small muted break", entryTitle(node)));
    task.list.append(item);
    if (children.length) {
      // After the first few levels, keep the rest readable instead of narrowing to zero.
      const target = task.depth === 4 ? task.list : el("ul", "tree");
      if (target !== task.list) item.append(target);
      for (let i = children.length - 1; i >= 0; i--) stack.push({ raw: children[i], list: target, depth: Math.min(4, task.depth + 1) });
    }
  }
  const clear = button("切换到空上下文", () => controls.navigate(null));
  clear.disabled = !controls.canNavigate || !leaf;
  clear.dataset.write = "";
  clear.dataset.idle = "";
  if (!leaf) clear.dataset.unavailable = "";
  const actionBar = el("div", "row");
  actionBar.append(clear);
  const body = table.childElementCount ? fold("查看会话节点", el("p", "small muted", "选择历史用户消息可将其载入输入框；不会自动发送。"), table, actionBar)
    : el("p", "small muted", "没有可导航的会话节点。");
  return part("会话树", body);
}

export function renderDetails(host: HTMLElement, data: Wire, state: Wire, options: Wire, controls: Controls): void {
  const opened = [...host.querySelectorAll("details")].map(node => node.open);
  host.replaceChildren(
    activity(object(data.stats), state), queuePanel(object(data.queue), controls),
    commandPanel(options, controls), treePanel(object(data.tree), controls),
  );
  host.querySelectorAll("details").forEach((node, i) => { node.open = opened[i] ?? false; });
}

export function showNativeActivity(host: HTMLElement, data: Wire): void {
  const opened = new Set([...host.querySelectorAll("details[open]")].map(node => node.firstElementChild?.textContent));
  const snapshot = renderNativeActivity(data);
  snapshot.setAttribute("aria-label", "原生 DAG 与子代理快照");
  host.replaceChildren(snapshot);
  snapshot.querySelectorAll("details").forEach(node => { node.open = opened.has(node.firstElementChild?.textContent); });
}

export function branchDialog(api: Api, enter: (session: Session, editorText: string, source: BranchSource) => void) {
  const modal = byId("branch-dialog", HTMLDialogElement);
  const message = byId("branch-message", HTMLSelectElement);
  const box = (id: string) => byId(id, HTMLElement);
  const btn = (id: string) => byId(id, HTMLButtonElement);
  const context = {
    web: "来源：Web 会话。新会话和原会话可分别继续。",
    history: "来源：CLI 最后保存的上下文，不修改 CLI 记录。",
    live: "来源：CLI 当前上下文。无法校验实时位置时不会改用历史记录。",
  } satisfies Record<BranchSource["kind"], string>;
  let selected: BranchSource | undefined;
  let request: AbortController | undefined;
  let pending = false;
  let canClone = false;
  let messages = new Map<string, string>();

  function render(): void {
    const disabled = pending || Boolean(request);
    const preview = messages.get(message.value);
    message.disabled = disabled || !messages.size;
    btn("branch-fork").disabled = disabled || preview === undefined;
    btn("branch-clone").disabled = disabled || !canClone;
    btn("branch-refresh").disabled = disabled;
    btn("branch-close").disabled = pending;
    notice(box("branch-message-preview"), preview);
  }

  async function load(source: BranchSource): Promise<void> {
    if (pending || request) return;
    const run = request = new AbortController();
    const status = box("branch-status");
    notice(status, "正在读取可用分支与复制选项…");
    notice(box("branch-error"));
    render();
    try {
      const data = await api.request(`${branchPath(source)}/branch-options`, undefined, run.signal);
      if (run.signal.aborted || !modal.open || selected !== source) return;
      canClone = data.canClone === true;
      messages = new Map(list(data.forkMessages).map(object).flatMap(row => {
        const id = str(row.entryId);
        return id && typeof row.text === "string" ? [[id, row.text] as const] : [];
      }));
      const previous = message.value;
      message.replaceChildren(option("选择一条用户消息", ""), ...Array.from(messages, ([id, text], i) => {
        const label = text.trim().replace(/\s+/g, " ");
        return option(`${i + 1} · ${label.slice(0, 100)}${label.length > 100 ? "…" : ""}`, id);
      }));
      if (messages.has(previous)) message.value = previous;
      notice(status, !canClone && !messages.size ? "此来源没有可分支或复制的上下文。" : "");
    } catch (error) {
      if (!run.signal.aborted && modal.open && selected === source) {
        canClone = false;
        messages.clear();
        message.replaceChildren(option("未读取到选项", ""));
        notice(status);
        notice(box("branch-error"), `无法读取分支选项：${errorText(error)}`);
      }
    } finally {
      if (request === run) request = undefined;
      render();
    }
  }

  async function submit(choice: BranchChoice): Promise<void> {
    const source = selected;
    if (!source || pending || request) return;
    pending = true;
    notice(box("branch-error"));
    notice(box("branch-status"), "正在创建独立的 Web 会话…");
    render();
    try {
      const result = await api.request(`${branchPath(source)}/branches`, choice);
      if (result.cancelled === true) {
        notice(box("branch-status"), "已取消，原会话没有修改。");
        return;
      }
      const session = parseSession(result.session);
      if (!session?.active) throw new RequestError("没有收到可继续的 Web 会话。请检查会话列表。", 502, "");
      modal.close();
      enter(session, str(result.editorText), source);
    } catch (error) {
      notice(box("branch-status"));
      notice(box("branch-error"), `无法确认新会话：${errorText(error)}`);
    } finally {
      pending = false;
      render();
    }
  }

  message.addEventListener("change", render);
  byId("branch-form", HTMLFormElement).addEventListener("submit", event => {
    event.preventDefault();
    if (!btn("branch-fork").disabled) void submit({ kind: "fork", entryId: message.value });
  });
  btn("branch-clone").addEventListener("click", () => void submit({ kind: "clone" }));
  btn("branch-close").addEventListener("click", () => modal.close());
  btn("branch-refresh").addEventListener("click", () => { if (selected) void load(selected); });
  modal.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
  modal.addEventListener("close", () => {
    if (modal.open) return;
    request?.abort();
    request = undefined;
    selected = undefined;
  });
  return (source: BranchSource): void => {
    if (modal.open) return;
    selected = source;
    canClone = false;
    messages.clear();
    message.replaceChildren(option("选择一条用户消息", ""));
    box("branch-source").textContent = source.name;
    box("branch-context").textContent = context[source.kind];
    modal.showModal();
    void load(source);
  };
}
