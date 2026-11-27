import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import type { WireObject } from "../src/protocol.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const privateDir = { recursive: true, mode: 0o700 } as const;
const commands = [
  "get_protocol_info", "list_sessions", "get_state", "get_messages", "get_entries", "set_client_info",
  "attach_session", "release_attachment", "prompt", "steer", "follow_up", "interrupt",
];

export const transcriptPadding = Buffer.alloc(64 * 1024, "x");

export async function writeTerminalBytes(peer: Socket, bytes: Buffer | string): Promise<void> {
  await new Promise<void>((resolve, reject) => peer.write(bytes, error => error ? reject(error) : resolve()));
}

export async function writeLargeTerminalTranscript(peer: Socket, id: unknown, chunks = 40): Promise<void> {
  // Native puts id first. Write a large valid row without assembling its source.
  await writeTerminalBytes(peer, `{"id":${JSON.stringify(id)},"type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":"omitted-old-`);
  for (let i = 0; i < chunks; i++) await writeTerminalBytes(peer, transcriptPadding);
  const latest = Buffer.from(`"},{"role":"assistant","content":[{"type":"thinking","thinking":"fixture-private"},{"type":"text","text":"近况 🐋"}],"timestamp":42}]}}\n`);
  const split = latest.indexOf(Buffer.from("🐋")) + 2;
  await writeTerminalBytes(peer, latest.subarray(0, split));
  await writeTerminalBytes(peer, latest.subarray(split));
}

export async function refuseTerminalTranscript(peer: Socket, id: unknown): Promise<void> {
  await writeTerminalBytes(peer, JSON.stringify({ type: "response", id, command: "get_messages", success: false,
    errorCode: "response_too_large", error: "fixture-private" }) + "\n");
}

