import { branchPath, parseSession, RequestError } from "./api.ts";
import type { Api, BranchChoice, BranchSource, Session } from "./api.ts";
import { byId, button, el, errorText, fold, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { renderNativeActivity } from "./native-activity.ts";
import { projectCacheRates, projectContextUsage } from "../runtime-metrics.ts";
import { thinkingLabels } from "./session-sidebar.ts";
import type { GenerationSpeed } from "../stream-speed.ts";

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

function appendUnreported(cell: HTMLElement): void {
  const dash = el("span", "", "—");
  dash.setAttribute("aria-hidden", "true");
  cell.append(dash, el("span", "sr-only", NO_SIGNAL));
}

function values(pairs: readonly (readonly [string, string])[], sharedUnavailable = false): HTMLElement {
  const result = el("dl", "details-list small numerical");
  for (const [label, value] of pairs) if (value) {
    const unreported = value === NO_SIGNAL || value === "未报告" || value === "已报告，无数值";
    const cell = el("dd", unreported ? "metric-unreported" : "");
    if (sharedUnavailable && value === NO_SIGNAL) appendUnreported(cell);
    else cell.textContent = value;
    result.append(el("dt", "", label), cell);
  }
  return result.childElementCount ? result : el("p", "small muted", "当前没有可用数据。");
}

function part(title: string, ...children: Node[]): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", title), ...children);
  return section;
}

function overviewFold(key: string, label: string, ...children: Node[]): HTMLDetailsElement {
  const details = fold(label, ...children);
  details.dataset.overviewDisclosure = key;
  details.querySelector("summary")?.setAttribute("data-overview-focus", key);
  return details;
}

function metricGroup(title: string, rows: readonly (readonly [string, string])[]): HTMLElement {
  const group = el("div", "metric-group stack");
  group.append(el("p", "metric-label small", title), values(rows, true));
  return group;
}

const NO_SIGNAL = "尚无数据（原生未报告）";

function formatBytes(value: unknown): string {
  const n = num(value);
  if (n === undefined) return "";
  if (n >= 1048576) return `${number.format(n / 1048576)} MB`;
  if (n >= 1024) return `${number.format(n / 1024)} KB`;
  return `${number.format(n)} B`;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "" : `${number.format(value * 100)}%`;
}

