import { el, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { knownActivityState, timeText } from "./native-activity.ts";
import { MAX_DAG_NODES, renderDagGraph } from "./dag-graph.ts";
import { tr, uiLocale } from "./locale.ts";

const unavailable = new Map([
  ["inactive", tr("会话尚未接入，或正在交接。", "The session is not connected or is being handed off.")],
  ["binding_unverified", tr("无法验证当前会话的宿主绑定。", "Could not verify which host owns the current session.")],
  ["unsupported", tr("当前宿主或连接方式不支持此读取。", "The current host or connection does not support this read.")],
  ["native_unavailable", tr("宿主未能提供摘要。", "The host could not provide a summary.")],
  ["engine_unavailable", tr("宿主连接忙碌、已断开或读取超时。", "The host is busy, disconnected, or did not respond in time.")],
  ["web_unsupported", tr("当前 Web 服务没有实时摘要入口。", "This Web server does not support live summaries.")],
  ["read_refused", tr("Web 服务未允许此读取，请确认当前会话仍可用。", "The Web server refused this read. Check that the session is still available.")],
  ["read_failed", tr("读取失败或超时，可手动刷新。", "The read failed or timed out. Refresh to try again.")],
]);
const counts = new Intl.NumberFormat(uiLocale);
type Pane = "tasks" | "dag";
type Snapshot = "waiting" | Wire;
type ReadDag = (key: string) => Promise<Wire>;

function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function message(data: Wire): string {
  switch (data.status) {
    case "unavailable": {
      const reason = unavailable.get(str(data.reason)) ?? tr("没有可用的读取结果。", "No results are available.");
      return tr(`不可用：${reason}`, `Unavailable: ${reason}`);
    }
    case "ownership_changed": return tr("会话归属已变化，未显示任何宿主数据。", "Session ownership changed. No host data is shown.");
    default: return tr("摘要格式无效，未显示宿主数据。", "The summary is invalid. No host data is shown.");
  }
}

export function canShowSnapshot(data: Wire): boolean {
  return data.status === "unavailable" && data.reason === "unsupported";
}

const dagKey = /^[a-f0-9]{64}$/u;

function dagWaves(data: Wire, verified = false): HTMLElement {
  const content = el("div", "dag-readout stack stack--tight");
  if (data.status !== "ok") {
    content.append(el("p", "small muted", data.status === "not_found"
      ? tr("该运行不在当前列表中，请刷新。", "This run is no longer in the list. Refresh to try again.") : message(data)));
    return content;
  }
  const nodes = new Map(list(data.nodes).slice(0, MAX_DAG_NODES).map(object).flatMap(node => {
    const id = count(node.id);
    return id === undefined ? [] : [[id, node] as const];
  }));
  for (const raw of list(data.waves).slice(0, MAX_DAG_NODES)) {
    const wave = object(raw);
    const index = count(wave.index);
    if (index === undefined) continue;
    const section = el("section", "dag-wave stack stack--tight");
    const items = el("ol", "inline-list numerical");
    for (const value of list(wave.nodes).slice(0, MAX_DAG_NODES)) {
      const id = count(value);
      const node = id === undefined ? undefined : nodes.get(id);
      if (id === undefined || !node) continue;
      nodes.delete(id);
      const upstream = verified ? list(node.upstream).map(count).filter(value => value !== undefined) : [];
      const route = verified ? str(node.agent) || str(node.category) : "";
      const state = knownActivityState(str(node.state)) ?? tr("状态未知", "Unknown status");
      const attempt = count(node.attempt);
      const line = el("li", "stack stack--tight");
      line.append(el("p", "small", [tr(`节点 ${counts.format(id + 1)}`, `Node ${counts.format(id + 1)}`), state, route,
        attempt ? tr(`尝试 ${counts.format(attempt)} 次`, `Attempts: ${counts.format(attempt)}`) : ""].filter(Boolean).join(" · ")));
      if (upstream.length) line.append(el("p", "small muted", tr(`依赖：${upstream.map(dep => `节点 ${counts.format(dep + 1)}`).join("、")}`,
        `Depends on: ${upstream.map(dep => `Node ${counts.format(dep + 1)}`).join(", ")}`)));
      items.append(line);
    }
    if (items.childElementCount) {
      section.append(el("h4", "", tr(`第 ${counts.format(index + 1)} 波`, `Wave ${counts.format(index + 1)}`)), items);
      content.append(section);
    }
  }
  if (!content.childElementCount) content.append(el("p", "small muted", tr("运行未提供可显示的波次。", "This run did not report any waves to display.")));
  return content;
}

function dagView(data: Wire): HTMLElement {
  if (data.status !== "ok") return dagWaves(data);
  const graph = renderDagGraph(data);
  const content = el("div", "dag-graph-view stack stack--tight");
  if (graph) content.append(graph);
  else content.append(el("p", "small muted", tr("无法验证完整拓扑；仅显示可识别的节点，不显示依赖连线。",
    "Could not verify the full graph. Only recognized nodes are shown, without dependency lines.")));
  const text = el("details", "dag-graph-text");
  text.open = !graph;
  text.append(el("summary", "small", tr("文字列表 · 波次与依赖", "Text list · Waves and dependencies")), dagWaves(data, !!graph));
  content.append(text);
  return content;
}

function rows(kind: Pane, data: readonly Wire[], persisted: boolean, readDag?: ReadDag): HTMLElement {
  const result = el("ol", "inline-list numerical");
  for (const [i, row] of data.entries()) {
    const item = el("li", "stack stack--tight");
    const nodeCount = kind === "dag" ? (persisted ? list(row.nodes).length : count(row.nodeCount)) : undefined;
    const created = persisted && kind === "tasks" ? row.startedAt : row.createdAt;
    const updated = persisted && kind === "tasks" ? row.completedAt : row.updatedAt;
    const state = knownActivityState(str(row.status)) ?? tr("状态未知", "Unknown status");
    const heading = `${kind === "tasks" ? tr("任务", "Task") : tr("运行", "Run")} ${counts.format(i + 1)} · ${state}`;
    const key = str(row.key);
    const statusCounts = object(row.counts);
    const progress = [["completed", tr("完成", "Completed")], ["running", tr("运行中", "Running")],
      ["failed", tr("失败", "Failed")], ["blocked", tr("阻塞", "Blocked")]].flatMap(([status, label]) => {
      const value = count(statusCounts[status]);
      return value ? [`${label} ${counts.format(value)}`] : [];
    });
    const recap = nodeCount === undefined ? "" : [
      tr(`${counts.format(nodeCount)} 个节点`, `${counts.format(nodeCount)} ${nodeCount === 1 ? "node" : "nodes"}`), ...progress].join(" · ");
    if (readDag && kind === "dag" && !persisted && dagKey.test(key)) {
      const details = el("details", "dag-run");
      details.dataset.dagKey = key;
      const body = el("div", "dag-content");
      const loading = el("p", "small muted", tr("正在读取波次与依赖…", "Loading waves and dependencies…"));
      loading.setAttribute("role", "status");
      details.append(el("summary", "", [heading, recap].filter(Boolean).join(" · ")), body);
      let reading = false;
      let loaded = false;
      details.addEventListener("toggle", () => {
        if (!details.open || reading || loaded) return;
        reading = true;
        body.replaceChildren(loading);
        void readDag(key).then(data => {
          if (details.isConnected) body.replaceChildren(dagView(data));
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
      item.append(el("p", "small muted", persisted && kind === "tasks"
        ? tr(`开始：${timeText(created)}`, `Started: ${timeText(created)}`) : tr(`创建：${timeText(created)}`, `Created: ${timeText(created)}`)));
    }
    if (num(updated) !== undefined && updated !== created) {
      item.append(el("p", "small muted", persisted && kind === "tasks"
        ? tr(`结束：${timeText(updated)}`, `Ended: ${timeText(updated)}`) : tr(`更新：${timeText(updated)}`, `Updated: ${timeText(updated)}`)));
    }
    result.append(item);
  }
  return result;
}

function snapshotSection(kind: Pane, snapshot: Snapshot): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h4", "", tr("磁盘快照 · 只读", "Saved snapshot · Read-only")));
  if (snapshot === "waiting") {
    const status = el("p", "small muted", tr("正在查找已保存的快照…", "Looking for a saved snapshot…"));
    status.setAttribute("role", "status");
    section.append(status);
  } else if (snapshot.status === "ok") {
    const entries = list(kind === "tasks" ? snapshot.tasks : snapshot.runs).map(object);
    section.append(el("p", "small muted", tr(`保存时间：${timeText(snapshot.updatedAt)} · 非实时`, `Saved: ${timeText(snapshot.updatedAt)} · Not live`)));
    section.append(entries.length ? rows(kind, entries, true) : el("p", "small muted",
      tr("快照没有此类记录，不代表当前没有。", "No matching records in the snapshot. There may still be live activity.")));
  } else {
    section.append(el("p", "small muted", tr("没有可读取的快照。", "No readable snapshot.")));
  }
  return section;
}

export function renderRuntimePane(kind: Pane, data?: Wire, snapshot?: Snapshot, readDag?: ReadDag): HTMLElement[] {
  const section = el("section", "subpanel stack stack--tight");
  section.append(el("h3", "", kind === "tasks" ? tr("子代理任务", "Subagent tasks") : tr("DAG 运行", "DAG runs")),
    el("p", "metric-label small", tr("实时宿主 · 只读", "Live host · Read-only")));
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  section.append(status);
  if (!data) {
    status.textContent = tr("正在读取宿主摘要…", "Loading host summary…");
  } else if (data.status === "empty") {
    status.textContent = kind === "tasks" ? tr("宿主报告当前没有子代理任务。", "The host reports no current subagent tasks.")
      : tr("宿主报告当前没有 DAG 运行。", "The host reports no current DAG runs.");
  } else if (data.status === "ok") {
    const entries = list(data.rows).map(object);
    const omitted = count(data.omittedCount);
    if (entries.length && entries.length <= 256 &&
      entries.every(row => knownActivityState(str(row.status)) && num(row.createdAt) !== undefined &&
        num(row.updatedAt) !== undefined && (kind !== "dag" || count(row.nodeCount) !== undefined)) &&
      (kind === "tasks" ? omitted !== undefined : typeof data.limitReached === "boolean")) {
      status.textContent = tr(`读到 ${counts.format(entries.length)} 条摘要。`,
        `${counts.format(entries.length)} ${entries.length === 1 ? "summary" : "summaries"} loaded.`);
      section.append(rows(kind, entries, false, readDag));
      if (kind === "tasks" && omitted) section.append(el("p", "small muted", tr(`宿主另有 ${counts.format(omitted)} 条未返回。`,
        `The host omitted ${counts.format(omitted)} ${omitted === 1 ? "additional entry" : "additional entries"}.`)));
      if (kind === "dag" && data.limitReached) section.append(el("p", "small muted",
        tr("本次读取已达上限，不代表还有下一页。", "The read limit was reached. It is not known whether there are more runs.")));
    } else status.textContent = message({});
  } else {
    status.textContent = message(data);
  }
  return [section, ...(data && snapshot && canShowSnapshot(data) ? [snapshotSection(kind, snapshot)] : [])];
}

export function renderJournal(data?: Wire): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.id = "runtime-journal";
  section.append(el("h3", "", tr("本会话记忆计数", "Session memory counts")));
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  section.append(status);
  if (!data) {
    status.textContent = tr("正在读取会话记忆…", "Loading session memory…");
  } else if (data.status === "ok") {
    const total = count(data.totalSteps);
    const reflected = count(data.reflectedSteps);
    if (total !== undefined && reflected !== undefined) {
      status.textContent = tr("仅当前会话的原生日志计数，不含共享记忆或原文。", "Native journal counts for this session only. Shared memory and original text are not shown.");
      const values = el("dl", "capability-list small numerical");
      for (const [label, value] of [[tr("记录步数", "Recorded steps"), total], [tr("已反思步数", "Reflected steps"), reflected]] as const) {
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
