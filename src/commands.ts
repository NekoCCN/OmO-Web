import { WebError, array, record } from "./protocol.ts";

const str = (value: unknown): string => typeof value === "string" ? value : "";

export const COMMAND_SOURCES = ["extension", "prompt", "skill"] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export type NativeCommand = {
  readonly name: string;
  readonly description: string;
  readonly source: CommandSource;
  /** Canonical invocation: `/name` for extension/prompt commands, `$name` for skills. */
  readonly invocation: string;
};

const SHORT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL_NAME = /^skill:[A-Za-z0-9-]{1,64}$/;
const SKILL_SHORT = /^[A-Za-z0-9-]{1,64}$/;

export function isCommandSource(value: unknown): value is CommandSource {
  return value === "extension" || value === "prompt" || value === "skill";
}

/** Canonical invocation for a registered command, or undefined when the row is not trusted. */
export function invocationFor(name: string, source: CommandSource): string | undefined {
  if (source === "skill") {
    if (!SKILL_NAME.test(name)) return;
    return `$${name.slice("skill:".length)}`;
  }
  if (!SHORT_NAME.test(name)) return;
  return `/${name}`;
}

/**
 * Project raw `get_commands` rows to browser-safe command rows. Only currently
 * registered extension/prompt/skill commands survive; `sourceInfo` (paths and
 * discovery metadata) is always dropped.
 */
export function projectCommands(value: unknown): NativeCommand[] {
  return array(value).flatMap((entry): NativeCommand[] => {
    const raw = record(entry);
    const name = str(raw.name);
    const source = raw.source;
    if (!name || !isCommandSource(source)) return [];
    const invocation = invocationFor(name, source);
    if (!invocation) return [];
    return [{ name, description: str(raw.description), source, invocation }];
  });
}

export function legacySkillInvocation(name: string): string | undefined {
  if (!SKILL_NAME.test(name)) return;
  return `/${name}`;
}

/** Resolve a client-supplied invocation against the current registry, accepting legacy `/skill:name`. */
export function resolveCommand(commands: readonly NativeCommand[], invocation: string): NativeCommand | undefined {
  const direct = commands.find(command => command.invocation === invocation);
  if (direct) return direct;
  if (invocation.startsWith("/skill:")) {
    return commands.find(command =>
      command.source === "skill" && legacySkillInvocation(command.name) === invocation);
  }
  return;
}

const MAX_ARGUMENTS = 2000;
const CONTROL_CHARS = /[\0-\x1f\x7f]/;

/**
 * Compose the single native input line for a resolved command. The invocation
 * is already registry-validated (one token, no whitespace); arguments must be
 * a single line so the composed message cannot grow a second command line or a
 * terminal prefix beyond the validated invocation.
 */
export function composeMessage(command: NativeCommand, args?: string): string {
  const invocation = command.invocation;
  if (!invocation || CONTROL_CHARS.test(invocation) || !/^[//$]/.test(invocation)) {
    throw new WebError(400, "invalid_command", "该命令的调用形式不可用。");
  }
  if (args === undefined) return invocation;
  if (args.length > MAX_ARGUMENTS || CONTROL_CHARS.test(args)) {
    throw new WebError(400, "invalid_arguments", "命令参数只能是单行文本，且不能过长。");
  }
  const trimmed = args.trim();
  return trimmed ? `${invocation} ${trimmed}` : invocation;
}
