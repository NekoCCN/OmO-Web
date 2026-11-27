import { Api, RequestError } from "./api.ts";
import { button, el, fold, object, str } from "./dom.ts";
import { tr } from "./locale.ts";

type TreeNode = { id: string; parentId: string | null; type: string; role?: string; label?: string; summary?: string };
type Page = { nodes: TreeNode[]; leafId: string | null; nextCursor?: string };

export const isStaleTree = (error: unknown): boolean => error instanceof RequestError && error.status === 409
  && (error.code === "tree_stale" || error.code === "session_changed" || error.code === "stale_leaf");

function readPage(raw: Awaited<ReturnType<Api["request"]>>): Page {
  const leafId = raw.leafId;
  const nextCursor = raw.nextCursor;
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 40 || (leafId !== null && !validId(leafId))
    || (nextCursor !== undefined && (!validId(nextCursor) || !raw.nodes.length))) throw new Error("Invalid tree page");
  const ids = new Set<string>();
  const nodes = raw.nodes.map(value => {
    const { id, parentId, type, role, label, summary } = object(value);
    if (!validId(id) || ids.has(id) || (parentId !== null && !validId(parentId)) || !validId(type)
      || !optionalText(role) || !optionalText(label) || !optionalText(summary)) throw new Error("Invalid tree node");
    ids.add(id);
    return { id, parentId, type, role, label, summary };
  });
  return { nodes, leafId, nextCursor };
}

const titles: Readonly<Record<string, string>> = {
  user: tr("你", "You"), assistant: tr("助手", "Assistant"), toolResult: tr("工具结果", "Tool result"),
  bashExecution: tr("命令输出", "Command output"), message: tr("消息", "Message"), compaction: tr("上下文压缩", "Context compaction"),
  branch_summary: tr("分支摘要", "Branch summary"), model_change: tr("模型变更", "Model change"),
  thinking_level_change: tr("思考档变更", "Thinking level change"), custom: tr("会话记录", "Session entry"), session_info: tr("会话信息", "Session info"),
};
const staleMessage = tr("会话位置已变化，请重新读取会话树。", "The session position changed. Reload the session tree.");

