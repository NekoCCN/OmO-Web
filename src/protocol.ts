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

const noControlChars = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
};

export const openInput = z.strictObject({ cwd: z.string().min(1).max(4096), name: z.string().trim().min(1).max(120).optional() });
export const emptyBody = z.strictObject({});
export const entryId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
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
  z.strictObject({
    action: z.literal("command"),
    invocation: z.string().min(2).max(80).refine(value => /^[/$][A-Za-z0-9_\-:]+$/.test(value)),
    arguments: z.string().max(2000).refine(value => noControlChars(value)).optional(),
    clientMessageId: z.uuid().optional(),
  }),
  z.strictObject({ action: z.literal("abort") }),
  z.strictObject({ action: z.literal("rename"), name: z.string().trim().min(1).max(120) }),
  z.strictObject({ action: z.literal("archive"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("settle"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("model"), provider: z.string().min(1).max(120), modelId: z.string().min(1).max(250) }),
  z.strictObject({ action: z.literal("thinking"), level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]) }),
  z.strictObject({ action: z.literal("preset"), preset: z.enum(["ask", "auto", "full-access"]) }),
  z.strictObject({ action: z.literal("fast"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("autoCompaction"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("compact"), instructions: z.string().max(6000).optional() }),
  z.strictObject({ action: z.literal("clearQueue") }),
  z.strictObject({ action: z.literal("navigate"), targetId: entryId.nullable(), expectedLeafId: entryId.nullable().optional() }),
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

const safeLabel = z.string().trim().min(1).max(120).refine(noControlChars);
const questionOption = z.object({
  label: z.string().min(1).max(2000),
  description: z.string().max(12000).optional(),
});
const questionRow = z.object({
  id: z.string().min(1).max(200),
  header: z.string().max(2000).optional(),
  question: z.string().max(12000).optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(questionOption).max(40).optional(),
});

export function dialog(value: unknown): WireObject | undefined {
  const d = record(value);
  if (!["select", "confirm", "input", "editor", "question"].includes(String(d.method)) ||
    d.secret === true || d.private === true || d.privateInput) return;
  const projected = d.method === "question"
    ? pick(d, ["id", "type", "method", "requestId", "toolCallId", "deadlineAtMs", "askedAtMs", "remainingMs", "timeout"])
    : pick(d, ["id", "type", "method", "title", "message", "options", "placeholder", "prefill", "defaultValue",
      "requestId", "toolCallId", "parentToolCallId", "deadlineAtMs", "askedAtMs", "remainingMs", "timeout"]);
  if (d.method === "question") {
    for (const key of ["id", "type", "method", "requestId", "toolCallId"]) {
      if (typeof projected[key] !== "string") delete projected[key];
    }
    projected.questions = array(d.questions).flatMap(raw => {
      const row = record(raw);
      if (row.secret === true || row.private === true || row.privateInput) return [];
      const options = array(row.options).filter(rawOption => {
        const option = record(rawOption);
        return option.secret !== true && option.private !== true && !option.privateInput;
      });
      const parsed = questionRow.safeParse({ ...row, ...(row.options === undefined ? {} : { options }) });
      return parsed.success ? [parsed.data] : [];
    });
    if (typeof d.waitForAnswer === "boolean") projected.waitForAnswer = d.waitForAnswer;
    const raisedBy = safeLabel.safeParse(d.raisedBy);
    if (raisedBy.success) projected.raisedBy = raisedBy.data;
    for (const key of ["deadlineAtMs", "askedAtMs", "remainingMs", "timeout"]) {
      if (typeof projected[key] !== "number" || !Number.isFinite(projected[key])) delete projected[key];
    }
  }
  return projected;
}

export function state(value: unknown): WireObject {
  const s = pick(value, ["thinkingLevel", "fastMode", "isStreaming", "isCompacting", "currentTurnId", "pendingMessageCount",
    "permissionPreset", "effectivePermissionPreset", "autoCompactionEnabled", "contextUsage", "usageTotals", "pendingModelSwitch"]);
  const raw = record(value);
  const thinkingLevelSource = safeLabel.safeParse(raw.thinkingLevelSource);
  if (thinkingLevelSource.success) s.thinkingLevelSource = thinkingLevelSource.data;
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
    case "question_updated": {
      if (value.secret === true || value.private === true || value.privateInput) return;
      const full = dialog(value);
      if (full) return full;
      const update = pick(value, ["type", "id", "requestId", "deadlineAtMs", "remainingMs"]);
      for (const key of ["id", "requestId"]) if (typeof update[key] !== "string") delete update[key];
      for (const key of ["deadlineAtMs", "remainingMs"]) {
        if (typeof update[key] !== "number" || !Number.isFinite(update[key])) delete update[key];
      }
      return update;
    }
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
    case "agent_idle":
    case "turn_start":
    case "turn_end":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "commands_changed":
    case "loaded_surfaces_changed":
    case "pending_input_update":
    case "session_closed":
    case "session_parked":
    case "session_released":
    case "session_replaced":
    case "extension_error":
    case "retry_fallback_exhausted":
    case "transcript_write_failed":
      return pick(value, ["type", "turnId", "reason", "willRetry", "attempt", "success", "aborted",
        "errorMessage", "error", "lastError"]);
    default:
      return;
  }
}