function formatTime(value: unknown): string {
  const timestamp = num(value);
  if (timestamp === undefined) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function activityContext(current: Wire, detail: Wire, stats: Wire) {
  const live = projectContextUsage(current.contextUsage);
  if (live.status === "ok" && (live.tokens !== undefined || live.window !== undefined || live.percent === 0)) return live;
  if (live.status !== "ok" && Object.hasOwn(current, "contextUsage")) return live;
  const read = projectContextUsage(detail.contextUsage);
  if (read.status === "ok") return read;
  const fallback = projectContextUsage(stats.contextUsage);
  // Older details can report a complete reading while state only carries a rounded percentage.
  // Keep that reading together rather than pairing numbers from different samples.
  if (fallback.status === "ok" && (!Object.hasOwn(current, "contextUsage") ||
    (live.status === "ok" && fallback.tokens !== undefined && fallback.window !== undefined))) return fallback;
  return live;
}

function activity(data: Wire, state: Wire, speed?: GenerationSpeed): HTMLElement {
  const stats = object(data.stats);
  const detailState = object(data.state);
  const settings = { ...detailState, ...state };
  const memory = object(data.sessionMemory);
  const model = object(settings.model);
  const tokens = object(stats.tokens ?? settings.usageTotals);
  const context = activityContext(state, detailState, stats);
  const contextTokens = context.status === "ok" ? format(context.tokens) : "";
  const contextWindow = context.status === "ok" ? format(context.window) : "";
  const contextPercent = context.status === "ok" ? format(context.percent) : "";
  const cache = projectCacheRates(settings.usageTotals);
  const latest = cache.status === "ok" ? cache.latest : undefined;
  const cumulative = cache.status === "ok" ? cache.cumulative : undefined;
  const input = num(tokens.input);
  const cacheRead = num(tokens.cacheRead);
  const cacheWrite = num(tokens.cacheWrite);
  const nonNegative = (n: number | undefined): n is number => n !== undefined && n >= 0;
  const splitInput = nonNegative(input) && nonNegative(cacheRead) && nonNegative(cacheWrite);
  const cost = num(stats.cost);
  const failures = object(stats.failures);
  const mainHeap = num(memory.mainHeapBytes);
  const kernelHeap = num(memory.kernelHeapBytes);
  const kernelCount = num(memory.kernelCount);
  const memoryKnown = mainHeap !== undefined || kernelHeap !== undefined || kernelCount !== undefined;
  const contextText = contextPercent ? (contextTokens ? `${contextTokens} (${contextPercent}%)` : `${contextPercent}%`) : contextTokens;
  const cacheText = formatRate(latest);
  const toolCalls = format(stats.toolCalls);
  const costText = cost === undefined ? "" : dollars.format(cost);
  const highlights = el("dl", "metric-highlights numerical");
  for (const [tone, label, value] of [
    ["context", "上下文已用", contextPercent ? `${contextPercent}%` : contextTokens ? `${contextTokens} token` : ""],
    ["cache", "最新缓存命中率", cacheText],
    ["tools", "工具调用", toolCalls],
    ["cost", "估算费用", costText],
  ] as const) {
    const tile = el("div", "metric-tile");
    tile.dataset.tone = tone;
    const reading = el("dd", value ? "" : "metric-unreported", value);
    if (!value) appendUnreported(reading);
    tile.append(el("dt", "", label), reading);
    highlights.append(tile);
  }
  const level = str(settings.thinkingLevel);
  const heading = el("div", "row row--between");
  const resources = el("button", "button button--quiet small", "规则与记忆");
  resources.type = "button";
  resources.id = "runtime-open-resources";
  resources.dataset.overviewFocus = "resources";
  resources.setAttribute("aria-controls", "runtime-resources");
  heading.append(el("h3", "", "运行状态与用量"), resources);
  const section = el("section", "subpanel stack stack--tight runtime-metrics");
  section.append(heading, highlights, metricGroup("会话设置", [
    ["模型", [str(model.provider), str(model.name) || str(model.id)].filter(Boolean).join(" · ") || NO_SIGNAL],
    ["生效思考档", (Object.hasOwn(thinkingLabels, level) ? thinkingLabels[level] : level) || NO_SIGNAL],
    ["快速模式", bool(settings.fastMode) || NO_SIGNAL],
    ["最近流式 · Web 观测", speed ? `${speed.tokensPerSecond < .01 ? "<0.01" : number.format(speed.tokensPerSecond)} token/s` : "未测得"],
  ]));
  const breakdown = overviewFold("metrics", "完整运行明细",
    metricGroup("上下文与缓存", [
      ["上下文已用（原生）", contextText || NO_SIGNAL],
      ["上下文窗口", contextWindow ? `${contextWindow} token` : NO_SIGNAL],
      ["缓存命中率（原生最新）", cacheText || (cache.status === "ok" ? "已报告，无数值" : NO_SIGNAL)],
      ["缓存累计命中率", formatRate(cumulative) || (cache.status === "ok" ? "已报告，无数值" : NO_SIGNAL)],
    ]),
    metricGroup("其他设置", [
      ["权限预设", str(settings.effectivePermissionPreset) || str(settings.permissionPreset) || NO_SIGNAL],
      ["自动压缩", bool(settings.autoCompactionEnabled) || NO_SIGNAL],
    ]),
    metricGroup("流量与费用", [
      ["用户消息", format(stats.userMessages)],
      ["助手消息", format(stats.assistantMessages)],
      ["工具调用", toolCalls],
      ["输入 token（含缓存）", splitInput ? format(input + cacheRead + cacheWrite) : NO_SIGNAL],
      ["未缓存输入 token", splitInput ? format(input + cacheWrite) : format(input)],
      ["输出 token", format(tokens.output)],
      ["缓存读取 token", format(tokens.cacheRead)],
      ["缓存写入 token", format(tokens.cacheWrite)],
      ["总 token", format(tokens.total ?? tokens.totalTokens)],
      ["估算费用", costText],
      ["失败请求", format(failures.erroredRequests)],
    ]),
    metricGroup("原生内存", [
      ["OmO 宿主主堆（引擎共享）", mainHeap !== undefined ? formatBytes(mainHeap) : NO_SIGNAL],
      ["本会话内核堆", kernelHeap !== undefined ? formatBytes(kernelHeap) : (memoryKnown ? "未报告" : NO_SIGNAL)],
      ["本会话内核数", kernelCount !== undefined ? format(kernelCount) : (memoryKnown ? "未报告" : NO_SIGNAL)],
    ]));
  breakdown.classList.add("metric-breakdown");
  section.append(breakdown);
  if (highlights.querySelector(".metric-unreported")) {
    highlights.after(el("p", "metric-key small", "— 表示原生未报告"));
  } else if (breakdown.querySelector(".metric-unreported [aria-hidden='true']")) {
    breakdown.querySelector(".fold-body")?.append(el("p", "metric-key small", "— 表示原生未报告"));
  }
  return section;
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
  clear.dataset.overviewFocus = "queue:clear";
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
    action.dataset.overviewFocus = `command:${syntax}`;
    const item = el("li", "stack stack--tight");
    item.append(action);
    if (str(command.description)) item.append(el("p", "small muted break", str(command.description)));
    result.append(item);
  }
  section.append(overviewFold("commands", `${commands.length} 项 · 展开后可插入输入框`, result));
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
      action.dataset.overviewFocus = `tree-node:${id}`;
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
  clear.dataset.overviewFocus = "tree:empty";
  clear.dataset.write = "";
  clear.dataset.idle = "";
  if (!leaf) clear.dataset.unavailable = "";
  const actionBar = el("div", "row");
  actionBar.append(clear);
  const body = table.childElementCount ? overviewFold("tree", "查看会话节点", el("p", "small muted", "选择历史用户消息可将其载入输入框；不会自动发送。"), table, actionBar)
    : el("p", "small muted", "没有可导航的会话节点。");
  const section = part("会话树", body);
  section.id = "runtime-tree";
  return section;
}

