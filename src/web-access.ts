import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { z } from "zod";
import { cliTr } from "../packaging/npm/locale.js";
import { readWindowsPasswordFile } from "../packaging/npm/windows-password.js";
import { WebError } from "./protocol.ts";

export const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

type FileSetting = "OMO_WEB_PASSWORD_FILE" | "OMO_WEB_TLS_CERT" | "OMO_WEB_TLS_KEY";

export class WebAccessConfigError extends Error {
  readonly name = "WebAccessConfigError";
  constructor(readonly setting: `OMO_WEB_${string}`, reason: string) {
    super(`${setting}: ${reason}`);
  }
}

const hostSchema = z.enum(["127.0.0.1", "0.0.0.0"]);
const passwordSchema = z.string().regex(/^[\x20-\x7e]{20,128}$/);
const MAX_AUTH_FAILURES = 5;
const MAX_TRACKED_ADDRESSES = 1024;
const AUTH_COOLDOWN_MS = 30_000;

function authFailureLimiter() {
  const attempts = new Map<string, { count: number; until: number }>();
  function check(address: string): number | undefined {
    const now = Math.floor(performance.now());
    // Entries are ordered by expiry. At capacity, don't evict an active
    // cooldown just because a different source is attempting credentials.
    for (const [ip, attempt] of attempts) {
      if (attempt.until > now) break;
      attempts.delete(ip);
    }
    const attempt = attempts.get(address);
    if (attempt && attempt.count >= MAX_AUTH_FAILURES) return Math.ceil((attempt.until - now) / 1000);
    if (!attempt && attempts.size >= MAX_TRACKED_ADDRESSES) {
      const earliest = attempts.values().next().value;
      if (earliest) return Math.ceil((earliest.until - now) / 1000);
    }
  }
  return {
    check,
    record(address: string) {
      const attempt = attempts.get(address);
      if (!attempt) attempts.set(address, { count: 1, until: Math.floor(performance.now()) + AUTH_COOLDOWN_MS });
      else if (++attempt.count === MAX_AUTH_FAILURES) {
        attempt.until = Math.floor(performance.now()) + AUTH_COOLDOWN_MS;
        attempts.delete(address);
        attempts.set(address, attempt);
      }
    },
  };
}

async function fileBytes(path: string, setting: FileSetting): Promise<Buffer> {
  const password = setting === "OMO_WEB_PASSWORD_FILE";
  const limit = password ? 130 : 1024 * 1024;
  const useWindowsACL = password && process.platform === "win32";
  try {
    if (useWindowsACL) return await readWindowsPasswordFile(path);
    // Open the configured target once. A FIFO must not block startup.
    await using file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (password && (stat.mode & 0o077) !== 0)) {
      throw new WebAccessConfigError(setting, password
        ? cliTr("需要仅属主可访问的常规文件（例如 0600）。", "Use a regular file accessible only to its owner (for example, mode 0600).")
        : cliTr("需要常规文件。", "Use a regular file."));
    }
    const tooLarge = cliTr("文件过大。", "File is too large.");
    if (stat.size > limit) throw new WebAccessConfigError(setting, tooLarge);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) return bytes.subarray(0, length);
      length += bytesRead;
    }
    throw new WebAccessConfigError(setting, tooLarge);
  } catch (error) {
    if (error instanceof WebAccessConfigError || !(error instanceof Error)) throw error;
    throw new WebAccessConfigError(setting, useWindowsACL
      ? cliTr("无法读取密码文件或确认其 Windows ACL 为私有。", "Could not read the password file or verify its private Windows ACL.")
      : cliTr("无法读取配置文件。", "Could not read the configured file."));
  }
}

function validateCertificate(cert: Buffer, key: Buffer, origin: URL): void {
  let leaf: X509Certificate;
  try {
    createSecureContext({ cert, key });
    leaf = new X509Certificate(cert);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new WebAccessConfigError("OMO_WEB_TLS_CERT / OMO_WEB_TLS_KEY", cliTr(
      "需要格式有效、互相匹配的 PEM 证书和未加密私钥。",
      "Use a valid PEM certificate and a matching, unencrypted PEM private key."));
  }
  const now = Date.now();
  if (!(Date.parse(leaf.validFrom) <= now && now <= Date.parse(leaf.validTo))) {
    throw new WebAccessConfigError("OMO_WEB_TLS_CERT", cliTr(
      "证书已过期或尚未生效。", "The certificate is expired or not yet valid."));
  }
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  // Browsers require a SAN rather than falling back to the subject Common Name.
  const matches = isIP(hostname) ? leaf.checkIP(hostname)
    : leaf.checkHost(hostname, { subject: "never", partialWildcards: false });
  if (matches === undefined) {
    throw new WebAccessConfigError("OMO_WEB_TLS_CERT", cliTr(
      "证书的主题备用名称必须与 OMO_WEB_ORIGIN 中的主机名或 IP 地址匹配。",
      "A certificate subject alternative name must match the hostname or IP address in OMO_WEB_ORIGIN."));
  }
}

