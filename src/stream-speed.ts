import { record } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

export type GenerationSpeed = { readonly tokensPerSecond: number; readonly measuredAt: number };

const deltaBlock = { text_delta: "text", thinking_delta: "thinking", toolcall_delta: "toolCall" } as const;
type Stream = {
  readonly timestamp: number;
  readonly blocks: Map<number, string>;
  first?: number;
  last?: number;
};

/** RPC receipt timing, not provider throughput. This tracker belongs to one live binding only. */
export class StreamSpeed {
  #stream: Stream | undefined;
  #latest: GenerationSpeed | undefined;

  constructor(private compacting: boolean) {}

  get latest() { return this.#latest; }

  observe(frame: WireObject): GenerationSpeed | undefined {
    switch (frame.type) {
      case "compaction_start":
      case "compaction_end":
        this.compacting = frame.type === "compaction_start";
        this.#stream = undefined;
        return;
      case "agent_start":
      case "agent_end":
      case "agent_settled":
      case "agent_idle":
      case "turn_start":
      case "turn_end":
      case "auto_retry_start":
        this.#stream = undefined;
        return;
    }
    if (this.compacting) return;
    const message = record(frame.message);
    if (frame.type === "message_start" && message.role === "assistant") {
      this.#stream = frame.streaming === true && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? { timestamp: message.timestamp, blocks: new Map() } : undefined;
      return;
    }
    const stream = this.#stream;
    if (!stream) return;
    if (frame.type === "message_update") {
      const delta = record(frame.assistantMessageEvent);
      const block = delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta"
        ? deltaBlock[delta.type] : undefined;
      if (!block) return;
      // The native writer demotes and may merge queued deltas by nulling these snapshots.
      if (message.role !== "assistant" || message.timestamp !== stream.timestamp || delta.partial === null) {
        this.#stream = undefined;
        return;
      }
      if (typeof delta.delta !== "string" || delta.delta.length === 0 ||
          typeof delta.contentIndex !== "number" || !Number.isSafeInteger(delta.contentIndex) || delta.contentIndex < 0) return;
      const now = performance.now();
      stream.blocks.set(delta.contentIndex, block);
      stream.first ??= now;
      stream.last = now;
    } else if (frame.type === "message_end" && message.role === "assistant") {
      this.#stream = undefined;
      if (message.timestamp !== stream.timestamp ||
          (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") ||
          stream.first === undefined || stream.last === undefined) return;
      const elapsed = stream.last - stream.first;
      if (elapsed < 500) return;
      const usage = record(message.usage);
      const { output, reasoning } = usage;
      // Per-message output can also include hidden reasoning or final-only blocks.
      // No reliable stream window can be associated with that full token count.
      if (typeof output !== "number" || !Number.isSafeInteger(output) || output <= 0 ||
          (reasoning !== undefined && reasoning !== 0) || !Array.isArray(message.content) ||
          message.content.length === 0 || message.content.some((value, index) => {
            const block = record(value);
            return block.redacted === true || stream.blocks.get(index) !== block.type || !stream.blocks.has(index);
          })) return;
      this.#latest = { tokensPerSecond: output / (elapsed / 1000), measuredAt: Date.now() };
      return this.#latest;
    }
  }
}
