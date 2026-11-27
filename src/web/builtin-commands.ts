import { tr, uiLocale } from "./locale.ts";

export type BuiltinCommandName = BuiltinCommand["name"];

export type BuiltinEntry = {
  readonly name: BuiltinCommandName;
  /** Canonical invocation shown in the existing command picker. */
  readonly invocation: `/${BuiltinCommandName}`;
  readonly label: string;
  readonly description: string;
};

const MAX_RENAME = 120;
const MAX_COMPACT = 6000;
const renameLimit = MAX_RENAME.toLocaleString(uiLocale);
const compactLimit = MAX_COMPACT.toLocaleString(uiLocale);

/** 与解析器配套的候选列表。 */
export const BUILTIN_COMMANDS: readonly BuiltinEntry[] = [
  { name: "new", invocation: "/new", label: tr("新会话", "New session"), description: tr("开始一个新会话。", "Start a new session.") },
  { name: "resume", invocation: "/resume", label: tr("继续会话", "Resume session"), description: tr("从历史会话中选择一个继续。", "Choose a past session to resume.") },
  { name: "sessions", invocation: "/sessions", label: tr("会话列表", "Session list"), description: tr("列出历史会话并继续其中一个。", "Browse and resume past sessions.") },
  { name: "rename", invocation: "/rename", label: tr("重命名", "Rename"), description: tr(`重命名当前会话（名称可选，最长 ${renameLimit} 字）。`,
    `Rename the current session. The name is optional and can be up to ${renameLimit} characters.`) },
  { name: "name", invocation: "/name", label: tr("重命名（别名）", "Rename (alias)"), description: tr("与 /rename 相同：设置会话显示名。", "Alias for /rename. Set the session's display name.") },
  { name: "session", invocation: "/session", label: tr("会话信息", "Session info"), description: tr("查看当前会话的信息与统计。", "View details and statistics for this session.") },
  { name: "tree", invocation: "/tree", label: tr("会话树", "Session tree"), description: tr("查看会话分支树并跳到任意点继续。", "Browse session branches and resume from any point.") },
  { name: "todo", invocation: "/todo", label: tr("本会话待办", "Session Todo"), description: tr("查看当前分支的待办。", "View the Todo list for the current branch.") },
  { name: "tasks", invocation: "/tasks", label: tr("本会话任务", "Session tasks"), description: tr("查看当前会话的原生子代理任务。", "View native subagent tasks for this session.") },
  { name: "dag", invocation: "/dag", label: tr("本会话 DAG", "Session DAG"), description: tr("查看本会话的运行，展开读取波次和依赖。", "View workflow runs and expand them to inspect execution waves and dependencies.") },
  { name: "help", invocation: "/help", label: tr("命令帮助", "Command help"), description: tr("查看 Web 可用的命令和快捷键。", "See which commands and keyboard shortcuts are available on the web.") },
  { name: "hotkeys", invocation: "/hotkeys", label: tr("快捷键", "Keyboard shortcuts"), description: tr("查看此工作台的键盘操作。", "View keyboard shortcuts for the workbench.") },
  { name: "fork", invocation: "/fork", label: tr("分支", "Fork"), description: tr("选择一条用户消息，从该消息之前创建分支。", "Choose a user message and start a branch from just before it.") },
  { name: "clone", invocation: "/clone", label: tr("副本", "Clone"), description: tr("复制当前会话为新会话并切换过去。", "Copy the current session and switch to the copy.") },
  { name: "compact", invocation: "/compact", label: tr("压缩上下文", "Compact context"), description: tr(`手动压缩上下文（指示可选，最长 ${compactLimit} 字）。`,
    `Compact context manually. Optional instructions can be up to ${compactLimit} characters.`) },
  { name: "model", invocation: "/model", label: tr("模型", "Model"), description: tr("切换本会话的模型（只对当前会话有效）。", "Change the model for this session only.") },
  { name: "thinking", invocation: "/thinking", label: tr("思考档位", "Thinking level"), description: tr("设置思考档位（可选；档位按实际可选值校验）。", "Set a thinking level. If specified, it must be one of the available levels.") },
  { name: "reasoning", invocation: "/reasoning", label: tr("推理状态", "Reasoning status"), description: tr("查看当前模型是否启用推理。持久设置在本机修改。", "Check whether reasoning is enabled for the current model. Change persistent settings in the native client.") },
  { name: "efforts", invocation: "/efforts", label: tr("原生推理档位", "Native reasoning levels"), description: tr("查看当前档和原生可用档位。持久设置在本机修改。", "View the current level and available native levels. Change persistent settings in the native client.") },
  { name: "fast", invocation: "/fast", label: tr("极速模式", "Fast mode"), description: tr("切换极速模式（开、关或不带参数切换；只影响当前模型）。", "Set fast mode to on or off, or omit the argument to toggle it. Applies only to the current model.") },
  { name: "copy", invocation: "/copy", label: tr("复制", "Copy"), description: tr("复制上一条助手消息。", "Copy the last assistant message.") },
] as const;
export const BUILTIN_COMMAND_NAMES: readonly BuiltinCommandName[] = BUILTIN_COMMANDS.map(entry => entry.name);

/** 已知但浏览器不支持的 TUI 命令名：只提示，不转发。 */
const TUI_ONLY_NAMES = [
  "settings",
  "scoped-models",
  "favorite-models",
  "task-kill",
  "login",
  "logout",
  "trust",
  "export",
  "import",
  "share",
  "reload",
  "keybindings",
  "changelog",
  "quit",
  "exit",
  "bug",
  "debug",
] as const;

type TuiOnlyName = (typeof TUI_ONLY_NAMES)[number];

