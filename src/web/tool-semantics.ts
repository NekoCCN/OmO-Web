import { object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
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
export type ToolRecap = { readonly kind: Kind; readonly label: string; readonly operation?: string; readonly target?: string;
  readonly preview?: string; readonly group?: string; readonly command?: string; readonly source?: string;
  readonly todo?: TodoChange; readonly scope?: string };

const memoryOperations = new Map([
  ["create", "新建"], ["str_replace", "替换"], ["insert", "插入"], ["delete", "删除"],
  ["rename", "重命名"], ["update_description", "更新描述"], ["apply_patch", "应用补丁"],
]);
const languages = new Map([
  ["js", "JavaScript"], ["javascript", "JavaScript"], ["ts", "TypeScript"], ["typescript", "TypeScript"],
  ["py", "Python"], ["python", "Python"], ["shell", "Shell"], ["bash", "Bash"], ["powershell", "PowerShell"],
]);

function codeDesk(tool: "eval" | "ctx_execute" | "ctx_execute_file", input: Wire): Pick<ToolRecap, "preview" | "source"> {
  if (tool === "eval" && input.action !== undefined && input.action !== "run") return {};
  const language = tool === "eval"
    ? input.language === "js" ? "JavaScript" : input.language === "py" ? "Python" : undefined
    : languages.get(str(input.language).toLowerCase());
  return { preview: language, source: str(input.code) || undefined };
}

const secretPrefix = /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[A-Z0-9]{16}$)/iu;
const safeAgentRoute = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,47}$/u.test(value) && !secretPrefix.test(value);

function agentRouting(input: Wire): string {
  const routing: string[] = [];
  for (const [caption, value] of [["类别", input.category], ["角色", input.subagent_type]] as const) {
    if (safeAgentRoute(value)) routing.push(`${caption} ${value}`);
  }
  if (typeof input.run_in_background === "boolean") routing.push(input.run_in_background ? "后台" : "前台");
  return routing.join(" · ");
}

const batchEntryLimit = 24;
const batchTextLimit = 16_384;
const batchText = (value: unknown): boolean =>
  typeof value === "string" && value.length <= batchTextLimit && /\S/u.test(value);

function batchCount(value: unknown, valid: (entry: unknown) => boolean): number | undefined {
  if (Array.isArray(value) && value.length > 0 && value.length <= batchEntryLimit && value.every(valid)) return value.length;
}

function ctxBatchPreview(input: Wire): string | undefined {
  const commands = batchCount(input.commands, batchText);
  const queries = batchCount(input.queries, batchText);
  if (commands !== undefined && queries !== undefined) return `提交 ${commands} 条命令 · ${queries} 条查询`;
}

function taskBatchPreview(input: Wire): string | undefined {
  if (input.prompt !== undefined) return;
  const count = batchCount(input.tasks, entry => {
    const item = object(entry);
    const category = item.category === undefined ? input.category : item.category;
    const role = item.subagent_type === undefined ? input.subagent_type : item.subagent_type;
    return batchText(item.prompt) && (category === undefined ? safeAgentRoute(role) : role === undefined && safeAgentRoute(category));
  });
  if (count !== undefined) return `提交 ${count} 项任务`;
}

const outputScopes = new Map([["status", "状态"], ["tail", "最近输出"], ["full", "完整输出"]]);

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
      return { kind: "inspect", label: "读取文件", group: "Read", target: localTarget(path ?? file_path ?? filePath) };
    case "grep": return { kind: "inspect", label: "搜索内容", group: "Grep", target: localTarget(path) };
    case "search": return { kind: "inspect", label: "搜索内容", target: localTarget(path) };
    case "find": return { kind: "inspect", label: "查找文件", group: "Find", target: localTarget(path) };
    case "glob": return { kind: "inspect", label: "查找文件", group: "Glob", target: localTarget(path) };
    case "ls": case "list": case "list_dir": case "list_directory": case "list_files":
      return { kind: "inspect", label: "列出目录", group: "List", target: localTarget(path) };
    case "tool_search": return { kind: "inspect", label: "查找工具", group: "Tool Search" };
    case "edit": case "edit_file": case "multiedit": case "apply_patch":
      return { kind: "modify", label: "编辑文件", target: localTarget(path ?? file_path ?? filePath) };
    case "write": case "write_file":
      return { kind: "modify", label: "写入文件", target: localTarget(path ?? file_path ?? filePath) };
    case "bash": case "shell": case "powershell":
      return { kind: "terminal", label: tool === "powershell" ? "PowerShell" : tool === "shell" ? "Shell" : "Bash",
        operation: "运行命令", command: str(input.command) };
    case "bash_output": return { kind: "terminal", label: "Bash", operation: "读取输出" };
    case "kill_bash": return { kind: "terminal", label: "Bash", operation: "终止命令" };
    case "memory":
      return { kind: "memory", label: "Memory", operation: memoryOperations.get(str(input.command)) };
    case "todo": case "todowrite": {
      const todo = todoChange(input);
      return { kind: "todo", label: "Todo", operation: todo.operation, preview: todo.preview, todo };
    }
    case "eval": {
      const action = str(input.action);
      const operation = action === "peek" ? "查看执行" : action === "list" ? "列出执行" : action === "stop" ? "停止执行" :
        action === "run" || input.action === undefined ? "执行脚本" : undefined;
      return { kind: "execution", label: "Eval", operation, ...codeDesk(tool, input),
        group: operation && action !== "stop" && (input.reset === undefined || input.reset === false) ? "Eval" : undefined };
    }
    case "ctx_execute": case "ctx_execute_file":
      return { kind: "context", label: "Ctx Execute", operation: "执行脚本", group: "Ctx Execute", ...codeDesk(tool, input) };
    case "ctx_search": return { kind: "context", label: "Ctx Search", operation: "搜索上下文", group: "Ctx Search" };
    case "ctx_batch":
      return { kind: "context", label: "Ctx Batch", operation: "批量查询", group: "Ctx Batch", preview: ctxBatchPreview(input) };
    case "ctx_index": return { kind: "context", label: "Ctx Index", operation: "收录上下文" };
    case "ctx_purge": return { kind: "context", label: "Ctx Purge", operation: "清除上下文" };
    case "task":
      return { kind: "agent", label: "Agent", operation: "派发任务",
        preview: input.tasks === undefined ? agentRouting(input) : taskBatchPreview(input) };
    case "task_output": return { kind: "agent", label: "Agent", operation: "查看任务", scope: outputScopes.get(str(input.mode)) };
    case "task_send": return { kind: "agent", label: "Agent", operation: "发送消息" };
    case "web_search": return { kind: "web", label: "Web", operation: "网页搜索", group: "Web Search" };
    case "webfetch": return { kind: "web", label: "Web", operation: "读取网页", group: "Web Fetch", preview: webHostname(input.url) };
    default: {
      const safe = /^[\p{L}\p{N}_.:-]{1,80}$/u.test(name) && /\p{L}/u.test(name) &&
        !name.split(/[.:]/u).some(part => secretPrefix.test(part) || /^(?:token|password|authorization|bearer|api[_-]?key)$/iu.test(part));
      return { kind: "unknown", label: safe ? name : "工具调用" };
    }
  }
}