const todoStatusText: Readonly<Record<string, string>> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
};

const runtimeInvalidReason: Readonly<Record<string, string>> = {
  "missing-tree": "缺少会话树，快照不可读。",
  "invalid-leaf": "活动分支标识无效。",
  "unknown-leaf": "活动分支不在会话树中。",
  "duplicate-id": "会话树存在重复标识，为避免混入其他分支不显示。",
  "broken-ancestry": "分支链断裂或指向他分支，为避免混入不显示。",
  "tree-budget": "会话树超出读取上限，为避免遗漏不显示。",
};

function runtimeBranchPanel(runtime: Wire): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", "待办 · 当前活动分支"));
  if (str(runtime.status) === "invalid") {
    section.append(el("p", "small muted",
      `分支投影无效（${runtimeInvalidReason[str(runtime.reason)] ?? "未知原因"}），不显示待办，避免混入其他分支。`));
    return section;
  }
  if (str(runtime.status) !== "ok") {
    section.append(el("p", "small muted", "分支投影不可用，没有可显示的待办。"));
    return section;
  }
  const leaf = str(runtime.leafId);
  section.append(el("p", "small muted", leaf ? `活动分支：${leaf}` : "原生返回空树，无活动分支。"));
  const todo = object(runtime.todo);
  if (str(todo.status) === "ok") {
    const phases = list(todo.phases).map(object);
    const incomplete = runtime.incomplete === true;
    if (!phases.length) {
      section.append(el("p", "small muted", "当前活动分支待办为空（原生明确返回空列表）。"));
    } else {
      const items = el("ul", "inline-list");
      for (const phase of phases) {
        const entry = el("li", "stack stack--tight");
        entry.append(el("p", "plain", str(phase.name) || "待办"));
        const lines = el("ul", "inline-list");
        for (const task of list(phase.tasks).map(object)) {
          const line = el("li");
          line.append(el("p", "small break", `${todoStatusText[str(task.status)] ?? str(task.status)} · ${str(task.content)}`));
          lines.append(line);
        }
        if (lines.childElementCount) entry.append(lines);
        items.append(entry);
      }
      section.append(fold(`待办（${items.childElementCount} 组）${incomplete ? " · 内容已截断" : ""}`,
        el("p", "small muted", "只读：来自所选活动分支的最新原生记录；其他分支与原始自定义内容不在此显示。"), items));
    }
    if (incomplete && phases.length) section.append(el("p", "small muted", "待办内容超出显示上限，仅显示前面的记录。"));
  } else {
    section.append(el("p", "small muted", "当前活动分支没有待办记录（缺失不伪造成空列表或零待办）。"));
  }
  return section;
}

