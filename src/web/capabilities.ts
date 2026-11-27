import { el, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { commandListIndex, isPlainCommandKey, scrollCommandRow } from "./command-list-keys.ts";
import { tr, uiLocale } from "./locale.ts";

type Row = { readonly name: string; readonly detail: string };
type Section =
  | { readonly status: "ok"; readonly rows: readonly Row[]; readonly incomplete: boolean }
  | { readonly status: "unavailable"; readonly reason: "rpc-failed" | "invalid-response" };

const surfaceName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const commandLabels = new Map([["extension", tr("扩展", "Extension")], ["prompt", tr("提示模板", "Prompt template")], ["skill", tr("技能", "Skill")]]);
const mcpLabels = new Map([
  ["enabled", tr("已启用", "Enabled")], ["disabled", tr("已停用", "Disabled")], ["untrusted", tr("不受信任", "Untrusted")], ["idle", tr("空闲", "Idle")],
  ["connecting", tr("连接中", "Connecting")], ["connected", tr("已连接", "Connected")], ["degraded", tr("降级", "Degraded")], ["suspended", tr("已挂起", "Suspended")],
  ["needs_auth", tr("需要认证", "Authentication required")], ["needs_client_registration", tr("需要注册客户端", "Client registration required")],
]);
const count = new Intl.NumberFormat(uiLocale);

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
  const provenance = origin === "package" ? tr(" · 包来源", " · From package") : origin === "top-level" ? tr(" · 顶层来源", " · Top-level") : "";
  return { name, detail: (enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")) + provenance };
}

function mcp({ name, status, toolCount }: Wire): Row | undefined {
  const label = mcpLabels.get(str(status));
  if (!label || typeof name !== "string" || !surfaceName.test(name) ||
    typeof toolCount !== "number" || !Number.isSafeInteger(toolCount) || toolCount < 0) return;
  return { name, detail: tr(`${label} · ${count.format(toolCount)} 个工具`, `${label} · ${count.format(toolCount)} ${toolCount === 1 ? "tool" : "tools"}`) };
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
    group.append(el("p", "small muted", section.reason === "rpc-failed"
      ? tr("当前不可用：未能从当前宿主读取。", "Unavailable: Could not read from the current host.")
      : tr("当前不可用：原生响应格式无效。", "Unavailable: The native response was invalid.")));
    return group;
  }
  if (explanation) group.append(el("p", "small muted", explanation));
  if (section.rows.length) {
    const list = el("dl", "capability-list small numerical");
    list.tabIndex = 0;
    list.setAttribute("aria-label", tr(`${title} · 只读列表`, `${title} · Read-only list`));
    for (const row of section.rows) {
      const item = el("div");
      item.tabIndex = -1;
      const name = el("dt");
      name.append(el("code", "", row.name));
      item.append(name, el("dd", "muted", row.detail));
      list.append(item);
    }
    list.addEventListener("keydown", event => {
      if (!isPlainCommandKey(event)) return;
      const viewport = list.closest<HTMLElement>(".details-scroll");
      if (!viewport) return;
      const items = Array.from(list.children) as HTMLElement[];
      const index = items.findIndex(item => item === event.target);
      const next = commandListIndex(event.key, index, items, viewport);
      if (next === undefined) return;
      event.preventDefault();
      items[next].focus({ preventScroll: true });
      scrollCommandRow(viewport, items[next]);
    });
    group.append(list);
  }
  if (section.incomplete) {
    group.append(el("p", "small muted", section.rows.length
      ? tr("清单不完整，部分项目未显示。", "This list is incomplete. Some entries are not shown.")
      : tr("清单不完整，没有可显示的项目。", "This list is incomplete. No entries can be shown.")));
  } else if (!section.rows.length) {
    group.append(el("p", "small muted", tr("原生未报告任何条目。", "The native host did not report any entries.")));
  }
  return group;
}

export function renderCapabilities(data: Wire): HTMLElement[] {
  return [
    group(tr("已加载扩展", "Loaded extensions"), tr("这里只显示当前会话的原生报告，不是安装清单。",
      "Shows only what the native host reports for this session, not everything installed."), readSection(data.extensions, extension)),
    group(tr("MCP 服务", "MCP servers"), tr("状态与工具数由原生报告，不代表工具可立即调用。",
      "The native host reports status and tool counts. Tools may not be ready to use."), readSection(data.mcpServers, mcp)),
    renderLocalCompatibility(),
    group(tr("注册命令与技能", "Registered commands and skills"), tr("已注册不代表当前可执行。",
      "Registered commands and skills may not be available to run."), readSection(data.commands, command)),
  ];
}

export function renderLocalCompatibility(): HTMLElement {
  const section = el("section", "subpanel stack stack--tight");
  section.id = "runtime-compatibility";
  section.append(
    el("h3", "", tr("浏览器原生兼容未启用", "Native terminal features are unavailable in the browser")),
    el("p", "small muted", tr("尚未验证浏览器终端能在各模式下可靠隔离私密交互。",
      "The browser terminal has not been verified to keep private interactions isolated in every mode.")),
    el("p", "small muted", tr("账户登录、凭据、私密授权（含 MCP）、直接 shell 或外部编辑器，请在本机 OmO 终端完成。",
      "Use the local OmO terminal for sign-in, credentials, private approvals (including MCP), direct shell access, and external editors.")),
    el("p", "small muted", tr("请自行打开本机 OmO，选择对应的工作目录和会话，再手动操作。此提示不会启动终端、执行或重放命令，也不会传送私密内容。",
      "Open OmO locally and select the working directory and session. This notice does not launch a terminal, run or replay commands, or transmit private content.")),
    el("p", "small muted", tr("如果要继续同一会话，符合条件的空闲会话可用「会话管理 → 转到 CLI」先释放，再按回执在本机继续。",
      "To continue an eligible idle session, release it with “Manage session → Move to CLI”, then follow the instructions to continue locally.")),
  );
  return section;
}