export type BuiltinCommand =
  | { readonly name: "new" }
  | { readonly name: "resume" }
  | { readonly name: "sessions" }
  | { readonly name: "session" }
  | { readonly name: "tree" }
  | { readonly name: "todo" | "tasks" | "dag" | "help" | "hotkeys" | "reasoning" | "efforts" }
  | { readonly name: "fork" }
  | { readonly name: "clone" }
  | { readonly name: "copy" }
  | { readonly name: "rename"; readonly value?: string }
  | { readonly name: "name"; readonly value?: string }
  | { readonly name: "compact"; readonly instructions?: string }
  | { readonly name: "model"; readonly reference?: string }
  | { readonly name: "thinking"; readonly level?: string }
  | { readonly name: "fast"; readonly mode?: "on" | "off" };

export type BuiltinParseResult =
  /** 普通输入：保持原样，走原有路径。 */
  | { readonly kind: "plain" }
  /** 认出但写坏：用 message 拒绝，不转发。 */
  | { readonly kind: "malformed"; readonly message: string }
  /** 受支持的内置命令：参数已校验。 */
  | { readonly kind: "builtin"; readonly command: BuiltinCommand }
  /** 已知但浏览器不支持：按 name 提示，不转发。 */
  | { readonly kind: "tui-only"; readonly name: TuiOnlyName | "reasoning" | "efforts" };

export function opensReadOnlyView(text: string): boolean {
  const parsed = parseBuiltinInput(text);
  return parsed.kind === "builtin" &&
    ["session", "tree", "todo", "tasks", "dag", "help", "hotkeys", "reasoning", "efforts"].includes(parsed.command.name);
}

const HEAD_PATTERN = /^\/[A-Za-z][A-Za-z0-9_-]*/;
const HAS_CONTROL = /[\0-\b\v\f\x0e-\x1f\x7f]/;
const MODEL_REFERENCE = /^[A-Za-z0-9_./:@+-]+$/;
const singleLineCommand = tr("命令只能是单行文本，不能包含换行或控制字符。", "Commands must be on one line and cannot contain control characters.");

const malformed = (message: string): BuiltinParseResult => ({ kind: "malformed", message });

// Like native TUI input, explicit built-ins precede registry fallback.
export function parseBuiltinInput(text: string): BuiltinParseResult {
  const head = HEAD_PATTERN.exec(text)?.[0];
  if (head === undefined) return { kind: "plain" };
  const rest = text.slice(head.length);
  const token = head.slice(1);
  const name = BUILTIN_COMMAND_NAMES.find(candidate => candidate === token);
  const tuiOnly = TUI_ONLY_NAMES.find(candidate => candidate === token);
  if (name === undefined && tuiOnly === undefined) return { kind: "plain" };
  if (rest !== "" && !/^[ \t\r\n]/.test(rest)) {
    return HAS_CONTROL.test(rest[0])
      ? malformed(singleLineCommand)
      : { kind: "plain" };
  }
  if (HAS_CONTROL.test(text) || text.includes("\r") || text.includes("\n")) {
    return malformed(singleLineCommand);
  }
  if (tuiOnly !== undefined) return { kind: "tui-only", name: tuiOnly };
  const args = rest.trim();
  switch (name) {
    case "new":
    case "resume":
    case "sessions":
    case "session":
    case "tree":
    case "todo":
    case "tasks":
    case "dag":
    case "help":
    case "hotkeys":
    case "fork":
    case "clone":
    case "copy":
      if (args !== "") return malformed(tr(`“/${name}”不带参数。`, `/${name} does not take arguments.`));
      return { kind: "builtin", command: { name } };
    case "reasoning":
    case "efforts":
      return args === "" ? { kind: "builtin", command: { name } } : { kind: "tui-only", name };
    case "rename":
    case "name":
      if (args.length > MAX_RENAME) return malformed(tr(`会话名称不能超过 ${renameLimit} 字。`, `Session names can be up to ${renameLimit} characters.`));
      return { kind: "builtin", command: { name, ...(args === "" ? {} : { value: args }) } };
    case "compact":
      if (args.length > MAX_COMPACT) return malformed(tr(`压缩指示不能超过 ${compactLimit} 字。`, `Compaction instructions can be up to ${compactLimit} characters.`));
      if (args === "") return { kind: "builtin", command: { name: "compact" } };
      return { kind: "builtin", command: { name: "compact", instructions: args } };
    case "model":
      if (args === "") return { kind: "builtin", command: { name: "model" } };
      if (/(^|\s)--\S/.test(args)) {
        return malformed(tr("Web 只接受精确模型引用，不支持 --default 等持久化参数。", "The web app accepts exact model references only. Persistent flags such as --default are not supported."));
      }
      if (!MODEL_REFERENCE.test(args)) return malformed(tr("模型引用只能是单个精确引用（如 provider/model）。", "Enter one exact model reference, such as provider/model."));
      return { kind: "builtin", command: { name: "model", reference: args } };
    case "thinking":
      if (args === "") return { kind: "builtin", command: { name: "thinking" } };
      if (!/^[^\s]+$/.test(args)) return malformed(tr("请输入单个思考档位，例如 high。", "Enter a single thinking level, such as high."));
      return { kind: "builtin", command: { name: "thinking", level: args.toLowerCase() } };
    case "fast": {
      if (args === "") return { kind: "builtin", command: { name: "fast" } };
      const mode = args.toLowerCase();
      return mode === "on" || mode === "off"
        ? { kind: "builtin", command: { name, mode } }
        : malformed(tr("“/fast”只接受 on、off 或无参数（切换）。", "Use /fast on, /fast off, or /fast to toggle."));
    }
    default:
      return { kind: "plain" };
  }
}
