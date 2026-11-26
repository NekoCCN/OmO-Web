import { el, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { knownActivityState, timeText } from "./native-activity.ts";

const unavailable = new Map([
  ["inactive", "会话尚未接入，或正在交接。"],
  ["binding_unverified", "无法验证当前会话的宿主绑定。"],
  ["unsupported", "当前宿主或连接方式不支持此读取。"],
  ["native_unavailable", "宿主未能提供摘要。"],
  ["engine_unavailable", "宿主连接忙碌、已断开或读取超时。"],
  ["web_unsupported", "当前 Web 服务没有实时摘要入口。"],
  ["read_refused", "Web 服务未允许此读取，请确认当前会话仍可用。"],
  ["read_failed", "读取失败或超时，可手动刷新。"],
]);
const counts = new Intl.NumberFormat("zh-CN");
type Pane = "tasks" | "dag";
type Snapshot = "waiting" | Wire;

function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function message(data: Wire): string {
  switch (data.status) {
    case "unavailable": return `不可用：${unavailable.get(str(data.reason)) ?? "没有可用的读取结果。"}`;
    case "ownership_changed": return "会话归属已变化，未显示任何宿主数据。";
    default: return "摘要格式无效，未显示宿主数据。";
  }
}

export function canShowSnapshot(data: Wire): boolean {
  return data.status === "unavailable" && data.reason === "unsupported";
}

function rows(kind: Pane, data: readonly Wire[], persisted: boolean): HTMLElement {
  const result = el("ol", "inline-list numerical");
  for (const [i, row] of data.entries()) {
    const item = el("li", "stack stack--tight");
    const nodeCount = kind === "dag" ? (persisted ? list(row.nodes).length : count(row.nodeCount)) : undefined;
    const created = persisted && kind === "tasks" ? row.startedAt : row.createdAt;
    const updated = persisted && kind === "tasks" ? row.completedAt : row.updatedAt;
    const state = knownActivityState(str(row.status)) ?? "状态未知";
    item.append(el("p", "metric-label small", `${kind === "tasks" ? "任务" : "运行"} ${counts.format(i + 1)} · ${state}`));
    if (nodeCount !== undefined) item.append(el("p", "small muted", `${counts.format(nodeCount)} 个节点`));
    if (num(created) !== undefined) {
      item.append(el("p", "small muted", `${persisted && kind === "tasks" ? "开始" : "创建"}：${timeText(created)}`));
    }
    if (num(updated) !== undefined && updated !== created) {
      item.append(el("p", "small muted", `${persisted && kind === "tasks" ? "结束" : "更新"}：${timeText(updated)}`));
    }
    result.append(item);
  }
  return result;
}

function snapshotSection(kind: Pane, snapshot: Snapshot): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h4", "", "磁盘快照 · 只读"));
  if (snapshot === "waiting") {
    const status = el("p", "small muted", "正在查找已保存的快照…");
    status.setAttribute("role", "status");
    section.append(status);
  } else if (snapshot.status === "ok") {
    const entries = list(kind === "tasks" ? snapshot.tasks : snapshot.runs).map(object);
    section.append(el("p", "small muted", `保存时间：${timeText(snapshot.updatedAt)} · 非实时`));
    section.append(entries.length ? rows(kind, entries, true) : el("p", "small muted", "快照没有此类记录，不代表当前没有。"));
  } else {
    section.append(el("p", "small muted", "没有可读取的快照。"));
  }
  return section;
}

export function renderRuntimePane(kind: Pane, data?: Wire, snapshot?: Snapshot): HTMLElement[] {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", kind === "tasks" ? "子代理任务" : "DAG 运行"), el("p", "metric-label small", "实时宿主 · 只读"));
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  section.append(status);
  if (!data) {
    status.textContent = "正在读取宿主摘要…";
  } else if (data.status === "empty") {
    status.textContent = kind === "tasks" ? "宿主报告当前没有子代理任务。" : "宿主报告当前没有 DAG 运行。";
  } else if (data.status === "ok") {
    const entries = list(data.rows).map(object);
    const omitted = count(data.omittedCount);
    if (entries.length && entries.length <= 256 &&
      entries.every(row => knownActivityState(str(row.status)) && num(row.createdAt) !== undefined &&
        num(row.updatedAt) !== undefined && (kind !== "dag" || count(row.nodeCount) !== undefined)) &&
      (kind === "tasks" ? omitted !== undefined : typeof data.limitReached === "boolean")) {
      status.textContent = `读到 ${counts.format(entries.length)} 条摘要。`;
      section.append(rows(kind, entries, false));
      if (kind === "tasks" && omitted) section.append(el("p", "small muted", `宿主另有 ${counts.format(omitted)} 条未返回。`));
      if (kind === "dag" && data.limitReached) section.append(el("p", "small muted", "本次读取已达上限，不代表还有下一页。"));
    } else status.textContent = message({});
  } else {
    status.textContent = message(data);
  }
  const controls = el("div", "subpanel stack stack--tight");
  const reason = el("p", "small muted", kind === "tasks"
    ? "当前原生接口不能限定动作只作用于正在运行的轮次：任务刚结束时，发送可能续跑，取消可能只释放资源。请在本机 OmO 管理任务。"
    : "当前宿主只提供 DAG 读取接口，不支持从 Web 启动、取消或重试。请在本机 OmO 管理 DAG。");
  reason.id = `runtime-${kind}-read-only`;
  const actions = el("div", "row");
  for (const label of kind === "tasks" ? ["发送任务消息", "取消任务"] : ["控制 DAG"]) {
    const control = el("button", "button", label);
    control.type = "button";
    control.disabled = true;
    control.setAttribute("aria-describedby", reason.id);
    actions.append(control);
  }
  controls.append(reason, actions);
  return [section, ...(data && snapshot && canShowSnapshot(data) ? [snapshotSection(kind, snapshot)] : []), controls];
}

export function renderJournal(data?: Wire): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.id = "runtime-journal";
  section.append(el("h3", "", "本会话记忆计数"));
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  section.append(status);
  if (!data) {
    status.textContent = "正在读取会话记忆…";
  } else if (data.status === "ok") {
    const total = count(data.totalSteps);
    const reflected = count(data.reflectedSteps);
    if (total !== undefined && reflected !== undefined) {
      status.textContent = "仅当前会话的原生日志计数，不含共享记忆或原文。";
      const values = el("dl", "capability-list small numerical");
      for (const [label, value] of [["记录步数", total], ["已反思步数", reflected]] as const) {
        const row = el("div");
        row.append(el("dt", "", label), el("dd", "", counts.format(value)));
        values.append(row);
      }
      section.append(values);
    } else status.textContent = message({});
  } else {
    status.textContent = message(data);
  }
  return section;
}
