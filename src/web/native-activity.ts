import { el, fold, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

const states: Readonly<Record<string, string>> = {
  pending: "等待中",
  queued: "排队中",
  scheduled: "已调度",
  blocked: "被依赖阻塞",
  paused: "已暂停",
  running: "运行中",
  completed: "已完成",
  done: "已完成",
  success: "成功",
  failed: "失败",
  error: "出错",
  cancelled: "已取消",
  skipped: "已跳过",
  interrupted: "已中断",
  lost: "已失联",
};

const stateText = (value: string): string => states[value] ?? value;

function timeText(value: unknown): string {
  const timestamp = num(value);
  if (timestamp === undefined) return "未知时间";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false });
}

function durationText(startedAt: unknown, completedAt: unknown): string {
  const start = num(startedAt);
  const end = num(completedAt);
  if (start === undefined || end === undefined || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function values(pairs: readonly (readonly [string, string])[]): HTMLElement {
  const result = el("dl", "details-list small numerical");
  for (const [label, value] of pairs) if (value) result.append(el("dt", "", label), el("dd", "", value));
  return result.childElementCount ? result : el("p", "small muted", "当前没有可用数据。");
}

function renderRun(run: Wire, tasks: ReadonlyMap<string, Wire>): HTMLElement {
  const nodes = list(run.nodes).map(object);
  const edges = list(run.edges).map(object);
  const describeTask = (taskId: string): string => {
    if (!taskId) return "";
    const task = tasks.get(taskId);
    if (!task) return `子任务 ${taskId}`;
    const description = str(task.description);
    return description ? `${description}（${taskId}）` : `子任务 ${taskId}`;
  };
  const body: Node[] = [];
  if (nodes.length) {
    body.push(values(nodes.map((node): readonly [string, string] => {
      const taskId = str(object(node).taskId);
      const upstream = list(object(node).upstream).map(str).filter(Boolean);
      return [str(object(node).label) || str(object(node).id) || "节点", [
        `${stateText(str(object(node).state))}`,
        `尝试 ${num(object(node).attempt) ?? 0} 次`,
        taskId ? `关联：${describeTask(taskId)}` : "",
        upstream.length ? `上游：${upstream.join("、")}` : "",
      ].filter(Boolean).join(" · ")];
    })));
  } else {
    body.push(el("p", "small muted", "这次运行还没有节点记录。"));
  }
  if (edges.length) {
    const items = el("ul", "inline-list");
    for (const edge of edges) {
      const from = str(edge.fromLabel) || str(edge.from);
      const to = str(edge.toLabel) || str(edge.to);
      if (from && to) {
        const item = el("li", "stack stack--tight");
        item.append(el("p", "plain", `${from} → ${to}`));
        items.append(item);
      }
    }
    if (items.childElementCount) body.push(fold(`依赖边（${items.childElementCount}）`, items));
  }
  return fold(`${str(run.name) || "运行"} · ${stateText(str(run.status))}`, ...body);
}

function renderTasks(tasks: readonly Wire[]): HTMLElement {
  const items = el("ul", "inline-list");
  for (const raw of tasks) {
    const task = object(raw);
    const timing = [timeText(task.startedAt), task.completedAt === undefined ? "" : timeText(task.completedAt)]
      .filter(value => value && value !== "未知时间");
    const duration = durationText(task.startedAt, task.completedAt);
    const item = el("li", "stack stack--tight");
    item.append(el("p", "plain", str(task.description) || "子任务"));
    item.append(el("p", "small muted break", [
      str(task.id) ? `任务 ID：${str(task.id)}` : "",
      str(task.parentTaskId) ? `父任务：${str(task.parentTaskId)}` : "",
      str(task.agent) ? `智能体：${str(task.agent)}` : "",
      str(task.model) ? `模型：${str(task.model)}` : "",
      str(task.status) ? `状态：${stateText(str(task.status))}` : "",
      timing.length ? `时间：${timing.join(" → ")}${duration ? `（耗时 ${duration}）` : ""}` : "",
      num(task.turns) !== undefined ? `轮次：${num(task.turns)}` : "",
      num(task.toolCalls) !== undefined ? `工具调用：${num(task.toolCalls)}` : "",
    ].filter(Boolean).join(" · ")));
    items.append(item);
  }
  return fold(`子任务（${items.childElementCount}）`, items);
}

export function renderNativeActivity(data: Wire): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", "原生任务"));
  if (str(data.status) !== "ok") {
    section.append(el("p", "small muted", "原生任务快照不可用，没有可显示的原生任务。"));
    return section;
  }
  const snapshot = [
    `快照时间：${timeText(data.updatedAt)}`,
    data.connected === undefined ? "工作区记录，非实时" : `Herdr 快照，记录时${data.connected === true ? "已连接" : "未连接"}，非实时`,
  ].join(" · ");
  section.append(el("p", "small muted", snapshot));
  const runs = list(data.runs).map(object);
  const tasks = list(data.tasks).map(object);
  if (!runs.length && !tasks.length) section.append(el("p", "small muted", "快照中没有运行或任务记录。"));
  const known = new Map(tasks.map(task => [str(task.id), task]));
  for (const run of runs) section.append(renderRun(run, known));
  if (tasks.length) section.append(renderTasks(tasks));
  return section;
}
