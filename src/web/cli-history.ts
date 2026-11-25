import { cliHistoryPath } from "./api.ts";
import type { Api, BranchSource, Session } from "./api.ts";
import { showNativeActivity } from "./details.ts";
import { byId, button, el, errorText, list, notice, num, object, str } from "./dom.ts";
import { roleOf, Transcript } from "./transcript.ts";

type HistoryRow = { readonly id: string; readonly name: string; readonly cwd: string; readonly updatedAt: number;
  readonly adopted: boolean };

const box = (id: string) => byId(id, HTMLElement);
const btn = (id: string) => byId(id, HTMLButtonElement);
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const time = (updatedAt: number) => Number.isFinite(new Date(updatedAt).getTime()) ? date.format(updatedAt) : "";

export function cliHistory(api: Api, onClose: () => void, openBranch: (source: BranchSource) => void,
  resumeUnavailable: () => string, onResumed: (session: Session, show: boolean) => void) {
  const modal = byId("cli-history-dialog", HTMLDialogElement);
  const filter = byId("cli-history-search", HTMLInputElement);
  const rows = box("cli-history-list");
  const index = box("cli-history-index");
  const record = box("cli-history-record");
  const title = box("cli-history-record-title");
  const activity = box("cli-history-activity");
  const refresh = btn("cli-history-refresh");
  const refreshActivity = btn("cli-history-refresh-activity");
  const branch = btn("cli-history-branch");
  const resume = btn("cli-history-resume");
  const resumeStatus = box("cli-history-resume-status");
  const resumeError = box("cli-history-resume-error");
  const transcript = new Transcript(box("cli-history-messages"), modal, box("cli-history-empty"));
  let items: readonly HistoryRow[] = [];
  let available: boolean | undefined;
  let selected: HistoryRow | undefined;
  let listing: AbortController | undefined;
  let reading: AbortController | undefined;
  let snapshot: AbortController | undefined;
  let readable = false;
  let opening: symbol | undefined;

  function update(): void {
    const reason = resumeUnavailable();
    branch.disabled = !readable || opening !== undefined;
    resume.disabled = branch.disabled || Boolean(reason);
    notice(resumeStatus, opening ? "正在尝试打开同一会话…" : readable ? reason : "");
  }

  function renderList(): void {
    const query = filter.value.trim().toLocaleLowerCase();
    const matches = items.filter(row => `${row.name} ${row.cwd}`.toLocaleLowerCase().includes(query));
    rows.replaceChildren();
    for (const row of matches) {
      const li = el("li");
      const open = button("", () => openRecord(row), "button--quiet session-link");
      open.dataset.history = row.id;
      open.append(el("span", "", row.name), el("span", "small muted path", row.cwd), el("small", "", time(row.updatedAt)),
        ...(row.adopted ? [el("small", "muted", "已在 Web 打开")] : []));
      li.append(open);
      rows.append(li);
    }
    rows.hidden = !matches.length;
    notice(box("cli-history-list-status"), listing ? "正在读取 CLI 历史…" : available === false
      ? "CLI 历史不可用：未启用或未找到本地历史记录。" : available && !matches.length
        ? query ? "没有匹配的 CLI 历史。" : "没有可显示的 CLI 历史。" : "");
  }

  async function loadList(): Promise<void> {
    listing?.abort();
    const request = listing = new AbortController();
    refresh.disabled = true;
    notice(box("cli-history-list-error"));
    renderList();
    try {
      const data = await api.request("/api/cli-history", undefined, request.signal);
      if (request.signal.aborted || !modal.open) return;
      available = data.available === true;
      items = list(data.sessions).map(object).flatMap(row => {
        const id = str(row.id);
        return id ? [{ id, name: str(row.name) || "未命名 CLI 会话", cwd: str(row.cwd), updatedAt: num(row.updatedAt) ?? 0,
          adopted: row.adopted === true }] : [];
      });
    } catch (error) {
      if (!request.signal.aborted && modal.open) notice(box("cli-history-list-error"), `无法读取 CLI 历史：${errorText(error)}`);
    } finally {
      if (listing === request) {
        listing = undefined;
        refresh.disabled = false;
        renderList();
      }
    }
  }

  const recordPath = (row: HistoryRow) => cliHistoryPath(row.id);

  async function loadActivity(row: HistoryRow): Promise<void> {
    snapshot?.abort();
    const request = snapshot = new AbortController();
    const previousStatus = activity.querySelector("[data-activity-status]");
    previousStatus?.remove();
    const status = el("p", "small muted", "正在读取原生快照…");
    status.dataset.activityStatus = "";
    status.setAttribute("role", "status");
    activity.append(status);
    refreshActivity.disabled = true;
    try {
      const data = await api.request(`${recordPath(row)}/activity`, undefined, request.signal);
      if (request.signal.aborted || !modal.open || selected !== row) return;
      showNativeActivity(activity, data);
    } catch (error) {
      if (!request.signal.aborted && modal.open && selected === row) {
        status.textContent = `无法读取原生快照：${errorText(error)}`;
        status.className = "notice error small";
        status.setAttribute("role", "alert");
      }
    } finally {
      if (snapshot === request) {
        snapshot = undefined;
        refreshActivity.disabled = false;
      }
    }
  }

  async function loadRecord(row: HistoryRow): Promise<void> {
    reading?.abort();
    const request = reading = new AbortController();
    const status = box("cli-history-record-status");
    notice(status, "正在读取对话记录…");
    notice(box("cli-history-record-error"));
    try {
      const data = await api.request(recordPath(row), undefined, request.signal);
      if (request.signal.aborted || !modal.open || selected !== row) return;
      const session = object(data.session);
      title.textContent = str(session.name) || row.name;
      readable = true;
      update();
      const modified = time(num(session.updatedAt) ?? row.updatedAt);
      box("cli-history-record-meta").textContent = [row.cwd, modified && `记录更新：${modified}`].filter(Boolean).join(" · ");
      const entries = list(data.messages).map(object).map((message, i) => {
        const toolId = roleOf(message) === "toolResult" && str(message.toolCallId);
        return { key: toolId ? `result:${toolId}` : `history-${i}`, message };
      });
      transcript.render(entries, "", new Map());
      requestAnimationFrame(() => { if (!request.signal.aborted && modal.open && selected === row) modal.scrollTop = 0; });
    } catch (error) {
      if (!request.signal.aborted && modal.open && selected === row) notice(box("cli-history-record-error"), `无法读取这条记录：${errorText(error)}`);
    } finally {
      if (reading === request) {
        reading = undefined;
        notice(status);
      }
    }
  }

  function stopRecord(): void {
    reading?.abort();
    reading = undefined;
    snapshot?.abort();
    snapshot = undefined;
    selected = undefined;
    readable = false;
    opening = undefined;
    notice(resumeError);
    update();
    transcript.reset();
    activity.replaceChildren();
  }

  function openRecord(row: HistoryRow): void {
    stopRecord();
    selected = row;
    index.hidden = true;
    record.hidden = false;
    title.textContent = row.name;
    box("cli-history-record-meta").textContent = row.cwd;
    box("cli-history-empty").hidden = true;
    title.focus({ preventScroll: true });
    modal.scrollTop = 0;
    void loadRecord(row);
    void loadActivity(row);
  }

  filter.addEventListener("input", renderList);
  refresh.addEventListener("click", () => void loadList());
  refreshActivity.addEventListener("click", () => { if (selected) void loadActivity(selected); });
  branch.addEventListener("click", () => {
    if (selected) openBranch({ kind: "history", id: selected.id, name: selected.name });
  });
  resume.addEventListener("click", async () => {
    const row = selected;
    if (!row || resume.disabled) return;
    const attempt = opening = Symbol();
    const stillSelected = () => opening === attempt && modal.open && selected === row;
    notice(resumeError);
    update();
    resumeStatus.focus();
    try {
      // Leave the HTTP mutation to finish if the user dismisses the record. A
      // late response must not navigate away from the user's new selection.
      const session = await api.resumeHistory(row.id);
      onResumed(session, stillSelected());
    } catch (error) {
      if (stillSelected()) {
        notice(resumeError, `无法在 Web 继续：${errorText(error)}`);
        if (document.activeElement === resumeStatus) resumeError.focus();
      }
    } finally {
      if (opening === attempt) {
        opening = undefined;
        update();
      }
    }
  });
  btn("cli-history-back").addEventListener("click", () => {
    const id = selected?.id;
    stopRecord();
    record.hidden = true;
    index.hidden = false;
    ([...rows.querySelectorAll("button")].find(row => row.dataset.history === id) ?? filter).focus();
  });
  modal.querySelector("[data-close]")?.addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => {
    if (modal.open) return;
    listing?.abort();
    listing = undefined;
    stopRecord();
    onClose();
  });
  /** Open the dialog; with a history id, jump straight to that record once
   * the list loads. Reading a record never opens a route, so sidebar preview
   * cannot seize the holder: entering still goes through explicit resume. */
  function open(recordId?: string): void {
    if (!modal.open) {
      stopRecord();
      record.hidden = true;
      index.hidden = false;
      filter.value = "";
      modal.showModal();
    }
    void loadList().then(() => {
      if (!modal.open || recordId === undefined) return;
      const row = items.find(item => item.id === recordId);
      if (row) openRecord(row);
    });
  }
  return { open, update };
}
