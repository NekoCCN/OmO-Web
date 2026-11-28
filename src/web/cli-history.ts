import { RequestError, cliHistoryPath } from "./api.ts";
import type { Api, BranchSource, Session } from "./api.ts";
import { showNativeActivity } from "./details.ts";
import { byId, button, el, errorText, list, notice, num, object, option, str } from "./dom.ts";
import { roleOf, Transcript } from "./transcript.ts";
import { tr, uiLocale } from "./locale.ts";

type HistoryRow = { readonly id: string; readonly name: string; readonly cwd: string; readonly updatedAt: number };
type Picker = {
  readonly scope: () => { readonly paths: readonly string[]; readonly browse: boolean };
  readonly directoryLabel: (cwd: string) => string;
  readonly bookmarks: () => Iterable<Session>;
  readonly onDirectory: (cwd: string) => void;
  readonly browse: (onDismiss: () => void) => boolean;
  readonly onClose: () => void;
  readonly openBookmark: (session: Session) => void;
  readonly openBranch: (source: BranchSource) => void;
  readonly resumeUnavailable: () => string;
  readonly onResumed: (session: Session, show: boolean) => void;
};

const box = (id: string) => byId(id, HTMLElement);
const btn = (id: string) => byId(id, HTMLButtonElement);
const date = new Intl.DateTimeFormat(uiLocale, { dateStyle: "medium", timeStyle: "short" });
const time = (updatedAt: number) => Number.isFinite(new Date(updatedAt).getTime()) ? date.format(updatedAt) : "";

