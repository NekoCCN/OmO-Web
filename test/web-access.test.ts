import { expect, onTestFinished, setSystemTime, spyOn, test } from "bun:test";
import { randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createWindowsPasswordFile } from "../packaging/npm/windows-password.js";
import { startApp } from "../src/server.ts";
import { loadWebAccess, WebAccessConfigError } from "../src/web-access.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-web-access-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const password = randomBytes(24).toString("base64url");
  const passwordFile = join(root, "password");
  if (process.platform === "win32") await createWindowsPasswordFile(passwordFile, password);
  else await writeFile(passwordFile, `${password}\r\n`, { mode: 0o600 });
  const settings = {
    dataDir: join(root, "data"),
    workspaces: [root],
    engineCommand: [process.execPath, fileURLToPath(new URL("./engine-fixture.ts", import.meta.url))] as const,
    port: 0,
  };
  return { root, settings, password, passwordFile, authorization: `Basic ${Buffer.from(`omo:${password}`).toString("base64")}` };
}

test("password-protected loopback challenges before serving files, running API routes, or opening SSE", async () => {
  const { settings, passwordFile, password } = await fixture();
  const app = await startApp({ ...settings, webEnv: { OMO_WEB_PASSWORD_FILE: passwordFile } });
  onTestFinished(() => app.stop());
  for (const [path, authorization, method] of [
    ["/", "", "GET"],
    ["/styles.css", "Basic @@@", "GET"],
    ["/icons.svg", "", "GET"],
    ["/tool-ledger.css", "", "GET"],
    ["/dag-graph.css", "", "GET"],
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

test("authenticated loopback retains root, bootstrap, same-origin POST and the SSE ready frame", async () => {
  const { root, settings, passwordFile, authorization } = await fixture();
  const app = await startApp({ ...settings, webEnv: { OMO_WEB_PASSWORD_FILE: passwordFile } });
  onTestFinished(() => app.stop());
  expect(app.unprotected).toBe(false);
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, app.url), {
    ...init, headers: { Authorization: authorization, ...init?.headers }, signal: AbortSignal.timeout(3000),
  });
  const page = await request("/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<!doctype html>");
  const icons = await request("/icons.svg");
  expect(icons.status).toBe(200);
  expect(icons.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
  await icons.body?.cancel();
  for (const path of ["/tool-ledger.css", "/dag-graph.css"]) {
    const styles = await request(path);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toMatch(/^text\/css/);
    await styles.body?.cancel();
  }
  const bootstrap = await request("/api/bootstrap");
  const { token } = z.object({ token: z.string(), unprotected: z.literal(false),
    engine: z.object({ online: z.literal(true) }) }).parse(await bootstrap.json());
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

test("anonymous loopback is not flagged as unprotected public access", async () => {
  const { settings } = await fixture();
  const app = await startApp({ ...settings, webEnv: { OMO_WEB_ALLOW_UNAUTHENTICATED: "1" } });
  onTestFinished(() => app.stop());
  expect(app.unprotected).toBe(false);
  const response = await fetch(new URL("/api/bootstrap", app.url), { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveProperty("unprotected", false);
});

test("invalid listen config fails before inspecting workspaces", async () => {
  const { root, settings, passwordFile } = await fixture();
  const wildcard = { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ORIGIN: "https://localhost:4431",
    OMO_WEB_PASSWORD_FILE: passwordFile, OMO_WEB_TLS_CERT: passwordFile, OMO_WEB_TLS_KEY: passwordFile };
  const cases: { env: NodeJS.ProcessEnv; key: string; port?: number }[] = [
    { env: { OMO_WEB_HOST: "localhost" }, key: "OMO_WEB_HOST" },
    { env: { ...wildcard, OMO_WEB_PASSWORD_FILE: undefined }, key: "OMO_WEB_PASSWORD_FILE" },
    ...["", "0", "true", " 1", "1 "].map(value => ({
      env: { ...wildcard, OMO_WEB_PASSWORD_FILE: undefined, OMO_WEB_ALLOW_UNAUTHENTICATED: value }, key: "OMO_WEB_PASSWORD_FILE",
    })),
    { env: { OMO_WEB_PASSWORD_FILE: join(root, "absent-password"), OMO_WEB_ALLOW_UNAUTHENTICATED: "1" }, key: "OMO_WEB_PASSWORD_FILE" },
    { env: { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ALLOW_UNAUTHENTICATED: "1" }, key: "OMO_WEB_ORIGIN" },
    { env: { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ALLOW_UNAUTHENTICATED: "1", OMO_WEB_ORIGIN: wildcard.OMO_WEB_ORIGIN },
      key: "OMO_WEB_TLS_CERT" },
    { env: { ...wildcard, OMO_WEB_ORIGIN: undefined }, key: "OMO_WEB_ORIGIN" },
    { env: { ...wildcard, OMO_WEB_TLS_CERT: undefined }, key: "OMO_WEB_TLS_CERT" },
    { env: { ...wildcard, OMO_WEB_TLS_KEY: undefined }, key: "OMO_WEB_TLS_KEY" },
    { env: { ...wildcard, OMO_WEB_ORIGIN: "http://localhost:4431" }, key: "OMO_WEB_ORIGIN" },
    { env: { ...wildcard, OMO_WEB_ORIGIN: "https://localhost:4431/" }, key: "OMO_WEB_ORIGIN" },
    { env: { ...wildcard, OMO_WEB_ORIGIN: "https://localhost:4432" }, key: "OMO_WEB_ORIGIN" },
    { env: wildcard, port: 0, key: "OMO_WEB_PORT" },
    { env: wildcard, key: "OMO_WEB_TLS" },
  ];
  for (const { env, port = 4431, key } of cases) {
    const input = { ...settings, workspaces: [join(root, "missing")], port, webEnv: env };
    const error = await startApp(input).then(async app => app.stop(), (error: unknown) => error);
    expect(error).toBeInstanceOf(WebAccessConfigError);
    expect(error).toHaveProperty("message", expect.stringContaining(key));
  }
});

test.if(process.platform !== "win32")("POSIX password files fail closed unless private and 20–128 printable ASCII bytes with at most one line ending", async () => {
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

// Opt in: OpenSSL creates short-lived test keys in each fixture's
// temp directory. The clients verify TLS and speak only to loopback.
const tlsTest = test.if(process.env.OMO_WEB_TEST_TLS === "1");

async function tlsFixture(san = "DNS:localhost,IP:127.0.0.1") {
  const base = await fixture();
  const certPath = join(base.root, "cert.pem");
  const keyPath = join(base.root, "key.pem");
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", `subjectAltName=${san}`, "-out", certPath, "-keyout", keyPath],
    { stdout: "ignore", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([openssl.exited, new Response(openssl.stderr).text()]);
  if (exit !== 0) throw new Error(`OpenSSL failed (${exit}): ${stderr}`);
  const cert = await readFile(certPath);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  if (!port) throw new RangeError("Missing test listener port");
  const origin = `https://localhost:${port}`;
  const webEnv = { OMO_WEB_HOST: "0.0.0.0", OMO_WEB_ORIGIN: origin,
    OMO_WEB_TLS_CERT: certPath, OMO_WEB_TLS_KEY: keyPath };
  const request = (path: string, options: { headers?: Record<string, string>; localAddress?: string; body?: string;
    trustCert?: boolean } = {}) => new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const { body, headers, localAddress, trustCert = true } = options;
    const client = httpsRequest({
      hostname: "127.0.0.1", servername: "localhost", port, path, localAddress, agent: false,
      ca: trustCert ? cert : undefined, rejectUnauthorized: true,
      method: body === undefined ? "GET" : "POST",
      headers: { Host: new URL(origin).host, ...(body === undefined ? {} : { "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) }), ...headers },
      signal: AbortSignal.timeout(3000),
    }, response => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    client.on("error", reject);
    client.end(body);
  });
  return { ...base, settings: { ...base.settings, port }, origin, webEnv, request, cert };
}

tlsTest("protected wildcard serves verified TLS and rejects untrusted TLS, plaintext and forwarded authority", async () => {
  const { settings, passwordFile, authorization, origin, webEnv, request } = await tlsFixture();
  const app = await startApp({ ...settings, webEnv: { ...webEnv, OMO_WEB_PASSWORD_FILE: passwordFile,
    OMO_WEB_ALLOW_UNAUTHENTICATED: "1" } });
  onTestFinished(() => app.stop());
  expect(app.url.origin).toBe(origin);
  expect(app.unprotected).toBe(false);
  const anonymous = await request("/api/bootstrap");
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers["www-authenticate"]).toMatch(/^Basic realm=/);
  const bootstrap = await request("/api/bootstrap", { headers: { Authorization: authorization,
    "X-Forwarded-Host": "unrelated.invalid", "X-Forwarded-Proto": "http" } });
  expect(bootstrap.status).toBe(200);
  expect(JSON.parse(bootstrap.body)).toHaveProperty("unprotected", false);
  const alias = await request("/api/bootstrap", { headers: { Authorization: authorization,
    Host: `127.0.0.1:${settings.port}`, "X-Forwarded-Host": `localhost:${settings.port}`, "X-Forwarded-Proto": "https" } });
  expect(alias.status).toBe(403);
  const foreign = await request("/api/bootstrap", { headers: { Authorization: authorization, Origin: "https://foreign.invalid" } });
  expect(foreign.status).toBe(403);
  await expect(request("/api/bootstrap", { trustCert: false })).rejects.toBeInstanceOf(Error);
  await expect(fetch(`http://127.0.0.1:${settings.port}`, { signal: AbortSignal.timeout(2000) })).rejects.toBeInstanceOf(Error);
});

tlsTest("unprotected wildcard still needs TLS and retains the origin and token fences", async () => {
  const { root, settings, origin, webEnv, request } = await tlsFixture();
  const confirmed = { ...webEnv, OMO_WEB_ALLOW_UNAUTHENTICATED: "1" };
  for (const passwordFile of ["", join(root, "absent")]) {
    await expect(startApp({ ...settings, webEnv: { ...confirmed, OMO_WEB_PASSWORD_FILE: passwordFile } })
      .then(async app => app.stop())).rejects.toThrow("OMO_WEB_PASSWORD_FILE");
  }
  const app = await startApp({ ...settings, webEnv: confirmed });
  onTestFinished(() => app.stop());
  expect(app.unprotected).toBe(true);
  const bootstrap = await request("/api/bootstrap");
  expect(bootstrap.status).toBe(200);
  const { token } = z.object({ token: z.string(), unprotected: z.literal(true) }).parse(JSON.parse(bootstrap.body));
  for (let i = 0; i < 7; i++) {
    const response = await request("/api/sessions", { headers: { Authorization: "Basic b21vOndyb25n" } });
    expect(response.status).toBe(200);
    expect(response.headers["retry-after"]).toBeUndefined();
  }
  const post = (headers: Record<string, string>) =>
    request("/api/sessions", { headers, body: JSON.stringify({ cwd: root }) });
  expect((await post({ Origin: origin })).status).toBe(403);
  expect((await post({ "X-OmO-Token": token })).status).toBe(403);
  expect((await post({ Origin: "https://foreign.invalid", "X-OmO-Token": token })).status).toBe(403);
  expect((await post({ Origin: origin, "X-OmO-Token": token, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post({ Origin: origin, "X-OmO-Token": token })).status).toBe(201);
  await expect(fetch(`http://127.0.0.1:${settings.port}`, { signal: AbortSignal.timeout(2000) })).rejects.toBeInstanceOf(Error);
});

tlsTest("wildcard rejects certificates outside their validity interval and names absent from the SAN", async () => {
  const { root, settings, webEnv, cert } = await tlsFixture("IP:127.0.0.1");
  const unopened = { ...settings, workspaces: [join(root, "missing")] };
  const confirmed = { ...webEnv, OMO_WEB_ALLOW_UNAUTHENTICATED: "1" };
  const rejects = (env: NodeJS.ProcessEnv) =>
    expect(startApp({ ...unopened, webEnv: env }).then(async app => app.stop())).rejects.toThrow("OMO_WEB_TLS_CERT");
  await rejects(confirmed); // A localhost common name without a DNS SAN is not browser-trusted.
  await rejects({ ...confirmed, OMO_WEB_ORIGIN: `https://127.0.0.2:${settings.port}` });
  const dnsOnly = await tlsFixture("DNS:127.0.0.1");
  await rejects({ ...confirmed, OMO_WEB_ORIGIN: `https://127.0.0.1:${settings.port}`,
    OMO_WEB_TLS_CERT: dnsOnly.webEnv.OMO_WEB_TLS_CERT, OMO_WEB_TLS_KEY: dnsOnly.webEnv.OMO_WEB_TLS_KEY });

  const ipOrigin = { ...confirmed, OMO_WEB_ORIGIN: `https://127.0.0.1:${settings.port}` };
  const app = await startApp({ ...settings, webEnv: ipOrigin });
  await app.stop();
  const leaf = new X509Certificate(cert);
  try {
    setSystemTime(new Date(Date.parse(leaf.validFrom) - 1000));
    await rejects(ipOrigin);
    setSystemTime(new Date(Date.parse(leaf.validTo) + 1000));
    await rejects(ipOrigin);
  } finally {
    setSystemTime();
  }
});

tlsTest("a full authentication tracker preserves active cooldowns and reuses expired slots", async () => {
  const { settings, passwordFile, origin, webEnv } = await tlsFixture();
  const access = await loadWebAccess({ ...webEnv, OMO_WEB_PASSWORD_FILE: passwordFile }, settings.port);
  const url = new URL(origin);
  const wrong = new Request(url, { headers: { Host: url.host, Authorization: "Basic b21vOndyb25n" } });
  const token = Buffer.alloc(64);
  const address = (i: number) => `192.0.${Math.floor(i / 256)}.${i % 256}`;
  const attempt = (i: number) => access.authorize(wrong, url, token, address(i));
  let now = 0.001;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    expect(attempt(0)?.status).toBe(401);
    now += 10_000;
    for (let i = 1; i < 1024; i++) expect(attempt(i)?.status).toBe(401);
    for (let i = 0; i < 4; i++) expect(attempt(0)?.status).toBe(401);
    expect(attempt(1024)?.status).toBe(429);
    expect(attempt(1024)?.headers.get("Retry-After")).toBe("30");
    expect(attempt(0)?.status).toBe(429);
    now += 29_000;
    expect(attempt(0)?.headers.get("Retry-After")).toBe("1");
    now += 1000;
    expect(attempt(1024)?.status).toBe(401);
    expect(attempt(0)?.status).toBe(401);
  } finally {
    clock.mockRestore();
  }
});

tlsTest("wildcard limits wrong supplied Basic credentials by transport IP, with a nonextending cooldown", async () => {
  const { settings, passwordFile, authorization, webEnv, request } = await tlsFixture();
  const app = await startApp({ ...settings, webEnv: { ...webEnv, OMO_WEB_PASSWORD_FILE: passwordFile } });
  onTestFinished(() => app.stop());
  const wrong = (forwarded: number, localAddress = "127.0.0.1") => request("/api/sessions", { localAddress,
    headers: { Authorization: "Basic b21vOndyb25n", Forwarded: `for=192.0.2.${forwarded}`,
      "X-Forwarded-For": `192.0.2.${forwarded}`, "X-Real-IP": `192.0.2.${forwarded}` } });
  let now = performance.now();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    for (let i = 0; i < 7; i++) {
      const initial = await request("/api/sessions");
      expect(initial.status).toBe(401);
      expect(initial.headers["retry-after"]).toBeUndefined();
    }
    for (let i = 1; i <= 5; i++) expect((await wrong(i)).status).toBe(401);
    const limited = await wrong(6);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("30");
    expect(limited.headers["cache-control"]).toBe("no-store");
    if (process.platform === "linux") expect((await wrong(6, "127.0.0.2")).status).toBe(401);
    const anonymous = await request("/api/sessions");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toMatch(/^Basic realm=/);
    expect(anonymous.headers["retry-after"]).toBeUndefined();
    expect((await request("/api/sessions", { headers: { Authorization: authorization } })).status).toBe(429);
    now += 29_001;
    expect((await wrong(7)).headers["retry-after"]).toBe("1");
    now += 999;
    expect((await request("/api/sessions", { headers: { Authorization: authorization } })).status).toBe(200);
    expect((await wrong(8)).status).toBe(401);
  } finally {
    clock.mockRestore();
  }
});