export function createDetailsTree(api: Api, path: string, visible: () => boolean, canNavigate: () => boolean,
  navigate: (id: string | null, leaf: string | null) => void) {
  const root = el("section", "subpanel stack stack--tight");
  root.id = "runtime-tree";
  const status = el("p", "small muted");
  status.setAttribute("role", "status");
  const hint = el("p", "small muted", tr(
    "仅显示已加载的节点（最新记录在前），不代表完整的分支结构。选择历史用户消息可将其载入输入框；不会自动发送。",
    "Shows loaded entries (newest first), not the complete branch structure. Select a past user message to load it into the input box without sending it."));
  const list = el("ul", "tree");
  const actions = el("div", "row");
  const older = button(tr("加载更早节点", "Load older"), () => { if (cursor) void load(cursor); });
  older.dataset.treeOlder = "";
  const reload = button(tr("重新读取会话树", "Reload session tree"), () => { void load(); });
  reload.dataset.treeReload = "";
  const clear = button(tr("切换到空上下文", "Switch to an empty context"), () => select(null));
  actions.append(older, reload, clear);
  const disclosure = fold(tr("查看会话节点", "View session nodes"), status, hint, list, actions);
  const title = disclosure.querySelector("summary")!;
  root.append(el("h3", "", tr("会话树", "Session tree")), disclosure);

  let request: AbortController | undefined;
  let leaf: string | null | undefined;
  let cursor: string | undefined;
  let head: string[] = [];
  let stale = false;
  let error = false;
  let message = "";
  const rows = new Map<string, HTMLButtonElement>();
  const active = () => visible() && disclosure.open;
  function syncWrites(): void {
    const blocked = !canNavigate();
    clear.disabled = blocked;
    for (const row of rows.values()) row.disabled = blocked;
  }
  function select(id: string | null): void {
    if (active() && !stale && leaf !== undefined && canNavigate()) navigate(id, leaf);
  }
  function render(): void {
    const focused = document.activeElement;
    status.textContent = message || (leaf !== undefined && !rows.size
      ? leaf === null ? tr("没有可导航的会话节点。", "No session nodes to navigate.")
        : tr("这一页没有列出活动节点。", "This page does not include the active node.")
      : rows.size && leaf !== null && leaf !== undefined && !rows.has(leaf)
        ? tr("活动节点不在已加载的记录中。", "The active node is not among the loaded entries.") : "");
    status.classList.toggle("error", stale || error);
    status.hidden = !status.textContent;
    hint.hidden = !rows.size;
    list.hidden = !rows.size;
    older.hidden = stale || (!cursor && focused !== older);
    older.textContent = cursor ? tr("加载更早节点", "Load older") : tr("没有更早的可加载节点", "No older entries to load");
    reload.hidden = !stale && !error && focused !== reload;
    clear.hidden = leaf === undefined || leaf === null || stale;
    actions.hidden = older.hidden && reload.hidden && clear.hidden;
    older.setAttribute("aria-disabled", String(Boolean(request) || !cursor));
    reload.setAttribute("aria-disabled", String(Boolean(request)));
    syncWrites();
    if (active() && ((focused === older && older.hidden) || (focused === clear && clear.hidden))) {
      (stale ? reload : title).focus({ preventScroll: true });
    }
  }

  function paint(page: Page, append: boolean): void {
    const ids = page.nodes.map(node => node.id);
    const sameHead = !append && leaf === page.leafId && ids.length === head.length && ids.every((id, i) => id === head[i]);
    if (!append && !sameHead) {
      const incoming = new Set(ids);
      for (const [id, action] of rows) if (!incoming.has(id)) {
        if (document.activeElement === action) title.focus({ preventScroll: true });
        action.parentElement?.remove();
        rows.delete(id);
      }
    }
    leaf = page.leafId;
    if (!sameHead || rows.size === head.length) cursor = page.nextCursor;
    if (!append) head = ids;
    const ordered: HTMLLIElement[] = [];
    for (const node of [...page.nodes].reverse()) {
      let action = rows.get(node.id);
      if (!action) {
        action = button("", () => select(node.id), "button--quiet break");
        rows.set(node.id, action);
        const item = el("li");
        item.append(action);
        list.append(item);
      }
      const kind = node.role || node.type;
      const label = node.label || (Object.hasOwn(titles, kind) ? titles[kind] : kind);
      action.textContent = `${label} · ${str(node.summary) || node.id.slice(0, 12)}`;
      if (node.id === leaf) action.setAttribute("aria-current", "true");
      else action.removeAttribute("aria-current");
      ordered.push(action.parentElement as HTMLLIElement);
    }
    if (!append && !sameHead) {
      let next: HTMLLIElement | null = null;
      for (const item of ordered.reverse()) {
        if (item.nextElementSibling !== next && !item.contains(document.activeElement)) list.insertBefore(item, next);
        next = item;
      }
    }
  }

  function invalidate(): void {
    abort();
    if (!disclosure.open && leaf === undefined) return;
    if (list.contains(document.activeElement)) title.focus({ preventScroll: true });
    list.replaceChildren();
    rows.clear();
    leaf = undefined;
    cursor = undefined;
    head = [];
    stale = true;
    error = false;
    message = staleMessage;
    render();
  }

  async function load(before?: string): Promise<void> {
    if (!active() || request || (before !== undefined && stale)) return;
    const read = request = new AbortController();
    const live = () => request === read && active();
    const query = before === undefined ? "" : `?${new URLSearchParams({ cursor: before })}`;
    error = false;
    message = before === undefined ? tr("正在读取会话节点…", "Loading session entries…")
      : tr("正在读取更早的节点…", "Loading older entries…");
    let appended = false;
    render();
    try {
      const signal = AbortSignal.any([read.signal, AbortSignal.timeout(12_000)]);
      const data = await api.request(`${path}/tree${query}`, undefined, signal);
      if (!live()) return;
      const page = readPage(data);
      if (before !== undefined && page.leafId !== leaf) { invalidate(); return; }
      if (before !== undefined && (page.nextCursor === before || page.nodes.some(node => rows.has(node.id)))) throw new Error("Overlapping tree page");
      stale = false;
      message = "";
      paint(page, before !== undefined);
      appended = before !== undefined;
      if (document.activeElement === reload) title.focus({ preventScroll: true });
    } catch (failure) {
      if (!live()) return;
      if (isStaleTree(failure)) { invalidate(); return; }
      error = true;
      message = before === undefined ? tr("读取会话树失败。请重试。", "Could not load the session tree. Try again.")
        : tr("读取更早的节点失败。已保留之前的节点。", "Could not load older entries. The loaded entries are kept.");
    } finally {
      if (request === read) {
        request = undefined;
        if (active()) {
          render();
          if (appended && document.activeElement === older) older.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
      }
    }
  }

  function abort(): void {
    if (!request) return;
    request.abort();
    request = undefined;
    message = stale ? staleMessage : "";
    render();
  }
  const activate = () => { if (leaf === undefined && !stale && !error) void load(); };
  disclosure.addEventListener("toggle", () => { if (active()) activate(); else abort(); });
  render();
  return {
    root, activate, abort, invalidate, syncWrites,
    checkLeaf: (next: string | null) => { if (leaf !== undefined && leaf !== next) invalidate(); },
    refresh: () => { void load(); },
  };
}
