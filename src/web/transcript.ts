import { button, codeBlock, el, fold, isImageType, list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";
import { markdownRichLimit, prose } from "./markdown.ts";
import { groupToolCalls, ToolDisplay, visibleToolTarget } from "./tool-display.ts";
import type { ToolTrace } from "./tool-display.ts";
import type { HistoryContent, HistoryControl, HistoryRender } from "./transcript-history.ts";
export type { ToolTrace } from "./tool-display.ts";

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
      return fold(tr("思考过程", "Thinking"), el("p", "plain muted", thinking));
    }
    case "image": {
      const data = str(part.data);
      if (!isImageType(part.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return el("p", "small muted", tr("图片内容不可用", "Image unavailable"));
      const img = el("img");
      img.alt = kind === "tool" ? tr("工具输出图片", "Tool output image") : tr("消息图片", "Image attached to message");
      img.loading = "lazy";
      img.src = `data:${part.mimeType};base64,${data}`;
      return img;
    }
    case "image_placeholder":
    case "imagePlaceholder":
      return el("p", "small muted", tr("此图片未包含在会话快照中", "This image is not included in the session snapshot."));
    default: {
      const type = str(part.type) || tr("未知类型", "Unknown type");
      return Object.keys(part).length ? el("p", "small muted", tr(`未展开的内容 · ${type}`, `Content not displayed · ${type}`)) : undefined;
    }
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
  const node = el("time", "numerical", date.toLocaleTimeString(uiLocale, { hour: "2-digit", minute: "2-digit" }));
  node.dateTime = date.toISOString();
  node.title = date.toLocaleString(uiLocale);
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
  const conversational = role === "user" || role === "assistant";
  const node = before?.node ?? el("article", conversational ? `message message--${role}` : "message");
  const speaker = before?.speaker ?? el("span", "speaker");
  const label = role === "assistant" ? live ? tr("助手 · 正在生成", "Assistant · Writing") : tr("助手", "Assistant")
    : role === "user" ? tr("你", "You") : role === "bashExecution" ? tr("命令输出", "Command output") : tr("会话记录", "Session record");
  if (speaker.textContent !== label) speaker.textContent = label;
  const body = before?.body ?? el("div", "message-body");
  const time = before?.timestamp === message.timestamp ? before?.time : timeLabel(message.timestamp);
  const header = before?.header ?? el("header");
  if (!before) {
    if (conversational) {
      const ns = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(ns, "svg");
      const path = document.createElementNS(ns, "path");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "currentColor");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      path.setAttribute("fill-rule", "evenodd");
      path.setAttribute("d", role === "user"
        ? "M3 6 6 3h15v15l-3 3H3V6Zm9 1-1.4 1.4 2.6 2.6H7v2h6.2l-2.6 2.6L12 17l5-5-5-5Z"
        : "M12 2 22 12 12 22 2 12 12 2Zm0 3-7 7 7 7 7-7-7-7Zm0 4 3 3-3 3-3-3 3-3Z");
      icon.append(path);
      const identity = el("span", "message-identity");
      speaker.style.overflowWrap = "normal";
      identity.append(icon, speaker);
      header.append(identity);
    } else header.append(speaker);
    node.append(body);
  }
  if (before?.time !== time) {
    before?.time?.remove();
    if (time) header.append(time);
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
    ...(error || stop === "error" ? [el("p", "notice error small", error || tr("生成失败", "Could not generate a response."))] : []),
    ...(stop === "aborted" ? [el("p", "muted small", tr("已停止生成", "Response stopped."))] : []),
    ...(stop === "length" ? [el("p", "muted small", tr("已达到输出长度限制", "Response reached the length limit."))] : []),
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
  readonly history?: HistoryRender;
  readonly sessionId?: string;
};
type ContentView = {
  readonly key: string; readonly node: HTMLElement; readonly output: HTMLElement;
  readonly button: HTMLButtonElement; readonly status: HTMLElement; count: number; length: number; control?: HistoryControl;
};
const pageSize = 80;
const loadOlderLabel = tr("加载更早消息", "Load older messages");
const reloadLabel = tr("重新加载记录", "Reload transcript");

function historyButton(node: HTMLButtonElement, control: HistoryControl | undefined, label: string): void {
  if (node.textContent !== label) node.textContent = label;
  node.toggleAttribute("data-reload", control?.reload === true);
  node.setAttribute("aria-disabled", String(Boolean(control?.busy || control?.disabled)));
  node.setAttribute("aria-busy", String(control?.busy === true));
}

function activateHistory(control?: HistoryControl): void {
  if (control && !control.busy && !control.disabled) control.activate();
}

type TraceTargets = {
  readonly user?: HTMLElement; readonly assistant?: HTMLElement; readonly tool?: HTMLElement;
};

export class Transcript {
  private readonly cache = new Map<string, Cached>();
  private readonly openFolds = new Map<string, readonly number[]>();
  private readonly toolViews = new Map<string, ToolDisplay>();
  private readonly openTools = new Set<string>();
  private readonly results = new Map<string, number>();
  private readonly contentViews = new WeakMap<HTMLElement, ContentView>();
  private readonly older = button(loadOlderLabel, () => {
    if (this.start) this.flush(true);
    else activateHistory(this.latest?.history?.older);
  }, "transcript-load");
  private readonly status = el("span", "sr-only");
  private readonly olderError = el("p", "notice small");
  private latest?: RenderInput;
  private frame?: number;
  private forceBottom = false;
  private prepended?: number;
  private limit = pageSize;
  private start = 0;
  private first?: string;
  private displayed?: readonly TranscriptEntry[];
  private indexed?: readonly TranscriptEntry[];
  private indexedLength = 0;
  private trace?: (targets: TraceTargets) => void;

  constructor(private readonly root: HTMLElement, private readonly scroller: HTMLElement, private readonly empty: HTMLElement) {
    this.status.setAttribute("role", "status");
    this.olderError.setAttribute("role", "status");
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
    this.prepended = undefined;
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

  render(entries: readonly TranscriptEntry[], liveKey: string, tools: ReadonlyMap<string, ToolTrace>, forceBottom = false,
    history?: HistoryRender, prepended?: number, sessionId?: string): void {
    this.latest = { entries, liveKey, tools, history, sessionId };
    this.forceBottom ||= forceBottom;
    if (prepended !== undefined) this.prepended = (this.prepended ?? 0) + prepended;
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

  private flush(expandLocal = false): void {
    if (!this.latest || (expandLocal && !this.start)) return;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    const { entries, liveKey, tools, history, sessionId } = this.latest;
    const prepended = this.prepended;
    this.prepended = undefined;
    const expand = expandLocal || prepended !== undefined;
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    const active = document.activeElement;
    const rowFocus = active instanceof HTMLElement && this.root.contains(active)
      && (active.closest(".tool-details, .tool-group, .tool-attachment, .transcript-content, .prose") || (this.trace && active.matches(".message[tabindex='-1']"))) ? active : undefined;
    const toolFocus = rowFocus?.matches(".tool-group-summary")
      ? rowFocus.parentElement?.querySelector<HTMLElement>(".tool-summary")
      : rowFocus?.querySelector<HTMLElement>(".tool-summary");
    const nearEnd = scrollHeight - clientHeight - scrollTop < 72;
    const follow = this.forceBottom || (nearEnd && !rowFocus && active !== this.older);
    this.forceBottom = false;
    const afterControls = this.olderError.nextElementSibling;
    const boundary = expand && afterControls instanceof HTMLElement ? afterControls : undefined;
    const toolBoundary = boundary?.querySelector<HTMLElement>(".tool-summary") ?? undefined;
    const readingAnchor = expand && rowFocus?.closest(".tool-details, .tool-group") && boundary?.contains(rowFocus) ? rowFocus : boundary;
    const previousTop = readingAnchor?.getBoundingClientRect().top;
    const moveFocus = expand && document.activeElement === this.older;
    this.indexResults(entries);
    const dangling: Row[] = [];
    for (const [id, tool] of tools) if (!this.results.has(id)) dangling.push({ key: `result:${id}`, tool });
    const total = entries.length + dangling.length;
    if (prepended !== undefined) this.limit += prepended;
    const tail = Math.max(0, total - this.limit);
    if (!this.displayed || (follow && !expand)) this.start = tail;
    else {
      if (entries !== this.displayed && this.first) {
        const index = entries.findIndex(entry => entry.key === this.first);
        if (index >= 0) this.start = index;
      }
      this.start = Math.min(this.start, tail);
    }
    let loaded = prepended ?? 0;
    if (expandLocal) {
      loaded = Math.min(this.start, pageSize);
      this.start -= loaded;
      this.limit = Math.max(this.limit, total - this.start);
    } else if (prepended !== undefined) {
      this.start = Math.max(0, this.start - prepended);
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
      view.update(call, tool, result, sessionId);
      const body = view.node.querySelector<HTMLElement>(":scope > .tool-details > .fold-body");
      if (body) this.renderHistoryContent(body, result && history?.content(result));
      if (this.trace && (tool?.id || str(call?.id) || str(call?.name) || str(result?.toolCallId) || str(result?.toolName))) {
        latestTool = view.node;
      }
      return view.node;
    };
    if (this.older.parentNode !== this.root) this.root.prepend(this.status, this.older, this.olderError);
    const remote = this.start ? undefined : history?.older;
    this.older.hidden = !this.start && !remote;
    const olderCount = this.start.toLocaleString(uiLocale);
    const label = this.start ? tr(`加载更早消息（${olderCount} 条）`, `Load older messages (${olderCount})`)
      : remote?.reload ? reloadLabel : remote?.busy ? tr("正在读取…", "Loading…") : loadOlderLabel;
    historyButton(this.older, remote, label);
    this.olderError.hidden = !remote?.error;
    if (this.olderError.textContent !== (remote?.error ?? "")) this.olderError.textContent = remote?.error ?? "";
    const renderCall = (key: string, part: Wire): HTMLElement | undefined => {
      const id = str(part.id);
      const result = this.results.get(id);
      return renderTool(id ? `id:${id}` : key, part, tools.get(id), result === undefined ? undefined : entries[result]?.message);
    };
    let last: Element = this.olderError;
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
        const messageView = this.cache.get(row.key)?.view;
        if (messageView) {
          const content = history?.content(message);
          const textParts = messageView.parts.filter(({ part }) => part.type === "text");
          // Text cursors read from the start of the original, not from the end of the preview.
          if (textParts.length === 1 && textParts[0]?.node) textParts[0].node.hidden = Boolean(content?.chunks.length);
          this.renderHistoryContent(messageView.body, content, message.role === "assistant" && textParts.length === 1);
        }
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
      if (loaded) {
        const count = loaded.toLocaleString(uiLocale);
        this.status.textContent = tr(`已加载 ${count} 条更早消息。`, `Loaded ${count} older ${loaded === 1 ? "message" : "messages"}.`);
      }
      const anchor = readingAnchor && this.root.contains(readingAnchor)
        ? visibleToolTarget(readingAnchor) : visibleToolTarget(toolBoundary);
      if (anchor && this.root.contains(anchor) && previousTop !== undefined) {
        if (moveFocus && (loaded || this.older.hidden)) {
          if (anchor.tagName !== "SUMMARY") anchor.tabIndex = -1;
          anchor.focus({ preventScroll: true });
        }
        this.scroller.scrollTop += anchor.getBoundingClientRect().top - previousTop;
      } else if (moveFocus && this.older.hidden) this.scroller.focus({ preventScroll: true });
    } else if (follow) this.scroller.scrollTop = this.scroller.scrollHeight;
    if (!expand && active === this.older && this.older.hidden) this.scroller.focus({ preventScroll: true });
  }

  private renderHistoryContent(host: HTMLElement, content?: HistoryContent, markdown = false): void {
    let view = this.contentViews.get(host);
    if (view && (!content || view.key !== content.key)) {
      const focused = view.node.contains(document.activeElement);
      view.node.remove();
      this.contentViews.delete(host);
      view = undefined;
      if (focused) this.scroller.focus({ preventScroll: true });
    }
    if (!content) return;
    if (!view) {
      const node = el("div", "transcript-content stack stack--tight");
      const output = el("div", markdown ? "prose" : "plain break");
      const status = el("p", "small muted");
      status.setAttribute("role", "status");
      const load = button("", () => activateHistory(this.contentViews.get(host)?.control), "button--quiet");
      node.append(output, status, load);
      host.append(node);
      view = { key: content.key, node, output, status, button: load, count: 0, length: 0 };
      this.contentViews.set(host, view);
    }
    view.control = content.control;
    if (content.chunks.length < view.count) {
      view.count = view.length = 0;
      view.output.replaceChildren();
      view.output.className = markdown ? "prose" : "plain break";
    }
    const additions = content.chunks.slice(view.count);
    let target: HTMLElement | undefined;
    if (additions.length) {
      const previousLength = view.length;
      view.length += additions.reduce((size, chunk) => size + chunk.length, 0);
      if (markdown && view.length <= markdownRichLimit) {
        prose(content.chunks.join(""), view.output);
        target = view.output;
      } else {
        const beyond = markdown && previousLength <= markdownRichLimit;
        if (beyond) {
          view.output.className = "plain break";
          view.output.replaceChildren(el("p", "small muted",
            tr("正文过长，已按纯文本显示。", "This long message is displayed as plain text.")));
        }
        const chunks = (beyond ? content.chunks : additions).map(chunk => el("span", "", chunk));
        view.output.append(...chunks);
        target = chunks.find(chunk => chunk.textContent);
      }
    }
    view.count = content.chunks.length;
    view.output.hidden = !view.count;
    const label = content.control?.reload ? reloadLabel : content.control?.busy ? tr("正在读取…", "Loading…")
      : view.count ? tr("加载下一段正文", "Load next content chunk") : tr("加载正文", "Load message content");
    historyButton(view.button, content.control, label);
    const status = content.control?.reload ? tr("记录版本已失效。", "This transcript page expired.") :
      content.control?.error ?? (additions.length ? tr("已加载正文。", "Message content loaded.") :
        content.control?.busy || !view.count ? "" : view.status.textContent);
    if (view.status.textContent !== status) view.status.textContent = status;
    view.status.hidden = !status;
    if (target && document.activeElement === view.button) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    const moveFocus = !content.control && document.activeElement === view.button;
    view.button.hidden = !content.control;
    if (moveFocus) this.scroller.focus({ preventScroll: true });
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
