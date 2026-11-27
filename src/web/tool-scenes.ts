import { codeBlock, el, notice } from "./dom.ts";
import { agentPromptLabel, toolCardRows } from "./tool-card.ts";
import type { ToolRecap } from "./tool-semantics.ts";

type ToolScene = {
  readonly node: HTMLElement;
  readonly update?: (recap: ToolRecap) => void;
};

export const toolOutputLabels = {
  inspect: "探查结果", modify: "文件变更回执", terminal: "终端输出", todo: "待办工具回执",
  memory: "记忆工具回执", execution: "执行结果", context: "上下文结果", agent: "任务工具输出",
  web: "网页输出", unknown: "输出",
} satisfies Record<ToolRecap["kind"], string>;

function terminal(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-terminal");
  const command = codeBlock("");
  const code = command.querySelector("code");
  const strip = el("div", "tool-terminal-input");
  command.classList.add("tool-command-preview");
  command.setAttribute("aria-label", "提交的命令");
  strip.append(el("span", "tool-scene-key", "命令"), command);
  node.append(strip, output);
  return { node, update(recap) {
    strip.hidden = !recap.command;
    if (code) notice(code, recap.command);
  } };
}

function receipt(kind: "todo" | "memory", output: HTMLElement): HTMLDetailsElement {
  const node = el("details", `tool-receipt tool-${kind}-receipt`);
  node.append(el("summary", "", "查看原始回执"), output);
  return node;
}

function todo(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-todo");
  const submission = el("div", "tool-todo-list");
  const phases = el("div", "tool-todo-board");
  const requested = el("p", "tool-todo-request small muted", "这是请求的变更，非当前进度。");
  submission.append(el("p", "tool-scene-key", "提交的待办 · 非当前进度"), phases);
  node.append(submission, requested, receipt("todo", output));
  return { node, update(recap) {
    const batches = recap.todo?.batches ?? [];
    submission.hidden = !batches.length;
    requested.hidden = !recap.todo?.requested;
    let start = 1;
    phases.replaceChildren(...batches.map(batch => {
      const lane = el("div", "tool-todo-lane stack stack--tight");
      const items = el("ol");
      items.start = start;
      start += batch.items.length;
      items.append(...batch.items.map(item => el("li", "", item)));
      if (batch.phase) lane.append(el("p", "small", batch.phase));
      lane.append(items);
      return lane;
    }));
  } };
}

function execution(output: HTMLElement, context: boolean): ToolScene {
  const node = el("div", `tool-scene tool-code-desk tool-code-desk--${context ? "context" : "execution"}`);
  const source = el("details", "tool-source");
  const block = codeBlock("");
  const code = block.querySelector("code");
  source.append(el("summary", "", "查看原始代码"), block);
  node.append(source, output);
  return { node, update(recap) {
    source.hidden = !recap.source;
    if (code) notice(code, recap.source);
  } };
}

export function createToolScene(kind: ToolRecap["kind"], output: HTMLElement): ToolScene | undefined {
  switch (kind) {
    case "terminal": return terminal(output);
    case "todo": return todo(output);
    case "memory": {
      const node = el("div", "tool-scene tool-memory-audit");
      node.append(el("p", "tool-memory-note small muted", "记忆路径与内容默认隐藏。"), receipt("memory", output));
      return { node };
    }
    case "execution": return execution(output, false);
    case "context": return execution(output, true);
    case "inspect":
    case "modify": {
      const node = el("div", `tool-scene tool-file tool-file--${kind}`);
      node.append(output);
      return { node };
    }
    case "agent": {
      const node = el("div", "tool-scene tool-agent");
      const scope = el("p", "tool-agent-scope small muted");
      const routes = el("div", "stack stack--tight");
      const prompts = el("div", "stack stack--tight");
      let shown: readonly string[] = [];
      prompts.hidden = true;
      node.append(scope, routes, prompts, output);
      return { node, update(recap) {
        notice(scope, recap.scope && `范围：${recap.scope}`);
        routes.hidden = !recap.dispatchRoutes;
        if (recap.dispatchRoutes) routes.replaceChildren(el("p", "tool-scene-key", "派发配置"), toolCardRows(recap.dispatchRoutes));
        const next = recap.agentPrompts ?? [];
        if (next.length === shown.length && next.every((prompt, index) => prompt === shown[index])) return;
        shown = next;
        prompts.hidden = !next.length;
        prompts.replaceChildren(...next.flatMap((prompt, index) => {
          const label = agentPromptLabel(index, next.length);
          const block = codeBlock(prompt);
          block.classList.add("tool-agent-prompt");
          block.setAttribute("aria-label", label);
          return [el("p", "tool-scene-key", label), block];
        }));
      } };
    }
    case "web": {
      const node = el("div", "tool-scene tool-web");
      node.append(output);
      return { node };
    }
    case "unknown": return undefined;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
