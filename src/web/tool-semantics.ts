import { object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { tr, uiLocale } from "./locale.ts";
import { todoChange } from "./tool-todo.ts";
import type { TodoChange } from "./tool-todo.ts";

export const toolGlyphs = {
  inspect: "M7 3h6l4 4v6l-4 4H7l-4-4V7Zm8 12 6 6",
  modify: "m3 15 12-12h3l3 3v3L9 21H3Zm10-10 6 6",
  terminal: "M3 5h14l4 4v10H7l-4-4Zm4 4 3 3-3 3m6 0h4",
  memory: "M8 5V3m8 2V3M8 21v-2m8 2v-2M5 5h11l3 3v11H8l-3-3Zm4 4h4m-4 5h6",
  todo: "M6 3h10l3 3v12l-3 3H5V4Zm2 6 2 2 4-4m-6 9h7",
  execution: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
  context: "M8 4H6L3 7v10l3 3h2m8-16h2l3 3v10l-3 3h-2M8 9h8m-8 6h8",
  agent: "M8 3h4l3 3v4l-3 3H8l-3-3V6ZM2 21v-3l3-3h10l3 3v3m0-18 4 4v5",
  web: "M8 3h8l5 5v8l-5 5H8l-5-5V8Zm-5 9h18m-9-9-3 5v8l3 5 3-5V8Z",
  unknown: "M7 3h10l4 4v10l-4 4H7l-4-4V7Zm2 5 2-1h2l2 2v2l-3 2v1m0 3v.1",
} as const;

type Kind = keyof typeof toolGlyphs;
export type ToolFact = readonly [label: string, value: string];
export type ToolRecap = { readonly kind: Kind; readonly label: string; readonly operation?: string; readonly target?: string;
  readonly preview?: string; readonly group?: string; readonly command?: string; readonly source?: string;
  readonly todo?: TodoChange; readonly scope?: string; readonly dispatchRoutes?: readonly string[];
  readonly agentRouting?: readonly string[]; readonly agentPrompts?: readonly string[]; readonly facts?: readonly ToolFact[] };

const memoryActions = new Map<string, readonly [operation: string, target: string]>([
  ["create", [tr("新建", "Create"), tr("记忆条目", "Memory entry")]],
  ["str_replace", [tr("替换", "Replace"), tr("正文", "Content")]],
  ["insert", [tr("插入", "Insert"), tr("正文", "Content")]],
  ["delete", [tr("删除", "Delete"), tr("记忆条目", "Memory entry")]],
  ["rename", [tr("重命名", "Rename"), tr("名称", "Name")]],
  ["update_description", [tr("更新描述", "Update description"), tr("描述", "Description")]],
  ["apply_patch", [tr("应用补丁", "Apply patch"), tr("记忆补丁", "Memory patch")]],
]);
const languages = new Map([
  ["js", "JavaScript"], ["javascript", "JavaScript"], ["ts", "TypeScript"], ["typescript", "TypeScript"],
  ["py", "Python"], ["python", "Python"], ["shell", "Shell"], ["bash", "Bash"], ["powershell", "PowerShell"],
]);

function codeDesk(tool: "eval" | "ctx_execute" | "ctx_execute_file", input: Wire): Pick<ToolRecap, "preview" | "source" | "facts"> {
  if (tool === "eval" && input.action !== undefined && input.action !== "run") return {};
  const language = tool === "eval"
    ? input.language === "js" ? "JavaScript" : input.language === "py" ? "Python" : undefined
    : languages.get(str(input.language).toLowerCase());
  return { preview: language, source: str(input.code) || undefined, facts: language ? [[tr("语言", "Language"), language]] : undefined };
}

const secretPrefix = /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[A-Z0-9]{16}$)/iu;
const safeAgentRoute = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,47}$/u.test(value) && !secretPrefix.test(value);

function agentRouting(input: Wire): readonly string[] {
  const routing: string[] = [];
  for (const [caption, value] of [[tr("类别", "Category"), input.category], [tr("角色", "Role"), input.subagent_type]] as const) {
    if (safeAgentRoute(value)) routing.push(`${caption} ${value}`);
  }
  if (typeof input.run_in_background === "boolean") routing.push(input.run_in_background ? tr("后台", "Background") : tr("前台", "Foreground"));
  return routing;
}

