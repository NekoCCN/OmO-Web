import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
if (!log) throw new Error("Missing queue wire log");
const sessions = new Map<string, { cwd: string; count: number | string }>();
let sequence = 0;
let queueReads = 0;
const privateText = "NATIVE-PRIVATE-QUEUE-SENTINEL";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const route = String(request.sessionId);
  const session = sessions.get(route);
  const envelope = { id: request.id, type: "response", command: request.type };
  const reply = (data: unknown) => send({ ...envelope, success: true, data });
  switch (request.type) {
    case "get_protocol_info":
      reply({ protocolVersion: 1, mode: "multi", capabilities: ["multi_session"] });
      break;
    case "open_session": {
      const sessionId = `queue-route-${++sequence}`;
      sessions.set(sessionId, { cwd: String(request.cwd), count: sequence === 1 ? 35 : "0" });
      reply({ sessionId, permissionPreset: "ask", permissionPresetStatus: "applied" });
      break;
    }
    case "get_state":
      reply({ cwd: session?.cwd, pendingMessageCount: session?.count, isStreaming: false,
        permissionPreset: "ask", effectivePermissionPreset: "ask" });
      break;
    case "get_session_stats":
      reply({ totalMessages: 7, cost: 0.125 });
      break;
    case "get_messages":
      reply({ messages: [{ role: "assistant", content: "Queue fixture conversation" }] });
      break;
    case "get_workbench_status":
      reply({ status: "empty" });
      break;
    case "get_pending_inputs": {
      appendFileSync(log, `${line}\n`);
      const read = ++queueReads;
      if (read === 1) {
        send({ ...envelope, success: false, errorCode: privateText, error: `Path: ${privateText}` });
      } else if (read === 2 && process.argv.includes("--oversize")) {
        const prefix = JSON.stringify({ ...envelope, success: true }).slice(0, -1);
        process.stdout.write(`${prefix},"data":{"inputs":[{"text":"`);
        const chunk = "X".repeat(1024 * 1024);
        for (let i = 0; i < 49; i++) process.stdout.write(chunk);
        process.stdout.write(`"}]}}\n`);
      } else {
        reply({ lifetimeId: privateText, throughCursor: privateText, outcomes: [{ text: privateText }],
          inputs: session?.count === 0 ? [] : [
            { state: "sent", text: privateText },
            ...Array.from({ length: 35 }, (_, i) => ({
              state: "queued", requestedMode: i ? privateText : "followUp",
              text: i ? `queued-${i}` : `f${"🎈".repeat(140)}${privateText.repeat(10)}`,
              path: privateText, id: privateText, metadata: { privateText },
            })),
          ] });
      }
      break;
    }
    case "clear_queue":
      appendFileSync(log, `${line}\n`);
      if (session) session.count = 0;
      reply({});
      break;
    default:
      reply({});
      break;
  }
}
