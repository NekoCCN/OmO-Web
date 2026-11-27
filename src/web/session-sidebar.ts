import { RequestError, sessionPath } from "./api.ts";
import type { Api } from "./api.ts";
import { byId, num, object } from "./dom.ts";
import type { GenerationSpeed } from "../stream-speed.ts";
import { tr } from "./locale.ts";

export const thinkingLabels: Readonly<Record<string, string>> = {
  off: tr("关闭", "Off"), minimal: tr("极低", "Minimal"), low: tr("低", "Low"), medium: tr("中", "Medium"),
  high: tr("高", "High"), xhigh: tr("极高", "Extra high"), max: tr("最高", "Maximum"),
};

export function readGenerationSpeed(value: unknown): GenerationSpeed | undefined {
  const data = object(value);
  const tokensPerSecond = num(data.tokensPerSecond);
  const measuredAt = num(data.measuredAt);
  return tokensPerSecond !== undefined && tokensPerSecond > 0 && measuredAt !== undefined && measuredAt >= 0
    ? { tokensPerSecond, measuredAt } : undefined;
}

export function bindProjectRules(api: Api, activeSession: () => string | undefined): () => void {
  const disclosure = byId("runtime-instructions", HTMLDetailsElement);
  const status = byId("runtime-instructions-status", HTMLElement);
  const text = byId("runtime-instructions-text", HTMLPreElement);
  const unavailable = tr("当前无法读取 AGENTS.md。关闭后可展开重试。", "Could not read AGENTS.md. Close and reopen this section to try again.");
  let active: AbortController | undefined;

  function reset(): void {
    active?.abort();
    active = undefined;
    text.hidden = true;
    text.textContent = "";
    status.textContent = "";
  }

  disclosure.addEventListener("toggle", async () => {
    reset();
    const id = activeSession();
    if (!disclosure.open || !id) return;
    const request = active = new AbortController();
    const current = () => active === request && disclosure.open && activeSession() === id;
    status.textContent = tr("正在读取工作目录中的 AGENTS.md…", "Reading AGENTS.md in the working directory…");
    try {
      const data = await api.request(`${sessionPath(id)}/instructions`, undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(18_000)]));
      if (!current()) return;
      switch (data.status) {
        case "ok":
          if (data.file !== "AGENTS.md" || typeof data.content !== "string") {
            status.textContent = tr("未能验证 AGENTS.md 原文。", "Could not verify the contents of AGENTS.md.");
            break;
          }
          text.textContent = data.content;
          text.hidden = !data.content;
          status.textContent = data.content ? tr("已读取 AGENTS.md 原文。", "Showing AGENTS.md as written.") : tr("AGENTS.md 是空文件。", "AGENTS.md is empty.");
          break;
        case "missing": status.textContent = tr("当前工作目录没有 AGENTS.md。", "There is no AGENTS.md in the working directory."); break;
        case "unsupported": status.textContent = tr("当前宿主或连接方式不支持读取项目规则。", "The current host or connection does not support reading project rules."); break;
        case "refused": status.textContent = tr("宿主拒绝读取，或无法确认文件属于当前会话。", "The host refused the read or could not verify that the file belongs to this session."); break;
        case "too_large": status.textContent = tr("AGENTS.md 超过读取上限，未显示内容。", "AGENTS.md exceeds the read limit. Its contents are not shown."); break;
        case "unavailable":
        default: status.textContent = unavailable;
      }
    } catch (error) {
      if (!current()) return;
      status.textContent = error instanceof RequestError && [401, 403, 409].includes(error.status)
        ? tr("读取被拒绝，或当前会话连接已变化。", "The read was refused or the session connection changed.")
        : error instanceof RequestError && error.status === 404 && error.code === "not_found"
        ? tr("当前 Web 服务不支持读取项目规则。", "This Web server does not support reading project rules.")
        : unavailable;
    } finally {
      if (active === request) active = undefined;
    }
  });

  return () => {
    disclosure.open = false;
    reset();
  };
}