export async function loadWebAccess(env: Readonly<NodeJS.ProcessEnv>, port: number) {
  const host = hostSchema.safeParse(env.OMO_WEB_HOST ?? "127.0.0.1");
  if (!host.success) throw new WebAccessConfigError("OMO_WEB_HOST", cliTr(
    "只允许 127.0.0.1 或 0.0.0.0。", "Only 127.0.0.1 or 0.0.0.0 is allowed."));
  const { OMO_WEB_PASSWORD_FILE: passwordFile, OMO_WEB_ORIGIN: originSetting,
    OMO_WEB_TLS_CERT: certFile, OMO_WEB_TLS_KEY: keyFile } = env;
  const publicBinding = host.data === "0.0.0.0";
  const unprotected = publicBinding && passwordFile === undefined;
  if (unprotected && env.OMO_WEB_ALLOW_UNAUTHENTICATED !== "1") {
    throw new WebAccessConfigError("OMO_WEB_PASSWORD_FILE", cliTr(
      "全接口监听必须配置密码文件，或显式设置 OMO_WEB_ALLOW_UNAUTHENTICATED=1。",
      "Listening on all interfaces requires a password file or explicit OMO_WEB_ALLOW_UNAUTHENTICATED=1."));
  }

  let origin: string | undefined;
  let tls: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  if (publicBinding || originSetting !== undefined || certFile !== undefined || keyFile !== undefined) {
    if (port === 0) throw new WebAccessConfigError("OMO_WEB_PORT", cliTr(
      "HTTPS 监听需要固定的非零端口。", "HTTPS requires a fixed, nonzero port."));
    const url = originSetting === undefined ? null : URL.parse(originSetting);
    if (!url || url.protocol !== "https:" || originSetting !== url.origin || Number(url.port || 443) !== port) {
      throw new WebAccessConfigError("OMO_WEB_ORIGIN", cliTr(
        "需要与监听端口一致的规范 HTTPS origin（无路径、尾部斜杠或凭据）。",
        "Use a canonical HTTPS origin matching the listen port, without a path, trailing slash, or credentials."));
    }
    if (!certFile) throw new WebAccessConfigError("OMO_WEB_TLS_CERT", cliTr(
      "HTTPS 监听需要 PEM 证书。", "HTTPS requires a PEM certificate."));
    if (!keyFile) throw new WebAccessConfigError("OMO_WEB_TLS_KEY", cliTr(
      "HTTPS 监听需要 PEM 私钥。", "HTTPS requires a PEM private key."));
    const [cert, key] = await Promise.all([fileBytes(certFile, "OMO_WEB_TLS_CERT"), fileBytes(keyFile, "OMO_WEB_TLS_KEY")]);
    validateCertificate(cert, key, url);
    tls = { cert, key };
    origin = url.origin;
  }

  let digest: Buffer | undefined;
  if (passwordFile !== undefined) {
    const bytes = await fileBytes(passwordFile, "OMO_WEB_PASSWORD_FILE");
    const password = passwordSchema.safeParse(bytes.toString("latin1").replace(/(?:\r\n|\n|\r)$/, ""));
    if (!password.success) {
      throw new WebAccessConfigError("OMO_WEB_PASSWORD_FILE", cliTr(
        "密码必须是 20–128 个可打印 ASCII 字符，只允许单个末尾换行。",
        "The password must be 20–128 printable ASCII characters with at most one trailing line ending."));
    }
    const credentials = Buffer.from(`omo:${password.data}`).toString("base64");
    digest = createHash("sha256").update(credentials).digest();
  }
  const limiter = publicBinding && digest ? authFailureLimiter() : undefined;

  return {
    hostname: host.data, origin, tls, unprotected,
    authorize(request: Request, expected: URL, token: Buffer, address?: string): Response | undefined {
      const requestOrigin = request.headers.get("Origin");
      if (request.headers.get("Host") !== expected.host || (requestOrigin !== null && requestOrigin !== expected.origin) ||
          ["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "")) {
        throw new WebError(403, "origin_refused", "只接受同源请求。");
      }
      if (digest) {
        const auth = request.headers.get("Authorization");
        const encoded = auth && auth.length <= 182 ? /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(auth)?.[1] : undefined;
        // Initial browser challenges don't count; check an active hold before
        // comparing any submitted password.
        const source = address && encoded && Buffer.from(encoded, "base64").includes(0x3a) ? address : undefined;
        const retryAfter = source ? limiter?.check(source) : undefined;
        if (retryAfter !== undefined) {
          return new Response(null, { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } });
        }
        // Only plausible encodings reach the fixed-length digest comparison.
        if (!encoded || encoded.length < 30 || encoded.length > 178 ||
            !timingSafeEqual(createHash("sha256").update(encoded).digest(), digest)) {
          if (source) limiter?.record(source);
          return new Response(null, { status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="OmO Web"' } });
        }
      }
      if (request.method === "POST") {
        const provided = request.headers.get("X-OmO-Token") ?? "";
        const bytes = provided.length === token.length ? Buffer.from(provided) : undefined;
        if (requestOrigin !== expected.origin || bytes?.length !== token.length || !timingSafeEqual(bytes, token)) {
          throw new WebError(403, "token_refused", "请刷新页面后重试。");
        }
      } else if (request.method !== "GET") {
        throw new WebError(405, "method_refused", "该 HTTP 方法不可用。");
      }
      return undefined;
    },
  };
}
