import { createInterface } from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";

/**
 * File-backed stdio fixture for the sequential-handoff HTTP tests.
 * Real OmO journals live under the configured agent profile; open_session
 * resolves them by path exactly like the native host, including the
 * cross-process holder guard (SESSION_HANDOFF_HELD). The transport is stdio,
 * so handoff stays unsupported here; the quiet release matrix is covered by
 * the in-process fake inside session-handoff.test.ts.
 */
const held = new Set(
  (process.env.SESSION_HANDOFF_HELD ?? "").split(",").map(entry => entry.trim()).filter(Boolean),
);

type Runtime = { path: string; leaf: string | null };
const runtimes = new Map<string, Runtime>();
const byPath = new Map<string, string>();
let sequence = 0;
const lines = createInterface({ input: process.stdin });
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const ok = (id: unknown, data: unknown, command: string) =>
  send({ id, type: "response", command, success: true, data });
const refused = (id: unknown, command: string, errorCode: string, error: string) =>
  send({ id, type: "response", command, success: false, error, errorCode });

const parseJournal = (text: string): { header: Record<string, unknown>; entries: Record<string, unknown>[] } => {
  const rows = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const [header, ...entries] = rows;
  return { header, entries };
};

const nameOf = (entries: Record<string, unknown>[]): string => {
  let name = "";
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      name = entry.name;
    }
  }
  return name;
};

const leafOf = (entries: Record<string, unknown>[]): string | null => {
  const last = entries.at(-1);
  return last && typeof last.id === "string" ? String(last.id) : null;
};

async function stateOf(path: string) {
  const { header, entries } = parseJournal(await readFile(path, "utf8"));
  return {
    sessionId: header.id,
    sessionFile: path,
    cwd: header.cwd,
    sessionName: nameOf(entries),
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    runPaused: false,
    archived: false,
    settled: false,
    pendingDialogs: [],
    pendingQuestions: [],
    permissionPreset: "ask",
  };
}

function assistantText(entries: Record<string, unknown>[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message as Record<string, unknown> | undefined;
    if (entries[index].type !== "message" || message?.role !== "assistant") continue;
    const text = Array.isArray(message.content)
      ? message.content.filter(part => part?.type === "text").map(part => part.text).join("")
      : typeof message.content === "string" ? message.content : "";
    if (text.trim()) return text;
  }
  return null;
}

for await (const line of lines) {
  const request = JSON.parse(line);
  const route = String(request.sessionId ?? "");
  const runtime = runtimes.get(route);
  try {
    switch (request.type) {
      case "get_protocol_info":
        ok(request.id, {
          protocolVersion: 1,
          mode: "multi",
          serverVersion: "handoff-fixture",
          capabilities: ["multi_session", "session_model_scope", "session_held",
            "release_caller_aware", "durable_session_id", "retain_on_disconnect"],
        }, request.type);
        continue;
      case "set_client_info":
        ok(request.id, {}, request.type);
        continue;
      case "open_session": {
        const path = String(request.sessionPath);
        if (held.has(path)) {
          refused(request.id, request.type, "session_held", "会话正被另一进程持有。");
          continue;
        }
        const attached = byPath.get(path);
        if (attached && runtimes.has(attached)) {
          ok(request.id, { sessionId: attached, attached: true, state: await stateOf(path),
            permissionPreset: "ask", permissionPresetStatus: "applied" }, request.type);
          continue;
        }
        let header: Record<string, unknown>;
        try {
          header = parseJournal(await readFile(path, "utf8")).header;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
          header = { type: "session", version: 3, id: crypto.randomUUID(),
            timestamp: new Date().toISOString(), cwd: String(request.cwd) };
          await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
        }
        if (header.cwd !== request.cwd) {
          refused(request.id, request.type, "open_failed", "工作目录与日志不一致。");
          continue;
        }
        const sessionId = `rpc-${++sequence}`;
        runtimes.set(sessionId, { path, leaf: null });
        byPath.set(path, sessionId);
        ok(request.id, { sessionId, attached: false, state: await stateOf(path),
          permissionPreset: "ask", permissionPresetStatus: "applied" }, request.type);
        continue;
      }
      case "close_session":
        if (runtime) {
          runtimes.delete(route);
          if (byPath.get(runtime.path) === route) byPath.delete(runtime.path);
        }
        ok(request.id, {}, request.type);
        continue;
      case "get_state":
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        ok(request.id, await stateOf(runtime.path), request.type);
        continue;
      case "get_messages": {
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        const { entries } = parseJournal(await readFile(runtime.path, "utf8"));
        ok(request.id, { messages: entries.filter(entry => entry.type === "message").map(entry => entry.message) },
          request.type);
        continue;
      }
      case "get_tree": {
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        const { entries } = parseJournal(await readFile(runtime.path, "utf8"));
        ok(request.id, { tree: [], leafId: runtime.leaf ?? leafOf(entries) }, request.type);
        continue;
      }
      case "get_last_assistant_text": {
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        const { entries } = parseJournal(await readFile(runtime.path, "utf8"));
        ok(request.id, { text: assistantText(entries) }, request.type);
        continue;
      }
      case "set_thinking_level":
        if (request.scope !== "turn") {
          refused(request.id, request.type, "scope_required", "Web 只使用 turn 作用域。");
          continue;
        }
        ok(request.id, {}, request.type);
        continue;
      case "set_session_name": {
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        const { entries } = parseJournal(await readFile(runtime.path, "utf8"));
        const leaf = runtime.leaf ?? leafOf(entries);
        await appendFile(runtime.path, `${JSON.stringify({ type: "session_info", id: crypto.randomUUID(),
          parentId: leaf, timestamp: new Date().toISOString(), name: String(request.name) })}\n`);
        ok(request.id, {}, request.type);
        continue;
      }
      case "set_session_archived":
      case "set_session_settled":
        ok(request.id, {}, request.type);
        continue;
      case "prompt": {
        if (!runtime) throw Object.assign(new Error("unknown"), { code: "unknown_session" });
        const { entries } = parseJournal(await readFile(runtime.path, "utf8"));
        const leaf = runtime.leaf ?? leafOf(entries);
        const userId = crypto.randomUUID();
        const assistantId = crypto.randomUUID();
        const stamp = new Date().toISOString();
        await appendFile(runtime.path, [
          { type: "message", id: userId, parentId: leaf, timestamp: stamp,
            message: { role: "user", content: request.message, timestamp: Date.now() } },
          { type: "message", id: assistantId, parentId: userId, timestamp: stamp,
            message: { role: "assistant", content: [{ type: "text", text: `Echo: ${request.message}` }],
              timestamp: Date.now() } },
        ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
        runtime.leaf = assistantId;
        ok(request.id, { disposition: "started", turnId: "turn-1", clientMessageId: request.clientMessageId },
          request.type);
        continue;
      }
      case "get_session_stats":
        ok(request.id, { totalMessages: 0, cost: 0 }, request.type);
        continue;
      case "get_pending_inputs":
        ok(request.id, { inputs: [], outcomes: [] }, request.type);
        continue;
      case "get_available_models":
        ok(request.id, { models: [] }, request.type);
        continue;
      case "get_available_thinking_levels":
        ok(request.id, { levels: ["off", "low", "high"] }, request.type);
        continue;
      case "get_commands":
        ok(request.id, { commands: [] }, request.type);
        continue;
      default:
        refused(request.id, request.type, "engine_refused", "unsupported fixture method");
        continue;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code === "unknown_session" ? "unknown_session" : "engine_refused";
    refused(request.id, request.type, code, error instanceof Error ? error.message : "fixture failed");
  }
}
