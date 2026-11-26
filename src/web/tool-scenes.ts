import { codeBlock, el, notice } from "./dom.ts";
import { agentRouting, codeDesk, submittedTodo } from "./tool-semantics.ts";
import type { ToolRecap } from "./tool-semantics.ts";

type ToolScene = {
  readonly node: HTMLElement;
  readonly update: (recap: ToolRecap, name: string, args: unknown) => void;
};

function sceneHeader(title: string): { readonly node: HTMLElement; readonly meta: HTMLElement } {
  const node = el("div", "tool-scene-head row row--between");
  const meta = el("span", "tool-scene-meta");
  node.append(el("p", "tool-scene-title", title), meta);
  return { node, meta };
}

function terminal(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-terminal");
  const { node: head, meta } = sceneHeader("终端");
  const command = codeBlock("");
  const code = command.querySelector("code");
  const strip = el("div", "tool-terminal-input");
  command.classList.add("tool-command-preview");
  command.setAttribute("aria-label", "提交的命令");
  strip.append(el("span", "tool-scene-key", "命令"), command);
  node.append(head, strip, output);
  return { node, update(recap) {
    notice(meta, [recap.label, recap.operation].filter(Boolean).join(" · "));
    strip.hidden = !recap.command;
    if (code) notice(code, recap.command);
  } };
}

function todo(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-todo");
  const { node: head, meta } = sceneHeader("待办面板");
  const board = el("div", "tool-todo-list");
  const phases = el("div", "tool-todo-board");
  board.append(el("p", "tool-scene-key", "提交的待办 · 非当前进度"), phases);
  node.append(head, board, output);
  return { node, update(recap, _name, args) {
    notice(meta, recap.operation);
    const batches = submittedTodo(args);
    board.hidden = !batches.length;
    phases.replaceChildren(...batches.map(batch => {
      const lane = el("div", "tool-todo-lane stack stack--tight");
      const items = el("ol");
      items.append(...batch.items.map(item => el("li", "", item)));
      if (batch.phase) lane.append(el("p", "small", batch.phase));
      lane.append(items);
      return lane;
    }));
  } };
}

function memory(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-memory-audit");
  const { node: head, meta } = sceneHeader("记忆审计");
  const receipt = el("details", "tool-memory-receipt");
  receipt.append(el("summary", "", "查看原始回执"), output);
  node.append(head, el("p", "tool-memory-note small muted", "记忆路径与内容默认隐藏。"), receipt);
  return { node, update(recap) {
    notice(meta, recap.operation ?? "未识别操作");
  } };
}

function execution(output: HTMLElement, context: boolean): ToolScene {
  const node = el("div", "tool-scene tool-code-desk");
  const { node: head, meta } = sceneHeader(context ? "上下文工作区" : "脚本工作区");
  const source = el("details", "tool-source");
  const block = codeBlock("");
  const code = block.querySelector("code");
  source.append(el("summary", "", "查看原始代码"), block);
  node.append(head, source, output);
  return { node, update(recap, name, args) {
    const { language, source: original } = codeDesk(recap, name, args);
    notice(meta, [recap.operation ?? "未识别操作", language].filter(Boolean).join(" · "));
    source.hidden = !original;
    if (code) notice(code, original);
  } };
}

function file(output: HTMLElement, action: boolean): ToolScene {
  const node = el("div", "tool-scene tool-file");
  const { node: head, meta } = sceneHeader(action ? "文件操作" : "文件检查");
  const target = el("div", "tool-file-target");
  const path = el("code", "path");
  target.append(el("span", "tool-scene-key", "提交路径"), path);
  node.append(head, target, output);
  return { node, update(recap) {
    notice(meta, recap.label);
    notice(path, recap.target);
    target.hidden = !recap.target;
  } };
}

function agent(output: HTMLElement): ToolScene {
  const node = el("div", "tool-scene tool-agent");
  const { node: head, meta } = sceneHeader("代理任务");
  const routing = el("dl", "tool-agent-routing");
  node.append(head, routing, output);
  return { node, update(recap, name, args) {
    notice(meta, recap.operation);
    const fields = agentRouting(name, args);
    routing.hidden = !fields.length;
    routing.replaceChildren(...fields.map(([key, value]) => {
      const field = el("div");
      field.append(el("dt", "tool-scene-key", key), el("dd", "", value));
      return field;
    }));
  } };
}

export function createToolScene(kind: ToolRecap["kind"], output: HTMLElement): ToolScene | undefined {
  switch (kind) {
    case "terminal": return terminal(output);
    case "todo": return todo(output);
    case "memory": return memory(output);
    case "execution": return execution(output, false);
    case "context": return execution(output, true);
    case "inspect": return file(output, false);
    case "modify": return file(output, true);
    case "agent": return agent(output);
    case "web": case "unknown": return undefined;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
