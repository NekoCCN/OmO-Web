import { lstat, realpath } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { WebError } from "./protocol.ts";
import { TERMINAL_COMMANDS, TerminalRefusal, TerminalTranscriptUnavailable, terminalProtocol } from "./terminal-wire.ts";
import type { TerminalPeer } from "./terminal-wire.ts";

const nativeId = z.string().min(1).max(256);
const turn = z.int().nonnegative();
const protocol = z.object({
  protocolVersion: z.literal(1), mode: z.literal("tui"), endpoint_kind: z.literal("tui"),
  instanceId: z.uuid(), generation: z.literal(0),
  capabilities: z.array(z.string().max(100)).max(128),
  commands: z.array(z.string().max(100)).max(256),
});
const rowSchema = z.object({
  sessionId: nativeId, durableSessionId: nativeId.optional(), cwd: z.string().min(1).max(4096),
  name: z.string().nullish(), kind: z.literal("interactive"), surface: z.literal("tui"), attachments: z.int().positive(),
});
const sessionRows = z.object({ sessions: z.tuple([rowSchema]) });
const stateSchema = z.object({
  sessionId: nativeId, cwd: z.string(), isStreaming: z.boolean(), compacting: z.boolean(),
  turn_epoch: turn, retryAttempt: turn.optional(), state_version: turn.optional(),
});

export type TerminalState = {
  readonly running: boolean;
  readonly turnId: string | null;
  readonly compacting: boolean;
};
export type TerminalMessage = {
  readonly role: "user" | "assistant" | "custom";
  readonly content: string;
  readonly customType?: "session_control_delivery";
  readonly timestamp?: number;
  readonly streaming?: true;
};
export type TerminalSession = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly attached: boolean;
  readonly running: boolean;
};
export type TerminalTranscript = {
  readonly messages: readonly TerminalMessage[];
  readonly transcript?: { readonly status: "truncated" | "unavailable" };
};
export type TerminalSnapshot = TerminalTranscript & {
  readonly session: TerminalSession;
  readonly state: TerminalState;
};
export type TerminalBranchIdentity = {
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly leafId: string;
};

export const terminalMissing = () => new WebError(404, "terminal_not_found", "CLI 会话已变化或不可用，请刷新列表。");
export const terminalUnattached = () => new WebError(409, "terminal_not_attached", "请先连接 CLI 会话。");
export const turnConflict = () => new WebError(409, "turn_conflict", "CLI 回合已变化，请刷新后再操作。");

export const terminalInput = z.strictObject({
  message: z.string().max(64_000).refine(message => message.trim().length > 0 && !/^(?:\/[\w:-]+(?:\s|$)|\$)/u.test(message.trimStart())),
  mode: z.enum(["prompt", "steer", "follow_up"]),
  clientMessageId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
  expectedTurnId: z.string().regex(/^(?:0|[1-9]\d{0,15})$/).optional(),
});
export type TerminalInput = z.infer<typeof terminalInput>;

const disposition = z.enum(["started", "queued", "held"]);
export type TerminalInputResult = {
  readonly disposition: z.infer<typeof disposition>;
  readonly clientMessageId: string;
  readonly duplicate: boolean;
};
export const admissionReply = z.object({
  disposition, clientMessageId: terminalInput.shape.clientMessageId, duplicate: z.boolean().optional(),
  admission: z.object({ disposition, clientMessageId: terminalInput.shape.clientMessageId, durableSessionId: nativeId }),
});
export const interruptReply = z.object({ interrupted: z.boolean(), turnId: z.string().optional() });
export const attachReply = z.object({ attached: z.literal(true), sessionId: nativeId });
export const leafReply = z.object({ entries: z.tuple([z.unknown()]), leafId: nativeId });

export async function readTerminalState(peer: TerminalPeer, identity: { readonly sessionId: string; readonly cwd: string }) {
  const state = parse(stateSchema, await peer.request({ type: "get_state", observe: true }));
  if (state.sessionId !== identity.sessionId || state.cwd !== identity.cwd) throw terminalMissing();
  return state;
}

export async function readTerminalIdentity(peer: TerminalPeer, instance: string, authorize: (cwd: string) => Promise<string | undefined>) {
  const info = parse(protocol, await peer.request({ type: "get_protocol_info", observe: true }));
  if (info.instanceId !== instance ||
    !["tui_control", "tui_observer", "observe_reads", "session_status", "entries_tail"].every(cap => info.capabilities.includes(cap)) ||
    !TERMINAL_COMMANDS.every(command => info.commands.includes(command))) throw terminalMissing();
  const { sessions: [row] } = parse(sessionRows, await peer.request({ type: "list_sessions", observe: true }));
  // TUI rows have no separate durableSessionId in 5.1.81. The state must corroborate the route.
  if (row.durableSessionId !== undefined && row.durableSessionId !== row.sessionId) throw terminalMissing();
  const workspaceKey = await authorize(row.cwd);
  if (workspaceKey === undefined) throw terminalMissing();
  return { row, workspaceKey, state: await readTerminalState(peer, row) };
}