const batchEntryLimit = 24;
const batchTextLimit = 16_384;
const batchText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= batchTextLimit && /\S/u.test(value);

function batchCount(value: unknown, valid: (entry: unknown) => boolean): number | undefined {
  if (Array.isArray(value) && value.length > 0 && value.length <= batchEntryLimit && value.every(valid)) return value.length;
}

function taskRoute(category: unknown, role: unknown): string | undefined {
  if (category === undefined && safeAgentRoute(role)) return tr(`角色 ${role}`, `Role ${role}`);
  if (role === undefined && safeAgentRoute(category)) return tr(`类别 ${category}`, `Category ${category}`);
}

function taskBatch(input: Wire): readonly { readonly route: string; readonly prompt: string }[] | undefined {
  if (input.prompt !== undefined || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > batchEntryLimit) return;
  const tasks: { route: string; prompt: string }[] = [];
  for (const entry of input.tasks) {
    const item = object(entry);
    const category = item.category === undefined ? input.category : item.category;
    const role = item.subagent_type === undefined ? input.subagent_type : item.subagent_type;
    const route = taskRoute(category, role);
    if (!route || !batchText(item.prompt)) return;
    tasks.push({ route, prompt: item.prompt });
  }
  return tasks;
}

const outputScopes = new Map([
  ["status", tr("状态", "Status")], ["tail", tr("最近输出", "Recent output")], ["full", tr("完整输出", "Full output")],
]);

export function textLines(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 65_536) return;
  if (!value.length) return 0;
  return (value.match(/\r\n|[\n\r]/gu)?.length ?? 0) + (value.endsWith("\n") || value.endsWith("\r") ? 0 : 1);
}

export function toolLineCount(lines: number): string {
  const count = lines.toLocaleString(uiLocale);
  return tr(`${count} 行`, `${count} ${lines === 1 ? "line" : "lines"}`);
}

function fileFacts(tool: string, input: Wire, args: unknown): readonly ToolFact[] {
  if (tool === "apply_patch") {
    const patch = (str(args) || str(input.patch) || str(input.patchText)).trim();
    if (patch.length > 65_536 || !/^\*\*\* Begin Patch\r?\n/u.test(patch) || !/\n\*\*\* End Patch$/u.test(patch)) return [];
    const facts: ToolFact[] = [];
    for (const [action, label] of [
      ["Add", tr("提交新增", "Add")], ["Update", tr("提交更新", "Update")], ["Delete", tr("提交删除", "Delete")],
    ] as const) {
      const count = [...patch.matchAll(new RegExp(`^\\*\\*\\* ${action} File: [^\\r\\n]+`, "gmu"))].length;
      const amount = count.toLocaleString(uiLocale);
      if (count) facts.push([label, tr(`${amount} 个文件`, `${amount} ${count === 1 ? "file" : "files"}`)]);
    }
    return facts;
  }
  if (tool === "write" || tool === "write_file") {
    const lines = textLines(input.content);
    return lines === undefined ? [] : [[tr("提交文本", "Submitted text"), toolLineCount(lines)]];
  }
  const before = textLines(input.oldText ?? input.old_string);
  const after = textLines(input.newText ?? input.new_string);
  const facts: ToolFact[] = [];
  if (before !== undefined) facts.push([tr("替换前", "Before replacement"), toolLineCount(before)]);
  if (after !== undefined) facts.push([before === undefined ? tr("提交文本", "Submitted text") : tr("替换后", "After replacement"), toolLineCount(after)]);
  return facts;
}

function webHostname(value: unknown): string | undefined {
  const address = str(value);
  // URL normalises some malformed authorities, including an empty userinfo; reject those before parsing.
  const authority = /^https?:\/\/([^/?#\\]+)/iu.exec(address)?.[1];
  if (!authority || authority.includes("@") || /[\s\\\p{Cc}\p{Cf}]/u.test(address)) return;
  const url = URL.parse(address);
  if (!url || url.username || url.password) return;
  const hostname = url.hostname.replace(/\.$/u, "");
  if (hostname.length > 253 || !/[a-z]/iu.test(hostname)) return;
  if (!hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label) && !secretPrefix.test(label))) return;
  return hostname;
}

