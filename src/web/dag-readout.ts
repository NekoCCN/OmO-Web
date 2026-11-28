import { button, el, fold, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { MAX_DAG_NODES, dagNodeLabel, executionTimeFacts, executionTimes, readDagWaves, renderDagGraph } from "./dag-graph.ts";
import type { DagNode } from "./dag-graph.ts";
import { knownActivityState, timeText } from "./native-activity.ts";
import { tr, uiLocale } from "./locale.ts";

const counts = new Intl.NumberFormat(uiLocale);
const stateLabels = [
  ["pending", tr("等待", "Pending")], ["scheduled", tr("已调度", "Scheduled")],
  ["running", tr("运行中", "Running")], ["paused", tr("已暂停", "Paused")],
  ["blocked", tr("阻塞", "Blocked")], ["completed", tr("已完成", "Completed")],
  ["failed", tr("失败", "Failed")], ["cancelled", tr("已取消", "Canceled")],
  ["skipped", tr("已跳过", "Skipped")],
] as const;
const unfinished = new Set(["pending", "scheduled", "running", "paused", "blocked"]);
const highlightStates = new Set(["scheduled", "running", "paused", "blocked", "failed"]);
const stateLabel = (state: string) => knownActivityState(state) ?? tr("状态未知", "Unknown status");
export type TaskExecution = {
  readonly description: string;
  readonly configuredModel: string;
  readonly effectiveModel: string;
  readonly reasoning: string;
};
type Fact = readonly [label: string, value: string];
export type DagTaskLinks = {
  readonly task: (key: string) => TaskExecution | undefined;
  readonly openTask: (key: string) => void;
};

function executionFacts(items: readonly Fact[]): HTMLElement {
  const facts = el("dl", "capability-list small numerical break");
  for (const [label, value] of items) {
    const row = el("div");
    row.append(el("dt", "", label), el("dd", value ? "" : "muted", value || tr("未报告", "Not reported")));
    facts.append(row);
  }
  return facts;
}

function modelFacts(task?: TaskExecution): readonly Fact[] {
  return [[tr("生效模型", "Effective model"), task?.effectiveModel ?? ""],
    [tr("推理档位", "Reasoning"), task?.reasoning ?? ""]];
}

export function taskExecution(row: Wire): TaskExecution {
  const effective = object(row.effectiveModel);
  const provider = str(effective.provider);
  const model = str(effective.modelId);
  return { description: str(row.description), configuredModel: str(row.configuredModel),
    effectiveModel: provider && model ? `${provider}/${model}` : "", reasoning: provider && model ? str(effective.reasoning) : "" };
}

export function taskDetail(row: Wire, heading: readonly [string, string], link?: { readonly key: string; readonly openDag?: () => void }): HTMLDetailsElement {
  const task = taskExecution(row);
  const agent = str(row.agent);
  const category = str(row.category);
  const routes = [agent ? tr(`代理：${agent}`, `Agent: ${agent}`) : "",
    category ? tr(`类别：${category}`, `Category: ${category}`) : ""].filter(Boolean);
  const action = link?.openDag ? button(tr("打开 DAG 节点", "Open DAG node"), link.openDag, "task-dag-jump")
    : el("p", "small muted", tr("没有已核验的 DAG 节点关联。", "No verified DAG node link."));
  const description = el("p", "small break", task.description || tr("未报告任务描述。", "Task description not reported."));
  const report = executionFacts([
    [tr("路由", "Route"), routes.join(" · ")], [tr("执行方式", "Execution mode"), str(row.executionMode)],
    [tr("请求模型", "Requested model"), task.configuredModel], ...modelFacts(task),
    [tr("创建", "Created"), timeText(row.createdAt)], [tr("更新", "Updated"), timeText(row.updatedAt)],
  ]);
  const detail = fold("", description, ...(link?.openDag ? [action, report] : [report, action]));
  detail.querySelector("summary")?.append(el("strong", "", heading[0]), ` · ${heading[1]}`);
  detail.className = "task-run";
  detail.name = "native-subagent-task";
  if (link) detail.dataset.taskKey = link.key;
  return detail;
}

export function focusExecution(summary: HTMLElement, anchor = summary): void {
  summary.focus({ preventScroll: true });
  anchor.scrollIntoView({ block: "start", inline: "nearest" });
}

export function revealDagNode(root: HTMLElement, id: number, focus: boolean): void {
  const list = root.querySelector<HTMLDetailsElement>(".dag-graph-text");
  const row = list?.querySelector<HTMLElement>(`[data-node-detail="${id}"]`);
  const detail = row?.querySelector<HTMLDetailsElement>(".runtime-execution");
  const summary = detail?.querySelector("summary");
  if (!list || !row || !detail || !summary) return;
  list.open = detail.open = true;
  if (focus) focusExecution(summary, row);
}

function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function completedText(completed: number, total: number): string {
  return tr(`已完成 ${counts.format(completed)} / ${counts.format(total)} 个节点`,
    `${counts.format(completed)} of ${counts.format(total)} completed`);
}

function stateBreakdown(read: (state: string) => number | undefined): string[] {
  return stateLabels.flatMap(([state, label]) => {
    const value = read(state);
    return value === undefined ? [] : [`${label} ${counts.format(value)}`];
  });
}

export function dagRoster(total: number, reported: Wire): HTMLElement[] {
  const read = (state: string) => {
    const value = count(reported[state]);
    return value !== undefined && value <= total ? value : undefined;
  };
  const completed = read("completed");
  const breakdown = stateBreakdown(state => state === "completed" ? undefined : read(state));
  const reportedStates = breakdown.length + Number(completed !== undefined);
  const recap = [
    ...(completed === undefined ? [] : [el("span", "dag-roster-progress", completedText(completed, total))]),
    ...(breakdown.length ? [el("span", "dag-roster-counts", breakdown.join(" · "))] : []),
  ];
  if (reportedStates < stateLabels.length) {
    recap.push(el("span", "dag-roster-counts", reportedStates
      ? tr("仅显示宿主报告的状态。", "Only reported states are shown.")
      : tr("宿主未报告节点状态计数。", "The host did not report node status counts.")));
  }
  return recap;
}

function nodeStates(nodes: readonly DagNode[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const node of nodes) result.set(node.state, (result.get(node.state) ?? 0) + 1);
  return result;
}

function waveTitle(index: number): string {
  return tr(`第 ${counts.format(index + 1)} 波`, `Wave ${counts.format(index + 1)}`);
}

function waveSection(index: number): HTMLElement {
  const section = el("section", "dag-wave stack stack--tight");
  section.append(el("h4", "", waveTitle(index)));
  return section;
}

function nodeDetail(node: DagNode, lookup: ReadonlyMap<number, DagNode>, links?: DagTaskLinks): HTMLElement {
  const line = el("li", "dag-node-detail stack stack--tight");
  line.dataset.nodeDetail = String(node.id);
  const heading = el("p", "small break");
  heading.append(el("strong", "", dagNodeLabel(node)), ` · ${stateLabel(node.state)}`);
  line.append(heading);
  const route = node.agent ? tr(`代理：${node.agent}`, `Agent: ${node.agent}`)
    : node.category ? tr(`类别：${node.category}`, `Category: ${node.category}`) : "";
  const attempt = node.attempt === undefined ? "" : tr(`尝试次数：${counts.format(node.attempt)}`, `Attempts: ${counts.format(node.attempt)}`);
  if (route || attempt) line.append(el("p", "small muted break", [route, attempt].filter(Boolean).join(" · ")));
  const upstream = node.upstream.flatMap(id => {
    const parent = lookup.get(id);
    return parent ? [parent] : [];
  });
  const describe = (parent: DagNode) => `${dagNodeLabel(parent)} (${stateLabel(parent.state)})`;
  const parents = upstream.map(dagNodeLabel);
  line.append(el("p", "small muted break", parents.length
    ? tr(`依赖：${parents.join("、")}`, `Depends on: ${parents.join(", ")}`)
    : tr("无上游依赖", "No upstream dependencies")));
  const groups = [
    [upstream.filter(parent => parent.state === "failed"), tr("失败上游", "Failed upstream")],
    [upstream.filter(parent => unfinished.has(parent.state)), tr("未结束上游", "Unfinished upstream")],
    [upstream.filter(parent => parent.state !== "failed" && !unfinished.has(parent.state)), tr("其他上游", "Other upstream")],
  ] as const;
  for (const [nodes, label] of groups) if (nodes.length) {
    line.append(el("p", "small break", `${label}${tr("：", ": ")}${nodes.map(describe).join(tr("、", ", "))}`));
  }
  const task = node.taskKey ? links?.task(node.taskKey) : undefined;
  const report = executionFacts([
    [tr("配置模型", "Configured model"), node.configuredModel],
    ...(task?.configuredModel ? [[tr("任务请求模型", "Task requested model"), task.configuredModel] as const] : []),
    ...modelFacts(task), ...executionTimeFacts(node.times),
  ]);
  const action = task && links ? button(tr("打开子代理任务", "Open subagent task"), () => links.openTask(node.taskKey), "node-task-jump")
    : el("p", "small muted", tr("没有已核验的子代理任务关联。", "No verified subagent task link."));
  const description = el("p", "small break", task?.description || tr("未报告任务描述。", "Task description not reported."));
  const detail = fold(tr("执行详情", "Execution details"), description, ...(task ? [action, report] : [report, action]));
  detail.className = "runtime-execution";
  detail.querySelector("summary")?.setAttribute("aria-label", tr(`${dagNodeLabel(node)}：执行详情`, `${dagNodeLabel(node)}: Execution details`));
  line.append(detail);
  return line;
}

function unverifiedWaves(data: Wire, content: HTMLElement): void {
  const nodes = new Map<number, string>();
  for (const raw of list(data.nodes).slice(0, MAX_DAG_NODES)) {
    const node = object(raw);
    const id = count(node.id);
    if (id !== undefined && id < MAX_DAG_NODES) nodes.set(id, str(node.state));
  }
  for (const raw of list(data.waves).slice(0, MAX_DAG_NODES)) {
    const wave = object(raw);
    const index = count(wave.index);
    if (index === undefined || index >= MAX_DAG_NODES) continue;
    const section = waveSection(index);
    const items = el("ol", "inline-list numerical");
    for (const value of list(wave.nodes).slice(0, MAX_DAG_NODES)) {
      const id = count(value);
      const state = id === undefined ? undefined : nodes.get(id);
      if (id === undefined || state === undefined) continue;
      nodes.delete(id);
      const item = el("li");
      item.append(el("p", "small", `${dagNodeLabel({ id, label: "" })} · ${stateLabel(state)}`));
      items.append(item);
    }
    if (items.childElementCount) {
      section.append(items);
      content.append(section);
    }
  }
  if (!content.childElementCount) content.append(el("p", "small muted",
    tr("运行未提供可显示的波次。", "This run did not report any waves to display.")));
}

export function dagView(data: Wire, links?: DagTaskLinks, listedName = ""): { root: HTMLElement; nodes: readonly DagNode[] } {
  const content = el("div", "dag-graph-view stack stack--tight");
  const details = el("details", "dag-graph-text");
  const summary = el("summary", "small", tr("节点详情 · 波次与依赖", "Node details · Waves and dependencies"));
  const readout = el("div", "dag-readout stack stack--tight");
  const waves = readDagWaves(data);
  const nodes = waves?.flat() ?? [];
  if (waves) {
    const lookup = new Map(nodes.map(node => [node.id, node]));
    const runCounts = nodeStates(nodes);
    const waveCount = tr(`${counts.format(waves.length)} 个波次`, `${counts.format(waves.length)} ${waves.length === 1 ? "wave" : "waves"}`);
    content.append(el("p", "small break dag-verified-roster", [
      tr("已核验快照", "Verified snapshot"), waveCount, completedText(runCounts.get("completed") ?? 0, nodes.length),
    ].join(" · ")));
    const currentBreakdown = stateBreakdown(state => state === "completed" ? undefined : runCounts.get(state));
    if (currentBreakdown.length) content.append(el("p", "small muted break", currentBreakdown.join(" · ")));
    const name = str(data.name);
    if (name && name !== listedName) content.append(el("p", "small metric-label break", name));
    const times = executionTimeFacts(executionTimes(data));
    if (times.length) content.append(executionFacts(times));
    const highlights: string[] = [];
    for (const [index, wave] of waves.entries()) {
      const section = waveSection(index);
      const items = el("ol", "inline-list numerical");
      const distribution = nodeStates(wave);
      const focus = stateBreakdown(state => highlightStates.has(state) ? distribution.get(state) : undefined);
      if (focus.length) highlights.push(`${waveTitle(index)}${tr("：", ": ")}${focus.join(" · ")}`);
      items.append(...wave.map(node => nodeDetail(node, lookup, links)));
      section.append(el("p", "small muted break", stateBreakdown(state => distribution.get(state)).join(" · ")), items);
      readout.append(section);
    }
    if (highlights.length) {
      const preview = el("span", "dag-wave-preview");
      for (const caption of highlights.slice(0, 3)) preview.append(el("span", "dag-roster-counts", caption));
      if (highlights.length > 3) preview.append(el("span", "dag-roster-counts",
        tr(`另有 ${counts.format(highlights.length - 3)} 个波次，展开查看`,
          `${counts.format(highlights.length - 3)} more highlighted waves in node details`)));
      summary.append(preview);
    }
  } else {
    content.append(el("p", "small muted", tr("无法验证完整拓扑；仅显示可识别的节点，不显示依赖连线。",
      "Could not verify the full graph. Only recognized nodes are shown, without dependency lines.")));
    unverifiedWaves(data, readout);
  }
  details.open = !waves || matchMedia("(max-width: 760px)").matches;
  details.append(summary, readout);
  content.append(details);
  if (waves) content.append(renderDagGraph(waves, id => revealDagNode(content, id, true)));
  return { root: content, nodes };
}
