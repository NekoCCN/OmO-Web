import { button, el, fold, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

type Controls = {
  readonly canWrite: boolean;
  readonly canNavigate: boolean;
  readonly queueCount?: number;
  readonly refresh: () => void;
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
  const commands = list(options.commands).map(object).filter(command => Boolean(str(command.name)));
  const section = part("可用命令");
  if (!commands.length) {
    section.append(el("p", "muted small", "未读取到可用命令。"));
    return section;
  }
  const result = el("ul", "command-list");
  for (const command of commands) {
    const name = str(command.name);
    const syntax = name.startsWith("/") || name.startsWith("$") ? name : `/${name}`;
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
  const actions = el("div", "row");
  const refresh = button("刷新详情", controls.refresh);
  actions.append(refresh);
  host.replaceChildren(
    actions, activity(object(data.stats), state), queuePanel(object(data.queue), controls),
    commandPanel(options, controls), treePanel(object(data.tree), controls),
  );
  host.querySelectorAll("details").forEach((node, i) => { node.open = opened[i] ?? false; });
}
