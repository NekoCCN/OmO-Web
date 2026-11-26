import { z } from "zod";
import { invocationFor, isCommandSource } from "./commands.ts";
import type { Engine } from "./engine.ts";
import { record, WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";

const MAX_ROWS = 128;
const SURFACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const mcpStatus = z.enum([
  "enabled", "disabled", "untrusted", "idle", "connecting", "connected", "degraded",
  "suspended", "needs_auth", "needs_client_registration",
]);

type Section<Row> =
  | { readonly status: "ok"; readonly rows: readonly Row[]; readonly incomplete: boolean }
  | { readonly status: "unavailable"; readonly reason: "rpc-failed" | "invalid-response" };
type ExtensionRow = { readonly name: string; readonly enabled: boolean; readonly origin?: "package" | "top-level" };

function section<Row>(data: WireObject | undefined, field: string, project: (row: WireObject) => Row | undefined): Section<Row> {
  if (data === undefined) return { status: "unavailable", reason: "rpc-failed" };
  const value = data[field];
  if (!Array.isArray(value)) return { status: "unavailable", reason: "invalid-response" };
  const rows = value.slice(0, MAX_ROWS).flatMap(entry => project(record(entry)) ?? []);
  return { status: "ok", rows, incomplete: rows.length !== value.length };
}

function extensionRow({ name, enabled, sourceInfo }: WireObject): ExtensionRow | undefined {
  if (typeof name !== "string" || !SURFACE_NAME.test(name) || typeof enabled !== "boolean") return;
  const { origin } = record(sourceInfo);
  return origin === "package" || origin === "top-level" ? { name, enabled, origin } : { name, enabled };
}

function mcpRow({ name, status, toolCount }: WireObject) {
  if (typeof name !== "string" || !SURFACE_NAME.test(name) ||
      typeof toolCount !== "number" || !Number.isSafeInteger(toolCount) || toolCount < 0) return;
  const parsed = mcpStatus.safeParse(status);
  if (parsed.success) return { name, status: parsed.data, toolCount };
}

function commandRow({ name, source }: WireObject) {
  if (typeof name !== "string" || !isCommandSource(source)) return;
  const invocation = invocationFor(name, source);
  if (invocation) return { name, source, invocation };
}

export async function readNativeSurfaces(engine: Engine, sessionId: string) {
  const read = (method: "get_loaded_surfaces" | "get_commands") =>
    engine.requestExisting(method, { sessionId }, 5_000).catch((error: unknown) => {
      if (!(error instanceof WebError)) throw error;
      // Native bridge error codes and messages are not part of the browser contract.
      return undefined;
    });
  const [surfaces, commands] = await Promise.all([read("get_loaded_surfaces"), read("get_commands")]);
  return {
    extensions: section(surfaces, "extensions", extensionRow),
    mcpServers: section(surfaces, "mcpServers", mcpRow),
    commands: section(commands, "commands", commandRow),
  };
}
