/**
 * Fake multi-session RPC host for engine-socket tests.
 *
 * Mirrors the native socket handshake as implemented in the shipped runtime
 * (dist/modes/rpc/rpc-auth-client.js), NOT the docs order:
 *   server_proof = HMAC(key, "senpi-rpc-server\nlaunch_id\nclient_nonce\nserver_nonce")
 *   client_proof = HMAC(key, "senpi-rpc-client\nlaunch_id\nserver_nonce\nclient_nonce")
 *
 * Usage: bun test/engine-socket-fixture.ts <socketPath> <keyRoot> <mode>
 * Modes: ok | wrong-order | no-challenge | oversized | corrupt-record | wrong-endpoint | fail-once
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Socket } from "node:net";

const [socketPath, keyRoot, mode] = process.argv.slice(2);
if (!socketPath || !keyRoot || !mode) {
  console.error("usage: engine-socket-fixture.ts <socketPath> <keyRoot> <mode>");
  process.exit(2);
}

const proof = (key: Buffer, label: string, ...parts: string[]) =>
  createHmac("sha256", key).update([`senpi-rpc-${label}`, ...parts].join("\n"), "utf8").digest("hex");

const launchId = randomUUID();
const key = randomBytes(32);
await mkdir(`${keyRoot}/rpc/keys`, { recursive: true, mode: 0o700 });
await mkdir(`${keyRoot}/rpc`, { recursive: true });
await writeFile(`${keyRoot}/fixture.pid`, String(process.pid));
await writeFile(join(keyRoot, "fixture.env"), JSON.stringify({
  OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR ?? null,
  SENPI_CODING_AGENT_DIR: process.env.SENPI_CODING_AGENT_DIR ?? null,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
}));
if (mode === "fail-once") {
  try {
    await access(join(keyRoot, "failed.marker"));
  } catch {
    await writeFile(join(keyRoot, "failed.marker"), "1");
    process.exit(1);
  }
}
await writeFile(
  `${keyRoot}/rpc/keys/${launchId}`,
  mode === "corrupt-record"
    ? JSON.stringify({ version: 1, launch_id: launchId, key: "not-a-key" })
    : JSON.stringify({
      version: 1,
      launch_id: launchId,
      key: key.toString("hex"),
      pid: process.pid,
      process_start: new Date().toISOString(),
      endpoint: mode === "wrong-endpoint" ? join(keyRoot, "elsewhere.sock") : socketPath,
      created_at: new Date().toISOString(),
    }),
  { mode: 0o600 },
);

const protocolInfo = {
  protocolVersion: 1,
  mode: "multi",
  serverVersion: "socket-fixture",
  capabilities: ["multi_session", "session_model_scope", "socket_auth"],
};

const send = (peer: Socket, value: unknown) => peer.write(`${JSON.stringify(value)}\n`);
const refuse = (peer: Socket, id: unknown, code: string) =>
  send(peer, { id, type: "response", command: "refused", success: false, error: code, errorCode: code });

const matchHex = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

const server = createServer();
server.on("connection", (peer: Socket) => {
  peer.on("error", () => peer.destroy());
  if (mode === "oversized") {
    peer.write(`{"id":"oversized","type":"response","data":"${"A".repeat(1_300_000)}"}\n`);
    peer.destroy();
    return;
  }
  let buf = "";
  let authed = false;
  let nonce = "";
  let serverNonce = "";
  let sessionCounter = 0;
  peer.on("data", chunk => {
    buf += chunk.toString("utf8");
    if (buf.length > 2_000_000) {
      peer.destroy();
      return;
    }
    let index: number;
    while ((index = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(line);
        if (typeof request !== "object" || request === null) throw new SyntaxError("not an object");
      } catch {
        peer.destroy();
        return;
      }
      if (!authed) {
        if (request.type === "get_protocol_info") {
          const clientNonce = (request.auth as { client_nonce?: unknown } | undefined)?.client_nonce;
          if (typeof clientNonce !== "string" || !/^[a-f0-9]{64}$/.test(clientNonce)) {
            refuse(peer, request.id, "auth_required");
            continue;
          }
          nonce = clientNonce;
          if (mode === "no-challenge") {
            authed = true;
            send(peer, { id: request.id, type: "response", command: request.type, success: true, data: protocolInfo });
            continue;
          }
          serverNonce = randomBytes(32).toString("hex");
          const serverProof =
            mode === "wrong-order"
              ? proof(key, "server", launchId, serverNonce, nonce)
              : proof(key, "server", launchId, nonce, serverNonce);
          send(peer, {
            id: request.id,
            type: "response",
            command: request.type,
            success: true,
            data: {
              ...protocolInfo,
              auth: { launch_id: launchId, server_nonce: serverNonce, server_proof: serverProof },
            },
          });
          continue;
        }
        if (request.type === "authenticate") {
          const wanted = proof(key, "client", launchId, serverNonce, nonce);
          if (typeof request.client_proof !== "string" || !matchHex(wanted, request.client_proof)) {
            peer.destroy();
            return;
          }
          authed = true;
          send(peer, { id: request.id, type: "response", command: request.type, success: true, data: {} });
          continue;
        }
        refuse(peer, request.id, "auth_required");
        continue;
      }
      if (request.type === "get_protocol_info") {
        send(peer, { id: request.id, type: "response", command: request.type, success: true, data: protocolInfo });
      } else if (request.type === "set_client_info") {
        send(peer, { id: request.id, type: "response", command: request.type, success: true, data: {} });
      } else if (request.type === "open_session") {
        sessionCounter++;
        send(peer, { id: request.id, type: "response", command: request.type, success: true, data: { sessionId: `sock-${sessionCounter}` } });
      } else if (request.type === "get_state") {
        send(peer, { id: request.id, type: "response", command: request.type, success: true, data: { sessionId: request.sessionId, isStreaming: false } });
      } else if (request.type === "close_session") {
        send(peer, { id: request.id, type: "response", command: request.type, success: true, data: {} });
      } else {
        refuse(peer, request.id, "unsupported");
      }
    }
  });
});

server.on("error", error => {
  console.error(`fixture failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});

await rm(socketPath, { force: true });
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});
await chmod(socketPath, 0o600);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
