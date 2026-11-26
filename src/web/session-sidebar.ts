import { RequestError, sessionPath } from "./api.ts";
import type { Api } from "./api.ts";
import { byId, num, object } from "./dom.ts";
import type { GenerationSpeed } from "../stream-speed.ts";

export const thinkingLabels: Readonly<Record<string, string>> = {
  off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
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
    status.textContent = "正在读取工作目录中的 AGENTS.md…";
    try {
      const data = await api.request(`${sessionPath(id)}/instructions`, undefined,
        AbortSignal.any([request.signal, AbortSignal.timeout(18_000)]));
      if (!current()) return;
      switch (data.status) {
        case "ok":
          if (data.file !== "AGENTS.md" || typeof data.content !== "string") {
            status.textContent = "未能验证 AGENTS.md 原文。";
            break;
          }
          text.textContent = data.content;
          text.hidden = !data.content;
          status.textContent = data.content ? "已读取 AGENTS.md 原文。" : "AGENTS.md 是空文件。";
          break;
        case "missing": status.textContent = "当前工作目录没有 AGENTS.md。"; break;
        case "unsupported": status.textContent = "当前宿主或连接方式不支持读取项目规则。"; break;
        case "refused": status.textContent = "宿主拒绝读取，或无法确认文件属于当前会话。"; break;
        case "too_large": status.textContent = "AGENTS.md 超过读取上限，未显示内容。"; break;
        case "unavailable":
        default: status.textContent = "当前无法读取 AGENTS.md。关闭后可展开重试。";
      }
    } catch (error) {
      if (!current()) return;
      status.textContent = error instanceof RequestError && [401, 403, 409].includes(error.status)
        ? "读取被拒绝，或当前会话连接已变化。"
        : error instanceof RequestError && error.status === 404 && error.code === "not_found"
        ? "当前 Web 服务不支持读取项目规则。"
        : "当前无法读取 AGENTS.md。关闭后可展开重试。";
    } finally {
      if (active === request) active = undefined;
    }
  });

  return () => {
    disclosure.open = false;
    reset();
  };
}
