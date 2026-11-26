import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "../src/server.ts";

async function usingSession(mode: string, run: (instructions: URL, authorization: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omo-web-instructions-"));
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const cwd = join(root, "workspace"), passwordFile = join(root, "password");
    const password = "fixture-only-password-123";
    await mkdir(cwd);
    await writeFile(passwordFile, password, { mode: 0o600 });
    const authorization = `Basic ${Buffer.from(`omo:${password}`).toString("base64")}`;
    app = await startApp({ dataDir: join(root, "data"), workspaces: [cwd], port: 0,
      webEnv: { OMO_WEB_PASSWORD_FILE: passwordFile },
      engineCommand: [process.execPath, fileURLToPath(new URL("./session-instructions-fixture.ts", import.meta.url)), mode] });
    const bootstrap = await fetch(new URL("/api/bootstrap", app.url), { headers: { Authorization: authorization } });
    const { token } = await bootstrap.json();
    const created = await fetch(new URL("/api/sessions", app.url), {
      method: "POST", headers: { Authorization: authorization, Origin: app.url.origin,
        "X-OmO-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json();
    await run(new URL(`/api/sessions/${session.id}/instructions`, app.url), authorization);
  } finally {
    try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("only the authenticated, exact instructions GET returns the fixed file", async () => {
  await usingSession("ok", async (url, authorization) => {
    expect((await fetch(url)).status).toBe(401);
    const options = { headers: { Authorization: authorization } };
    expect((await fetch(new URL(`${url.pathname}/CLAUDE.md`, url), options)).status).toBe(404);
    const details = await fetch(new URL("details", url), options);
    expect(details.status).toBe(200);
    expect(await details.text()).not.toContain("# Workspace");
    url.search = "?path=../../CLAUDE.md&cwd=/other&sessionId=other";
    const response = await fetch(url, options);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", file: "AGENTS.md", content: "# Workspace\n" });
  });
});

test.each([
  ["missing", "missing"], ["unsupported", "unsupported"], ["refused", "refused"], ["unavailable", "unavailable"],
  ["wrong-cwd", "refused"], ["wrong-path", "refused"], ["invalid-missing", "unavailable"], ["malformed", "unavailable"],
  ["workspace-removed", "refused"], ["route-replaced", "refused"], ["identity-changed", "refused"],
  ["native-size", "too_large"], ["size", "too_large"],
])("instructions %s returns only %s", async (mode, status) => {
  await usingSession(mode, async (url, authorization) => {
    const response = await fetch(url, { headers: { Authorization: authorization } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status });
  });
});

test("accepts exactly 64 KiB without truncating", async () => {
  await usingSession("max-size", async (url, authorization) => {
    const response = await fetch(url, { headers: { Authorization: authorization } });
    expect(await response.json()).toEqual({ status: "ok", file: "AGENTS.md", content: "x".repeat(65_536) });
  });
});
