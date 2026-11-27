import { codeBlock, el, list, notice, object, pretty, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { projectToolCard, renderToolCard } from "./tool-card.ts";
import { ToolGroupView } from "./tool-group-view.ts";
import { createToolScene, toolOutputLabels } from "./tool-scenes.ts";
import { recapTool, toolGlyphs } from "./tool-semantics.ts";
import type { ToolRecap } from "./tool-semantics.ts";
import type { TranscriptEntry } from "./transcript.ts";

export type ToolTrace = {
  readonly id: string; readonly name: string; readonly args?: unknown; readonly output?: unknown;
  readonly stage: "running" | "done" | "error";
};

const states = {
  running: { label: "运行中", icon: "M12 4a8 8 0 1 0 8 8" },
  success: { label: "成功", icon: "m5 12 4 4L19 6" },
  error: { label: "失败", icon: "m6 6 12 12M18 6 6 18" },
  unknown: { label: "未见结果", icon: "M6 12h12" },
  incomplete: { label: "结果不完整", icon: "M12 4v10m0 5v1" },
} as const;

const clipped = (message?: Wire): boolean => message?.truncated === true || message?.partial === true;
const hasPayload = (result: Wire): boolean => typeof result.content === "string" || Array.isArray(result.content);

function toolState(call?: Wire, trace?: ToolTrace, result?: Wire): keyof typeof states {
  if (result?.isError === true || str(result?.errorMessage) || trace?.stage === "error") return "error";
  if (clipped(call) || clipped(result) || (result?.isError === false && !hasPayload(result))) return "incomplete";
  if (result?.isError === false || trace?.stage === "done") return "success";
  return !result && trace?.stage === "running" ? "running" : "unknown";
}

function glyph(path: SVGPathElement): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

type RenderOutputPart = (part: Wire) => HTMLElement | undefined;

export class ToolDisplay {
  readonly node = el("article", "message message--tool");
  private readonly details = el("details", "tool-details");
  private readonly label = el("span", "tool-label");
  private readonly target = el("span", "tool-target path");
  private readonly operation = el("span", "tool-operation small muted");
  private readonly preview = el("span", "tool-preview small muted");
  private readonly compactFacts = el("span", "tool-card-inline small muted");
  private readonly status = el("span", "tool-state-text");
  private readonly icon = document.createElementNS("http://www.w3.org/2000/svg", "path");
  private readonly kindIcon = document.createElementNS("http://www.w3.org/2000/svg", "path");
  private readonly identity = el("p", "tool-name small muted", "工具名：");
  private readonly name = el("code");
  private readonly args = codeBlock("");
  private readonly argsSection = el("div", "stack stack--tight");
  private readonly rawArgs = el("details", "tool-raw-args");
  private readonly output = el("div", "tool-output stack stack--tight");
  private readonly outputLabel = el("p", "small muted", "输出");
  private readonly empty = el("p", "muted small");
  private readonly outputSection = el("div", "tool-result stack stack--tight");
  private readonly body = el("div", "fold-body stack stack--tight");
  private card?: HTMLElement;
  private cardKey?: string;
  private scene?: ReturnType<typeof createToolScene>;
  private lastName?: string;
  private lastArgs?: unknown;
  private lastOutput?: unknown;
  private group?: ToolGroupView;

  constructor(private readonly renderOutputPart: RenderOutputPart) {
    const summary = el("summary", "tool-summary");
    const chevron = el("span", "tool-chevron");
    chevron.setAttribute("aria-hidden", "true");
    const subject = el("span", "tool-subject");
    const kind = glyph(this.kindIcon);
    kind.classList.add("tool-kind-icon");
    this.compactFacts.hidden = true;
    subject.append(kind, this.label, this.operation, this.target, this.preview, this.compactFacts);
    const state = el("span", "tool-state");
    state.append(glyph(this.icon), this.status);
    summary.append(chevron, subject, state);

    this.identity.append(this.name);
    this.rawArgs.append(el("summary", "", "原始参数"));
    this.argsSection.append(el("p", "small muted", "调用参数"));
    this.output.tabIndex = 0;
    this.output.setAttribute("role", "region");
    this.output.setAttribute("aria-label", "工具输出");
    this.outputSection.append(this.outputLabel, this.output, this.empty);
    this.body.append(this.identity);
    this.details.append(summary, this.body);
    this.node.append(this.details);
  }

  get open(): boolean { return this.details.open; }
  set open(value: boolean) { this.details.open = value; }

  groupWith(members: readonly HTMLElement[]): HTMLDetailsElement {
    this.group ??= new ToolGroupView();
    return this.group.update(members);
  }

  private updateCard(recap: ToolRecap, output: unknown): void {
    const projection = projectToolCard(recap, output);
    const repeatedRecap = Boolean(recap.preview && !recap.dispatchRoutes);
    const key = projection && JSON.stringify([recap.kind, projection, repeatedRecap]);
    if (this.cardKey === key) return;
    this.cardKey = key;
    this.card?.remove();
    this.card = undefined;
    notice(this.compactFacts, projection && "facts" in projection
      ? projection.facts.map(([label, value]) => `${label} ${value}`).join(" · ") : "");
    if (!projection) return;
    const card = el("div", "tool-card-preview");
    if (repeatedRecap) card.dataset.repeatRecap = "";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", recap.kind === "todo" ? "m3 12 6 6L21 6" : toolGlyphs[recap.kind]);
    const emblem = glyph(path);
    emblem.classList.add("tool-card-emblem");
    card.append(emblem, renderToolCard(projection));
    this.node.append(card);
    this.card = card;
  }

  update(call?: Wire, trace?: ToolTrace, result?: Wire): void {
    const name = str(call?.name) || trace?.name || str(result?.toolName);
    const args = call?.arguments === undefined ? trace?.args : call.arguments;
    const output = result?.content ?? trace?.output;
    const state = toolState(call, trace, result);
    const stateLabel = state === "unknown" && result ? "状态未知" : states[state].label;
    const recap = recapTool(name, args);
    const { kind, label, operation, target, preview, group } = recap;
    const kindChanged = this.details.dataset.toolKind !== kind;
    if (kindChanged) {
      this.details.dataset.toolKind = kind;
      this.kindIcon.setAttribute("d", toolGlyphs[kind]);
      const outputLabel = toolOutputLabels[kind];
      this.outputLabel.textContent = outputLabel;
      this.output.setAttribute("aria-label", outputLabel === "输出" ? "工具输出" : outputLabel);
      this.scene?.node.remove();
      this.outputSection.remove();
      this.argsSection.remove();
      this.rawArgs.remove();
      this.scene = createToolScene(kind, this.outputSection);
      this.body.classList.toggle("tool-generic", !this.scene);
      if (this.scene) {
        this.rawArgs.append(this.args);
        this.body.append(this.scene.node, this.rawArgs);
      } else {
        this.argsSection.append(this.args);
        this.body.append(this.argsSection, this.outputSection);
      }
    }
    if (this.details.dataset.groupTool !== group) {
      if (group) this.details.dataset.groupTool = group;
      else delete this.details.dataset.groupTool;
    }
    const previousState = this.details.dataset.state;
    if (previousState !== state) {
      this.details.dataset.state = state;
      this.icon.setAttribute("d", states[state].icon);
      if (state === "running" && this.scene) this.details.dataset.toolMotion = "entry";
      else if (previousState === "running" && (state === "success" || state === "error")) this.details.dataset.toolMotion = "settlement";
      else delete this.details.dataset.toolMotion;
    }
    if (this.status.textContent !== stateLabel) this.status.textContent = stateLabel;
    if (this.label.textContent !== label) this.label.textContent = label;
    notice(this.operation, operation);
    notice(this.target, target);
    notice(this.preview, preview);
    notice(this.name, kind === "unknown" || name.toLowerCase() === label.toLowerCase() ? "" : name);
    this.identity.hidden = this.name.hidden;

    const inputChanged = kindChanged || this.lastArgs !== args || this.lastName !== name;
    if (inputChanged || this.lastOutput !== output) this.updateCard(recap, output);
    if (inputChanged) {
      this.scene?.update?.(recap);
      this.argsSection.hidden = this.rawArgs.hidden = args === undefined;
      const code = this.args.firstElementChild;
      const formatted = pretty(args);
      if (code && code.textContent !== formatted) code.textContent = formatted;
      this.lastArgs = args;
      this.lastName = name;
    }
    if (this.lastOutput !== output) {
      const content = typeof output === "string" ? [{ type: "text", text: output }] : list(output);
      const top = this.output.scrollTop;
      const left = this.output.scrollLeft;
      this.output.replaceChildren(...content.flatMap(value => {
        const node = this.renderOutputPart(object(value));
        if (node?.tagName === "PRE") node.removeAttribute("tabindex");
        return node ?? [];
      }));
      this.output.scrollTop = top;
      this.output.scrollLeft = left;
      this.lastOutput = output;
    }
    this.output.hidden = !this.output.childElementCount;
    this.outputLabel.hidden = this.output.hidden;
    this.empty.hidden = !this.output.hidden;
    const placeholder = state === "running" ? "等待工具输出…" : state === "unknown" && !result ? "没有可见的工具结果。" : "无可显示的输出。";
    if (this.empty.textContent !== placeholder) this.empty.textContent = placeholder;
  }
}

type GroupSource = {
  readonly entries: readonly TranscriptEntry[]; readonly start: number; readonly liveKey: string;
  readonly tools: ReadonlyMap<string, ToolTrace>; readonly calls: ReadonlyMap<string, number>;
  readonly results: ReadonlyMap<string, number>;
};

export function groupToolCalls({ entries, start, liveKey, tools, calls, results }: GroupSource): ReadonlyMap<string, readonly Wire[]> {
  const groups = new Map<string, readonly Wire[]>();
  let visibleTurn = false;
  let run: Wire[] = [];
  const endRun = () => {
    if (run.length > 1) for (const call of run) groups.set(str(call.id), run);
    run = [];
  };
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index];
    const message = entry?.message;
    if (!entry || !message || message.role !== "assistant" || !visibleTurn || entry.key === liveKey || message.streaming === true ||
      clipped(message) || str(message.errorMessage) || (message.stopReason !== undefined && message.stopReason !== "toolUse" && message.stopReason !== "stop")) {
      endRun();
      if (message?.role === "user") visibleTurn = !clipped(message);
      continue;
    }
    const content = list(message.content).map(object);
    if (!content.length) { endRun(); continue; }
    const callIds = new Set(content.flatMap(part => part.type === "toolCall" ? str(part.id) || [] : []));
    const settled = new Map<string, Wire>();
    // Only results contiguous with their originating assistant can bridge to the next message.
    for (let next = entries[index + 1]?.message; next?.role === "toolResult"; next = entries[index + 1]?.message) {
      const id = str(next.toolCallId);
      if (!callIds.has(id) || settled.has(id) || results.get(id) !== index + 1) break;
      settled.set(id, next);
      index++;
    }
    // A non-tool part breaks the run at its own position, not at the message boundary.
    for (const call of content) {
      const id = str(call.id);
      const name = str(call.name).toLowerCase();
      const result = settled.get(id);
      const trace = tools.get(id);
      const stage = trace?.stage;
      const args = call.arguments === undefined ? trace?.args : call.arguments;
      if (call.type === "toolCall" && calls.get(id) === 1 && recapTool(name, args).group && !clipped(call) &&
        result?.isError === false && hasPayload(result) && !clipped(result) && !str(result.errorMessage) &&
        (!str(result.toolName) || str(result.toolName).toLowerCase() === name) && (stage === undefined || stage === "done")) {
        run.push(call);
      } else endRun();
    }
  }
  endRun();
  return groups;
}

export function visibleToolTarget(node?: HTMLElement): HTMLElement | undefined {
  if (!node) return;
  const group = node.closest(".tool-group:not([open])");
  return group?.querySelector<HTMLElement>(":scope > summary") ?? node;
}