export async function terminalFixture(options: { readonly fallback?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ow-t-"));
  const agentDir = options.fallback ? join(root, "p".repeat(85)) : join(root, "profile");
  const cwd = join(root, "workspace");
  const instance = randomUUID();
  const file = `t-${sha(instance).slice(0, 16)}.sock`;
  const fallback = join(tmpdir(), `senpi-rpc-${sha(agentDir).slice(0, 8)}`);
  const socketRoot = options.fallback ? join(fallback, "tui") : join(agentDir, "rpc", "tui");
  const socket = join(socketRoot, file);
  const registry = join(agentDir, "rpc-host-daemon");
  const endpoint = join(registry, sha(socket).slice(0, 16));
  const generation = join(endpoint, "generations", instance);
  const manifest = join(endpoint, "endpoint.json");
  const pointer = join(endpoint, "host.pid");
  const secret = randomBytes(32);
  const secured = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const registration = { layout: 2, registry_version: 1, endpoint_kind: "tui", socket, created_at: new Date().toISOString() };
  const writer = { pid: process.pid, startTime: "2026-11-25T10:00:00.000Z" };
  const peers = new Set<Socket>();
  const attached = new Set<Socket>();
  const trace: WireObject[] = [];
  const delivered: WireObject[] = [];
  const receipts = new Map<string, WireObject>();
  const state = {
    durable: "native-fixture-session",
    cwd,
    turn: 0,
    running: false,
    refusal: "",
    oversized: false,
    noInputResponse: false,
    raceTurn: false,
    extraRow: false,
    wrongInstance: false,
    rowDurable: undefined as string | undefined,
    leafId: "active-leaf" as string | null,
    unstableLeaf: false,
    messages: [] as unknown[],
    beforeMessagesReply: undefined as (() => Promise<void>) | undefined,
    messagesReply: undefined as ((peer: Socket, id: unknown) => Promise<void>) | undefined,
    acceptedSecrets: 0,
    interrupted: 0,
  };
  function send(peer: Socket, value: unknown) {
    peer.write(`${JSON.stringify(value)}\n`);
  }
  function emit(type: string, fields: WireObject = {}) {
    for (const peer of attached) send(peer, { type, sessionId: state.durable, ...fields });
  }
  const server = createServer(peer => {
    peers.add(peer);
    peer.on("error", () => peer.destroy());
    peer.once("close", () => {
      peers.delete(peer);
      attached.delete(peer);
    });
    let buf = Buffer.alloc(0);
    let authenticated = false;
    peer.on("data", chunk => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      if (!authenticated) {
        if (buf.length < secret.length) return;
        if (!timingSafeEqual(buf.subarray(0, 32), secret)) return peer.destroy();
        state.acceptedSecrets++;
        buf = buf.subarray(32);
        authenticated = true;
      }
      let index: number;
      while ((index = buf.indexOf(10)) !== -1) {
        const request = record(JSON.parse(buf.subarray(0, index).toString()));
        buf = buf.subarray(index + 1);
        trace.push(request);
        const { type, id } = request;
        const ok = (data?: unknown) => send(peer, { type: "response", id, command: type, success: true, data });
        const refuse = (error: string) => send(peer, {
          type: "response", id, command: type, success: false, errorCode: error,
          error: "fixture-private token", errorData: { reason: "fixture-private reason" },
        });
        switch (type) {
          case "get_protocol_info":
            ok({ protocolVersion: 1, mode: "tui", endpoint_kind: "tui", generation: 0,
              instanceId: state.wrongInstance ? randomUUID() : instance,
              capabilities: ["tui_control", "tui_observer", "observe_reads", "session_status", "entries_tail"], commands });
            break;
          case "list_sessions": {
            const row = { sessionId: state.rowDurable ?? state.durable, name: "Fixture TUI", cwd: state.cwd,
              kind: "interactive", surface: "tui", attachments: 1, activity: state.running ? "running" : "idle",
              sessionPath: "/fixture-private", retain_on_disconnect: true };
            ok({ sessions: state.extraRow ? [row, { ...row, cwd: `${cwd}/child` }] : [row] });
            break;
          }
          case "get_state":
            ok({ sessionId: state.durable, cwd: state.cwd, isStreaming: state.running, compacting: false,
              turn_epoch: state.turn, editor_has_draft: true, blocking_question: { id: "fixture-private" },
              pendingDialogs: [{ title: "fixture-private" }], model: { apiKey: "fixture-private" } });
            break;
          case "get_messages": {
            const messages = state.messages;
            if (state.messagesReply) void state.messagesReply(peer, id).catch(() => peer.destroy());
            else if (state.oversized) peer.write(Buffer.alloc(2_200_000, 65));
            else if (state.beforeMessagesReply) {
              void state.beforeMessagesReply().then(() => ok({ messages }), () => peer.destroy());
            } else ok({ messages });
            break;
          }
          case "get_entries":
            if (!attached.has(peer) || request.tail !== 1 || request.maxBytes !== 2_097_152) refuse("invalid_argument");
            else {
              ok({ leafId: state.leafId, entries: state.leafId ? [{ id: "last-written-not-current-leaf" }] : [] });
              if (state.unstableLeaf) state.leafId = "changed-leaf";
            }
            break;
          case "set_client_info":
            if (!Array.isArray(request.capabilities) || request.capabilities.length !== 0) refuse("role_refused");
            else ok();
            break;
          case "attach_session":
            if (request.sessionId !== state.durable || request.durableSessionId !== state.durable ||
              request.expectedHostInstance !== instance || request.takeover !== undefined) refuse("session_identity_mismatch");
            else {
              attached.add(peer);
              send(peer, { type: "extension_ui_request", sessionId: state.durable, title: "fixture-private" });
              ok({ sessionId: state.durable, attached: true });
            }
            break;
          case "release_attachment":
            if (request.sessionId !== state.durable || !attached.delete(peer)) refuse("session_not_attached");
            else ok({ deferred: false });
            break;
          case "prompt":
          case "steer":
          case "follow_up": {
            if (!attached.has(peer)) { refuse("session_not_attached"); break; }
            if (state.refusal) { refuse(state.refusal); break; }
            if (type === "prompt" && state.running) { refuse("session_busy"); break; }
            const clientId = String(request.clientMessageId);
            const prior = receipts.get(clientId);
            if (prior) { ok({ ...prior, duplicate: true, replayed: true }); break; }
            if (typeof request.expected_turn_id !== "number" || request.expected_turn_id !== state.turn) {
              refuse("turn_conflict"); break;
            }
            if (type !== "prompt" && request.whenIdle !== "queue") { refuse("invalid_when_idle"); break; }
            delivered.push(request);
            const disposition = state.running || type !== "prompt" ? "queued" : "started";
            const receipt = { disposition, clientMessageId: clientId,
              admission: { clientMessageId: clientId, durableSessionId: state.durable, disposition } };
            receipts.set(clientId, receipt);
            if (disposition === "started") { state.turn++; state.running = true; }
            state.messages.push({ role: "custom", customType: "session_control_delivery", display: true, content: request.message });
            emit("message_end", { message: state.messages.at(-1) });
            if (state.noInputResponse) peer.destroy();
            else ok(receipt);
            break;
          }
          case "interrupt":
            if (state.raceTurn) state.turn++;
            if (request.turnId !== String(state.turn) || !state.running) {
              ok({ interrupted: false, turnId: String(state.turn) });
            } else {
              state.running = false;
              state.interrupted++;
              ok({ interrupted: true, turnId: String(state.turn) });
              emit("agent_end");
            }
            break;
          default:
            refuse("unsupported");
        }
      }
    });
  });
  try {
    if (options.fallback) await mkdir(fallback, { mode: 0o700 }); // Refuse a pre-existing path we do not own.
    await Promise.all([cwd, socketRoot, generation].map(path => mkdir(path, privateDir)));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await Promise.all([
      chmod(socket, 0o600),
      writeFile(`${socket}.secret`, secret, { mode: 0o600 }),
      secured(manifest, registration),
      secured(pointer, { layout: 2, instance_id: instance, generation_dir: `generations/${instance}`, writer }),
      secured(join(generation, "host.pid"), {
        pid: process.pid, processStartTime: writer.startTime, instance_id: instance,
        generation: 0, launchProfileId: "tui", socket, writer,
      }),
    ]);
  } catch (error) {
    for (const peer of peers) peer.destroy();
    server.close();
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  return {
    agentDir, cwd, endpoint, generation, manifest, pointer, registry, registration, secret, socket, state, trace, delivered,
    emit,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
      if (options.fallback) await rm(fallback, { force: true, recursive: true });
    },
  };
}
