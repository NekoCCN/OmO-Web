import { createHash, createHmac, randomBytes } from "node:crypto";
import { WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { discoverTerminalRegistry, registeredTerminal } from "./terminal-registry.ts";
import type { TerminalEndpoint, TerminalRegistry } from "./terminal-registry.ts";
import {
  admissionReply, attachReply, canonicalDirectory, displayText, interruptReply, isAssistant, leafReply, parse, projectMessages,
  projectState, projectStreamingAssistant, readTerminalIdentity, readTerminalState, terminalInput, terminalMissing, terminalUnattached, turnConflict,
} from "./terminal-view.ts";
import type { TerminalBranchIdentity, TerminalInput, TerminalInputResult, TerminalMessage, TerminalSession, TerminalSnapshot } from "./terminal-view.ts";
import { TERMINAL_ENTRY_BYTES, TerminalPeer, TerminalRefusal, terminalOffline, terminalProtocol } from "./terminal-wire.ts";

export type { TerminalBranchIdentity, TerminalInput, TerminalInputResult, TerminalMessage, TerminalSession, TerminalSnapshot, TerminalState } from "./terminal-view.ts";

type Candidate = {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly registry: TerminalRegistry;
  readonly endpoint: TerminalEndpoint;
};
type Attachment = {
  readonly candidate: Candidate;
  peer?: TerminalPeer;
  opening?: Promise<TerminalSnapshot>;
  acceptEvents: boolean;
  ready: boolean;
  closing: boolean;
  pending: number;
  tail: Promise<void>;
  observedTurn: string | null;
  revision: number;
  streaming?: TerminalMessage;
  invalidation?: ReturnType<typeof setTimeout>;
};
type Receipt = {
  readonly fingerprint: string;
  readonly outcome?: TerminalInputResult;
};
type Reading = Awaited<ReturnType<typeof readTerminalIdentity>>;
type State = Awaited<ReturnType<typeof readTerminalState>>;
type Listing = { readonly available: boolean; readonly sessions: readonly TerminalSession[] };
type Follow = {
  readonly status: "ok";
  readonly session: Pick<TerminalSession, "id" | "name" | "cwd" | "running">;
  readonly messages: readonly TerminalMessage[];
} | { readonly status: "none" | "ambiguous" | "unavailable" };

const MAX_ATTACHED = 8;
const MAX_PENDING = 8;
const MAX_RECEIPTS = 4096;
const PROBE_LANES = 6;
const PROBE_MS = 5_000;
const EVENTS = new Set([
  "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "session_abort",
  "session_lifecycle", "queue_update",
]);
const capacity = () => new WebError(429, "terminal_capacity", "CLI 操作达到本机服务的容量上限。");
const outcomeUnknown = () => new WebError(409, "terminal_outcome_unknown", "无法确认 CLI 是否执行了操作。请刷新，不要重复发送。");
const leafUnavailable = () => new WebError(409, "terminal_leaf_unavailable", "无法确认 CLI 的当前分支位置，请刷新后再试。");

/** Server-only, allowlisted control of sessions that the configured native profile already owns. */
export class TerminalSessions {
  readonly #agentDir: string | undefined;
  readonly #onChange: (opaqueId: string) => void;
  readonly #authorized: ReadonlySet<string>;
  readonly #key = randomBytes(32);
  readonly #attachments = new Map<string, Attachment>();
  readonly #peers = new Set<TerminalPeer>();
  readonly #receipts = new Map<string, Receipt>();
  #candidates = new Map<string, Candidate>();
  #listing?: Promise<Listing>;
  #following?: Promise<Follow>;
  #stopped = false;

  constructor(agentDir: string | undefined, authorizedCwds: readonly string[], onChange: (opaqueId: string) => void) {
    this.#agentDir = agentDir;
    this.#onChange = onChange;
    this.#authorized = new Set(authorizedCwds);
  }

  list(): Promise<Listing> {
    this.#listing ??= this.#discover().finally(() => { this.#listing = undefined; });
    return this.#listing;
  }

  follow(): Promise<Follow> {
    this.#following ??= this.#follow().finally(() => { this.#following = undefined; });
    return this.#following;
  }

  snapshot(id: string): Promise<TerminalSnapshot> {
    return this.#use(id, async (slot, peer) => this.#snapshot(slot, peer, await this.#refresh(slot.candidate, peer)));
  }

  attach(id: string): Promise<TerminalSnapshot> {
    const existing = this.#attachments.get(id);
    if (existing) {
      if (existing.closing) return Promise.reject(terminalUnattached());
      return existing.opening ?? this.snapshot(id);
    }
    const candidate = this.#candidates.get(id);
    if (this.#stopped || !candidate) return Promise.reject(terminalMissing());
    if (this.#attachments.size >= MAX_ATTACHED) return Promise.reject(capacity());
    const slot: Attachment = {
      candidate, acceptEvents: false, ready: false, closing: false,
      pending: 0, tail: Promise.resolve(), observedTurn: null, revision: 0,
    };
    this.#attachments.set(id, slot);
    const opening = this.#attach(slot).finally(() => { slot.opening = undefined; });
    slot.opening = opening;
    return opening;
  }

  async detach(id: string): Promise<{ readonly detached: boolean }> {
    const slot = this.#attachments.get(id);
    if (!slot || slot.closing) return { detached: false };
    slot.closing = true;
    const peer = slot.peer;
    try {
      // Disconnect suffices while a request is pending. Never queue a release
      // behind an operation that might have lost its response.
      if (peer && slot.ready && slot.pending === 0) {
        await this.#refresh(slot.candidate, peer);
        await peer.request({ type: "release_attachment", sessionId: slot.candidate.sessionId });
      }
    } catch (error) {
      // Native disconnect always releases only this connection's attachment.
      if (!(error instanceof WebError)) throw error;
    } finally {
      peer?.close();
      this.#forget(slot);
    }
    return { detached: true };
  }

  async input(id: string, input: TerminalInput): Promise<TerminalInputResult> {
    const checked = terminalInput.safeParse(input);
    if (!checked.success) throw new WebError(400, "terminal_invalid_input", "CLI 只接受长度受限的纯文本消息和有效消息编号。");
    return this.#use(id, async (slot, peer) => {
      const { state } = await this.#refresh(slot.candidate, peer);
      this.#ensureSelected(slot);
      const { message, mode, clientMessageId, expectedTurnId } = checked.data;
      const fingerprint = createHash("sha256").update(JSON.stringify([mode, message, expectedTurnId])).digest("hex");
      const key = `${id}:${clientMessageId}`;
      const prior = this.#receipts.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TerminalRefusal("client_message_id_conflict");
        if (!prior.outcome) throw outcomeUnknown();
        return { ...prior.outcome, duplicate: true };
      }
      if (mode === "steer" || expectedTurnId !== undefined) this.#checkTurn(slot, state, expectedTurnId);
      if (this.#receipts.size >= MAX_RECEIPTS) throw capacity();

      this.#receipts.set(key, { fingerprint });
      try {
        // Native queue admission can queue a steer that reaches an already
        // settled epoch. Report its actual receipt, not a promise of steering.
        const data = parse(admissionReply, await peer.request({
          type: mode, message, clientMessageId, expected_turn_id: state.turn_epoch,
          ...(mode === "prompt" ? {} : { whenIdle: "queue" }),
        }));
        if (data.clientMessageId !== clientMessageId || data.admission.clientMessageId !== clientMessageId ||
            data.admission.durableSessionId !== slot.candidate.sessionId || data.admission.disposition !== data.disposition) {
          throw terminalProtocol();
        }
        const outcome = { clientMessageId, disposition: data.disposition, duplicate: data.duplicate === true };
        this.#receipts.set(key, { fingerprint, outcome });
        this.#invalidate(slot);
        return outcome;
      } catch (error) {
        if (error instanceof TerminalRefusal) {
          this.#receipts.delete(key);
          throw error;
        }
        if (!(error instanceof WebError)) throw error;
        // No retry even after reconnecting: the native terminal may have
        // admitted the text before the reply vanished or failed validation.
        peer.close();
        throw outcomeUnknown();
      }
    });
  }

  interrupt(id: string, expectedTurnId: string): Promise<{ readonly interrupted: true; readonly turnId: string }> {
    return this.#use(id, async (slot, peer) => {
      const { state } = await this.#refresh(slot.candidate, peer);
      this.#ensureSelected(slot);
      this.#checkTurn(slot, state, expectedTurnId);
      // OmO only fences interrupt for a STRING. A number is treated like no token.
      const turnId = String(state.turn_epoch);
      let result;
      try { result = parse(interruptReply, await peer.request({ type: "interrupt", turnId })); }
      catch (error) {
        if (error instanceof TerminalRefusal || !(error instanceof WebError)) throw error;
        peer.close();
        throw outcomeUnknown();
      }
      if (!result.interrupted) throw turnConflict();
      if (result.turnId !== turnId) {
        peer.close();
        throw outcomeUnknown();
      }
      this.#invalidate(slot);
      return { interrupted: true, turnId };
    });
  }

  branchIdentity(id: string): Promise<TerminalBranchIdentity> {
    return this.#use(id, async (slot, peer) => {
      const { candidate } = slot;
      const { state } = await this.#refresh(candidate, peer);
      if (projectState(state).running || state.compacting) {
        throw new WebError(409, "terminal_busy", "请等待 CLI 回合和压缩结束后再创建分支。");
      }
      const revision = slot.revision;
      const tail = { type: "get_entries", observe: true, tail: 1, maxBytes: TERMINAL_ENTRY_BYTES } as const;
      const first = leafReply.safeParse(await peer.request(tail));
      if (!first.success) throw leafUnavailable();
      const second = leafReply.safeParse(await peer.request(tail));
      const end = await readTerminalState(peer, candidate);
      await this.#verifyRegistration(candidate);
      this.#ensureSelected(slot);
      if (!second.success || first.data.leafId !== second.data.leafId || projectState(end).running || end.compacting ||
          state.turn_epoch !== end.turn_epoch || state.state_version !== end.state_version || revision !== slot.revision) {
        throw leafUnavailable();
      }
      return { cwd: candidate.cwd, nativeSessionId: candidate.sessionId, leafId: first.data.leafId };
    });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#candidates.clear();
    this.#receipts.clear();
    for (const slot of this.#attachments.values()) this.#forget(slot);
    for (const peer of this.#peers) peer.close();
  }

  async #follow(): Promise<Follow> {
    if (this.#stopped) return { status: "unavailable" };
    const expires = AbortSignal.timeout(PROBE_MS);
    const registry = await discoverTerminalRegistry(this.#agentDir);
    const active = () => !this.#stopped && !expires.aborted;
    if (!registry || !active()) return { status: "unavailable" };
    // Count names before trusting or filtering any registered endpoint.
    if (registry.names.length > 1) return { status: "ambiguous" };
    const [name] = registry.names;
    if (name === undefined) return { status: "none" };

    const selection = async () => {
      if (!active()) return "unavailable";
      const current = await discoverTerminalRegistry(this.#agentDir);
      if (!current || !active()) return "unavailable";
      if (current.names.length > 1) return "ambiguous";
      return current.names[0] === name ? "ok" : "unavailable";
    };
    let peer: TerminalPeer | undefined;
    try {
      const registered = await registeredTerminal(registry, name);
      if (!registered) throw terminalMissing();
      const { endpoint } = registered;
      peer = await this.#connect(registry, endpoint, active, undefined, expires);
      const initial = await selection();
      if (initial !== "ok") return { status: initial };
      const { row: { sessionId, cwd, name: label } } = await readTerminalIdentity(peer, endpoint.instance, this.#authorized);
      const identity = { registry, endpoint, sessionId, cwd };
      await this.#verifyRegistration(identity);
      const before = await selection();
      if (before !== "ok") return { status: before };
      const messages = projectMessages(await peer.request({ type: "get_messages", observe: true }));
      const state = await readTerminalState(peer, identity);
      await this.#verifyRegistration(identity);
      const after = await selection();
      if (after !== "ok") return { status: after };
      if (peer.closed) return { status: "unavailable" };
      const id = createHmac("sha256", this.#key)
        .update(JSON.stringify(["follow", endpoint.instance, endpoint.stamp, sessionId, cwd])).digest("hex");
      return { status: "ok", session: { id, cwd, name: displayText(label ?? "", 200).trim() || "OmO CLI",
        running: projectState(state).running }, messages };
    } catch (error) {
      if (!(error instanceof WebError)) throw error;
      return { status: await selection() === "ambiguous" ? "ambiguous" : "unavailable" };
    } finally {
      peer?.close();
    }
  }

  async #discover(): Promise<Listing> {
    const registry = this.#stopped || this.#authorized.size === 0 ? undefined : await discoverTerminalRegistry(this.#agentDir);
    if (this.#stopped || !registry) {
      this.#candidates.clear();
      return { available: false, sessions: [] };
    }
    const expires = AbortSignal.timeout(PROBE_MS);
    const found: { readonly candidate: Candidate; readonly reading: Reading }[] = [];
    const probes = async (lane: number) => {
      for (let i = lane; i < registry.names.length && !expires.aborted && !this.#stopped; i += PROBE_LANES) {
        const name = registry.names[i];
        if (!name) continue;
        const registered = await registeredTerminal(registry, name);
        if (!registered) continue;
        const { endpoint } = registered;
        let peer;
        try {
          peer = await this.#connect(registry, endpoint, () => !expires.aborted, undefined, expires);
          const reading = await readTerminalIdentity(peer, endpoint.instance, this.#authorized);
          const { sessionId, cwd } = reading.row;
          const id = createHmac("sha256", this.#key)
            .update(JSON.stringify([endpoint.instance, endpoint.stamp, sessionId, cwd])).digest("hex");
          const candidate = { id, registry, endpoint, sessionId, cwd };
          await this.#verifyRegistration(candidate);
          if (!peer.closed && !expires.aborted) found.push({ candidate, reading });
        } catch (error) {
          if (!(error instanceof WebError)) throw error;
        } finally {
          peer?.close();
        }
      }
    };
    await Promise.all(Array.from({ length: PROBE_LANES }, (_, lane) => probes(lane)));
    if (this.#stopped || expires.aborted) {
      this.#candidates.clear();
      return { available: false, sessions: [] };
    }
    const durableKey = (candidate: Candidate) => JSON.stringify([candidate.cwd, candidate.sessionId]);
    const counts = new Map<string, number>();
    for (const { candidate } of found) {
      const key = durableKey(candidate);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const selected = new Map<string, Candidate>();
    const sessions = [];
    for (const { candidate, reading } of found) {
      if (counts.get(durableKey(candidate)) !== 1) {
        this.#attachments.get(candidate.id)?.peer?.close();
        continue;
      }
      selected.set(candidate.id, candidate);
      sessions.push(this.#view(candidate, reading.row, projectState(reading.state), this.#isAttached(candidate.id)));
    }
    this.#candidates = selected;
    sessions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { available: true, sessions };
  }

  async #connect(registry: TerminalRegistry, endpoint: TerminalEndpoint, allowed: () => boolean,
    slot?: Attachment, signal?: AbortSignal): Promise<TerminalPeer> {
    const initial = await registeredTerminal(registry, endpoint.name);
    if (initial?.endpoint.stamp !== endpoint.stamp) throw terminalMissing();
    if (this.#stopped || !allowed()) throw terminalOffline();

    const peer = new TerminalPeer(endpoint.socket, event => {
      if (slot?.acceptEvents && !slot.closing) this.#event(slot, event);
    }, () => {
      this.#peers.delete(peer);
      if (slot) this.#forget(slot);
      signal?.removeEventListener("abort", cancel);
    });
    const cancel = () => peer.close();
    this.#peers.add(peer);
    if (slot) slot.peer = peer;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await peer.connected();
      // No secret bytes until the connected name and all registration
      // evidence have been checked again against the original inode stamps.
      const bound = await registeredTerminal(registry, endpoint.name);
      if (bound?.endpoint.stamp !== endpoint.stamp) throw terminalMissing();
      if (this.#stopped || !allowed()) throw terminalOffline();
      peer.authenticate(bound.secret);
      return peer;
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  async #attach(slot: Attachment): Promise<TerminalSnapshot> {
    const { candidate } = slot;
    try {
      const peer = await this.#connect(candidate.registry, candidate.endpoint, () => !slot.closing, slot);
      const reading = await this.#refresh(candidate, peer);
      this.#ensureSelected(slot);
      // Interrupt needs no declared role. Freeze the connection without
      // task_parent, remote-origin or any MCP/UI presenter capability.
      await peer.request({ type: "set_client_info", width: 120, capabilities: [] });
      await this.#verifyRegistration(candidate);
      this.#ensureSelected(slot);
      slot.acceptEvents = true; // Native attach may replay the in-flight message before its response.
      const attached = parse(attachReply, await peer.request({
        type: "attach_session", sessionId: candidate.sessionId, durableSessionId: candidate.sessionId,
        expectedHostInstance: candidate.endpoint.instance,
      }));
      if (attached.sessionId !== candidate.sessionId) throw terminalMissing();
      const snapshot = await this.#snapshot(slot, peer, reading);
      slot.ready = true;
      this.#notify(candidate.id);
      return snapshot;
    } catch (error) {
      if (error instanceof WebError && error.code === "terminal_not_found") this.#candidates.delete(candidate.id);
      slot.peer?.close();
      this.#forget(slot);
      throw error;
    }
  }

  async #snapshot(slot: Attachment, peer: TerminalPeer, reading: Reading): Promise<TerminalSnapshot> {
    const messages = projectMessages(await peer.request({ type: "get_messages", observe: true }));
    const state = projectState(await readTerminalState(peer, slot.candidate));
    await this.#verifyRegistration(slot.candidate);
    this.#ensureSelected(slot);
    slot.observedTurn = state.turnId;
    if (!state.running) slot.streaming = undefined;
    const partial = slot.streaming;
    const last = messages.at(-1);
    const alreadySettled = partial && last?.role === "assistant" && last.timestamp === partial.timestamp &&
      last.content.startsWith(partial.content);
    return {
      session: this.#view(slot.candidate, reading.row, state, true), state,
      messages: partial && !alreadySettled ? [...messages, partial] : messages,
    };
  }

  #view(candidate: Candidate, row: Reading["row"], state: TerminalSnapshot["state"], attached: boolean): TerminalSession {
    return {
      id: candidate.id, cwd: candidate.cwd, name: displayText(row.name ?? "", 200).trim() || "OmO CLI",
      attached, running: state.running,
    };
  }

  async #refresh(candidate: Candidate, peer: TerminalPeer): Promise<Reading> {
    await this.#verifyRegistration(candidate);
    const reading = await readTerminalIdentity(peer, candidate.endpoint.instance, this.#authorized);
    if (reading.row.sessionId !== candidate.sessionId || reading.row.cwd !== candidate.cwd) throw terminalMissing();
    await this.#verifyRegistration(candidate);
    return reading;
  }

  async #verifyRegistration(candidate: Pick<Candidate, "registry" | "endpoint" | "cwd">): Promise<void> {
    const current = await registeredTerminal(candidate.registry, candidate.endpoint.name);
    if (current?.endpoint.stamp !== candidate.endpoint.stamp || !await canonicalDirectory(candidate.cwd)) throw terminalMissing();
  }

  #isAttached(id: string): boolean {
    const slot = this.#attachments.get(id);
    return slot?.ready === true && !slot.closing && slot.peer?.closed === false;
  }

  #checkTurn(slot: Attachment, state: State, expected: string | undefined): void {
    if (typeof expected !== "string" || expected !== slot.observedTurn || expected !== projectState(state).turnId) throw turnConflict();
  }

  #ensureSelected(slot: Attachment): void {
    if (this.#stopped || slot.closing || this.#attachments.get(slot.candidate.id) !== slot || slot.peer?.closed !== false) {
      throw terminalOffline();
    }
  }

  async #use<T>(id: string, operation: (slot: Attachment, peer: TerminalPeer) => Promise<T>): Promise<T> {
    const slot = this.#attachments.get(id);
    const peer = slot?.peer;
    if (!slot?.ready || slot.closing || !peer || peer.closed) {
      throw this.#candidates.has(id) ? terminalUnattached() : terminalMissing();
    }
    if (slot.pending >= MAX_PENDING) throw capacity();
    slot.pending++;
    const work = slot.tail.then(async () => {
      try {
        this.#ensureSelected(slot);
        return await operation(slot, peer);
      }
      catch (error) {
        if (error instanceof WebError && error.code === "terminal_not_found") {
          this.#candidates.delete(id);
          peer.close();
        }
        throw error;
      } finally {
        slot.pending--;
      }
    });
    slot.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  #event(slot: Attachment, event: WireObject): void {
    if (typeof event.type !== "string" || !EVENTS.has(event.type)) return;
    if (event.sessionId !== slot.candidate.sessionId) {
      if (typeof event.sessionId !== "string") return;
      this.#candidates.delete(slot.candidate.id);
      slot.peer?.close();
      return;
    }
    if ((event.type === "message_start" || event.type === "message_update") && isAssistant(event.message)) {
      slot.streaming = projectStreamingAssistant(event.message);
    } else if (["agent_start", "agent_end", "turn_start", "turn_end", "session_abort"].includes(event.type) ||
               (event.type === "message_end" && isAssistant(event.message))) {
      slot.streaming = undefined;
    }
    this.#invalidate(slot);
  }

  #invalidate(slot: Attachment): void {
    slot.revision++;
    if (!slot.ready || slot.closing || slot.invalidation !== undefined) return;
    slot.invalidation = setTimeout(() => {
      slot.invalidation = undefined;
      if (this.#isAttached(slot.candidate.id)) this.#notify(slot.candidate.id);
    }, 35);
  }

  #forget(slot: Attachment): void {
    if (this.#attachments.get(slot.candidate.id) !== slot) return;
    this.#attachments.delete(slot.candidate.id);
    clearTimeout(slot.invalidation);
    if (slot.ready) this.#notify(slot.candidate.id);
  }

  #notify(id: string): void {
    if (!this.#stopped) this.#onChange(id);
  }
}
