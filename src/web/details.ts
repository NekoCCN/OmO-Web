import { branchPath, parseSession, RequestError } from "./api.ts";
import type { Api, BranchChoice, BranchSource, Session } from "./api.ts";
import { byId, button, el, errorText, fold, list, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { renderNativeActivity } from "./native-activity.ts";
import { projectCacheRates, projectContextUsage } from "../runtime-metrics.ts";
import { thinkingLabels } from "./session-sidebar.ts";
import type { GenerationSpeed } from "../stream-speed.ts";
import { tr, uiLocale } from "./locale.ts";

type Controls = {
  readonly canWrite: boolean;
  readonly canNavigate: boolean;
  readonly queueCount?: number;
  readonly clearQueue: () => void;
  readonly navigate: (id: string | null) => void;
  readonly insertCommand: (value: string) => void;
};

const number = new Intl.NumberFormat(uiLocale, { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat(uiLocale, { style: "currency", currency: "USD", maximumFractionDigits: 5 });
const format = (value: unknown): string => {
  const n = num(value);
  return n === undefined ? "" : number.format(n);
};
const bool = (value: unknown): string => typeof value === "boolean" ? value ? tr("开启", "On") : tr("关闭", "Off") : "";

function appendUnreported(cell: HTMLElement): void {
  const dash = el("span", "", "—");
  dash.setAttribute("aria-hidden", "true");
  cell.append(dash, el("span", "sr-only", NO_SIGNAL));
}

function values(pairs: readonly (readonly [string, string])[], sharedUnavailable = false): HTMLElement {
  const result = el("dl", "details-list small numerical");
  for (const [label, value] of pairs) if (value) {
    const unreported = value === NO_SIGNAL || value === NOT_REPORTED || value === NO_NUMBER;
    const cell = el("dd", unreported ? "metric-unreported" : "");
    if (sharedUnavailable && value === NO_SIGNAL) appendUnreported(cell);
    else cell.textContent = value;
    result.append(el("dt", "", label), cell);
  }
  return result.childElementCount ? result : el("p", "small muted", tr("当前没有可用数据。", "No data available."));
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

const NO_SIGNAL = tr("尚无数据（原生未报告）", "Not reported by the native host");
const NOT_REPORTED = tr("未报告", "Not reported");
const NO_NUMBER = tr("已报告，无数值", "Reported without a value");
const NO_SIGNAL_KEY = tr("— 表示原生未报告", "— means the native host did not report a value");

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
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(uiLocale, { hour12: false });
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
    ["context", tr("上下文已用", "Context used"), contextPercent ? `${contextPercent}%` : contextTokens ? tr(`${contextTokens} token`, `${contextTokens} tokens`) : ""],
    ["cache", tr("最新缓存命中率", "Latest cache hit rate"), cacheText],
    ["tools", tr("工具调用", "Tool calls"), toolCalls],
    ["cost", tr("估算费用", "Estimated cost"), costText],
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
  const resources = el("button", "button button--quiet small", tr("规则与记忆", "Rules and memory"));
  resources.type = "button";
  resources.id = "runtime-open-resources";
  resources.dataset.overviewFocus = "resources";
  resources.setAttribute("aria-controls", "runtime-resources");
  heading.append(el("h3", "", tr("运行状态与用量", "Runtime and usage")), resources);
  const section = el("section", "subpanel stack stack--tight runtime-metrics");
  section.append(heading, highlights, metricGroup(tr("会话设置", "Session settings"), [
    [tr("模型", "Model"), [str(model.provider), str(model.name) || str(model.id)].filter(Boolean).join(" · ") || NO_SIGNAL],
    [tr("生效思考档", "Active thinking level"), (Object.hasOwn(thinkingLabels, level) ? thinkingLabels[level] : level) || NO_SIGNAL],
    [tr("快速模式", "Fast mode"), bool(settings.fastMode) || NO_SIGNAL],
    [tr("最近流式 · Web 观测", "Latest streaming speed (Web)"), speed ? `${speed.tokensPerSecond < .01 ? `<${number.format(.01)}` : number.format(speed.tokensPerSecond)} token/s` : tr("未测得", "Not measured")],
  ]));
  const breakdown = overviewFold("metrics", tr("完整运行明细", "Full runtime details"),
    metricGroup(tr("上下文与缓存", "Context and cache"), [
      [tr("上下文已用（原生）", "Context used (native)"), contextText || NO_SIGNAL],
      [tr("上下文窗口", "Context window"), contextWindow ? tr(`${contextWindow} token`, `${contextWindow} tokens`) : NO_SIGNAL],
      [tr("缓存命中率（原生最新）", "Latest cache hit rate (native)"), cacheText || (cache.status === "ok" ? NO_NUMBER : NO_SIGNAL)],
      [tr("缓存累计命中率", "Cumulative cache hit rate"), formatRate(cumulative) || (cache.status === "ok" ? NO_NUMBER : NO_SIGNAL)],
    ]),
    metricGroup(tr("其他设置", "Other settings"), [
      [tr("权限预设", "Permission preset"), str(settings.effectivePermissionPreset) || str(settings.permissionPreset) || NO_SIGNAL],
      [tr("自动压缩", "Auto-compaction"), bool(settings.autoCompactionEnabled) || NO_SIGNAL],
    ]),
    metricGroup(tr("流量与费用", "Usage and cost"), [
      [tr("用户消息", "User messages"), format(stats.userMessages)],
      [tr("助手消息", "Assistant messages"), format(stats.assistantMessages)],
      [tr("工具调用", "Tool calls"), toolCalls],
      [tr("输入 token（含缓存）", "Input tokens (including cache)"), splitInput ? format(input + cacheRead + cacheWrite) : NO_SIGNAL],
      [tr("未缓存输入 token", "Uncached input tokens"), splitInput ? format(input + cacheWrite) : format(input)],
      [tr("输出 token", "Output tokens"), format(tokens.output)],
      [tr("缓存读取 token", "Cache read tokens"), format(tokens.cacheRead)],
      [tr("缓存写入 token", "Cache write tokens"), format(tokens.cacheWrite)],
      [tr("总 token", "Total tokens"), format(tokens.total ?? tokens.totalTokens)],
      [tr("估算费用", "Estimated cost"), costText],
      [tr("失败请求", "Failed requests"), format(failures.erroredRequests)],
    ]),
    metricGroup(tr("原生内存", "Native memory"), [
      [tr("OmO 宿主主堆（引擎共享）", "OmO host heap (shared by the engine)"), mainHeap !== undefined ? formatBytes(mainHeap) : NO_SIGNAL],
      [tr("本会话内核堆", "Session kernel heap"), kernelHeap !== undefined ? formatBytes(kernelHeap) : (memoryKnown ? NOT_REPORTED : NO_SIGNAL)],
      [tr("本会话内核数", "Session kernel count"), kernelCount !== undefined ? format(kernelCount) : (memoryKnown ? NOT_REPORTED : NO_SIGNAL)],
    ]));
  breakdown.classList.add("metric-breakdown");
  section.append(breakdown);
  if (highlights.querySelector(".metric-unreported")) {
    highlights.after(el("p", "metric-key small", NO_SIGNAL_KEY));
  } else if (breakdown.querySelector(".metric-unreported [aria-hidden='true']")) {
    breakdown.querySelector(".fold-body")?.append(el("p", "metric-key small", NO_SIGNAL_KEY));
  }
  return section;
}

function queuePanel(queue: Wire, controls: Controls): HTMLElement {
  const active = new Set(["held", "queued", "sending", "pending", "accepted"]);
  const inputs = list(queue.inputs).map(object).filter(item => !item.state || active.has(str(item.state)));
  const items = el("ul", "inline-list");
  for (const input of inputs) {
    const mode = str(input.requestedMode);
    const state = ({ queued: tr("排队中", "Queued"), sending: tr("正在发送", "Sending"), held: tr("等待中", "Waiting"),
      pending: tr("等待中", "Waiting"), accepted: tr("已接收", "Accepted") })[str(input.state)] || "";
    const label = [mode === "steer" ? tr("引导", "Steer") : mode === "followUp" || mode === "follow_up" ? tr("后续", "Follow-up") : "", state].filter(Boolean).join(" · ");
    const entry = el("li", "stack stack--tight");
    if (label) entry.append(el("span", "small muted", label));
    entry.append(el("p", "plain", str(input.text) || tr("（无文本）", "(No text)")));
    items.append(entry);
  }
  const clear = button(tr("清空队列", "Clear queue"), controls.clearQueue, "button--danger");
  clear.disabled = !controls.canWrite || !((controls.queueCount ?? 0) > 0 || inputs.length > 0);
  clear.dataset.overviewFocus = "queue:clear";
  clear.dataset.write = "";
  if (clear.disabled && controls.canWrite) clear.dataset.unavailable = "";
  const actions = el("div", "row");
  actions.append(clear);
  const count = controls.queueCount ?? inputs.length;
  return part(tr("输入队列", "Input queue"), el("p", "small muted", count
    ? tr(`${number.format(count)} 条待处理输入`, `${number.format(count)} pending ${count === 1 ? "input" : "inputs"}`)
    : tr("没有排队的输入。", "No queued inputs.")), ...(inputs.length ? [items] : []), actions);
}

function commandPanel(options: Wire, controls: Controls): HTMLElement {
  const commands = list(options.commands).map(object).filter(command => Boolean(str(command.invocation)));
  const section = part(tr("可用命令", "Available commands"));
  if (!commands.length) {
    section.append(el("p", "muted small", tr("未读取到可用命令。", "No commands were returned.")));
    return section;
  }
  const result = el("ul", "command-list");
  for (const command of commands) {
    const syntax = str(command.invocation);
    const action = button(syntax, () => controls.insertCommand(syntax), "button--quiet path");
    action.title = tr("插入输入框，不会立即发送", "Insert in the input box without sending");
    action.setAttribute("aria-label", tr(`插入命令：${syntax}`, `Insert command: ${syntax}`));
    action.dataset.overviewFocus = `command:${syntax}`;
    const item = el("li", "stack stack--tight");
    item.append(action);
    if (str(command.description)) item.append(el("p", "small muted break", str(command.description)));
    result.append(item);
  }
  section.append(overviewFold("commands", tr(`${number.format(commands.length)} 项 · 展开后可插入输入框`,
    `${number.format(commands.length)} ${commands.length === 1 ? "command" : "commands"} · Expand to insert`), result));
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
    user: tr("你", "You"), assistant: tr("助手", "Assistant"), toolResult: tr("工具结果", "Tool result"),
    bashExecution: tr("命令输出", "Command output"), message: tr("消息", "Message"), compaction: tr("上下文压缩", "Context compaction"),
    branch_summary: tr("分支摘要", "Branch summary"), model_change: tr("模型变更", "Model change"),
    thinking_level_change: tr("思考档变更", "Thinking level change"), custom: tr("会话记录", "Session entry"), session_info: tr("会话信息", "Session info"),
  };
  const id = str(entry.id);
  const name = Object.hasOwn(titles, role || type) ? titles[role || type] : role || type || tr("节点", "Node");
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
  const clear = button(tr("切换到空上下文", "Switch to an empty context"), () => controls.navigate(null));
  clear.disabled = !controls.canNavigate || !leaf;
  clear.dataset.overviewFocus = "tree:empty";
  clear.dataset.write = "";
  clear.dataset.idle = "";
  if (!leaf) clear.dataset.unavailable = "";
  const actionBar = el("div", "row");
  actionBar.append(clear);
  const body = table.childElementCount ? overviewFold("tree", tr("查看会话节点", "View session nodes"), el("p", "small muted",
    tr("选择历史用户消息可将其载入输入框；不会自动发送。", "Select a past user message to load it into the input box without sending it.")), table, actionBar)
    : el("p", "small muted", tr("没有可导航的会话节点。", "No session nodes to navigate."));
  const section = part(tr("会话树", "Session tree"), body);
  section.id = "runtime-tree";
  return section;
}

const todoStatusText: Readonly<Record<string, string>> = {
  pending: tr("待办", "Pending"),
  in_progress: tr("进行中", "In progress"),
  completed: tr("已完成", "Completed"),
  abandoned: tr("已放弃", "Abandoned"),
};

const runtimeInvalidReason: Readonly<Record<string, string>> = {
  "missing-tree": tr("快照缺少会话树", "The snapshot has no session tree."),
  "invalid-leaf": tr("活动分支标识无效", "The active branch ID is invalid."),
  "unknown-leaf": tr("活动分支不在会话树中", "The active branch is not in the session tree."),
  "duplicate-id": tr("会话树有重复标识", "The session tree contains duplicate IDs."),
  "broken-ancestry": tr("分支链断裂或指向其他分支", "The branch chain is broken or points to another branch."),
  "tree-budget": tr("会话树超出读取上限，可能不完整", "The session tree exceeds the read limit and may be incomplete."),
};

function runtimeBranchPanel(runtime: Wire): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", tr("待办 · 当前活动分支", "Todo · Active branch")));
  if (str(runtime.status) === "invalid") {
    const reason = runtimeInvalidReason[str(runtime.reason)] ?? tr("未知原因", "Unknown reason.");
    section.append(el("p", "small muted", tr(`无法确认活动分支（${reason}），不显示待办，以免混入其他分支。`,
      `Could not verify the active branch. ${reason} Todo is hidden to avoid showing another branch’s tasks.`)));
    return section;
  }
  if (str(runtime.status) !== "ok") {
    section.append(el("p", "small muted", tr("分支投影不可用，没有可显示的待办。", "Branch data is unavailable, so Todo cannot be shown.")));
    return section;
  }
  const leaf = str(runtime.leafId);
  section.append(el("p", "small muted", leaf ? tr(`活动分支：${leaf}`, `Active branch: ${leaf}`) : tr("原生返回空树，无活动分支。", "The native host returned an empty tree. No branch is active.")));
  const todo = object(runtime.todo);
  if (str(todo.status) === "ok") {
    const phases = list(todo.phases).map(object);
    const incomplete = runtime.incomplete === true;
    if (!phases.length) {
      section.append(el("p", "small muted", tr("当前活动分支待办为空（原生明确返回空列表）。", "The native host returned an empty Todo list for the active branch.")));
    } else {
      const items = el("ul", "inline-list");
      for (const phase of phases) {
        const entry = el("li", "stack stack--tight");
        entry.append(el("p", "plain", str(phase.name) || tr("待办", "Todo")));
        const lines = el("ul", "inline-list");
        for (const task of list(phase.tasks).map(object)) {
          const line = el("li");
          line.append(el("p", "small break", `${todoStatusText[str(task.status)] ?? str(task.status)} · ${str(task.content)}`));
          lines.append(line);
        }
        if (lines.childElementCount) entry.append(lines);
        items.append(entry);
      }
      const groups = items.childElementCount;
      section.append(fold(tr(`待办（${number.format(groups)} 组）${incomplete ? " · 内容已截断" : ""}`,
        `Todo (${number.format(groups)} ${groups === 1 ? "group" : "groups"})${incomplete ? " · Truncated" : ""}`),
        el("p", "small muted", tr("只读：来自所选活动分支的最新原生记录；其他分支与原始自定义内容不在此显示。",
          "Read-only. Shows the latest native record for the selected branch. Other branches and raw custom entries are not shown.")), items));
    }
    if (incomplete && phases.length) section.append(el("p", "small muted", tr("待办内容超出显示上限，仅显示前面的记录。", "The Todo list exceeds the display limit. Only the first entries are shown.")));
  } else {
    section.append(el("p", "small muted", tr("当前分支未报告待办，数量未知。", "No Todo record was reported for the active branch. The task count is unknown.")));
  }
  return section;
}

function branchMemory(runtime: Wire): Node[] {
  if (runtime.status !== "ok") return [el("p", "small muted", tr("无法确认当前分支，未显示长期记忆计数。", "Could not verify the active branch, so long-term memory counts are hidden."))];
  const memory = object(runtime.memory);
  if (str(memory.status) !== "ok") {
    return [el("p", "small muted", tr("当前分支没有召回记录；不代表未启用长期记忆。", "No recall record for this branch. Long-term memory may still be enabled."))];
  }
  const recalled = num(memory.recalledCount);
  const recent = formatTime(memory.recentRecalledAt);
  const gate = object(memory.gate);
  const unavailable = object(memory.unavailable);
  const gateText = gate.status === "failed" || gate.status === "skipped"
    ? tr(`${gate.status === "failed" ? "失败" : "跳过"} · 连续 ${format(gate.consecutiveFailures)} 次 · 候选 ${format(gate.candidateCount)}${formatTime(gate.at) ? ` · ${formatTime(gate.at)}` : ""}`,
      `${gate.status === "failed" ? "Failed" : "Skipped"} · Consecutive failures: ${format(gate.consecutiveFailures)} · Candidates: ${format(gate.candidateCount)}${formatTime(gate.at) ? ` · ${formatTime(gate.at)}` : ""}`) : "";
  const unavailableCount = num(unavailable.count);
  const rows = [
    [tr("长期记忆召回条目（累计，仅计数）", "Long-term memory recalls (total count)"), recalled !== undefined ? format(recalled) : ""],
    [tr("最近召回时间", "Last recall"), recent],
    [tr("召回门控", "Recall gate"), gateText],
    [tr("记忆不可用记录（仅计数）", "Memory unavailability records (count only)"), unavailableCount !== undefined ? `${format(unavailableCount)}${formatTime(unavailable.at) ? ` · ${formatTime(unavailable.at)}` : ""}` : ""],
  ] as const;
  const filled = rows.filter(([, value]) => Boolean(value));
  return [
    el("p", "small muted", tr("仅活动分支的召回计数与状态，不含个人记忆原文、路径、提示词或宿主堆内存。",
      "Recall counts and status for the active branch only. Personal memory text, paths, prompts, and host heap data are not shown.")),
    filled.length ? values(filled) : el("p", "small muted", tr("有记忆聚合记录，但暂无可显示的数值。", "Memory records exist, but there are no values to show.")),
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
    web: tr("来源：Web 会话。新会话和原会话可分别继续。", "Source: Web session. You can continue the original and the new session separately."),
    history: tr("来源：CLI 最后保存的上下文，不修改 CLI 记录。", "Source: Last saved CLI context. The CLI record will not change."),
    live: tr("来源：CLI 当前上下文。无法校验实时位置时不会改用历史记录。", "Source: Current CLI context. If the live position cannot be verified, history will not be used instead."),
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
    notice(status, tr("正在读取可用分支与复制选项…", "Loading branch and clone options…"));
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
      message.replaceChildren(option(tr("选择一条用户消息", "Choose a user message"), ""), ...Array.from(messages, ([id, text], i) => {
        const label = text.trim().replace(/\s+/g, " ");
        return option(`${number.format(i + 1)} · ${label.slice(0, 100)}${label.length > 100 ? "…" : ""}`, id);
      }));
      if (messages.has(previous)) message.value = previous;
      notice(status, !canClone && !messages.size ? tr("此来源没有可分支或复制的上下文。", "This source has no context to branch or clone.") : "");
    } catch (error) {
      if (!run.signal.aborted && modal.open && selected === source) {
        canClone = false;
        messages.clear();
        message.replaceChildren(option(tr("未读取到选项", "No options loaded"), ""));
        notice(status);
        notice(box("branch-error"), tr(`无法读取分支选项：${errorText(error)}`, `Could not load branch options: ${errorText(error)}`));
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
    notice(box("branch-status"), tr("正在创建独立的 Web 会话…", "Creating a separate Web session…"));
    render();
    try {
      const result = await api.request(`${branchPath(source)}/branches`, choice);
      if (result.cancelled === true) {
        notice(box("branch-status"), tr("已取消，原会话没有修改。", "Canceled. The original session did not change."));
        return;
      }
      const session = parseSession(result.session);
      if (!session?.active) throw new RequestError(tr("没有收到可继续的 Web 会话。请检查会话列表。", "No active Web session was returned. Check the session list."), 502, "");
      modal.close();
      enter(session, str(result.editorText), source);
    } catch (error) {
      notice(box("branch-status"));
      notice(box("branch-error"), tr(`无法确认新会话：${errorText(error)}`, `Could not confirm the new session: ${errorText(error)}`));
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
    message.replaceChildren(option(tr("选择一条用户消息", "Choose a user message"), ""));
    box("branch-source").textContent = source.name;
    box("branch-context").textContent = context[source.kind];
    modal.showModal();
    void load(source);
  };
}
