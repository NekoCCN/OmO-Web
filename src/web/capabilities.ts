import { el, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

type Row = { readonly name: string; readonly detail: string };
type Section =
  | { readonly status: "ok"; readonly rows: readonly Row[]; readonly incomplete: boolean }
  | { readonly status: "unavailable"; readonly reason: "rpc-failed" | "invalid-response" };

const surfaceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const commandLabels = new Map([["extension", "扩展"], ["prompt", "提示模板"], ["skill", "技能"]]);
const mcpLabels = new Map([
  ["enabled", "已启用"], ["disabled", "已停用"], ["untrusted", "不受信任"], ["idle", "空闲"],
  ["connecting", "连接中"], ["connected", "已连接"], ["degraded", "降级"], ["suspended", "已挂起"],
  ["needs_auth", "需要认证"], ["needs_client_registration", "需要注册客户端"],
]);
const count = new Intl.NumberFormat("zh-CN");

function command(row: Wire): Row | undefined {
  const invocation = str(row.invocation);
  const source = str(row.source);
  const detail = commandLabels.get(source);
  if (!detail) return;
  const valid = source === "skill" ? /^\$[A-Za-z0-9-]{1,64}$/.test(invocation) : /^\/[A-Za-z0-9_-]{1,64}$/.test(invocation);
  if (valid) return { name: invocation, detail };
}

function extension({ name, enabled, origin }: Wire): Row | undefined {
  if (typeof name !== "string" || !surfaceName.test(name) || typeof enabled !== "boolean") return;
  const provenance = origin === "package" ? " · 包来源" : origin === "top-level" ? " · 顶层来源" : "";
  return { name, detail: (enabled ? "已启用" : "已停用") + provenance };
}

function mcp({ name, status, toolCount }: Wire): Row | undefined {
  const label = mcpLabels.get(str(status));
  if (!label || typeof name !== "string" || !surfaceName.test(name) ||
    typeof toolCount !== "number" || !Number.isSafeInteger(toolCount) || toolCount < 0) return;
  return { name, detail: `${label} · ${count.format(toolCount)} 个工具` };
}

function readSection(value: unknown, project: (row: Wire) => Row | undefined): Section {
  const raw = object(value);
  if (raw.status !== "ok" || !Array.isArray(raw.rows) || typeof raw.incomplete !== "boolean") {
    return { status: "unavailable", reason: raw.status === "unavailable" && raw.reason === "rpc-failed" ? "rpc-failed" : "invalid-response" };
  }
  const rows = raw.rows.slice(0, 128).flatMap(entry => project(object(entry)) ?? []);
  return { status: "ok", rows, incomplete: raw.incomplete || rows.length !== raw.rows.length };
}

function group(title: string, explanation: string, section: Section): HTMLElement {
  const group = el("section", "subpanel stack stack--tight");
  group.append(el("h3", "", title));
  if (section.status === "unavailable") {
    const reason = section.reason === "rpc-failed" ? "未能从当前宿主读取" : "原生响应格式无效";
    group.append(el("p", "small muted", `当前不可用：${reason}。`));
    return group;
  }
  if (explanation) group.append(el("p", "small muted", explanation));
  if (section.rows.length) {
    const list = el("dl", "capability-list small numerical");
    for (const row of section.rows) {
      const item = el("div");
      const name = el("dt");
      name.append(el("code", "", row.name));
      item.append(name, el("dd", "muted", row.detail));
      list.append(item);
    }
    group.append(list);
  }
  if (section.incomplete) {
    group.append(el("p", "small muted", section.rows.length
      ? "清单不完整，部分项目未显示。" : "清单不完整，没有可显示的项目。"));
  } else if (!section.rows.length) {
    group.append(el("p", "small muted", "原生未报告任何条目。"));
  }
  return group;
}

export function renderCapabilities(data: Wire): HTMLElement[] {
  return [
    group("已加载扩展", "这里只显示当前会话的原生报告，不是安装清单。", readSection(data.extensions, extension)),
    group("MCP 服务", "状态与工具数由原生报告，不代表工具可立即调用。", readSection(data.mcpServers, mcp)),
    renderLocalCompatibility(),
    group("注册命令与技能", "已注册不代表当前可执行。", readSection(data.commands, command)),
  ];
}

export function renderLocalCompatibility(): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.id = "runtime-compatibility";
  section.append(
    el("h3", "", "浏览器原生兼容未启用"),
    el("p", "small muted", "尚未验证浏览器终端能在各模式下可靠隔离私密交互。"),
    el("p", "small muted", "账户登录、凭据、私密授权（含 MCP）、直接 shell 或外部编辑器，请在本机 OmO 终端完成。"),
    el("p", "small muted", "请自行打开本机 OmO，选择对应的工作目录和会话，再手动操作。此提示不会启动终端、执行或重放命令，也不会传送私密内容。"),
    el("p", "small muted", "如果要继续同一会话，符合条件的空闲会话可用「会话管理 → 转到 CLI」先释放，再按回执在本机继续。"),
  );
  return section;
}
