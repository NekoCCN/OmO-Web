import { RequestError } from "./api.ts";
import type { Api } from "./api.ts";
import { byId, button, el, notice, num, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr } from "./locale.ts";

type Platform = "posix" | "win32";
type Approval = { readonly token: string; readonly path: string; readonly expiresAt: number };
type Operation = { readonly kind: "browse" | "prepare" | "decision"; readonly controller: AbortController };

const REQUEST_TIMEOUT_MS = 10_000;
const isTimeout = (error: unknown): boolean => error instanceof DOMException && error.name === "TimeoutError";

export function workspacePaths(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((path): path is string => typeof path === "string" && Boolean(path)))] : [];
}

export function workspaceBrowser(
  api: Api,
  scope: () => { readonly roots: readonly string[]; readonly selected: string },
  onSelect: (path: string, roots: readonly string[]) => void,
  restoreFocus: () => void,
) {
  const launch = byId("workspace-browser-button", HTMLButtonElement);
  const modal = byId("workspace-browser-dialog", HTMLDialogElement);
  const close = byId("workspace-browser-close", HTMLButtonElement);
  const form = byId("workspace-browser-form", HTMLFormElement);
  const input = byId("workspace-browser-path", HTMLInputElement);
  const use = byId("workspace-browser-use", HTMLButtonElement);
  const navigation = byId("workspace-browser-navigation", HTMLElement);
  const rootField = byId("workspace-browser-root-field", HTMLElement);
  const roots = byId("workspace-browser-root", HTMLSelectElement);
  const up = byId("workspace-browser-up", HTMLButtonElement);
  const current = byId("workspace-browser-current", HTMLElement);
  const status = byId("workspace-browser-status", HTMLElement);
  const entries = byId("workspace-browser-entries", HTMLUListElement);
  const feedback = byId("workspace-browser-feedback", HTMLElement);
  const approvalPanel = byId("workspace-browser-approval", HTMLElement);
  const approvalTitle = byId("workspace-browser-approval-title", HTMLElement);
  const approvalPath = byId("workspace-browser-approval-path", HTMLElement);
  const confirm = byId("workspace-browser-confirm", HTMLButtonElement);
  const deny = byId("workspace-browser-deny", HTMLButtonElement);
  let platform: Platform | undefined;
  let operation: Operation | undefined;
  let approval: Approval | undefined;
  let expiry = 0;
  let parent = "";

  function message(text = "", error = false): void {
    feedback.classList.toggle("error", error);
    notice(feedback, text);
  }

  function render(): void {
    const deciding = operation?.kind === "decision";
    const preparing = operation?.kind === "prepare";
    navigation.hidden = Boolean(approval);
    approvalPanel.hidden = !approval;
    approvalPath.textContent = approval?.path ?? "";
    use.disabled = !input.value || preparing || deciding;
    roots.disabled = preparing;
    up.disabled = !parent || preparing;
    close.setAttribute("aria-disabled", String(deciding));
    confirm.setAttribute("aria-disabled", String(deciding));
    deny.setAttribute("aria-disabled", String(deciding));
  }

  function setApproval(value?: Approval): void {
    clearTimeout(expiry);
    approval = value;
    if (value) {
      expiry = window.setTimeout(() => {
        if (approval === value && operation?.kind !== "decision") expire();
      }, value.expiresAt - Date.now());
    }
    render();
  }

  function expire(): void {
    setApproval();
    message(tr("审批已过期。请重新选择「使用此目录」，发起新的审批。", "Approval expired. Choose “Use this directory” to request approval again."), true);
    use.focus();
  }

  function abort(): void {
    const previous = operation;
    operation = undefined;
    previous?.controller.abort();
  }

  async function request(
    kind: Operation["kind"], route: string, body: object,
    accept: (data: Wire) => void, reject: (error: unknown) => void,
  ): Promise<void> {
    if (!modal.open || operation?.kind === "decision" || !platform) return;
    abort();
    const active = { kind, controller: new AbortController() };
    operation = active;
    render();
    const deadline = performance.now() + REQUEST_TIMEOUT_MS;
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let onAbort: (() => void) | undefined;
    try {
      // Stop waiting even if a transport does not reject on abort.
      const aborted = new Promise<never>((_, stop) => {
        onAbort = () => stop(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const data = await Promise.race([api.request(`/api/workspaces/${route}`, body, signal), aborted]);
      if (operation !== active || !modal.open || active.controller.signal.aborted) return;
      signal.throwIfAborted();
      // A response can resume before an already-due timeout task runs.
      if (performance.now() >= deadline) throw new DOMException("Workspace request timed out", "TimeoutError");
      operation = undefined;
      render();
      accept(data);
    } catch (error) {
      if ((operation !== active && operation !== undefined) || !modal.open || active.controller.signal.aborted) return;
      operation = undefined;
      render();
      reject(error);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  function resetListing(target = ""): void {
    parent = "";
    current.textContent = target;
    current.hidden = !target;
    entries.replaceChildren();
    entries.hidden = true;
  }

  function browse(path: string, focusPath = true): void {
    if (!path || approval || operation?.kind === "prepare" || !modal.open) return;
    input.value = path;
    // Move keyboard focus before removing the selected directory button.
    if (focusPath) {
      current.textContent = path;
      current.hidden = false;
      current.focus({ preventScroll: true });
    }
    resetListing(path);
    message();
    status.textContent = tr("正在读取目录…", "Reading directory…");
    void request("browse", "browse", { path }, data => {
      const canonical = str(data.path);
      if (!canonical || !Array.isArray(data.entries)) throw new Error("Invalid browse response");
      parent = str(data.parent);
      current.textContent = canonical;
      input.value = canonical;
      roots.value = scope().roots.includes(canonical) ? canonical : "";
      for (const item of data.entries) {
        const { name, path: destination, kind } = object(item);
        if (typeof name !== "string" || !name || typeof destination !== "string" || !destination) continue;
        if (kind !== "directory" && kind !== "file") continue;
        const row = el("li");
        const control = kind === "directory"
          ? button("", () => browse(destination), "button--quiet workspace-entry")
          : el("div", "workspace-entry");
        control.append(el("bdi", "break", name), el("span", "small muted", kind === "directory" ? tr("目录 ›", "Folder ›") : tr("文件", "File")));
        row.append(control);
        entries.append(row);
      }
      entries.hidden = !entries.childElementCount;
      status.textContent = data.truncated === true ? tr("目录条目太多，仅显示部分名称。", "This directory has too many entries to show them all.") : entries.hidden ? tr("没有可显示的条目。", "No entries to show.") : "";
      render();
    }, error => {
      status.textContent = "";
      roots.value = "";
      message(isTimeout(error) ? tr("读取目录超时。请重新选择一个已授权工作区。", "Reading the directory timed out. Choose an authorized directory and try again.")
        : tr("无法读取该目录。只能浏览已授权范围内仍可访问的目录。", "Could not read this directory. You can only browse accessible directories within authorized locations."), true);
    });
  }

  function select(data: Wire): void {
    const path = str(data.path);
    const allowed = workspacePaths(data.workspaces);
    if (!path || !allowed.includes(path)) throw new Error("Invalid workspace selection receipt");
    modal.close();
    onSelect(path, allowed);
  }

  function prepare(path: string): void {
    if (!path || approval || operation?.kind === "prepare") return;
    if (operation?.kind === "browse") status.textContent = tr("目录读取已取消。", "Directory read canceled.");
    message(tr("正在核验目录…", "Verifying directory…"));
    void request("prepare", "prepare", { path }, data => {
      if (data.status === "authorized") { select(data); return; }
      const canonical = str(data.path);
      const token = str(data.confirmation);
      const expiresAt = num(data.expiresAt);
      if (data.status !== "confirmation_required" || !canonical || !token || expiresAt === undefined) throw new Error("Invalid approval response");
      input.value = canonical;
      if (expiresAt <= Date.now()) { expire(); return; }
      message();
      setApproval({ token, path: canonical, expiresAt });
      approvalTitle.focus();
    }, error => {
      message(isTimeout(error) ? tr("核验目录超时。路径已保留，请重试。", "Directory verification timed out. The path is still in the field. Try again.")
        : tr("无法核验目录。请检查绝对路径、目录是否仍存在及本机 Web 服务是否可用。", "Could not verify the directory. Check the absolute path, whether the directory still exists, and whether the local Web server is running."), true);
    });
  }

  function decide(allow: boolean, closeAfter = false): void {
    if (!approval || operation?.kind === "decision") return;
    const { token, expiresAt } = approval;
    if (expiresAt <= Date.now()) { expire(); return; }
    clearTimeout(expiry);
    message(allow ? tr("正在提交允许决定…", "Granting access…") : tr("正在提交拒绝决定…", "Denying access…"));
    void request("decision", "confirm", { confirmation: token, allow }, data => {
      if (allow) { select(data); return; }
      if (data.status !== "cancelled") throw new Error("Invalid denial receipt");
      setApproval();
      if (closeAfter) modal.close();
      else {
        message(tr("已拒绝。工作区未切换。", "Access denied. The selected directory did not change."));
        use.focus();
      }
    }, error => {
      setApproval();
      const stale = error instanceof RequestError && (error.code === "workspace_confirmation_stale" || error.status === 410);
      message(stale
        ? tr("审批已失效：可能已过期或目录已变更。请重新核验路径。", "Approval expired or the directory changed. Verify the path again.")
        : tr("未能确认审批结果，未切换工作区。请重新核验路径。", "Could not confirm the approval result. The selected directory did not change. Verify the path again."), true);
      use.focus();
    });
  }

  function dismiss(): void {
    if (operation?.kind === "decision") return;
    if (approval) decide(false, true);
    else {
      abort();
      modal.close();
    }
  }

  function setRoots(): void {
    const { roots: paths } = scope();
    const selected = roots.value;
    roots.replaceChildren(option(tr("选择已授权工作区", "Choose an authorized directory"), ""), ...paths.map(path => option(path, path)));
    roots.value = paths.includes(selected) ? selected : "";
    rootField.hidden = !paths.length;
  }

  launch.addEventListener("click", () => {
    if (!platform || document.querySelector("dialog:modal")) return;
    abort();
    setApproval();
    message();
    const { roots: paths, selected } = scope();
    const start = paths.includes(selected) ? selected : paths[0] ?? "";
    setRoots();
    roots.value = start;
    input.value = start;
    status.textContent = start ? "" : tr("没有已授权目录。可手动输入目录的绝对路径。", "No directories are authorized. Enter an absolute directory path.");
    resetListing();
    render();
    modal.showModal();
    if (start) browse(start, false);
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    prepare(input.value);
  });
  input.addEventListener("input", () => {
    if (operation?.kind === "browse" || operation?.kind === "prepare") {
      if (operation.kind === "browse") status.textContent = tr("目录读取已取消。", "Directory read canceled.");
      abort();
    }
    message();
    render();
  });
  roots.addEventListener("change", () => browse(roots.value));
  up.addEventListener("click", () => browse(parent));
  confirm.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));
  close.addEventListener("click", dismiss);
  modal.addEventListener("cancel", event => {
    event.preventDefault();
    dismiss();
  });
  modal.addEventListener("close", () => {
    if (modal.open) return;
    abort();
    setApproval();
    message();
    resetListing();
    if (!document.querySelector("dialog:modal")) restoreFocus();
  });

  return {
    update(value: unknown, tokenChanged: boolean): void {
      const candidate = object(value).platform;
      const next = candidate === "win32" || candidate === "posix" ? candidate : undefined;
      const invalidated = platform !== next || tokenChanged;
      platform = next;
      launch.hidden = !platform;
      input.placeholder = platform === "win32" ? "C:\\Projects\\OmO" : "/home/me/projects/OmO";
      if (!modal.open) return;
      if (!platform) {
        abort();
        modal.close();
      } else {
        setRoots();
        if (!invalidated) return;
        abort();
        setApproval();
        resetListing();
        status.textContent = "";
        message(tr("本机 Web 服务连接已更新。请重新选择或核验目录。", "The local Web server connection changed. Choose a directory or verify the path again."), true);
        input.focus();
      }
    },
  };
}
