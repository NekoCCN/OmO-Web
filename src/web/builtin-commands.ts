export type BuiltinCommandName = BuiltinCommand["name"];

export type BuiltinEntry = {
  readonly name: BuiltinCommandName;
  /** Canonical invocation shown in the existing command picker. */
  readonly invocation: `/${BuiltinCommandName}`;
  readonly label: string;
  readonly description: string;
};

/** 与解析器配套的候选列表。 */
export const BUILTIN_COMMANDS: readonly BuiltinEntry[] = [
  { name: "new", invocation: "/new", label: "新会话", description: "开始一个新会话。" },
  { name: "resume", invocation: "/resume", label: "继续会话", description: "从历史会话中选择一个继续。" },
  { name: "sessions", invocation: "/sessions", label: "会话列表", description: "列出历史会话并继续其中一个。" },
  { name: "rename", invocation: "/rename", label: "重命名", description: "重命名当前会话（名称可选，最长 120 字）。" },
  { name: "name", invocation: "/name", label: "重命名（别名）", description: "与 /rename 相同：设置会话显示名。" },
  { name: "session", invocation: "/session", label: "会话信息", description: "查看当前会话的信息与统计。" },
  { name: "tree", invocation: "/tree", label: "会话树", description: "查看会话分支树并跳到任意点继续。" },
  { name: "fork", invocation: "/fork", label: "分支", description: "选择一条用户消息，从该消息之前创建分支。" },
  { name: "clone", invocation: "/clone", label: "副本", description: "复制当前会话为新会话并切换过去。" },
  { name: "compact", invocation: "/compact", label: "压缩上下文", description: "手动压缩上下文（指示可选，最长 6000 字）。" },
  { name: "model", invocation: "/model", label: "模型", description: "切换本会话的模型（只对当前会话有效）。" },
  { name: "thinking", invocation: "/thinking", label: "思考档位", description: "设置思考档位（可选；档位按实际可选值校验）。" },
  { name: "fast", invocation: "/fast", label: "极速模式", description: "切换极速模式（开、关或不带参数切换；只影响当前模型）。" },
  { name: "copy", invocation: "/copy", label: "复制", description: "复制上一条助手消息。" },
] as const;
export const BUILTIN_COMMAND_NAMES: readonly BuiltinCommandName[] = BUILTIN_COMMANDS.map(entry => entry.name);

/** 已知但浏览器不支持的 TUI 命令名：只提示，不转发。 */
const TUI_ONLY_NAMES = [
  "settings",
  "scoped-models",
  "reasoning",
  "efforts",
  "login",
  "logout",
  "trust",
  "export",
  "import",
  "share",
  "reload",
  "hotkeys",
  "help",
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
  | { readonly kind: "tui-only"; readonly name: TuiOnlyName };

const MAX_RENAME = 120;
const MAX_COMPACT = 6000;
const HEAD_PATTERN = /^\/[A-Za-z][A-Za-z0-9_-]*/;
const HAS_CONTROL = /[\0-\b\v\f\x0e-\x1f\x7f]/;
const MODEL_REFERENCE = /^[A-Za-z0-9_./:@+-]+$/;

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
      ? malformed("命令只能是单行文本，不能包含换行或控制字符。")
      : { kind: "plain" };
  }
  if (HAS_CONTROL.test(text) || text.includes("\r") || text.includes("\n")) {
    return malformed("命令只能是单行文本，不能包含换行或控制字符。");
  }
  if (tuiOnly !== undefined) return { kind: "tui-only", name: tuiOnly };
  const args = rest.trim();
  switch (name) {
    case "new":
    case "resume":
    case "sessions":
    case "session":
    case "tree":
    case "fork":
    case "clone":
    case "copy":
      if (args !== "") return malformed(`“/${name}”不带参数。`);
      return { kind: "builtin", command: { name } };
    case "rename":
    case "name":
      if (args.length > MAX_RENAME) return malformed("会话名称不能超过 120 字。");
      return { kind: "builtin", command: { name, ...(args === "" ? {} : { value: args }) } };
    case "compact":
      if (args.length > MAX_COMPACT) return malformed("压缩指示不能超过 6000 字。");
      if (args === "") return { kind: "builtin", command: { name: "compact" } };
      return { kind: "builtin", command: { name: "compact", instructions: args } };
    case "model":
      if (args === "") return { kind: "builtin", command: { name: "model" } };
      if (/(^|\s)--\S/.test(args)) {
        return malformed("Web 只接受精确模型引用，不支持 --default 等持久化参数。");
      }
      if (!MODEL_REFERENCE.test(args)) return malformed("模型引用只能是单个精确引用（如 provider/model）。");
      return { kind: "builtin", command: { name: "model", reference: args } };
    case "thinking":
      if (args === "") return { kind: "builtin", command: { name: "thinking" } };
      if (!/^[^\s]+$/.test(args)) return malformed("请输入单个思考档位，例如 high。");
      return { kind: "builtin", command: { name: "thinking", level: args.toLowerCase() } };
    case "fast": {
      if (args === "") return { kind: "builtin", command: { name: "fast" } };
      const mode = args.toLowerCase();
      return mode === "on" || mode === "off"
        ? { kind: "builtin", command: { name, mode } }
        : malformed("“/fast”只接受 on、off 或无参数（切换）。");
    }
    default:
      return { kind: "plain" };
  }
}