export async function canonicalDirectory(cwd: string): Promise<boolean> {
  try { return (await realpath(cwd)) === cwd && (await lstat(cwd)).isDirectory(); }
  catch (error) {
    if (error instanceof Error && "code" in error) return false;
    throw error;
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw terminalProtocol();
  return result.data;
}

export function projectState(state: z.infer<typeof stateSchema>): TerminalState {
  const running = state.isStreaming || (state.retryAttempt ?? 0) > 0;
  return { running, turnId: running ? String(state.turn_epoch) : null, compacting: state.compacting };
}

// Keep only plain visible text: no thinking, images, tool payloads, sender
// metadata, questions, dialog fields or native transcript/source identities.
const messagesSchema = z.object({ messages: z.array(z.unknown()), historyTruncated: z.literal(true).optional().catch(undefined) });
const messageSchema = z.object({
  role: z.enum(["user", "assistant", "custom"]), content: z.unknown(),
  timestamp: z.number().nonnegative().optional(),
  customType: z.unknown().optional(), display: z.unknown().optional(), details: z.unknown().optional(),
});
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const customType = "session_control_delivery";
const assistantRole = z.object({ role: z.literal("assistant") });
const deliveryDetails = z.object({
  delivery_id: z.string(), source: z.literal("session_control"), deliverAs: z.enum(["steer", "followUp"]),
  display_text: z.string(),
  sender: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), session_id: z.string() }),
    z.object({ kind: z.literal("command_line") }),
    z.object({ kind: z.literal("external"), platform: z.string() }),
  ]).optional().catch(undefined),
  remote_origin: z.object({ deviceId: z.string().min(1) }).optional().catch(undefined),
});

export function displayText(value: string, limit: number): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Bidi_Control}]/gu, "")
    .slice(0, limit);
}

export function projectMessages(data: unknown): readonly TerminalMessage[] {
  return projectHistory(data).messages;
}

const HISTORY_ROWS = 100;
const HISTORY_TEXT = 128_000;
const MESSAGE_TEXT = 16_000;

function projectHistory(data: unknown): TerminalTranscript {
  const { messages, historyTruncated } = parse(messagesSchema, data);
  const visible: TerminalMessage[] = [];
  let truncated = historyTruncated === true;
  let remaining = HISTORY_TEXT;
  for (let index = messages.length - 1; index >= 0; index--) {
    const value = projectMessage(messages[index], MESSAGE_TEXT);
    if (!value) continue;
    if (visible.length === HISTORY_ROWS || remaining === 0) {
      truncated = true;
      break;
    }
    const { message, clipped } = value;
    const content = clipText(message.content, remaining);
    truncated ||= clipped || content !== message.content;
    if (content.trim() === "") continue;
    remaining -= content.length;
    visible.push({ ...message, content });
  }
  return { messages: visible.reverse(), ...(truncated ? { transcript: { status: "truncated" } } : {}) };
}

export async function readTerminalTranscript(peer: TerminalPeer): Promise<TerminalTranscript> {
  try { return projectHistory(await peer.request({ type: "get_messages", observe: true })); }
  catch (error) {
    if (peer.closed || !(error instanceof TerminalTranscriptUnavailable ||
        (error instanceof TerminalRefusal && error.code === "terminal_read_limit"))) throw error;
    return { messages: [], transcript: { status: "unavailable" } };
  }
}

export function withStreamingMessage(history: TerminalTranscript, partial: TerminalMessage): TerminalTranscript {
  const last = history.messages.at(-1);
  if (last?.role === "assistant" && last.timestamp === partial.timestamp && last.content.startsWith(partial.content)) return history;
  const messages = [...history.messages, partial];
  let start = 0;
  let text = messages.reduce((total, row) => total + row.content.length, 0);
  while (messages.length - start > HISTORY_ROWS || text > HISTORY_TEXT) text -= messages[start++]!.content.length;
  return {
    ...history, messages: messages.slice(start),
    ...(start && !history.transcript ? { transcript: { status: "truncated" } } : {}),
  };
}

export const isAssistant = (value: unknown): boolean => assistantRole.safeParse(value).success;

export function projectStreamingAssistant(value: unknown): TerminalMessage | undefined {
  if (!isAssistant(value)) return;
  const projected = projectMessage(value, MESSAGE_TEXT);
  if (projected) return { ...projected.message, streaming: true };
}

function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const before = text.charCodeAt(limit - 1);
  const after = text.charCodeAt(limit);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return text.slice(0, splitsPair ? limit - 1 : limit);
}

function projectMessage(value: unknown, max: number): { message: TerminalMessage; clipped: boolean } | undefined {
  const raw = messageSchema.safeParse(value);
  if (!raw.success) return;
  const { role, content, timestamp } = raw.data;
  if (role === "custom" && (raw.data.customType !== customType || raw.data.display !== true)) return;
  const details = role === "custom" ? deliveryDetails.safeParse(raw.data.details) : undefined;
  const excerpt = details?.success && (details.data.sender || details.data.remote_origin) ? details.data.display_text : undefined;
  let text = "";
  let clipped = false;
  if (excerpt !== undefined || typeof content === "string") {
    const plain = displayText(excerpt ?? String(content), Infinity);
    text = clipText(plain, max);
    clipped = text !== plain;
  } else if (Array.isArray(content)) {
    for (const value of content) {
      const block = textBlock.safeParse(value);
      if (!block.success) continue;
      const plain = displayText(block.data.text, Infinity);
      if (!plain) continue;
      const separator = text ? "\n" : "";
      const part = clipText(plain, Math.max(0, max - text.length - separator.length));
      if (part) text += `${separator}${part}`;
      if (part !== plain) { clipped = true; break; }
    }
  }
  if (text.trim() === "") return;
  return { clipped, message: {
    role, content: text, ...(role === "custom" ? { customType } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
  } };
}