function branchMemory(runtime: Wire): Node[] {
  if (runtime.status !== "ok") return [el("p", "small muted", "无法确认当前分支，未显示长期记忆计数。")];
  const memory = object(runtime.memory);
  if (str(memory.status) !== "ok") {
    return [el("p", "small muted", "当前分支没有召回记录；不代表未启用长期记忆。")];
  }
  const recalled = num(memory.recalledCount);
  const recent = formatTime(memory.recentRecalledAt);
  const gate = object(memory.gate);
  const unavailable = object(memory.unavailable);
  const gateText = gate.status === "failed" || gate.status === "skipped"
    ? `${gate.status === "failed" ? "失败" : "跳过"} · 连续 ${format(gate.consecutiveFailures)} 次 · 候选 ${format(gate.candidateCount)}${formatTime(gate.at) ? ` · ${formatTime(gate.at)}` : ""}` : "";
  const unavailableCount = num(unavailable.count);
  const rows = [
    ["长期记忆召回条目（累计，仅计数）", recalled !== undefined ? format(recalled) : ""],
    ["最近召回时间", recent],
    ["召回门控", gateText],
    ["记忆不可用记录（仅计数）", unavailableCount !== undefined ? `${format(unavailableCount)}${formatTime(unavailable.at) ? ` · ${formatTime(unavailable.at)}` : ""}` : ""],
  ] as const;
  const filled = rows.filter(([, value]) => Boolean(value));
  return [
    el("p", "small muted", "仅活动分支的召回计数与状态，不含个人记忆原文、路径、提示词或宿主堆内存。"),
    filled.length ? values(filled) : el("p", "small muted", "有记忆聚合记录，但暂无可显示的数值。"),
  ];
}

export function refreshDetailsActivity(data: Wire, state: Wire, speed?: GenerationSpeed): void {
  const previous = byId("runtime-metrics", HTMLElement).querySelector(".runtime-metrics");
  if (!previous) return;
  const next = activity(data, state, speed);
  const fold = previous.querySelector("details");
  const nextFold = next.querySelector("details");
  const focused = document.activeElement;
  const focusKey = focused instanceof HTMLElement && previous.contains(focused) ? focused.dataset.overviewFocus : undefined;
  if (fold && nextFold) nextFold.open = fold.open;
  previous.replaceWith(next);
  if (focusKey) next.querySelector<HTMLElement>(`[data-overview-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

export function renderDetails(data: Wire, state: Wire, options: Wire, controls: Controls, speed?: GenerationSpeed): void {
  const metrics = byId("runtime-metrics", HTMLElement);
  const todo = byId("runtime-todo", HTMLElement);
  const focused = document.activeElement;
  const focusKey = focused instanceof HTMLElement && metrics.contains(focused) ? focused.dataset.overviewFocus : undefined;
  const openedOverview = new Set([...metrics.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.overviewDisclosure));
  metrics.replaceChildren(
    activity(data, state, speed),
    queuePanel(object(data.queue), controls), commandPanel(options, controls), treePanel(object(data.tree), controls),
  );
  const runtime = object(data.runtime);
  const branch = runtimeBranchPanel(runtime);
  const oldBranch = todo.querySelector("[data-runtime-branch]");
  const previousTodo = oldBranch?.querySelector("details");
  const nextTodo = branch.querySelector("details");
  if (previousTodo && nextTodo) nextTodo.open = previousTodo.open;
  const focusTodo = previousTodo?.querySelector("summary") === focused;
  branch.dataset.runtimeBranch = "";
  if (oldBranch) oldBranch.replaceWith(branch);
  else todo.prepend(branch);
  byId("runtime-memory-branch-content", HTMLElement).replaceChildren(...branchMemory(runtime));
  if (focusTodo) (nextTodo?.querySelector("summary") ?? todo).focus({ preventScroll: true });
  metrics.querySelectorAll<HTMLDetailsElement>("details[data-overview-disclosure]").forEach(node => {
    node.open = openedOverview.has(node.dataset.overviewDisclosure);
  });
  if (focusKey !== undefined) {
    const next = metrics.querySelector<HTMLElement>(`[data-overview-focus="${CSS.escape(focusKey)}"]:not(:disabled)`);
    (next?.getClientRects().length ? next : metrics).focus({ preventScroll: true });
  }
}

export function showNativeActivity(host: HTMLElement, data: Wire): void {
  const opened = new Set([...host.querySelectorAll("details[open]")].map(node => node.firstElementChild?.textContent));
  const snapshot = renderNativeActivity(data);
  snapshot.querySelectorAll("details").forEach(node => { node.open = opened.has(node.firstElementChild?.textContent); });
  const panels = host.querySelectorAll('[role="tabpanel"]');
  if (!panels.length) {
    for (const section of snapshot.children) section.removeAttribute("id");
    host.replaceChildren(snapshot);
  }
  for (const panel of panels) {
    const section = [...snapshot.children].find(child => child.id === panel.id);
    if (!section) continue;
    section.removeAttribute("id");
    section.removeAttribute("tabindex");
    panel.replaceChildren(section);
  }
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
