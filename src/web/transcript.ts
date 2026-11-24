import { codeBlock, el, fold, isImageType, list, num, object, pretty, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

// Only static element names and text nodes are emitted. Raw HTML, links and remote images stay text.
function inline(parent: HTMLElement, text: string): void {
  const token = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let from = 0;
  for (const match of text.matchAll(token)) {
    const at = match.index ?? 0;
    parent.append(text.slice(from, at), match[1] ? el("code", "", match[1]) : el("strong", "", match[2]));
    from = at + match[0].length;
  }
  parent.append(text.slice(from));
}

function prose(text: string): HTMLElement {
  const output = el("div", "prose");
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  let items: HTMLOListElement | HTMLUListElement | null = null;
  const flush = () => {
    if (paragraph.length) {
      const p = el("p");
      inline(p, paragraph.join("\n"));
      output.append(p);
      paragraph = [];
    }
    items = null;
  };
  for (const line of text.split("\n")) {
    if (code) {
      if (line.trim() === fence) {
        output.append(codeBlock(code.join("\n")));
        code = null;
      } else code.push(line);
    } else if (/^\s*(`{3,}|~{3,})/.test(line)) {
      flush();
      fence = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? "```";
      code = [];
    } else if (!line.trim()) {
      flush();
    } else {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
      if (heading) {
        flush();
        const h = el("h4");
        inline(h, heading[1] ?? "");
        output.append(h);
      } else if (item) {
        const ordered = /^\d/.test(item[1] ?? "");
        if (!items || items.tagName !== (ordered ? "OL" : "UL")) {
          flush();
          items = el(ordered ? "ol" : "ul");
          output.append(items);
        }
        const li = el("li");
        inline(li, item[2] ?? "");
        items.append(li);
      } else paragraph.push(line);
    }
  }
  if (code) output.append(codeBlock(code.join("\n")));
  flush();
  return output;
}

function contents(content: unknown, kind: "markdown" | "plain" | "tool"): Node[] {
  if (typeof content === "string") content = [{ type: "text", text: content }];
  return list(content).flatMap((entry): Node[] => {
    const part = object(entry);
    switch (part.type) {
      case "text": {
        const text = str(part.text);
        if (!text) return [];
        return [kind === "markdown" ? prose(text) : kind === "tool" ? codeBlock(text) : el("p", "plain", text)];
      }
      case "thinking": {
        const thinking = str(part.thinking);
        return thinking ? [fold("思考过程", el("p", "plain muted", thinking))] : [];
      }
      case "toolCall": {
        const args = part.arguments === undefined ? [] : [codeBlock(pretty(part.arguments))];
        return [fold(`工具调用 · ${str(part.name) || "未命名工具"}`, ...args)];
      }
      case "image": {
        const data = str(part.data);
        if (!isImageType(part.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return [el("p", "small muted", "图片内容不可用")];
        const img = el("img");
        img.alt = kind === "tool" ? "工具输出图片" : "消息图片";
        img.loading = "lazy";
        img.src = `data:${part.mimeType};base64,${data}`;
        return [img];
      }
      case "image_placeholder":
      case "imagePlaceholder":
        return [el("p", "small muted", "此图片未包含在会话快照中")];
      default: {
        return Object.keys(part).length ? [el("p", "small muted", `未展开的内容 · ${str(part.type) || "未知类型"}`)] : [];
      }
    }
  });
}

export type TranscriptEntry = { readonly key: string; readonly message: Wire };
export type ToolTrace = { readonly id: string; readonly name: string; readonly args?: unknown; readonly output?: unknown; readonly stage: "running" | "done" | "error" };
export const roleOf = (message: Wire): string => str(message.role);
export const messageKey = (message: Wire): string => {
  if (roleOf(message) === "toolResult" && str(message.toolCallId)) return `result:${str(message.toolCallId)}`;
  if (str(message.id)) return `id:${str(message.id)}`;
  const time = num(message.timestamp);
  return time === undefined ? "" : `${roleOf(message)}:${time}`;
};

function timeLabel(timestamp: unknown): HTMLElement | undefined {
  const value = num(timestamp);
  if (value === undefined) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  const node = el("time", "numerical", date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  node.dateTime = date.toISOString();
  node.title = date.toLocaleString("zh-CN");
  return node;
}

function renderMessage(message: Wire, live: boolean): HTMLElement {
  const role = roleOf(message);
  const node = el("article", `message ${role === "user" ? "message--user" : ""}`);
  const label = role === "assistant" ? live ? "助手 · 正在生成" : "助手" : role === "user" ? "你" : role === "bashExecution" ? "命令输出" : "会话记录";
  const header = el("header");
  header.append(el("span", "speaker", label));
  const time = timeLabel(message.timestamp);
  if (time) header.append(time);
  const body = el("div", "message-body");
  body.append(...contents(message.content, role === "assistant" ? "markdown" : "plain"));
  if (role === "bashExecution" && str(message.output)) body.append(codeBlock(str(message.output)));
  const error = str(message.errorMessage);
  if (error || message.stopReason === "error") body.append(el("p", "notice error small", error || "生成失败"));
  if (message.stopReason === "aborted") body.append(el("p", "muted small", "已停止生成"));
  if (message.stopReason === "length") body.append(el("p", "muted small", "已达到输出长度限制"));
  node.append(header, body);
  return node;
}

function renderTool(tool: ToolTrace | undefined, message: Wire | undefined): HTMLElement {
  const node = el("article", "message message--tool");
  const stage = message?.isError === true || tool?.stage === "error" ? "失败" : message || tool?.stage === "done" ? "结果" : "运行中";
  const name = str(message?.toolName) || tool?.name || "未命名工具";
  const body: Node[] = [];
  if (tool?.args !== undefined) body.push(fold("调用参数", codeBlock(pretty(tool.args))));
  body.push(...contents(message?.content ?? tool?.output, "tool"));
  if (!body.length) body.push(el("p", "muted small", stage === "运行中" ? "等待工具输出…" : "无文本输出"));
  node.append(fold(`工具${stage} · ${name}`, ...body));
  return node;
}

type Cached = { readonly node: HTMLElement; readonly message?: Wire; readonly tool?: ToolTrace; readonly live?: boolean };

export class Transcript {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly root: HTMLElement, private readonly scroller: HTMLElement, private readonly empty: HTMLElement) {}

  reset(): void {
    this.cache.clear();
    this.root.replaceChildren();
    this.scroller.scrollTop = 0;
  }

  render(entries: readonly TranscriptEntry[], liveKey: string, tools: ReadonlyMap<string, ToolTrace>, forceBottom = false): void {
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    const nearEnd = scrollHeight - clientHeight - scrollTop < 72;
    const remaining = new Map(tools);
    const keys = new Set<string>();
    let next: ChildNode | null = this.root.firstChild;
    const add = (key: string, message?: Wire, tool?: ToolTrace, live = false) => {
      keys.add(key);
      const previous = this.cache.get(key);
      let node = previous?.node;
      if (!node || previous?.message !== message || previous?.tool !== tool || previous?.live !== live) {
        const fresh = tool || message?.role === "toolResult" ? renderTool(tool, message) : renderMessage(message ?? {}, live);
        if (node) {
          const oldDetails = [...node.querySelectorAll("details")];
          fresh.querySelectorAll("details").forEach((current, index) => { current.open = oldDetails[index]?.open ?? false; });
          node.className = fresh.className;
          node.replaceChildren(...fresh.childNodes);
        } else node = fresh;
        this.cache.set(key, { node, message, tool, live });
      }
      if (node !== next) this.root.insertBefore(node, next);
      next = node.nextSibling;
    };
    for (const entry of entries) {
      if (entry.message.role === "toolResult") {
        const id = str(entry.message.toolCallId);
        add(id ? `tool:${id}` : entry.key, entry.message, remaining.get(id));
        remaining.delete(id);
      } else add(entry.key, entry.message, undefined, entry.key === liveKey);
    }
    for (const [id, tool] of remaining) add(`tool:${id}`, undefined, tool);
    for (const [key, entry] of this.cache) if (!keys.has(key)) {
      entry.node.remove();
      this.cache.delete(key);
    }
    this.empty.hidden = keys.size > 0;
    if (forceBottom || nearEnd) this.scroller.scrollTop = this.scroller.scrollHeight;
  }
}
