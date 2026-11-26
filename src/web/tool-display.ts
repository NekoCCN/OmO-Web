import { codeBlock, el, list, object, pretty, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
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
} as const;

function toolState(trace?: ToolTrace, result?: Wire): keyof typeof states {
  if (typeof result?.isError === "boolean") return result.isError ? "error" : "success";
  if (trace?.stage === "error") return "error";
  if (trace?.stage === "done") return "success";
  return !result && trace?.stage === "running" ? "running" : "unknown";
}

function localTarget(value: unknown): string {
  const path = str(value);
  if (!path || path.length > 512 || !/^[\p{L}\p{M}\p{N}_.~ /\\-]+$/u.test(path) || path.startsWith("-")) return "";
  if (path === "." || path === ".." || path === "~") return path;
  const segments = path.split(/[/\\]/).filter(Boolean);
  if (segments.some(segment => /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[A-Z0-9]{16}$)/.test(segment))) return "";
  if (!/[/\\]/.test(path) && !/^(?:[\p{L}_][\p{L}\p{M}\p{N}_-]{0,23}|[\p{L}\p{N}_-]*\.[\p{L}\p{N}]{1,10})$/u.test(path)) return "";
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

function recap(name: string, args: unknown): { readonly label: string; readonly target?: string } {
  const { path, file_path, filePath } = object(args);
  switch (name.toLowerCase()) {
    case "read": case "read_file": return { label: "读取文件", target: localTarget(path ?? file_path ?? filePath) };
    case "edit": case "edit_file": case "multiedit": case "apply_patch": return { label: "编辑文件", target: localTarget(path ?? file_path ?? filePath) };
    case "write": case "write_file": return { label: "写入文件", target: localTarget(path ?? file_path ?? filePath) };
    case "grep": case "search": return { label: "搜索内容", target: localTarget(path) };
    case "find": case "glob": return { label: "查找文件", target: localTarget(path) };
    case "ls": return { label: "列出目录", target: localTarget(path) };
    case "bash": case "shell": case "powershell": return { label: "运行命令" };
    default: return { label: /^[\p{L}\p{N}_.:-]{1,80}$/u.test(name) ? name : "工具调用" };
  }
}

type RenderOutputPart = (part: Wire) => HTMLElement | undefined;

export class ToolDisplay {
  readonly node = el("article", "message message--tool");
  private readonly details = el("details", "tool-details");
  private readonly label = el("span", "tool-label");
  private readonly target = el("span", "tool-target path");
  private readonly status = el("span", "tool-state-text");
  private readonly icon = document.createElementNS("http://www.w3.org/2000/svg", "path");
  private readonly name = el("code");
  private readonly args = codeBlock("");
  private readonly argsSection = el("div", "stack stack--tight");
  private readonly output = el("div", "tool-output stack stack--tight");
  private readonly empty = el("p", "muted small");
  private lastArgs?: unknown;
  private lastOutput?: unknown;
  private group?: { readonly node: HTMLDetailsElement; readonly summary: HTMLElement; readonly body: HTMLElement };

  constructor(private readonly renderOutputPart: RenderOutputPart) {
    const summary = el("summary", "tool-summary");
    const chevron = el("span", "tool-chevron");
    chevron.setAttribute("aria-hidden", "true");
    const subject = el("span", "tool-subject");
    subject.append(this.label, this.target);
    const state = el("span", "tool-state");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.append(this.icon);
    state.append(svg, this.status);
    summary.append(chevron, subject, state);

    const name = el("p", "tool-name small muted", "工具名：");
    name.append(this.name);
    this.argsSection.append(el("p", "small muted", "调用参数"), this.args);
    this.output.tabIndex = 0;
    this.output.setAttribute("role", "region");
    this.output.setAttribute("aria-label", "工具输出");
    const outputSection = el("div", "stack stack--tight");
    outputSection.append(el("p", "small muted", "输出"), this.output, this.empty);
    const body = el("div", "fold-body stack stack--tight");
    body.append(name, this.argsSection, outputSection);
    this.details.append(summary, body);
    this.node.append(this.details);
  }

  get open(): boolean { return this.details.open; }
  set open(value: boolean) { this.details.open = value; }

  groupWith(members: readonly HTMLElement[]): HTMLDetailsElement {
    if (!this.group) {
      const node = el("details", "tool-group");
      const summary = el("summary", "tool-group-summary");
      const body = el("div", "tool-group-body");
      node.append(summary, body);
      this.group = { node, summary, body };
    }
    const { node, summary, body } = this.group;
    const label = `探查工具 · ${members.length} 项成功`;
    if (summary.textContent !== label) summary.textContent = label;
    let next = body.firstElementChild;
    for (const member of members) {
      if (member.parentElement !== body && (member.contains(document.activeElement) || member.querySelector(".tool-details[open]"))) {
        node.open = true;
      }
      if (member !== next) body.insertBefore(member, next);
      next = member.nextElementSibling;
    }
    while (next) {
      const remaining = next.nextElementSibling;
      next.remove();
      next = remaining;
    }
    return node;
  }

  update(call?: Wire, trace?: ToolTrace, result?: Wire): void {
    const name = str(call?.name) || trace?.name || str(result?.toolName);
    const args = call?.arguments === undefined ? trace?.args : call.arguments;
    const output = result?.content ?? trace?.output;
    const state = toolState(trace, result);
    const stateLabel = state === "unknown" && result ? "状态未知" : states[state].label;
    const { label, target } = recap(name, args);
    if (this.details.dataset.state !== state) {
      this.details.dataset.state = state;
      this.icon.setAttribute("d", states[state].icon);
    }
    if (this.status.textContent !== stateLabel) this.status.textContent = stateLabel;
    if (this.label.textContent !== label) this.label.textContent = label;
    if (this.target.textContent !== (target ?? "")) this.target.textContent = target ?? "";
    this.target.hidden = !target;
    if (this.name.textContent !== (name || "未命名工具")) this.name.textContent = name || "未命名工具";

    this.argsSection.hidden = args === undefined;
    if (this.lastArgs !== args) {
      const code = this.args.firstElementChild;
      if (code) code.textContent = pretty(args);
      this.lastArgs = args;
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
    this.empty.hidden = !this.output.hidden;
    const placeholder = state === "running" ? "等待工具输出…" : state === "unknown" && !result ? "没有可见的工具结果。" : "无可显示的输出。";
    if (this.empty.textContent !== placeholder) this.empty.textContent = placeholder;
  }
}

const inspectionTools = new Set(["read", "read_file", "grep", "find", "glob", "ls", "list", "list_dir", "list_directory", "list_files"]);
const clipped = (message: Wire): boolean => message.truncated === true || message.partial === true;

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
      const stage = tools.get(id)?.stage;
      if (call.type === "toolCall" && calls.get(id) === 1 && inspectionTools.has(name) && !clipped(call) &&
        result?.isError === false && !clipped(result) && !str(result.errorMessage) &&
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
