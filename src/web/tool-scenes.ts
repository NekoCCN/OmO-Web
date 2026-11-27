import { codeBlock, el, notice } from "./dom.ts";
import { tr } from "./locale.ts";
import { agentPromptLabel, toolCardRows } from "./tool-card.ts";
import type { ToolRecap } from "./tool-semantics.ts";

type ToolScene = {
  readonly node: HTMLElement;
  readonly update?: (recap: ToolRecap) => void;
};

export const toolOutputLabels = {
  inspect: tr("探查结果", "Inspection results"), modify: tr("文件变更回执", "File change receipt"),
  terminal: tr("终端输出", "Terminal output"), todo: tr("待办工具回执", "Todo receipt"),
  memory: tr("记忆工具回执", "Memory receipt"), execution: tr("执行结果", "Execution results"),
  context: tr("上下文结果", "Context results"), agent: tr("任务工具输出", "Agent tool output"),
  web: tr("网页输出", "Web output"), unknown: tr("输出", "Output"),
} satisfies Record<ToolRecap["kind"], string>;

function terminal(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-terminal");
  const command = codeBlock("");
  const code = command.querySelector("code");
  const strip = el("div", "tool-terminal-input");
  command.classList.add("tool-command-preview");
  command.setAttribute("aria-label", tr("提交的命令", "Submitted command"));
  strip.append(el("span", "tool-scene-key", tr("命令", "Command")), command);
  node.append(strip, output);
  return { node, update(recap) {
    strip.hidden = !recap.command;
    if (code) notice(code, recap.command);
  } };
}

function receipt(kind: "todo" | "memory", output: HTMLElement): HTMLDetailsElement {
  const node = el("details", `tool-receipt tool-${kind}-receipt`);
  node.append(el("summary", "", tr("查看原始回执", "View raw receipt")), output);
  return node;
}

function todo(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-todo");
  const submission = el("div", "tool-todo-list");
  const phases = el("div", "tool-todo-board");
  submission.append(el("p", "tool-scene-key", tr("提交的待办", "Tasks submitted")), phases);
  node.append(submission, receipt("todo", output));
  return { node, update(recap) {
    const batches = recap.todo?.batches ?? [];
    submission.hidden = !batches.length;
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
  source.append(el("summary", "", tr("查看原始代码", "View source code")), block);
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
      node.append(el("p", "tool-memory-note small muted", tr("记忆路径与内容默认隐藏。", "Memory paths and content are hidden by default.")), receipt("memory", output));
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
        notice(scope, recap.scope && tr(`范围：${recap.scope}`, `Scope: ${recap.scope}`));
        routes.hidden = !recap.dispatchRoutes;
        if (recap.dispatchRoutes) routes.replaceChildren(el("p", "tool-scene-key", tr("派发配置", "Dispatch settings")), toolCardRows(recap.dispatchRoutes));
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
