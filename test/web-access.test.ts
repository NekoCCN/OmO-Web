import { expect, onTestFinished, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startApp } from "../src/server.ts";

const supportsPasswordFiles = process.platform !== "win32";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-web-access-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const password = randomBytes(24).toString("base64url");
  const passwordFile = join(root, "password");
  await writeFile(passwordFile, `${password}\r\n`, { mode: 0o600 });
  const settings = {
    dataDir: join(root, "data"),
    workspaces: [root],
    engineCommand: [process.execPath, fileURLToPath(new URL("./engine-fixture.ts", import.meta.url))] as const,
    port: 0,
  };
  return { root, settings, password, passwordFile, authorization: `Basic ${Buffer.from(`omo:${password}`).toString("base64")}` };
}

test.if(supportsPasswordFiles)("password-protected loopback challenges before serving files, running API routes, or opening SSE", async () => {
  const { settings, passwordFile, password } = await fixture();
  const app = await startApp({ ...settings, webEnv: { OMO_WEB_PASSWORD_FILE: passwordFile } });
  onTestFinished(() => app.stop());
  for (const [path, authorization, method] of [
    ["/", "", "GET"],
    ["/styles.css", "Basic @@@", "GET"],
    ["/api/bootstrap", `Basic ${Buffer.from(`other:${password}`).toString("base64")}`, "GET"],
    ["/api/events", `Basic ${Buffer.from(`omo:${"x".repeat(password.length)}`).toString("base64")}`, "GET"],
    ["/api/sessions", "", "POST"],
    ["/unknown", `Basic ${"A".repeat(1024)}`, "GET"],
  ]) {
    const response = await fetch(new URL(path, app.url), { method, headers: authorization ? { Authorization: authorization } : {},
      signal: AbortSignal.timeout(2000) });
    // Cancel an unexpected stream as well as ordinary response bodies.
    await response.body?.cancel();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test.if(supportsPasswordFiles)("authenticated loopback retains root, bootstrap, same-origin POST and the SSE ready frame", async () => {
  const { root, settings, passwordFile, authorization } = await fixture();
  const app = await startApp({ ...settings, webEnv: { OMO_WEB_PASSWORD_FILE: passwordFile } });
  onTestFinished(() => app.stop());
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, app.url), {
    ...init, headers: { Authorization: authorization, ...init?.headers }, signal: AbortSignal.timeout(3000),
  });
  const page = await request("/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<!doctype html>");
  const bootstrap = await request("/api/bootstrap");
  const { token } = z.object({ token: z.string(), engine: z.object({ online: z.literal(true) }) }).parse(await bootstrap.json());
  const post = (headers: Record<string, string>) => request("/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ cwd: root }),
  });
  const refusedHeaders: readonly Record<string, string>[] = [
    { Origin: app.url.origin },
    { "X-OmO-Token": token },
    { Origin: "https://foreign.invalid", "X-OmO-Token": token },
    { Origin: app.url.origin, "X-OmO-Token": token, "Sec-Fetch-Site": "same-site" },
  ];
  for (const headers of refusedHeaders) {
    const refused = await post(headers);
    expect(refused.status).toBe(403);
    await refused.body?.cancel();
  }
  const created = await post({ Origin: app.url.origin, "X-OmO-Token": token });
  expect(created.status).toBe(201);
  await created.body?.cancel();
  const events = await request("/api/events");
  expect(events.status).toBe(200);
  expect(events.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const reader = events.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new TypeError("Missing SSE stream");
  try { expect((await reader.read()).value).toContain('"type":"ready"'); }
  finally { await reader.cancel(); }
});

test("invalid listen config fails before inspecting workspaces", async () => {
  const { root, settings, passwordFile } = await fixture();
  const wildcard = { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ORIGIN: "https://localhost:4431",
    OMO_WEB_PASSWORD_FILE: passwordFile, OMO_WEB_TLS_CERT: passwordFile, OMO_WEB_TLS_KEY: passwordFile };
  const cases = [
    { env: { OMO_WEB_HOST: "localhost" }, key: "OMO_WEB_HOST" },
    { env: { ...wildcard, OMO_WEB_PASSWORD_FILE: undefined }, key: "OMO_WEB_PASSWORD_FILE" },
    ...(supportsPasswordFiles ? [
      { env: { ...wildcard, OMO_WEB_ORIGIN: undefined }, key: "OMO_WEB_ORIGIN" },
      { env: { ...wildcard, OMO_WEB_TLS_CERT: undefined }, key: "OMO_WEB_TLS_CERT" },
      { env: { ...wildcard, OMO_WEB_TLS_KEY: undefined }, key: "OMO_WEB_TLS_KEY" },
      { env: { ...wildcard, OMO_WEB_ORIGIN: "http://localhost:4431" }, key: "OMO_WEB_ORIGIN" },
      { env: { ...wildcard, OMO_WEB_ORIGIN: "https://localhost:4431/" }, key: "OMO_WEB_ORIGIN" },
      { env: { ...wildcard, OMO_WEB_ORIGIN: "https://localhost:4432" }, key: "OMO_WEB_ORIGIN" },
      { env: wildcard, port: 0, key: "OMO_WEB_PORT" },
      { env: wildcard, key: "OMO_WEB_TLS" },
    ] : []),
  ];
  for (const { env, port = 4431, key } of cases) {
    const input = { ...settings, workspaces: [join(root, "missing")], port, webEnv: env };
    await expect(startApp(input).then(async app => app.stop())).rejects.toThrow(key);
  }
});

test.if(!supportsPasswordFiles)("Windows rejects password files and wildcard binding before opening a workspace", async () => {
  const { root, settings } = await fixture();
  const unopened = { ...settings, workspaces: [join(root, "missing")] };
  for (const webEnv of [
    { OMO_WEB_PASSWORD_FILE: join(root, "missing-password") },
    { OMO_WEB_HOST: "0.0.0.0" },
  ]) {
    await expect(startApp({ ...unopened, webEnv }).then(async app => app.stop())).rejects.toThrow(/OMO_WEB_PASSWORD_FILE.*Windows/);
  }
});

test.if(supportsPasswordFiles)("password files fail closed unless private and 20–128 printable ASCII bytes with at most one line ending", async () => {
  const { root, settings, password } = await fixture();
  const cases = [
    { content: password, mode: 0o644 },
    { content: "a".repeat(19), mode: 0o600 },
    { content: "a".repeat(129), mode: 0o600 },
    { content: `${password}\n\n`, mode: 0o600 },
    { content: `${password}\u00a0`, mode: 0o600 },
  ];
  for (const [index, { content, mode }] of cases.entries()) {
    const path = join(root, `invalid-password-${index}`);
    await writeFile(path, content, { mode: 0o600 });
    // Creation modes are masked by the runner's umask; exercise the exact mode.
    await chmod(path, mode);
    const input = { ...settings, webEnv: { OMO_WEB_PASSWORD_FILE: path } };
    await expect(startApp(input).then(async app => app.stop())).rejects.toThrow("OMO_WEB_PASSWORD_FILE");
  }
});

// Opt-in: supply a short-lived localhost certificate and private key. CI does
// not invoke OpenSSL or bind a wildcard listener in its default test run.
const { OMO_WEB_TEST_TLS_CERT: certPath, OMO_WEB_TEST_TLS_KEY: keyPath } = process.env;
test.if(supportsPasswordFiles && certPath !== undefined && keyPath !== undefined)("wildcard only serves verified TLS on the configured authority", async () => {
  if (!certPath || !keyPath) throw new TypeError("Missing TLS test inputs");
  const { settings, passwordFile, authorization } = await fixture();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  if (!port) throw new RangeError("Missing test listener port");
  const origin = `https://localhost:${port}`;
  const webEnv = { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ORIGIN: origin, OMO_WEB_PASSWORD_FILE: passwordFile,
    OMO_WEB_TLS_CERT: certPath, OMO_WEB_TLS_KEY: keyPath };
  const app = await startApp({ ...settings, port, webEnv });
  onTestFinished(() => app.stop());
  expect(app.url.origin).toBe(origin);
  const request = (url: string, headers?: Record<string, string>) => fetch(url, {
    headers, tls: { ca: Bun.file(certPath), rejectUnauthorized: true }, signal: AbortSignal.timeout(2000),
  });
  const anonymous = await request(origin);
  expect(anonymous.status).toBe(401);
  await anonymous.body?.cancel();
  const root = await request(origin, { Authorization: authorization, "X-Forwarded-Host": "unrelated.invalid", "X-Forwarded-Proto": "http" });
  expect(root.status).toBe(200);
  await root.body?.cancel();
  const alias = await request(`https://127.0.0.1:${port}/api/bootstrap`, {
    Authorization: authorization, "X-Forwarded-Host": `localhost:${port}`, "X-Forwarded-Proto": "https",
  });
  expect(alias.status).toBe(403);
  await alias.body?.cancel();
  const foreign = await request(`${origin}/api/bootstrap`, { Authorization: authorization, Origin: `https://localhost:${port + 1}` });
  expect(foreign.status).toBe(403);
  await foreign.body?.cancel();
  await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) })).rejects.toBeInstanceOf(Error);
});
