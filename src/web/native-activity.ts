import { el, fold, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";

const states: Readonly<Record<string, string>> = {
  pending: tr("等待中", "Pending"),
  queued: tr("排队中", "Queued"),
  scheduled: tr("已调度", "Scheduled"),
  blocked: tr("被依赖阻塞", "Blocked by dependencies"),
  paused: tr("已暂停", "Paused"),
  running: tr("运行中", "Running"),
  completed: tr("已完成", "Completed"),
  done: tr("已完成", "Completed"),
  success: tr("成功", "Succeeded"),
  failed: tr("失败", "Failed"),
  error: tr("出错", "Error"),
  cancelled: tr("已取消", "Canceled"),
  skipped: tr("已跳过", "Skipped"),
  interrupted: tr("已中断", "Interrupted"),
  lost: tr("已失联", "Lost contact"),
};
const unknownTime = tr("未知时间", "Unknown time");
const number = new Intl.NumberFormat(uiLocale);

export const knownActivityState = (value: string): string | undefined => Object.hasOwn(states, value) ? states[value] : undefined;
const stateText = (value: string): string => knownActivityState(value) ?? value;

export function timeText(value: unknown): string {
  const timestamp = num(value);
  if (timestamp === undefined) return unknownTime;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? unknownTime : date.toLocaleString(uiLocale, { hour12: false });
}

function durationText(startedAt: unknown, completedAt: unknown): string {
  const start = num(startedAt);
  const end = num(completedAt);
  if (start === undefined || end === undefined || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return tr(`${number.format(seconds)} 秒`, `${number.format(seconds)} sec`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tr(`${number.format(minutes)} 分钟`, `${number.format(minutes)} min`);
  const hours = number.format(Math.floor(minutes / 60));
  const remainder = number.format(minutes % 60);
  return tr(`${hours} 小时 ${remainder} 分钟`, `${hours} hr ${remainder} min`);
}

function values(pairs: readonly (readonly [string, string])[]): HTMLElement {
  const result = el("dl", "details-list small numerical");
  for (const [label, value] of pairs) if (value) result.append(el("dt", "", label), el("dd", "", value));
  return result.childElementCount ? result : el("p", "small muted", tr("当前没有可用数据。", "No data available."));
}

function renderRun(run: Wire, tasks: ReadonlyMap<string, Wire>): HTMLElement {
  const nodes = list(run.nodes).map(object);
  const edges = list(run.edges).map(object);
  const describeTask = (taskId: string): string => {
    if (!taskId) return "";
    const task = tasks.get(taskId);
    const description = task ? str(task.description) : "";
    return description ? tr(`${description}（${taskId}）`, `${description} (${taskId})`) : tr(`子任务 ${taskId}`, `Subtask ${taskId}`);
  };
  const body: Node[] = [];
  if (nodes.length) {
    body.push(values(nodes.map((node): readonly [string, string] => {
      const taskId = str(object(node).taskId);
      const upstream = list(object(node).upstream).map(str).filter(Boolean);
      const attempt = number.format(num(object(node).attempt) ?? 0);
      return [str(object(node).label) || str(object(node).id) || tr("节点", "Node"), [
        `${stateText(str(object(node).state))}`,
        tr(`尝试 ${attempt} 次`, `Attempts: ${attempt}`),
        taskId ? tr(`关联：${describeTask(taskId)}`, `Task: ${describeTask(taskId)}`) : "",
        upstream.length ? tr(`上游：${upstream.join("、")}`, `Upstream: ${upstream.join(", ")}`) : "",
      ].filter(Boolean).join(" · ")];
    })));
  } else {
    body.push(el("p", "small muted", tr("这次运行还没有节点记录。", "No nodes were recorded for this run.")));
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
    if (items.childElementCount) body.push(fold(tr(`依赖边（${number.format(items.childElementCount)}）`, `Dependencies (${number.format(items.childElementCount)})`), items));
  }
  return fold(`${str(run.name) || tr("运行", "Run")} · ${stateText(str(run.status))}`, ...body);
}

function renderTasks(tasks: readonly Wire[]): HTMLElement {
  const items = el("ul", "inline-list");
  for (const raw of tasks) {
    const task = object(raw);
    const timing = [timeText(task.startedAt), task.completedAt === undefined ? "" : timeText(task.completedAt)]
      .filter(value => value && value !== unknownTime);
    const duration = durationText(task.startedAt, task.completedAt);
    const turns = num(task.turns);
    const calls = num(task.toolCalls);
    const item = el("li", "stack stack--tight");
    item.append(el("p", "plain", str(task.description) || tr("子任务", "Subtask")));
    item.append(el("p", "small muted break", [
      str(task.id) ? tr(`任务 ID：${str(task.id)}`, `Task ID: ${str(task.id)}`) : "",
      str(task.parentTaskId) ? tr(`父任务：${str(task.parentTaskId)}`, `Parent task: ${str(task.parentTaskId)}`) : "",
      str(task.agent) ? tr(`智能体：${str(task.agent)}`, `Agent: ${str(task.agent)}`) : "",
      str(task.model) ? tr(`模型：${str(task.model)}`, `Model: ${str(task.model)}`) : "",
      str(task.status) ? tr(`状态：${stateText(str(task.status))}`, `Status: ${stateText(str(task.status))}`) : "",
      timing.length ? tr(`时间：${timing.join(" → ")}${duration ? `（耗时 ${duration}）` : ""}`,
        `Time: ${timing.join(" → ")}${duration ? ` (${duration} elapsed)` : ""}`) : "",
      turns !== undefined ? tr(`轮次：${number.format(turns)}`, `Turns: ${number.format(turns)}`) : "",
      calls !== undefined ? tr(`工具调用：${number.format(calls)}`, `Tool calls: ${number.format(calls)}`) : "",
    ].filter(Boolean).join(" · ")));
    items.append(item);
  }
  return fold(tr(`子任务（${number.format(items.childElementCount)}）`, `Subtasks (${number.format(items.childElementCount)})`), items);
}

const unavailableReason: Readonly<Record<string, string>> = {
  "no-agent-dir": tr("原生任务快照不可用：未配置原生配置目录，快照入口已关闭。", "Native task snapshots are disabled because no native configuration directory is set."),
  "invalid-id": tr("原生任务快照不可用：会话标识无效，无法定位快照。", "Could not locate the native task snapshot: the session ID is invalid."),
  "session-unavailable": tr("原生任务快照不可用：会话尚未接入引擎，请先恢复会话。", "Resume the session to connect it to the engine before reading its native task snapshot."),
  "missing-projection": tr("原生任务快照不可用：原生暂无此会话的任务快照，并非读取失败。", "The native host has no task snapshot for this session. The read did not fail."),
};

export function renderNativeActivity(data: Wire): HTMLElement {
  const result = el("div", "stack stack--tight");
  const section = el("section", "subpanel stack stack--tight");
  const subtasks = el("section", "subpanel stack stack--tight");
  section.id = "runtime-dag";
  section.tabIndex = -1;
  subtasks.id = "runtime-subagent";
  subtasks.tabIndex = -1;
  section.append(el("h3", "", tr("DAG 快照", "DAG snapshot")));
  subtasks.append(el("h3", "", tr("子代理", "Subagents")));
  result.append(subtasks, section);
  if (str(data.status) !== "ok") {
    const reason = str(data.reason);
    const message = unavailableReason[reason] ?? tr("原生任务快照不可用。", "Native task snapshot unavailable.");
    section.append(el("p", "small muted", message));
    subtasks.append(el("p", "small muted", message));
    return result;
  }
  const snapshot = [
    tr(`快照时间：${timeText(data.updatedAt)}`, `Snapshot time: ${timeText(data.updatedAt)}`),
    data.connected === undefined ? tr("工作区记录，非实时", "Workspace record · Not live")
      : tr(`Herdr 快照，记录时${data.connected === true ? "已连接" : "未连接"}，非实时`,
        `Herdr snapshot · ${data.connected === true ? "Connected" : "Not connected"} at capture · Not live`),
  ].join(" · ");
  section.append(el("p", "small muted", snapshot));
  subtasks.append(el("p", "small muted", snapshot));
  const runs = list(data.runs).map(object);
  const tasks = list(data.tasks).map(object);
  if (!runs.length) section.append(el("p", "small muted", tr("快照中没有 DAG 记录。", "No DAG runs in this snapshot.")));
  const known = new Map(tasks.map(task => [str(task.id), task]));
  for (const run of runs) section.append(renderRun(run, known));
  if (tasks.length) subtasks.append(renderTasks(tasks));
  else subtasks.append(el("p", "small muted", tr("快照中没有子代理记录。", "No subagents in this snapshot.")));
  return result;
}
