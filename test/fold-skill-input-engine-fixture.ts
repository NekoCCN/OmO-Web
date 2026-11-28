import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const route = "fixture-skill-route";
const send = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
let cwd = "";

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let data: object = {};
  switch (request.type) {
    case "get_protocol_info":
      data = { protocolVersion: 1, mode: "multi", serverVersion: "skill-fixture", capabilities: ["multi_session"] };
      break;
    case "open_session":
      cwd = request.cwd;
      data = { sessionId: route, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    case "get_state":
      data = { isStreaming: false };
      break;
    case "get_messages":
      data = { messages: JSON.parse(readFileSync(join(cwd, "seed.json"), "utf8")) };
      break;
    case "prompt":
      data = { disposition: "started", turnId: "skill-redraw", clientMessageId: request.clientMessageId };
      break;
  }
  send({ id: request.id, type: "response", command: request.type, success: true, data });
  if (request.type === "prompt") {
    const message: unknown = JSON.parse(readFileSync(join(cwd, "redraw.json"), "utf8"));
    send({ type: "message_end", sessionId: route, message });
  }
}