export function cliHistory(api: Api, picker: Picker) {
  const modal = byId("cli-history-dialog", HTMLDialogElement);
  const directory = byId("cli-history-directory", HTMLSelectElement);
  const directoryHint = box("cli-history-directory-hint");
  const browse = btn("cli-history-browse");
  const filter = byId("cli-history-search", HTMLInputElement);
  const rows = box("cli-history-list");
  const listStatus = box("cli-history-list-status");
  const listError = box("cli-history-list-error");
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
  let suspended = false;
  const opening = new Set<string>();
  const entryControl = () => !directory.disabled ? directory : !browse.hidden ? browse : btn("cli-history-title-close");

  function update(): void {
    const reason = picker.resumeUnavailable();
    const pending = selected !== undefined && opening.has(selected.id);
    branch.disabled = !readable || pending;
    resume.disabled = !selected || pending || Boolean(reason);
    refreshActivity.disabled = !readable || snapshot !== undefined;
    notice(resumeStatus, pending ? tr("正在尝试打开同一会话…", "Opening the same session in Web…") : selected ? reason : "");
  }

  function renderBookmarks(): void {
    if (!modal.open || index.hidden) return;
    const query = filter.value.trim().toLocaleLowerCase();
    const matches = [...picker.bookmarks()].filter(row => row.cwd === directory.value && row.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const host = box("cli-history-web-list");
    const signature = JSON.stringify(matches.map(({ id, name, archived }) => [id, name, archived]));
    if (host.dataset.rows === signature) return;
    host.dataset.rows = signature;
    const focused = document.activeElement instanceof HTMLButtonElement && host.contains(document.activeElement) ? document.activeElement.dataset.session : undefined;
    host.replaceChildren(...matches.map(row => {
      const li = el("li");
      const open = button("", () => picker.openBookmark(row), "button--quiet session-link");
      open.dataset.session = row.id;
      open.append(el("span", "", row.name));
      if (row.archived) open.append(el("small", "", tr("已归档", "Archived")));
      li.append(open);
      return li;
    }));
    box("cli-history-bookmarks").hidden = !matches.length;
    if (focused) ([...host.querySelectorAll("button")].find(row => row.dataset.session === focused) ?? filter).focus({ preventScroll: true });
  }

  function renderList(): void {
    const query = filter.value.trim().toLocaleLowerCase();
    const matches = items.filter(row => row.name.toLocaleLowerCase().includes(query));
    const focused = document.activeElement instanceof HTMLButtonElement && rows.contains(document.activeElement) ? document.activeElement.dataset.history : undefined;
    rows.replaceChildren();
    for (const row of matches) {
      const li = el("li");
      const open = button("", () => openRecord(row), "button--quiet session-link");
      open.dataset.history = row.id;
      open.append(el("span", "", row.name), el("small", "numerical", time(row.updatedAt)));
      li.append(open);
      rows.append(li);
    }
    rows.hidden = !matches.length;
    if (focused) ([...rows.querySelectorAll("button")].find(row => row.dataset.history === focused) ?? filter).focus({ preventScroll: true });
    notice(listStatus, listing ? tr("正在读取此目录的 CLI 历史…", "Loading CLI history for this directory…") : available === false
      ? tr("CLI 历史不可用：未启用或未找到本地历史记录。", "CLI history is disabled or no local history records were found.") : available && !matches.length
        ? query ? tr("没有匹配的 CLI 历史。", "No matching CLI history.") : tr("此目录没有未在 Web 打开的 CLI 会话。", "No CLI sessions to add from this directory.") : "");
    renderBookmarks();
  }

  async function loadList(): Promise<void> {
    const cwd = directory.value;
    if (!cwd || listing) return;
    const request = listing = new AbortController();
    const current = () => listing === request && cwd === directory.value;
    refresh.setAttribute("aria-disabled", "true");
    notice(listError);
    notice(listStatus, tr("正在读取此目录的 CLI 历史…", "Loading CLI history for this directory…"));
    try {
      const data = await api.request(`/api/cli-history?${new URLSearchParams({ cwd })}`, undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
      if (!current()) return;
      if (typeof data.available !== "boolean" || !Array.isArray(data.sessions)) {
        throw new Error(tr("无法核验目录会话列表。", "Could not verify the directory session list."));
      }
      available = data.available;
      items = list(data.sessions).map(object).flatMap(row => {
        const id = str(row.id);
        return available && /^[a-f0-9]{64}$/u.test(id) && row.cwd === cwd && row.adopted === false
          ? [{ id, name: str(row.name) || tr("未命名 CLI 会话", "Untitled CLI session"), cwd, updatedAt: num(row.updatedAt) ?? 0 }] : [];
      });
    } catch (error) {
      if (!current()) return;
      items = [];
      available = undefined;
      notice(listError, tr(`无法读取 CLI 历史：${errorText(error)}`, `Could not load CLI history: ${errorText(error)}`));
    } finally {
      if (current()) {
        listing = undefined;
        refresh.removeAttribute("aria-disabled");
        renderList();
      }
    }
  }

  function setDirectory(cwd: string): void {
    listing?.abort();
    listing = undefined;
    directory.value = cwd;
    filter.value = "";
    items = [];
    available = undefined;
    refresh.removeAttribute("aria-disabled");
    notice(listError);
    notice(box("cli-history-directory-path"), directory.value);
    directoryHint.hidden = Boolean(directory.value);
    box("cli-history-results").hidden = !directory.value;
    renderList();
    if (directory.value) {
      picker.onDirectory(directory.value);
      void loadList();
    }
  }

  function scopeChanged(reset = false): void {
    if (!modal.open && !suspended) return;
    const { paths, browse: supported } = picker.scope();
    const cwd = directory.value;
    browse.hidden = !supported;
    directory.disabled = !paths.length;
    const signature = JSON.stringify(paths);
    if (directory.dataset.paths !== signature) {
      directory.dataset.paths = signature;
      directory.replaceChildren(option(tr("选择已授权目录", "Choose an authorized directory"), ""), ...paths.map(path => option(picker.directoryLabel(path), path)));
      directory.value = paths.includes(cwd) ? cwd : "";
    }
    if (reset || (cwd && !directory.value)) {
      stopRecord();
      record.hidden = true;
      index.hidden = false;
      setDirectory("");
      if (modal.open) entryControl().focus();
    }
    directoryHint.textContent = paths.length
      ? tr("先选目录查看会话，不会直接打开。", "Choose a directory to list its sessions. This won’t open a session.")
      : supported ? tr("还没有获准目录。可浏览或输入一个绝对路径。", "No directories are authorized. Browse or enter an absolute path.")
        : tr("没有获准目录。请检查 Web 服务启动设置。", "No directories are authorized. Check the Web server startup settings.");
  }

  const recordPath = (row: HistoryRow) => cliHistoryPath(row.id);

  async function loadActivity(row: HistoryRow): Promise<void> {
    snapshot?.abort();
    const request = snapshot = new AbortController();
    update();
    const previousStatus = activity.querySelector("[data-activity-status]");
    previousStatus?.remove();
    const status = el("p", "small muted", tr("正在读取原生快照…", "Loading native snapshot…"));
    status.dataset.activityStatus = "";
    status.setAttribute("role", "status");
    activity.append(status);
    try {
      const data = await api.request(`${recordPath(row)}/activity`, undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
      if (request.signal.aborted || !modal.open || selected !== row) return;
      showNativeActivity(activity, data);
    } catch (error) {
      if (!request.signal.aborted && modal.open && selected === row) {
        status.textContent = tr(`无法读取原生快照：${errorText(error)}`, `Could not load the native snapshot: ${errorText(error)}`);
        status.className = "notice error small";
        status.setAttribute("role", "alert");
      }
    } finally {
      if (snapshot === request) {
        snapshot = undefined;
        update();
      }
    }
  }

  async function loadRecord(row: HistoryRow): Promise<void> {
    reading?.abort();
    const request = reading = new AbortController();
    const status = box("cli-history-record-status");
    notice(status, tr("正在读取对话记录…", "Loading conversation…"));
    notice(box("cli-history-record-error"));
    try {
      const data = await api.request(recordPath(row), undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
      if (request.signal.aborted || !modal.open || selected !== row) return;
      const session = object(data.session);
      title.textContent = str(session.name) || row.name;
      readable = true;
      update();
      const modified = time(num(session.updatedAt) ?? row.updatedAt);
      notice(box("cli-history-record-updated"), modified && tr(`记录更新：${modified}`, `Record updated: ${modified}`));
      const entries = list(data.messages).map(object).map((message, i) => {
        const toolId = roleOf(message) === "toolResult" && str(message.toolCallId);
        return { key: toolId ? `result:${toolId}` : `history-${i}`, message };
      });
      transcript.render(entries, "", new Map());
      requestAnimationFrame(() => { if (!request.signal.aborted && modal.open && selected === row) modal.scrollTop = 0; });
    } catch (error) {
      if (request.signal.aborted || !modal.open || selected !== row) return;
      if (error instanceof RequestError && (error.code === "history_too_large" || error.code === "history_preview_too_large")) {
        notice(box("cli-history-record-error"),
          tr("这条 CLI 记录过大，无法预览。仍可尝试在 Web 继续。",
            "This CLI record is too large to preview. You can still try to continue in Web."));
        return;
      }
      notice(box("cli-history-record-error"),
        tr(`无法读取这条记录：${errorText(error)}`, `Could not load this record: ${errorText(error)}`));
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
    notice(resumeError);
    update();
    transcript.reset();
    activity.replaceChildren();
  }

  function openRecord(item: HistoryRow): void {
    if (directory.value !== item.cwd) return;
    stopRecord();
    const row = selected = { ...item };
    index.hidden = true;
    record.hidden = false;
    title.textContent = row.name;
    box("cli-history-record-meta").textContent = row.cwd;
    notice(box("cli-history-record-updated"));
    box("cli-history-empty").hidden = true;
    title.focus({ preventScroll: true });
    modal.scrollTop = 0;
    update();
    void loadRecord(row);
  }

  directory.addEventListener("change", () => setDirectory(directory.value));
  browse.addEventListener("click", () => {
    suspended = true;
    modal.close();
    if (!picker.browse(() => { open(); browse.focus(); })) open();
  });
  filter.addEventListener("input", renderList);
  refresh.addEventListener("click", () => void loadList());
  refreshActivity.addEventListener("click", () => { if (selected && readable) void loadActivity(selected); });
  branch.addEventListener("click", () => {
    if (selected && readable) picker.openBranch({ kind: "history", id: selected.id, name: selected.name });
  });
  resume.addEventListener("click", async () => {
    const row = selected;
    if (!row || resume.disabled) return;
    const token = api.token;
    opening.add(row.id);
    const stillSelected = () => modal.open && selected === row;
    notice(resumeError);
    update();
    resumeStatus.focus();
    try {
      // Leave the HTTP mutation to finish if the user dismisses the record. A
      // late response must not navigate away from the user's new selection.
      const session = await api.resumeHistory(row.id);
      if (token !== api.token) return;
      if (session.cwd !== row.cwd) throw new Error(tr("返回的会话不属于所选目录。", "The returned session does not belong to the selected directory."));
      items = items.filter(item => item.id !== row.id);
      picker.onResumed(session, stillSelected());
      if (modal.open && !index.hidden) renderList();
    } catch (error) {
      if (stillSelected()) {
        notice(resumeError, tr(`无法在 Web 继续：${errorText(error)}`, `Could not continue in Web: ${errorText(error)}`));
        if (document.activeElement === resumeStatus) resumeError.focus();
      }
    } finally {
      opening.delete(row.id);
      update();
    }
  });
  btn("cli-history-back").addEventListener("click", () => {
    const id = selected?.id;
    stopRecord();
    record.hidden = true;
    index.hidden = false;
    renderList();
    ([...rows.querySelectorAll("button")].find(row => row.dataset.history === id) ?? filter).focus();
  });
  modal.querySelector("[data-close]")?.addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => {
    if (modal.open || suspended) return;
    stopRecord();
    setDirectory("");
    picker.onClose();
  });
  function open(cwd?: string): void {
    if (modal.open) return;
    if (!suspended) {
      stopRecord();
      record.hidden = true;
      index.hidden = false;
      setDirectory("");
    }
    scopeChanged();
    modal.showModal();
    scopeChanged();
    suspended = false;
    if (cwd && picker.scope().paths.includes(cwd)) setDirectory(cwd);
    else renderBookmarks();
    entryControl().focus();
  }
  return { open, update, scopeChanged, renderBookmarks };
}
