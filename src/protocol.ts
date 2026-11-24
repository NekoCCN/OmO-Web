import { z } from "zod";

export const sessionKey = z.uuid().brand<"WebSessionId">();
export type SessionKey = z.infer<typeof sessionKey>;
export const object = z.record(z.string(), z.unknown());
export type WireObject = z.infer<typeof object>;

export function record(value: unknown): WireObject {
  const parsed = object.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function pick(value: unknown, keys: readonly string[]): WireObject {
  const source = record(value);
  return Object.fromEntries(keys.flatMap(key => Object.hasOwn(source, key) ? [[key, source[key]]] : []));
}

export class WebError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WebError";
  }
}

export const openInput = z.strictObject({ cwd: z.string().min(1).max(4096), name: z.string().trim().min(1).max(120).optional() });
export const actions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({
    action: z.literal("prompt"), message: z.string().max(200_000),
    mode: z.enum(["prompt", "steer", "follow_up"]).default("prompt"),
    clientMessageId: z.uuid().optional(), expectedTurnId: z.string().min(1).max(100).optional(),
    images: z.array(z.strictObject({
      type: z.literal("image"),
      data: z.string().min(4).max(2_800_000).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)),
      mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    })).max(4).optional(),
  }),
  z.strictObject({ action: z.literal("abort") }),
  z.strictObject({ action: z.literal("rename"), name: z.string().trim().min(1).max(120) }),
  z.strictObject({ action: z.literal("archive"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("settle"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("model"), provider: z.string().min(1).max(120), modelId: z.string().min(1).max(250) }),
  z.strictObject({ action: z.literal("thinking"), level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) }),
  z.strictObject({ action: z.literal("fast"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("autoCompaction"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("compact"), instructions: z.string().max(6000).optional() }),
  z.strictObject({ action: z.literal("clearQueue") }),
  z.strictObject({ action: z.literal("navigate"), targetId: z.string().min(1).max(120).nullable() }),
  z.strictObject({
    action: z.literal("answer"), requestId: z.string().min(1).max(200), value: z.string().max(30_000).optional(),
    confirmed: z.boolean().optional(), cancelled: z.literal(true).optional(),
    answers: z.record(z.string().max(200), z.strictObject({ selected: z.array(z.string().max(2000)).max(40), text: z.string().max(12_000).optional() })).optional(),
    comment: z.string().max(12_000).optional(),
  }).refine(value => [value.value, value.confirmed, value.cancelled, value.answers].filter(x => x !== undefined).length === 1
    && (value.comment === undefined || value.answers !== undefined)),
]);
export type Action = z.infer<typeof actions>;

export function model(value: unknown): WireObject | null {
  return value == null ? null : pick(value, ["id", "provider", "name", "contextWindow", "maxTokens", "reasoning", "input", "supportedThinkingLevels"]);
}

export function message(value: unknown): WireObject {
  const m = pick(value, ["role", "content", "timestamp", "toolName", "toolCallId", "isError", "stopReason", "errorMessage", "usage", "provider", "model", "customType"]);
  if (Array.isArray(m.content)) m.content = m.content.flatMap((part: unknown) => {
    const block = record(part);
    if (block.type === "image" && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(block.mimeType))) return [];
    return [pick(block, ["type", "text", "thinking", "id", "name", "arguments", "mimeType", "data", "mediaId"])];
  });
  return m.role === "bashExecution" ? { ...m, ...pick(value, ["command", "output", "exitCode", "cancelled", "truncated"]) } : m;
}

export function transcriptMessage(value: unknown): WireObject | undefined {
  const raw = record(value);
  if (raw.role === "custom" ? raw.display !== true : !["user", "assistant", "toolResult", "bashExecution"].includes(String(raw.role))) {
    return;
  }
  return message(raw);
}

export function transcriptTree(value: unknown): WireObject {
  const tree = record(value);
  const nodes: WireObject[] = [];
  const pending = [{ source: array(tree.tree), target: nodes }];
  for (const { source, target } of pending) {
    for (const node of source.map(record)) {
      const raw = record(node.entry);
      const entry = pick(raw, ["type", "id", "parentId", "timestamp", "provider", "modelId", "thinkingLevel", "name", "label"]);
      const content = transcriptMessage(raw.message);
      if (content) entry.message = content;
      const children: WireObject[] = [];
      target.push({ entry, children, ...pick(node, ["label"]) });
      pending.push({ source: array(node.children), target: children });
    }
  }
  return { tree: nodes, ...pick(tree, ["leafId"]) };
}

export function dialog(value: unknown): WireObject | undefined {
  const d = record(value);
  if (!["select", "confirm", "input", "editor", "question"].includes(String(d.method)) ||
    d.secret === true || d.private === true || d.privateInput) return;
  return pick(d, ["id", "type", "method", "title", "message", "options", "placeholder", "prefill", "defaultValue",
    "questions", "requestId", "toolCallId", "parentToolCallId", "deadlineAtMs", "askedAtMs", "remainingMs", "timeout"]);
}

export function state(value: unknown): WireObject {
  const s = pick(value, ["thinkingLevel", "fastMode", "isStreaming", "isCompacting", "currentTurnId", "pendingMessageCount",
    "permissionPreset", "effectivePermissionPreset", "autoCompactionEnabled", "contextUsage", "usageTotals", "pendingModelSwitch"]);
  const raw = record(value);
  return { ...s, model: model(raw.model), pendingDialogs: array(raw.pendingDialogs).flatMap(d => dialog(d) ?? []),
    pendingQuestions: array(raw.pendingQuestions).flatMap(q => dialog(q) ?? []) };
}

export function browserEvent(value: WireObject): WireObject | undefined {
  switch (value.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      const visible = transcriptMessage(value.message);
      return visible && { type: value.type, message: visible };
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const result = record(value.result ?? value.partialResult);
      return { ...pick(value, ["type", "toolName", "toolCallId", "args", "isError"]),
        ...(result.content === undefined ? {} : { result: message(result) }) };
    }
    case "extension_ui_request":
      return dialog(value);
    case "question_updated":
      return dialog(value) ?? pick(value, ["type", "id", "requestId", "deadlineAtMs", "remainingMs"]);
    case "question_resolved":
    case "extension_ui_resolved":
      return pick(value, ["type", "id", "requestId", "toolCallId", "outcome", "deadlineAtMs", "remainingMs"]);
    case "model_changed":
      return { ...pick(value, ["type", "thinkingLevel", "source"]), model: model(value.model) };
    case "service_tier_changed":
      return pick(value, ["type", "tier", "fastMode"]);
    case "queue_update":
      return pick(value, ["type", "steering", "followUp"]);
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "commands_changed":
    case "loaded_surfaces_changed":
    case "session_closed":
    case "session_replaced":
    case "transcript_write_failed":
      return pick(value, ["type", "turnId", "reason", "willRetry", "attempt", "success", "aborted", "errorMessage"]);
    default:
      return;
  }
}