function localTarget(value: unknown): string {
  const path = str(value);
  if (!path || path.length > 512 || !/^[\p{L}\p{M}\p{N}_.~ /\\-]+$/u.test(path) || path.startsWith("-")) return "";
  if (path === "." || path === ".." || path === "~") return path;
  const segments = path.split(/[/\\]/).filter(Boolean);
  if (segments.some(segment => secretPrefix.test(segment))) return "";
  if (!/[/\\]/.test(path) && !/^(?:[\p{L}_][\p{L}\p{M}\p{N}_-]{0,23}|[\p{L}\p{N}_-]*\.[\p{L}\p{N}]{1,10})$/u.test(path)) return "";
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

export function recapTool(name: string, args: unknown): ToolRecap {
  const input = object(args);
  const { path, file_path, filePath } = input;
  const tool = name.toLowerCase();
  switch (tool) {
    case "read": case "read_file":
      return { kind: "inspect", label: tr("读取文件", "Read file"), group: "Read", target: localTarget(path ?? file_path ?? filePath) };
    case "grep": return { kind: "inspect", label: tr("搜索内容", "Search contents"), group: "Grep", target: localTarget(path) };
    case "search": return { kind: "inspect", label: tr("搜索内容", "Search contents"), target: localTarget(path) };
    case "find": return { kind: "inspect", label: tr("查找文件", "Find files"), group: "Find", target: localTarget(path) };
    case "glob": return { kind: "inspect", label: tr("查找文件", "Find files"), group: "Glob", target: localTarget(path) };
    case "ls": case "list": case "list_dir": case "list_directory": case "list_files":
      return { kind: "inspect", label: tr("列出目录", "List directory"), group: "List", target: localTarget(path) };
    case "tool_search": return { kind: "inspect", label: tr("查找工具", "Find tools"), group: "Tool Search" };
    case "edit": case "edit_file": case "multiedit": case "apply_patch":
      return { kind: "modify", label: tr("编辑文件", "Edit file"), target: localTarget(path ?? file_path ?? filePath), facts: fileFacts(tool, input, args) };
    case "write": case "write_file":
      return { kind: "modify", label: tr("写入文件", "Write file"), target: localTarget(path ?? file_path ?? filePath), facts: fileFacts(tool, input, args) };
    case "bash": case "shell": case "powershell":
      return { kind: "terminal", label: tool === "powershell" ? "PowerShell" : tool === "shell" ? "Shell" : "Bash",
        operation: tr("运行命令", "Run command"), command: str(input.command) };
    case "bash_output": return { kind: "terminal", label: "Bash", operation: tr("读取输出", "Read output") };
    case "kill_bash": return { kind: "terminal", label: "Bash", operation: tr("终止命令", "Stop command") };
    case "memory": {
      const [operation, target] = memoryActions.get(str(input.command)) ?? [];
      return { kind: "memory", label: "Memory", operation,
        facts: target ? [[tr("变更对象", "Change target"), target]] : undefined };
    }
    case "todo": case "todowrite": {
      const todo = todoChange(input);
      return { kind: "todo", label: "Todo", operation: todo.operation, preview: todo.preview, todo };
    }
    case "eval": {
      const action = str(input.action);
      const operation = action === "peek" ? tr("查看执行", "View run") : action === "list" ? tr("列出执行", "List runs")
        : action === "stop" ? tr("停止执行", "Stop run")
        : action === "run" || input.action === undefined ? tr("执行脚本", "Run script") : undefined;
      return { kind: "execution", label: "Eval", operation, ...codeDesk(tool, input),
        group: operation && action !== "stop" && (input.reset === undefined || input.reset === false) ? "Eval" : undefined };
    }
    case "ctx_execute": case "ctx_execute_file":
      return { kind: "context", label: "Ctx Execute", operation: tr("执行脚本", "Run script"), group: "Ctx Execute", ...codeDesk(tool, input) };
    case "ctx_search": {
      const count = batchCount(input.queries, batchText);
      return { kind: "context", label: "Ctx Search", operation: tr("搜索上下文", "Search context"), group: "Ctx Search",
        facts: count === undefined ? undefined : [[tr("查询", "Queries"), tr(`${count.toLocaleString(uiLocale)} 条`, count.toLocaleString(uiLocale))]] };
    }
    case "ctx_batch": {
      const commands = batchCount(input.commands, batchText);
      const queries = batchCount(input.queries, batchText);
      const summary = commands !== undefined && queries !== undefined ? {
        preview: tr(`提交 ${commands.toLocaleString(uiLocale)} 条命令 · ${queries.toLocaleString(uiLocale)} 条查询`,
          `Submitted ${commands.toLocaleString(uiLocale)} ${commands === 1 ? "command" : "commands"} · ${queries.toLocaleString(uiLocale)} ${queries === 1 ? "query" : "queries"}`),
        facts: [[tr("命令", "Commands"), tr(`${commands.toLocaleString(uiLocale)} 条`, commands.toLocaleString(uiLocale))],
          [tr("查询", "Queries"), tr(`${queries.toLocaleString(uiLocale)} 条`, queries.toLocaleString(uiLocale))]] as const,
      } : undefined;
      return { kind: "context", label: "Ctx Batch", operation: tr("批量查询", "Batch search"), group: "Ctx Batch", ...summary };
    }
    case "ctx_index": {
      const inputs = [[input.path, tr("本机文件", "Local file")], [input.content, tr("提交文本", "Submitted text")],
        [input.url, tr("网页地址", "Web address")]].filter(([value]) => batchText(value));
      const kind = inputs.length === 1 ? str(inputs[0]?.[1]) : "";
      return { kind: "context", label: "Ctx Index", operation: tr("收录上下文", "Index context"), facts: kind ? [[tr("来源类型", "Source type"), kind]] : undefined };
    }
    case "ctx_purge": {
      const scopes = [input.project === true && tr("项目", "Project"), str(input.session) && tr("指定会话", "Selected session"),
        str(input.source) && tr("指定来源", "Selected source")].filter(Boolean);
      const scope = scopes.length === 1 ? str(scopes[0]) : "";
      return { kind: "context", label: "Ctx Purge", operation: tr("清除上下文", "Clear context"), facts: scope ? [[tr("清除范围", "Scope"), scope]] : undefined };
    }
    case "task": {
      const batch = taskBatch(input);
      const dispatchRoutes = batch?.map(task => task.route);
      const routing = input.tasks === undefined ? agentRouting(input) : undefined;
      const prompt = input.tasks === undefined && taskRoute(input.category, input.subagent_type) ? str(input.prompt) : "";
      const count = dispatchRoutes?.length.toLocaleString(uiLocale);
      return { kind: "agent", label: "Agent", operation: tr("派发任务", "Dispatch tasks"),
        preview: routing?.join(" · ") ?? (dispatchRoutes && tr(`提交 ${count} 项任务`,
          `Submitted ${count} ${dispatchRoutes.length === 1 ? "task" : "tasks"}`)),
        dispatchRoutes, agentRouting: routing, agentPrompts: batch?.map(task => task.prompt) ?? (prompt.trim() ? [prompt] : undefined) };
    }
    case "task_output": return { kind: "agent", label: "Agent", operation: tr("查看任务", "View task"), scope: outputScopes.get(str(input.mode)) };
    case "task_send": return { kind: "agent", label: "Agent", operation: tr("发送消息", "Send message") };
    case "web_search": case "mcp_tinyfish_search":
      return { kind: "web", label: "Web", operation: tr("网页搜索", "Search the web"), group: "Web Search",
        facts: batchText(input.query) ? [[tr("查询", "Queries"), tr("1 条", "1")]] : undefined };
    case "webfetch": case "mcp_tinyfish_fetch_content": {
      const host = webHostname(input.url);
      const addresses = batchCount(input.urls, batchText);
      const single = addresses === 1 && Array.isArray(input.urls) ? webHostname(input.urls[0]) : undefined;
      const hostname = host ?? single;
      return { kind: "web", label: "Web", operation: tr("读取网页", "Read webpage"), group: "Web Fetch", preview: hostname,
        facts: [...(hostname ? [[tr("主机", "Host"), hostname]] as const : []),
          ...(addresses === undefined ? [] : [[tr("地址", "Addresses"), tr(`${addresses.toLocaleString(uiLocale)} 个`, addresses.toLocaleString(uiLocale))]] as const)] };
    }
    default: {
      const safe = /^[\p{L}\p{N}_.:-]{1,80}$/u.test(name) && /\p{L}/u.test(name) &&
        !name.split(/[.:]/u).some(part => secretPrefix.test(part) || /^(?:token|password|authorization|bearer|api[_-]?key)$/iu.test(part));
      return { kind: "unknown", label: safe ? name : tr("工具调用", "Tool call") };
    }
  }
}
