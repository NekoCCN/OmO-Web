import { cliLivePath, RequestError } from "./api.ts";
import type { Api, BranchSource, CliLiveAction } from "./api.ts";
import { byId, errorText, list, notice, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { Transcript } from "./transcript.ts";
import type { ToolTrace, TranscriptEntry } from "./transcript.ts";

type Candidate = { readonly id: string; readonly name: string; readonly cwd: string };
const box = (id: string) => byId(id, HTMLElement);
const btn = (id: string) => byId(id, HTMLButtonElement);
const hint = "仅普通文字。命令、权限审批及私密交互请回到 CLI 处理。";
const missing = new Set(["terminal_not_attached", "terminal_not_found", "terminal_offline"]);

export function cliLive(api: Api, onClose: () => void, openBranch: (source: BranchSource) => void) {
  const modal = byId("cli-live-dialog", HTMLDialogElement);
  const select = byId("cli-live-session", HTMLSelectElement);
  const input = byId("cli-live-input", HTMLTextAreaElement);
  const transcript = new Transcript(box("cli-live-messages"), box("cli-live-transcript"), box("cli-live-empty"));
  const tools = new Map<string, ToolTrace>();
  const drafts = new Map<string, string>();
  const uncertain = new Map<string, string>();
  let items: readonly Candidate[] = [];
  let available: boolean | undefined;
  let attached = "";
  let shown = "";
  let listing: AbortController | undefined;
  let reading: AbortController | undefined;
  let pending: CliLiveAction["action"] | undefined;
  let timer: number | undefined;
  let trail = false;
  let retryDelay = 500;
  let transport: "waiting" | "open" | "lost" = "waiting";
  let fresh = false;
  let state: Wire = {};
  let entries: readonly TranscriptEntry[] = [];
  let restoreOnClose = true;

  function render(): void {
    const row = items.find(item => item.id === select.value);
    const connected = row !== undefined && attached === row.id;
    const writable = connected && fresh && transport === "open" && !pending;
    const busy = state.running === true || state.compacting === true;
    const hasTranscript = connected || Boolean(row && shown === row.id);
    const unknownDelivery = Boolean(row && uncertain.get(row.id) === input.value);
    select.disabled = Boolean(attached || pending || listing || !items.length);
    btn("cli-live-close").disabled = Boolean(pending);
    btn("cli-live-connect").hidden = connected;
    btn("cli-live-connect").disabled = !row || !available || !api.token || transport !== "open" || Boolean(pending || listing);
    btn("cli-live-disconnect").hidden = !connected;
    btn("cli-live-disconnect").disabled = Boolean(pending);
    btn("cli-live-refresh").disabled = Boolean(pending || listing);
    btn("cli-live-branch").hidden = !connected;
    btn("cli-live-branch").disabled = !writable || busy;
    btn("cli-live-send").disabled = !writable || busy || unknownDelivery || !input.value.trim();
    const stop = btn("cli-live-stop");
    const canStop = connected && state.running === true && Boolean(str(state.turnId));
    if (!canStop && document.activeElement === stop) input.focus({ preventScroll: true });
    stop.hidden = !canStop;
    stop.disabled = !writable;
    input.readOnly = pending === "input";
    box("cli-live-conversation").hidden = !hasTranscript && !input.value;
    notice(box("cli-live-workspace"), row?.cwd);
    notice(box("cli-live-status"), pending === "connect" ? "正在连接 CLI…"
      : pending === "disconnect" ? "正在释放 Web 连接…"
      : transport === "lost" ? "实时更新已离线，草稿会保留。连接恢复后只刷新消息，不会重发。"
      : listing ? "正在查找本地 CLI 会话…"
      : connected ? !fresh ? "正在同步 CLI 对话…" : state.compacting === true ? "CLI 正在压缩上下文。"
        : state.running === true ? "已连接 · CLI 正在运行" : "已连接 · 等待输入"
      : available === false ? "CLI 实时不可用：未启用或找不到本地终端控制服务。"
      : !items.length ? "没有发现可连接的 CLI 会话。"
      : transport === "waiting" ? "正在等待 Web 实时连接…"
      : shown === row?.id ? "已断开；显示最后一次同步的消息。" : "选择会话后，点击「连接」读取对话。");
    box("cli-live-hint").textContent = unknownDelivery ? `上一次发送的结果未知，请先核对 CLI，不要重发这条消息。${hint}` : hint;
  }

  function clearSelection(): void {
    shown = "";
    state = {};
    entries = [];
    transcript.reset();
    input.value = drafts.get(select.value) ?? "";
    notice(box("cli-live-error"));
    notice(box("cli-live-receipt"));
    render();
  }

  async function discover(): Promise<void> {
    if (attached || listing || !modal.open) return;
    const request = listing = new AbortController();
    notice(box("cli-live-error"));
    render();
    try {
      const data = await api.request("/api/cli-live", undefined, request.signal);
      if (!modal.open || request.signal.aborted) return;
      available = data.available === true;
      items = list(data.sessions).map(object).flatMap(row => {
        const id = str(row.id);
        return id ? [{ id, name: str(row.name) || "未命名 CLI 会话", cwd: str(row.cwd) }] : [];
      });
      const previous = select.value;
      select.replaceChildren(option("选择可用会话", ""), ...items.map(row => option(row.name, row.id)));
      select.value = items.some(item => item.id === previous) ? previous : items.length === 1 ? items[0]?.id ?? "" : "";
      if (select.value !== previous) clearSelection();
    } catch (error) {
      if (!request.signal.aborted && modal.open) {
        available = false;
        notice(box("cli-live-error"), `无法发现 CLI 会话：${errorText(error)}`);
      }
    } finally {
      if (listing === request) listing = undefined;
      render();
    }
  }

  function apply(id: string, data: Wire): void {
    state = object(data.state);
    const before = entries;
    entries = list(data.messages).map(object).map((message, i) => ({
      key: `cli-live:${i}`,
      message: JSON.stringify(before[i]?.message) === JSON.stringify(message) ? before[i]?.message ?? message : message,
    }));
    const last = entries.at(-1);
    transcript.render(entries, last?.message.streaming === true ? last.key : "", tools, shown !== id);
    shown = id;
    fresh = true;
    retryDelay = 500;
  }

  function cancelRead(): void {
    clearTimeout(timer);
    timer = undefined;
    reading?.abort();
    reading = undefined;
    trail = false;
  }

  function queueRead(delay = 50): void {
    if (!modal.open || !attached || transport !== "open") return;
    if (reading || pending) { trail = true; return; }
    // Keep the first scheduled read under sustained streaming invalidations.
    if (timer !== undefined && delay !== 0) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void refreshSnapshot();
    }, delay);
  }

  async function refreshSnapshot(): Promise<void> {
    const id = attached;
    if (!id || reading || !modal.open || transport !== "open") return;
    if (pending) { trail = true; return; }
    const request = reading = new AbortController();
    const active = () => attached === id && modal.open && !request.signal.aborted;
    let retry = 0;
    trail = false;
    try {
      const data = await api.request(cliLivePath(id), undefined, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]));
      if (active()) {
        apply(id, data);
        if (box("cli-live-error").dataset.read === "true") notice(box("cli-live-error"));
      }
    } catch (error) {
      if (active()) {
        fresh = false;
        if (error instanceof RequestError && missing.has(error.code)) attached = "";
        else {
          retry = retryDelay;
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
        const alert = box("cli-live-error");
        if (alert.hidden || alert.dataset.read === "true") {
          alert.dataset.read = "true";
          notice(alert, `无法同步 CLI 对话：${errorText(error)}`);
        }
      }
    } finally {
      if (reading === request) reading = undefined;
      if (active() && (retry || trail)) queueRead(retry || 50);
      render();
    }
  }

  async function act(id: string, action: CliLiveAction): Promise<void> {
    if (!id || pending) return;
    pending = action.action;
    const alert = box("cli-live-error");
    delete alert.dataset.read;
    notice(alert);
    if (action.action !== "disconnect") notice(box("cli-live-receipt"));
    if (action.action === "disconnect") cancelRead();
    render();
    let focus: HTMLElement | undefined;
    try {
      const result = await api.cliLiveAction(id, action);
      switch (action.action) {
        case "connect":
          attached = id;
          apply(id, result);
          focus = input;
          break;
        case "disconnect":
          attached = "";
          fresh = false;
          focus = btn("cli-live-connect");
          break;
        case "input":
          drafts.delete(id);
          uncertain.delete(id);
          input.value = "";
          notice(box("cli-live-receipt"), result.disposition === "held" ? "CLI 已暂存消息；请在 CLI 查看，勿重发。"
            : result.disposition === "queued" ? "CLI 已将消息加入队列。" : "CLI 已接收消息。");
          break;
        case "stop":
          notice(box("cli-live-receipt"), "当前回合已停止。");
          focus = input;
          break;
      }
    } catch (error) {
      if (action.action === "input" && (!(error instanceof RequestError) ||
          error.status >= 500 || error.code === "terminal_outcome_unknown")) uncertain.set(id, action.message);
      if (error instanceof RequestError && missing.has(error.code)) {
        attached = "";
        fresh = false;
      }
      notice(alert, errorText(error));
    } finally {
      pending = undefined;
      render();
      if (modal.open) focus?.focus({ preventScroll: true });
      if (attached) queueRead(0);
    }
  }

  select.addEventListener("change", clearSelection);
  input.addEventListener("input", () => { drafts.set(select.value, input.value); render(); });
  btn("cli-live-connect").addEventListener("click", () => void act(select.value, { action: "connect" }));
  btn("cli-live-disconnect").addEventListener("click", () => void act(attached, { action: "disconnect" }));
  btn("cli-live-refresh").addEventListener("click", () => { if (attached) queueRead(0); else void discover(); });
  btn("cli-live-stop").addEventListener("click", () => {
    const expectedTurnId = str(state.turnId);
    if (expectedTurnId) void act(attached, { action: "stop", expectedTurnId });
  });
  btn("cli-live-branch").addEventListener("click", () => {
    const row = items.find(item => item.id === attached);
    if (row) openBranch({ ...row, kind: "live" });
  });
  byId("cli-live-form", HTMLFormElement).addEventListener("submit", event => {
    event.preventDefault();
    if (!btn("cli-live-send").disabled) {
      void act(attached, { action: "input", mode: "prompt", clientMessageId: crypto.randomUUID(), message: input.value });
    }
  });
  btn("cli-live-close").addEventListener("click", () => modal.close());
  modal.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
  modal.addEventListener("close", () => {
    if (modal.open) return;
    listing?.abort();
    listing = undefined;
    cancelRead();
    if (attached) void act(attached, { action: "disconnect" });
    if (restoreOnClose) onClose();
    restoreOnClose = true;
  });

  return {
    open() {
      if (modal.open) return;
      modal.showModal();
      render();
      if (!attached) void discover();
    },
    closeAfterBranch() { restoreOnClose = false; modal.close(); },
    invalidate(id: string) { if (attached && attached === id) queueRead(); },
    setTransport(next: typeof transport) {
      if (next === transport) return;
      transport = next;
      if (next !== "open") { fresh = false; cancelRead(); }
      else if (attached) queueRead(0);
      else if (!available) void discover();
      render();
    },
  };
}
