import { el, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { knownActivityState, timeText } from "./native-activity.ts";
import { dagRoster, dagView, taskDetail, taskExecution } from "./dag-readout.ts";
import type { DagTaskLinks, TaskExecution } from "./dag-readout.ts";
import { executionTime, runtimeKey } from "./dag-graph.ts";
import type { DagNode } from "./dag-graph.ts";
import { tr, uiLocale } from "./locale.ts";

const unavailable = new Map([
  ["inactive", tr("会话尚未接入，或正在交接。", "The session is not connected or is being handed off.")],
  ["binding_unverified", tr("无法验证当前会话的宿主绑定。", "Could not verify which host owns the current session.")],
  ["unsupported", tr("当前宿主或连接方式不支持此读取。", "The current host or connection does not support this read.")],
  ["native_unavailable", tr("宿主未能提供摘要。", "The host could not provide a summary.")],
  ["native_window_unverified", tr("宿主在读取范围内没有返回匹配的运行。更早的匹配未知。",
    "The host returned no matching runs within its read window. Older matches are unknown.")],
  ["engine_unavailable", tr("宿主连接忙碌、已断开或读取超时。", "The host is busy, disconnected, or did not respond in time.")],
  ["web_unsupported", tr("当前 Web 服务没有实时摘要入口。", "This Web server does not support live summaries.")],
  ["read_refused", tr("Web 服务未允许此读取，请确认当前会话仍可用。", "The Web server refused this read. Check that the session is still available.")],
  ["read_failed", tr("读取失败或超时，可手动刷新。", "The read failed or timed out. Refresh to try again.")],
]);
const counts = new Intl.NumberFormat(uiLocale);
type Pane = "tasks" | "dag";
type Snapshot = "waiting" | Wire;
type ReadDag = (key: string, signal: AbortSignal) => Promise<Wire>;
export type DagRuntimeOptions = {
  readonly read: ReadDag;
  readonly links: DagTaskLinks;
  readonly settled: (key: string, nodes: readonly DagNode[], body: HTMLElement) => void;
};
type TaskJump = (key: string) => (() => void) | undefined;
type PaneOptions = {
  readonly snapshot?: Snapshot;
  readonly dag?: DagRuntimeOptions;
  readonly taskJump?: TaskJump;
  readonly history?: boolean;
};
const currentDagStates = new Set(["pending", "running", "paused"]);
const terminalDagStates = new Set(["completed", "failed", "cancelled"]);

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

function liveRows(kind: Pane, data: Wire, history: boolean): readonly Wire[] | undefined {
  if (data.status !== "ok") return;
  const entries = list(data.rows).map(object);
  const states = history ? terminalDagStates : currentDagStates;
  if (!entries.length || entries.length > 256 || !entries.every(row =>
    knownActivityState(str(row.status)) && executionTime(row.createdAt) !== undefined &&
    executionTime(row.updatedAt) !== undefined && (kind === "tasks" ||
      (count(row.nodeCount) !== undefined && states.has(str(row.status)))))) return;
  if (kind === "tasks" ? count(data.omittedCount) === undefined : data.coverage !== "native_window" ||
    typeof data.limitReached !== "boolean") return;
  return entries;
}

export function runtimeTaskIndex(data: Wire): ReadonlyMap<string, TaskExecution> {
  const unique = new Map<string, TaskExecution>();
  const duplicates = new Set<string>();
  for (const row of liveRows("tasks", data, false) ?? []) {
    const key = runtimeKey(row.key);
    if (!key || duplicates.has(key)) continue;
    if (unique.delete(key)) duplicates.add(key);
    else unique.set(key, taskExecution(row));
  }
  return unique;
}

function dagLoadError(data: Wire): HTMLElement {
  const content = el("div", "dag-readout stack stack--tight");
  content.append(el("p", "small muted", data.status === "not_found"
    ? tr("该运行不在当前列表中，请刷新。", "This run is no longer in the list. Refresh to try again.") : message(data)));
  return content;
}

function rows(kind: Pane, data: readonly Wire[], options: PaneOptions & { readonly taskKeys?: ReadonlyMap<string, TaskExecution> } = {}): HTMLElement {
  const { dag, taskJump, taskKeys, snapshot } = options;
  const persisted = snapshot !== undefined;
  const result = el("ol", "inline-list numerical");
  for (const [i, row] of data.entries()) {
    const item = el("li", "stack stack--tight");
    const nodeCount = kind === "dag" ? (persisted ? list(row.nodes).length : count(row.nodeCount)) : undefined;
    const created = persisted && kind === "tasks" ? row.startedAt : row.createdAt;
    const updated = persisted && kind === "tasks" ? row.completedAt : row.updatedAt;
    const state = knownActivityState(str(row.status)) ?? tr("状态未知", "Unknown status");
    const label = !persisted ? str(kind === "dag" ? row.name : row.title) : "";
    const title = label || `${kind === "tasks" ? tr("任务", "Task") : tr("运行", "Run")} ${counts.format(i + 1)}`;
    const heading = `${title} · ${state}`;
    const key = runtimeKey(row.key);
    if (kind === "tasks" && !persisted) {
      item.append(taskDetail(row, [title, state], taskKeys?.has(key) ? { key, openDag: taskJump?.(key) } : undefined));
      result.append(item);
      continue;
    }
    const recap = nodeCount === undefined ? "" : tr(`${counts.format(nodeCount)} 个节点`,
      `${counts.format(nodeCount)} ${nodeCount === 1 ? "node" : "nodes"}`);
    const roster = nodeCount !== undefined && !persisted ? dagRoster(nodeCount, object(row.counts)) : [];
    if (dag && kind === "dag" && !persisted && key) {
      const details = el("details", "dag-run");
      details.dataset.dagKey = key;
      const body = el("div", "dag-content");
      const loading = el("p", "small muted", tr("正在读取波次与依赖…", "Loading waves and dependencies…"));
      loading.setAttribute("role", "status");
      const summary = el("summary");
      summary.append(el("strong", "", title), ` · ${[state, recap].filter(Boolean).join(" · ")}`, ...roster);
      details.append(summary, body);
      let request: AbortController | undefined;
      let loaded = false;
      details.addEventListener("toggle", () => {
        if (!details.open) {
          request?.abort();
          request = undefined;
          return;
        }
        if (request || loaded || !details.isConnected) return;
        const run = request = new AbortController();
        const live = () => request === run && details.isConnected && details.open;
        body.replaceChildren(loading);
        void dag.read(key, run.signal).then(data => {
          if (!live()) return;
          const view = data.status === "ok" ? dagView(data, dag.links, label) : undefined;
          body.replaceChildren(view?.root ?? dagLoadError(data));
          loaded = data.status === "ok";
          dag.settled(key, view?.nodes ?? [], body);
        }, (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (live()) {
            body.replaceChildren(dagLoadError({ status: "unavailable", reason: "read_failed" }));
            dag.settled(key, [], body);
          }
        }).finally(() => { if (request === run) request = undefined; });
      });
      item.append(details);
    } else {
      item.append(el("p", "metric-label small", heading));
      if (recap) item.append(el("p", "small muted", recap));
      if (roster.length) {
        const progress = el("p", "break numerical");
        progress.append(...roster);
        item.append(progress);
      }
    }
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
    section.append(entries.length ? rows(kind, entries, { snapshot }) : el("p", "small muted",
      tr("快照没有此类记录，不代表当前没有。", "No matching records in the snapshot. There may still be live activity.")));
  } else {
    section.append(el("p", "small muted", tr("没有可读取的快照。", "No readable snapshot.")));
  }
  return section;
}

export function renderRuntimePane(kind: Pane, data?: Wire, { snapshot, dag, taskJump, history = false }: PaneOptions = {}): HTMLElement[] {
  const section = el("section", "subpanel stack stack--tight");
  if (!history) section.append(el("h3", "", kind === "tasks" ? tr("子代理任务", "Subagent tasks") : tr("当前 DAG 运行", "Current DAG runs")),
    el("p", "metric-label small", tr("实时宿主 · 只读", "Live host · Read-only")));
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  section.append(status);
  if (!data) {
    status.textContent = history ? tr("正在读取已结束的 DAG 运行…", "Loading finished DAG runs…")
      : tr("正在读取宿主摘要…", "Loading host summary…");
  } else if (data.status === "empty" && kind === "tasks") {
    status.textContent = tr("宿主报告当前没有子代理任务。", "The host reports no current subagent tasks.");
  } else if (data.status === "ok") {
    const entries = liveRows(kind, data, history);
    const omitted = count(data.omittedCount);
    if (entries) {
      status.textContent = tr(`读到 ${counts.format(entries.length)} 条摘要。`,
        `${counts.format(entries.length)} ${entries.length === 1 ? "summary" : "summaries"} loaded.`);
      section.append(rows(kind, entries, { dag, taskJump, taskKeys: kind === "tasks" ? runtimeTaskIndex(data) : undefined }));
      if (kind === "tasks" && omitted) section.append(el("p", "small muted", tr(`宿主另有 ${counts.format(omitted)} 条未返回。`,
        `The host omitted ${counts.format(omitted)} ${omitted === 1 ? "additional entry" : "additional entries"}.`)));
      if (kind === "dag") section.append(el("p", "small muted",
        tr("宿主最多检查最近 256 次运行再筛选，更早的匹配可能未显示。",
          "The host checks up to 256 recent runs before filtering. Older matches may not appear.")));
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
