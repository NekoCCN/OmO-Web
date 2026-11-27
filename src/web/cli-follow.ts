import type { Api } from "./api.ts";
import { byId, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { messageKey, Transcript } from "./transcript.ts";
import type { ToolTrace, TranscriptEntry } from "./transcript.ts";
import { tr } from "./locale.ts";

type Target = { readonly id: string; readonly name: string; readonly cwd: string; readonly running: boolean };
type History = "truncated" | "unavailable";
type Snapshot = { readonly status: "ok"; readonly target: Target; readonly messages: readonly Wire[]; readonly history?: History }
  | { readonly status: "none" | "ambiguous" | "unavailable" };
const pollInterval = 2_000;
const readTimeout = 8_000;
const labels = {
  pending: tr("正在查找 CLI 会话…", "Looking for a CLI session…"),
  none: tr("未发现可跟随的 CLI 会话。", "No CLI session to follow."),
  ambiguous: tr("有多个 CLI 会话，无法确认跟随哪一个。", "Multiple CLI sessions were found. Could not determine which one to follow."),
  unavailable: tr("无法核验 CLI 会话，暂不显示对话。", "Could not verify the CLI session. The conversation is hidden."),
} as const;

function parseSnapshot(data: Wire, authorized: (cwd: string) => boolean): Snapshot {
  switch (data.status) {
    case "none": return { status: "none" };
    case "ambiguous": return { status: "ambiguous" };
    case "ok": {
      const session = object(data.session);
      const id = str(session.id);
      const cwd = str(session.cwd);
      const name = str(session.name);
      if (!id || !cwd || !authorized(cwd) || typeof session.name !== "string"
        || typeof session.running !== "boolean" || !Array.isArray(data.messages)) return { status: "unavailable" };
      const history = object(data.transcript).status;
      const messages: Wire[] = [];
      for (const raw of history === "unavailable" ? [] : data.messages) {
        const { role, content, timestamp, streaming } = object(raw);
        if ((role !== "user" && role !== "assistant" && role !== "custom") || typeof content !== "string") {
          return { status: "unavailable" };
        }
        // Pass only the projected text fields to Transcript, never raw UI events.
        messages.push({ role, content, timestamp: num(timestamp), streaming: role === "assistant" && streaming === true });
      }
      return { status: "ok", target: { id, name: name || tr("未命名 CLI 会话", "Untitled CLI session"), cwd, running: session.running }, messages,
        ...(history === "truncated" || history === "unavailable" ? { history } : {}) };
    }
    default: return { status: "unavailable" };
  }
}

export function cliFollow(api: Api, authorized: (cwd: string) => boolean, onChange: () => void) {
  const view = byId("cli-follow-view", HTMLElement);
  const status = byId("cli-follow-status", HTMLElement);
  const empty = byId("cli-follow-empty", HTMLElement);
  const transcript = new Transcript(byId("cli-follow-messages", HTMLElement), view, empty);
  const tools = new Map<string, ToolTrace>();
  let enabled = false;
  let target: Target | undefined;
  // Keep the last verified picker scope on a failed read, but never its transcript.
  let workspace = "";
  let reading: AbortController | undefined;
  let timer: number | undefined;
  let entries: readonly TranscriptEntry[] = [];

  function clearTranscript(): void {
    entries = [];
    transcript.reset();
    empty.hidden = true;
  }

  function setStatus(state: keyof typeof labels | "ok", running = false, history?: History): void {
    const text = state === "ok" ? tr(`只读跟随 · ${running ? "CLI 正在运行" : "CLI 未在运行"}`,
      `Following · Read-only · ${running ? "CLI is running" : "CLI is idle"}`) : labels[state];
    const detail = history === "unavailable" ? tr(" · 对话记录暂不可读", " · Conversation history is unavailable")
      : history === "truncated" ? tr(" · 仅显示部分近期消息", " · Showing a limited set of recent messages") : "";
    if (status.dataset.state !== state) status.dataset.state = state;
    if (status.textContent !== text + detail) status.textContent = text + detail;
  }

  function apply(snapshot: Snapshot): void {
    const before = target;
    if (snapshot.status !== "ok") {
      if (target) clearTranscript();
      target = undefined;
      setStatus(snapshot.status);
      if (before) onChange();
      return;
    }
    target = snapshot.target;
    workspace = target.cwd;
    const switched = !before || before.id !== target.id || before.cwd !== target.cwd;
    if (switched) clearTranscript();
    setStatus("ok", target.running, snapshot.history);
    const previous = new Map(entries.map(entry => [entry.key, entry]));
    const keys = new Set<string>();
    const next = snapshot.messages.map((message, i) => {
      const base = messageKey(message) || `follow:${i}`;
      const key = keys.has(base) ? `${base}:${i}` : base;
      keys.add(key);
      const old = previous.get(key);
      return old && JSON.stringify(old.message) === JSON.stringify(message) ? old : { key, message };
    });
    if (snapshot.history && next.length === 0) {
      // An unavailable read is not an authoritative empty transcript.
      clearTranscript();
    } else if (switched || entries.length !== next.length || next.some((entry, index) => entry !== entries[index])) {
      entries = next;
      const last = entries.at(-1);
      transcript.render(entries, last?.message.streaming === true ? last.key : "", tools, switched);
    }
    empty.hidden = Boolean(snapshot.history) || entries.length > 0;
    if (switched || before?.name !== target.name) onChange();
  }

  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
    reading?.abort();
    reading = undefined;
  }

  async function poll(): Promise<void> {
    if (!enabled || document.hidden || reading) return;
    const request = reading = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(readTimeout)]);
    const deadline = performance.now() + readTimeout;
    const current = () => enabled && !document.hidden && reading === request;
    try {
      const data = await api.request("/api/cli-follow", undefined, signal).catch(() => undefined);
      if (current()) apply(!data || signal.aborted || performance.now() >= deadline
        ? { status: "unavailable" } : parseSnapshot(data, authorized));
    } finally {
      if (reading === request) {
        reading = undefined;
        if (enabled && !document.hidden) timer = window.setTimeout(() => { timer = undefined; void poll(); }, pollInterval);
      }
    }
  }

  function stop(): void {
    if (!enabled) return;
    enabled = false;
    cancel();
    target = undefined;
    workspace = "";
    clearTranscript();
    onChange();
  }

  document.addEventListener("visibilitychange", () => {
    if (!enabled) return;
    if (document.hidden) {
      cancel();
      if (target) {
        clearTranscript();
        target = undefined;
        onChange();
      }
      setStatus("pending");
    } else void poll();
  });
  window.addEventListener("pagehide", stop);

  return {
    get active() { return enabled; },
    get target() { return target; },
    get workspace() { return workspace; },
    start() {
      if (enabled) return;
      enabled = true;
      setStatus("pending");
      onChange();
      void poll();
    },
    stop,
    recheckWorkspace() {
      if (!workspace || authorized(workspace)) return;
      workspace = "";
      apply({ status: "unavailable" });
    },
  };
}
