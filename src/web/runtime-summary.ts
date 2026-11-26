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
type ReadDag = (key: string) => Promise<Wire>;

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

const dagKey = /^[a-f0-9]{64}$/u;

function dagWaves(data: Wire): HTMLElement {
  const content = el("div", "dag-readout stack stack--tight");
  if (data.status !== "ok") {
    content.append(el("p", "small muted", data.status === "not_found"
      ? "该运行不在当前列表中，请刷新。" : message(data)));
    return content;
  }
  const nodes = new Map(list(data.nodes).map(object).flatMap(node => {
    const id = count(node.id);
    return id === undefined ? [] : [[id, node] as const];
  }));
  for (const raw of list(data.waves)) {
    const wave = object(raw);
    const index = count(wave.index);
    if (index === undefined) continue;
    const section = el("section", "dag-wave stack stack--tight");
    const items = el("ol", "inline-list numerical");
    for (const value of list(wave.nodes)) {
      const id = count(value);
      const node = id === undefined ? undefined : nodes.get(id);
      if (id === undefined || !node) continue;
      const upstream = list(node.upstream).map(count).filter(value => value !== undefined);
      const route = str(node.agent) || str(node.category);
      const state = knownActivityState(str(node.state)) ?? "状态未知";
      const attempt = count(node.attempt);
      const line = el("li", "stack stack--tight");
      line.append(el("p", "small", [`节点 ${id + 1}`, state, route, attempt ? `尝试 ${attempt} 次` : ""].filter(Boolean).join(" · ")));
      if (upstream.length) line.append(el("p", "small muted", `依赖：${upstream.map(dep => `节点 ${dep + 1}`).join("、")}`));
      items.append(line);
    }
    if (items.childElementCount) {
      section.append(el("h4", "", `第 ${index + 1} 波`), items);
      content.append(section);
    }
  }
  if (!content.childElementCount) content.append(el("p", "small muted", "运行未提供可显示的波次。"));
  return content;
}

function rows(kind: Pane, data: readonly Wire[], persisted: boolean, readDag?: ReadDag): HTMLElement {
  const result = el("ol", "inline-list numerical");
  for (const [i, row] of data.entries()) {
    const item = el("li", "stack stack--tight");
    const nodeCount = kind === "dag" ? (persisted ? list(row.nodes).length : count(row.nodeCount)) : undefined;
    const created = persisted && kind === "tasks" ? row.startedAt : row.createdAt;
    const updated = persisted && kind === "tasks" ? row.completedAt : row.updatedAt;
    const state = knownActivityState(str(row.status)) ?? "状态未知";
    const heading = `${kind === "tasks" ? "任务" : "运行"} ${counts.format(i + 1)} · ${state}`;
    const key = str(row.key);
    const statusCounts = object(row.counts);
    const progress = [["completed", "完成"], ["running", "运行中"], ["failed", "失败"], ["blocked", "阻塞"]].flatMap(([status, label]) => {
      const value = count(statusCounts[status]);
      return value ? [`${label} ${counts.format(value)}`] : [];
    });
    const recap = nodeCount === undefined ? "" : [`${counts.format(nodeCount)} 个节点`, ...progress].join(" · ");
    if (readDag && kind === "dag" && !persisted && dagKey.test(key)) {
      const details = el("details", "dag-run");
      details.dataset.dagKey = key;
      const body = el("div", "dag-content");
      const loading = el("p", "small muted", "正在读取波次与依赖…");
      loading.setAttribute("role", "status");
      details.append(el("summary", "", [heading, recap].filter(Boolean).join(" · ")), body);
      let reading = false;
      let loaded = false;
      details.addEventListener("toggle", () => {
        if (!details.open || reading || loaded) return;
        reading = true;
        body.replaceChildren(loading);
        void readDag(key).then(data => {
          if (details.isConnected) body.replaceChildren(dagWaves(data));
          loaded = data.status === "ok";
        }, (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (details.isConnected) body.replaceChildren(dagWaves({ status: "unavailable", reason: "read_failed" }));
        }).finally(() => { reading = false; });
      });
      item.append(details);
    } else {
      item.append(el("p", "metric-label small", heading));
      if (recap) item.append(el("p", "small muted", recap));
    }
    const route = kind === "tasks" && !persisted && [str(row.agent), str(row.category), str(row.executionMode)].filter(Boolean).join(" · ");
    if (route) item.append(el("p", "small muted", route));
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

export function renderRuntimePane(kind: Pane, data?: Wire, snapshot?: Snapshot, readDag?: ReadDag): HTMLElement[] {
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
      section.append(rows(kind, entries, false, readDag));
      if (kind === "tasks" && omitted) section.append(el("p", "small muted", `宿主另有 ${counts.format(omitted)} 条未返回。`));
      if (kind === "dag" && data.limitReached) section.append(el("p", "small muted", "本次读取已达上限，不代表还有下一页。"));
    } else status.textContent = message({});
  } else {
    status.textContent = message(data);
  }
  return [section, ...(data && snapshot && canShowSnapshot(data) ? [snapshotSection(kind, snapshot)] : [])];
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
