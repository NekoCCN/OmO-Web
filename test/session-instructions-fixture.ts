import { createInterface } from "node:readline";
import { rename } from "node:fs/promises";

const mode = process.argv[2];
const route = "fixture-route";
let state = { cwd: "", sessionFile: "", sessionId: "fixture-durable" };
let reads = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let data: unknown = {};
  let errorCode: string | undefined;
  switch (request.type) {
    case "get_protocol_info":
      data = { mode: "multi", protocolVersion: 1 };
      break;
    case "open_session":
      state = { ...state, cwd: request.cwd, sessionFile: request.sessionPath };
      data = { sessionId: route, state, permissionPreset: "ask", permissionPresetStatus: "applied" };
      break;
    case "get_state":
      data = state;
      break;
    case "get_tree":
      data = { tree: [], leafId: null };
      break;
    case "read_project_file": {
      if (++reads !== 1 || request.sessionId !== route || request.path !== "AGENTS.md" ||
          Object.keys(request).sort().join(",") !== "id,path,sessionId,type") {
        errorCode = "wrong_request";
        break;
      }
      const cwd = state.cwd;
      switch (mode) {
        case "refused": errorCode = "project_file_not_allowed"; break;
        case "unsupported": errorCode = "unknown_command"; break;
        case "unavailable": errorCode = "internal_error"; break;
        case "native-size": errorCode = "project_file_too_large"; break;
        case "workspace-removed": await rename(cwd, `${cwd}-moved`); break;
        case "route-replaced":
          send({ type: "session_replaced", sessionId: route, cwd, durableSessionId: "transient" });
          break;
        case "identity-changed": state = { ...state, sessionId: "other-durable" }; break;
      }
      data = {
        cwd: mode === "wrong-cwd" ? `${cwd}/nested` : cwd,
        path: mode === "wrong-path" ? "CLAUDE.md" : "AGENTS.md",
        exists: mode !== "missing" && mode !== "invalid-missing",
        content: mode === "missing" ? null : mode === "malformed" ? { text: "native-private" } :
          mode === "size" ? "中".repeat(21_846) : mode === "max-size" ? "x".repeat(65_536) : "# Workspace\n",
        etag: "native-private",
      };
      break;
    }
  }
  send(errorCode ? { type: "response", id: request.id, success: false, errorCode, error: "native-private" }
    : { type: "response", id: request.id, success: true, data });
}
