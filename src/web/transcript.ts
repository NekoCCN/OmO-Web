import { button, codeBlock, el, fold, isImageType, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { groupToolCalls, ToolDisplay, visibleToolTarget } from "./tool-display.ts";
import type { ToolTrace } from "./tool-display.ts";
export type { ToolTrace } from "./tool-display.ts";

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

const proseProgress = new WeakMap<HTMLElement, { readonly text: string; readonly end: number; readonly children: number }>();

function prose(text: string, node: HTMLElement = el("div", "prose")): HTMLElement {
  const before = proseProgress.get(node);
  if (before?.text === text) return node;
  const keep = before && text.startsWith(before.text.slice(0, before.end)) ? before : undefined;
  const output = document.createDocumentFragment();
  let offset = keep?.end ?? 0;
  let end = offset;
  let children = keep?.children ?? 0;
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
  const seal = () => {
    // An unterminated line can still change its Markdown meaning.
    if (offset <= text.length) {
      end = offset;
      children = (keep?.children ?? 0) + output.childElementCount;
    }
  };
  for (const line of text.slice(offset).split("\n")) {
    offset += line.length + 1;
    if (code) {
      if (line.trim() === fence) {
        output.append(codeBlock(code.join("\n")));
        code = null;
        seal();
      } else code.push(line);
    } else if (/^\s*(`{3,}|~{3,})/.test(line)) {
      flush();
      fence = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? "```";
      code = [];
    } else if (!line.trim()) {
      flush();
      seal();
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
  while (node.childElementCount > (keep?.children ?? 0)) node.lastElementChild?.remove();
  node.append(output);
  proseProgress.set(node, { text, end, children });
  return node;
}

function parts(content: unknown): readonly unknown[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : list(content);
}

function renderPart(part: Wire, kind: "markdown" | "plain" | "tool", previous?: HTMLElement): HTMLElement | undefined {
  if (kind === "tool" && part.type !== "text" && part.type !== "image" && part.type !== "image_placeholder" && part.type !== "imagePlaceholder") return;
  switch (part.type) {
    case "text": {
      const text = str(part.text);
      if (!text) return;
      return kind === "markdown" ? prose(text, previous) : kind === "tool" ? codeBlock(text) : el("p", "plain", text);
    }
    case "thinking": {
      const thinking = str(part.thinking);
      if (!thinking) return;
      const text = previous?.querySelector(".plain");
      if (previous && text) {
        text.textContent = thinking;
        return previous;
      }
      return fold("思考过程", el("p", "plain muted", thinking));
    }
    case "image": {
      const data = str(part.data);
      if (!isImageType(part.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return el("p", "small muted", "图片内容不可用");
      const img = el("img");
      img.alt = kind === "tool" ? "工具输出图片" : "消息图片";
      img.loading = "lazy";
      img.src = `data:${part.mimeType};base64,${data}`;
      return img;
    }
    case "image_placeholder":
    case "imagePlaceholder":
      return el("p", "small muted", "此图片未包含在会话快照中");
    default:
      return Object.keys(part).length ? el("p", "small muted", `未展开的内容 · ${str(part.type) || "未知类型"}`) : undefined;
  }
}

export type TranscriptEntry = { readonly key: string; readonly message: Wire };
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

type PartView = { readonly part: Wire; readonly node?: HTMLElement };
type MessageView = {
  readonly node: HTMLElement; readonly body: HTMLElement; readonly header: HTMLElement; readonly speaker: HTMLElement;
  readonly time?: HTMLElement; readonly timestamp: unknown; readonly role: string;
  readonly parts: readonly PartView[]; readonly notices: readonly HTMLElement[]; readonly metadata: string;
};

function renderMessage(message: Wire, live: boolean, renderCall: (part: Wire, index: number) => HTMLElement | undefined, previous?: MessageView): MessageView {
  const role = roleOf(message);
  const before = previous?.role === role ? previous : undefined;
  const node = before?.node ?? el("article", `message ${role === "user" ? "message--user" : ""}`);
  const speaker = before?.speaker ?? el("span", "speaker");
  const label = role === "assistant" ? live ? "助手 · 正在生成" : "助手" : role === "user" ? "你" : role === "bashExecution" ? "命令输出" : "会话记录";
  if (speaker.textContent !== label) speaker.textContent = label;
  const body = before?.body ?? el("div", "message-body");
  const time = before?.timestamp === message.timestamp ? before?.time : timeLabel(message.timestamp);
  const header = before?.header ?? el("header");
  if (!before) { header.append(speaker); node.append(body); }
  if (before?.time !== time) {
    before?.time?.remove();
    if (time) speaker.after(time);
  }
  const rendered = parts(message.content).map((entry, index): PartView => {
    const part = object(entry);
    if (part.type === "toolCall") return { part, node: renderCall(part, index) };
    const old = before?.parts[index];
    if (old) {
      const keys = Object.keys(part);
      if (old.part === part || (keys.length === Object.keys(old.part).length && keys.every(key => Object.hasOwn(old.part, key) && part[key] === old.part[key]))) return old;
    }
    const oldNode = old?.part.type === part.type ? old?.node : undefined;
    const current = renderPart(part, role === "assistant" ? "markdown" : "plain", oldNode);
    if (current instanceof HTMLDetailsElement && oldNode instanceof HTMLDetailsElement) current.open = oldNode.open;
    return { part, node: current };
  });
  const error = str(message.errorMessage);
  const output = role === "bashExecution" ? str(message.output) : "";
  const stop = str(message.stopReason);
  const metadata = JSON.stringify([output, error, stop]);
  const notices = before?.metadata === metadata ? before.notices : [
    ...(output ? [codeBlock(output)] : []),
    ...(error || stop === "error" ? [el("p", "notice error small", error || "生成失败")] : []),
    ...(stop === "aborted" ? [el("p", "muted small", "已停止生成")] : []),
    ...(stop === "length" ? [el("p", "muted small", "已达到输出长度限制")] : []),
  ];
  const toolOnly = role === "assistant" && !notices.length && rendered.some(({ part }) => part.type === "toolCall")
    && rendered.every(({ part, node }) => part.type === "toolCall" || !node || (part.type === "text" && !str(part.text).trim()));
  node.classList.toggle("message--tool-only", toolOnly);
  if (toolOnly) header.remove();
  else if (header.parentNode !== node) node.prepend(header);
  const content = (toolOnly ? rendered.filter(({ part }) => part.type === "toolCall") : rendered).flatMap(part => part.node ?? []);
  const kept = new Set(content);
  for (const old of before?.parts ?? []) if (old.node?.parentNode === body && !kept.has(old.node)) old.node.remove();
  if (before && before.notices !== notices) for (const old of before.notices) old.remove();
  let next = body.firstElementChild;
  for (const current of [...content, ...notices]) {
    if (current !== next) body.insertBefore(current, next);
    next = current.nextElementSibling;
  }
  return { node, body, header, speaker, time, timestamp: message.timestamp, role, parts: rendered, notices, metadata };
}

type Row = { readonly key: string; readonly message?: Wire; readonly tool?: ToolTrace; readonly live?: boolean; readonly hasCalls?: boolean };
type Cached = { readonly message: Wire; readonly live: boolean; readonly view: MessageView };
type RenderInput = {
  readonly entries: readonly TranscriptEntry[]; readonly liveKey: string; readonly tools: ReadonlyMap<string, ToolTrace>;
};
const pageSize = 80;

type TraceTargets = {
  readonly user?: HTMLElement; readonly assistant?: HTMLElement; readonly tool?: HTMLElement;
};

export class Transcript {
  private readonly cache = new Map<string, Cached>();
  private readonly openFolds = new Map<string, readonly number[]>();
  private readonly toolViews = new Map<string, ToolDisplay>();
  private readonly openTools = new Set<string>();
  private readonly results = new Map<string, number>();
  private readonly older = button("加载更早消息", () => this.flush(true), "transcript-load");
  private readonly status = el("span", "sr-only");
  private latest?: RenderInput;
  private frame?: number;
  private forceBottom = false;
  private limit = pageSize;
  private start = 0;
  private first?: string;
  private displayed?: readonly TranscriptEntry[];
  private indexed?: readonly TranscriptEntry[];
  private indexedLength = 0;
  private trace?: (targets: TraceTargets) => void;

  constructor(private readonly root: HTMLElement, private readonly scroller: HTMLElement, private readonly empty: HTMLElement) {
    this.status.setAttribute("role", "status");
  }

  observeTrace(update: (targets: TraceTargets) => void): void {
    this.trace = update;
  }

  reset(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.latest = this.displayed = this.indexed = undefined;
    this.first = undefined;
    this.forceBottom = false;
    this.limit = pageSize;
    this.start = this.indexedLength = 0;
    this.cache.clear();
    this.openFolds.clear();
    this.toolViews.clear();
    this.openTools.clear();
    this.results.clear();
    this.root.replaceChildren();
    this.status.textContent = "";
    this.empty.hidden = false;
    this.scroller.scrollTop = 0;
    this.trace?.({});
  }

  render(entries: readonly TranscriptEntry[], liveKey: string, tools: ReadonlyMap<string, ToolTrace>, forceBottom = false): void {
    this.latest = { entries, liveKey, tools };
    this.forceBottom ||= forceBottom;
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined;
      this.flush();
    });
  }

  private indexResults(entries: readonly TranscriptEntry[]): void {
    // The live caller replaces messages in place by key and appends; snapshots replace the array.
    if (this.indexed !== entries || this.indexedLength > entries.length) {
      this.indexed = entries;
      this.indexedLength = 0;
      this.results.clear();
    }
    for (; this.indexedLength < entries.length; this.indexedLength++) {
      const message = entries[this.indexedLength]?.message;
      const id = str(message?.toolCallId);
      if (message?.role === "toolResult" && id) this.results.set(id, this.indexedLength);
    }
  }

  private flush(expand = false): void {
    if (!this.latest || (expand && !this.start)) return;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    const { entries, liveKey, tools } = this.latest;
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    const active = document.activeElement;
    const rowFocus = active instanceof HTMLElement && this.root.contains(active)
      && (active.closest(".tool-details, .tool-group") || (this.trace && active.matches(".message[tabindex='-1']"))) ? active : undefined;
    const toolFocus = rowFocus?.matches(".tool-group-summary")
      ? rowFocus.parentElement?.querySelector<HTMLElement>(".tool-summary")
      : rowFocus?.querySelector<HTMLElement>(".tool-summary");
    const nearEnd = scrollHeight - clientHeight - scrollTop < 72;
    const follow = this.forceBottom || (nearEnd && !rowFocus);
    this.forceBottom = false;
    const boundary = expand && this.older.nextElementSibling instanceof HTMLElement ? this.older.nextElementSibling : undefined;
    const toolBoundary = boundary?.querySelector<HTMLElement>(".tool-summary") ?? undefined;
    const readingAnchor = expand && rowFocus?.closest(".tool-details, .tool-group") && boundary?.contains(rowFocus) ? rowFocus : boundary;
    const previousTop = readingAnchor?.getBoundingClientRect().top;
    const moveFocus = expand && document.activeElement === this.older;
    this.indexResults(entries);
    const dangling: Row[] = [];
    for (const [id, tool] of tools) if (!this.results.has(id)) dangling.push({ key: `result:${id}`, tool });
    const total = entries.length + dangling.length;
    const tail = Math.max(0, total - this.limit);
    if (!this.displayed || (follow && !expand)) this.start = tail;
    else {
      if (entries !== this.displayed && this.first) {
        const index = entries.findIndex(entry => entry.key === this.first);
        if (index >= 0) this.start = index;
      }
      this.start = Math.min(this.start, tail);
    }
    let loaded = 0;
    if (expand) {
      loaded = Math.min(this.start, pageSize);
      this.start -= loaded;
      this.limit = Math.max(this.limit, total - this.start);
    }
    this.displayed = entries;
    this.first = entries[this.start]?.key;
    const rows: Row[] = [];
    const visibleCalls = new Map<string, number>();
    for (let index = this.start; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const { message } = entry;
      if (message.role === "toolResult") {
        const id = str(message.toolCallId);
        if (!id || this.results.get(id) === index) rows.push({ ...entry, tool: tools.get(id) });
      } else {
        let hasCalls = false;
        if (message.role === "assistant") for (const value of parts(message.content)) {
          const part = object(value);
          if (part.type !== "toolCall") continue;
          hasCalls = true;
          const id = str(part.id);
          if (id) visibleCalls.set(id, (visibleCalls.get(id) ?? 0) + 1);
        }
        rows.push({ ...entry, live: entry.key === liveKey, hasCalls });
      }
    }
    for (let index = Math.max(0, this.start - entries.length); index < dangling.length; index++) rows.push(dangling[index]);
    const groups = groupToolCalls({ entries, start: this.start, liveKey, tools, calls: visibleCalls, results: this.results });
    const keys = new Set(rows.filter(row => row.message && row.message.role !== "toolResult").map(row => row.key));
    for (const [key, entry] of this.cache) if (!keys.has(key)) {
      const open = [...entry.view.body.querySelectorAll<HTMLDetailsElement>(":scope > details:not(.tool-group)")].flatMap((fold, index) => fold.open ? [index] : []);
      if (open.length) this.openFolds.set(key, open);
      entry.view.node.remove();
      this.cache.delete(key);
    }
    const usedTools = new Set<string>();
    let latestTool: HTMLElement | undefined;
    const renderTool = (key: string, call?: Wire, tool?: ToolTrace, result?: Wire): HTMLElement | undefined => {
      if (usedTools.has(key)) return;
      usedTools.add(key);
      let view = this.toolViews.get(key);
      if (!view) {
        view = new ToolDisplay(part => renderPart(part, "tool"));
        view.open = this.openTools.delete(key);
        this.toolViews.set(key, view);
      }
      view.update(call, tool, result);
      if (this.trace && (tool?.id || str(call?.id) || str(call?.name) || str(result?.toolCallId) || str(result?.toolName))) {
        latestTool = view.node;
      }
      return view.node;
    };
    if (this.older.parentNode !== this.root) this.root.prepend(this.status, this.older);
    this.older.hidden = !this.start;
    const label = `加载更早消息（${this.start} 条）`;
    if (this.older.textContent !== label) this.older.textContent = label;
    const renderCall = (key: string, part: Wire): HTMLElement | undefined => {
      const id = str(part.id);
      const result = this.results.get(id);
      return renderTool(id ? `id:${id}` : key, part, tools.get(id), result === undefined ? undefined : entries[result]?.message);
    };
    let last: Element = this.older;
    let latestUser: HTMLElement | undefined;
    let latestAssistant: HTMLElement | undefined;
    for (const row of rows) {
      const { message } = row;
      let node: HTMLElement | undefined;
      if (!message || message.role === "toolResult") {
        const id = str(message?.toolCallId) || row.tool?.id;
        if (id && visibleCalls.has(id)) continue;
        node = renderTool(id ? `id:${id}` : `row:${row.key}`, undefined, row.tool, message);
      } else {
        let groupedElsewhere = false;
        node = this.updateMessage(row, message, (part, index) => {
          const id = str(part.id);
          const group = groups.get(id);
          const key = `part:${row.key}:${index}`;
          if (!group) return renderCall(key, part);
          if (group[0] !== part) { groupedElsewhere = true; return; }
          const members = group.flatMap(call => renderCall(key, call) ?? []);
          return this.toolViews.get(`id:${id}`)?.groupWith(members);
        });
        if (groupedElsewhere && node.classList.contains("message--tool-only") && !this.cache.get(row.key)?.view.body.childElementCount) {
          node.remove();
          continue;
        }
        if (this.trace && (message.role === "user" || message.role === "assistant")) {
          const rendered = this.cache.get(row.key)?.view.parts;
          if (rendered?.some(({ part, node }) => node && part.type !== "toolCall" && part.type !== "thinking"
            && (part.type !== "text" || str(part.text).trim()))) {
            if (message.role === "user") latestUser = node;
            else latestAssistant = node;
          }
        }
      }
      if (!node) continue;
      const next = last.nextElementSibling;
      if (node !== next) this.root.insertBefore(node, next);
      last = node;
    }
    for (const [key, view] of this.toolViews) if (!usedTools.has(key)) {
      if (view.open) this.openTools.add(key);
      view.node.remove();
      this.toolViews.delete(key);
    }
    if (rowFocus && document.activeElement === document.body) {
      const target = this.root.contains(rowFocus) ? rowFocus : toolFocus;
      if (target && this.root.contains(target)) visibleToolTarget(target)?.focus({ preventScroll: true });
    }
    this.empty.hidden = total > 0;
    const tool = latestTool?.closest(".tool-group") ?? latestTool;
    this.trace?.({ user: latestUser, assistant: latestAssistant, tool: tool?.querySelector("summary") ?? undefined });
    if (expand) {
      if (loaded) this.status.textContent = `已加载 ${loaded} 条更早消息。`;
      const anchor = readingAnchor && this.root.contains(readingAnchor)
        ? visibleToolTarget(readingAnchor) : visibleToolTarget(toolBoundary);
      if (anchor && this.root.contains(anchor) && previousTop !== undefined) {
        if (moveFocus) {
          if (anchor.tagName !== "SUMMARY") anchor.tabIndex = -1;
          anchor.focus({ preventScroll: true });
        }
        this.scroller.scrollTop += anchor.getBoundingClientRect().top - previousTop;
      } else if (moveFocus) this.scroller.focus({ preventScroll: true });
    } else if (follow) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private updateMessage(row: Row, message: Wire, renderCall: (part: Wire, index: number) => HTMLElement | undefined): HTMLElement {
    const { key, hasCalls } = row;
    const live = Boolean(row.live);
    const previous = this.cache.get(key);
    if (!hasCalls && previous && previous.message === message && previous.live === live) return previous.view.node;
    const view = renderMessage(message, live, renderCall, previous?.view);
    if (previous && view.node !== previous.view.node) previous.view.node.remove();
    if (!previous) {
      const open = this.openFolds.get(key);
      if (open) {
        const folds = view.body.querySelectorAll<HTMLDetailsElement>(":scope > details:not(.tool-group)");
        for (const index of open) if (folds[index]) folds[index].open = true;
        this.openFolds.delete(key);
      }
    }
    this.cache.set(key, { message, live, view });
    return view.node;
  }
}
