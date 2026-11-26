import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { z } from "zod";
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

class WebAccessConfigError extends Error {
  readonly name = "WebAccessConfigError";
  constructor(readonly setting: `OMO_WEB_${string}`, reason: string) {
    super(`${setting}: ${reason}`);
  }
}

const hostSchema = z.enum(["127.0.0.1", "0.0.0.0"]);
const passwordSchema = z.string().regex(/^[\x20-\x7e]{20,128}$/);

async function fileBytes(path: string, setting: FileSetting): Promise<Buffer> {
  const password = setting === "OMO_WEB_PASSWORD_FILE";
  const limit = password ? 130 : 1024 * 1024;
  try {
    // Open the configured target once. A FIFO must not block startup.
    await using file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (password && (stat.mode & 0o077) !== 0)) {
      throw new WebAccessConfigError(setting, password ? "需要仅属主可访问的常规文件（例如 0600）。" : "需要常规文件。");
    }
    if (stat.size > limit) throw new WebAccessConfigError(setting, "文件过大。");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) return bytes.subarray(0, length);
      length += bytesRead;
    }
    throw new WebAccessConfigError(setting, "文件过大。");
  } catch (error) {
    if (error instanceof WebAccessConfigError || !(error instanceof Error)) throw error;
    throw new WebAccessConfigError(setting, "无法读取配置文件。");
  }
}

export async function loadWebAccess(env: Readonly<NodeJS.ProcessEnv>, port: number) {
  const host = hostSchema.safeParse(env.OMO_WEB_HOST ?? "127.0.0.1");
  if (!host.success) throw new WebAccessConfigError("OMO_WEB_HOST", "只允许 127.0.0.1 或 0.0.0.0。");
  const { OMO_WEB_PASSWORD_FILE: passwordFile, OMO_WEB_ORIGIN: originSetting,
    OMO_WEB_TLS_CERT: certFile, OMO_WEB_TLS_KEY: keyFile } = env;
  const publicBinding = host.data === "0.0.0.0";
  if (process.platform === "win32" && (publicBinding || passwordFile !== undefined)) {
    throw new WebAccessConfigError("OMO_WEB_PASSWORD_FILE", "密码保护和 0.0.0.0 监听仅支持 POSIX；Windows 无法用文件模式位验证私有 ACL。请使用默认的 127.0.0.1 免密监听。");
  }
  if (publicBinding && !passwordFile) throw new WebAccessConfigError("OMO_WEB_PASSWORD_FILE", "公开监听必须配置密码文件。");

  let origin: string | undefined;
  let tls: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  if (publicBinding || originSetting !== undefined || certFile !== undefined || keyFile !== undefined) {
    if (port === 0) throw new WebAccessConfigError("OMO_WEB_PORT", "HTTPS 监听需要固定的非零端口。");
    const url = originSetting === undefined ? null : URL.parse(originSetting);
    if (!url || url.protocol !== "https:" || originSetting !== url.origin || Number(url.port || 443) !== port) {
      throw new WebAccessConfigError("OMO_WEB_ORIGIN", "需要与监听端口一致的规范 HTTPS origin（无路径、尾部斜杠或凭据）。");
    }
    if (!certFile) throw new WebAccessConfigError("OMO_WEB_TLS_CERT", "HTTPS 监听需要 PEM 证书。");
    if (!keyFile) throw new WebAccessConfigError("OMO_WEB_TLS_KEY", "HTTPS 监听需要 PEM 私钥。");
    const [cert, key] = await Promise.all([fileBytes(certFile, "OMO_WEB_TLS_CERT"), fileBytes(keyFile, "OMO_WEB_TLS_KEY")]);
    try { createSecureContext({ cert, key }); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new WebAccessConfigError("OMO_WEB_TLS_CERT / OMO_WEB_TLS_KEY", "需要格式有效、互相匹配的 PEM 证书和未加密私钥。");
    }
    tls = { cert, key };
    origin = url.origin;
  }

  let digest: Buffer | undefined;
  if (passwordFile !== undefined) {
    const bytes = await fileBytes(passwordFile, "OMO_WEB_PASSWORD_FILE");
    const password = passwordSchema.safeParse(bytes.toString("latin1").replace(/(?:\r\n|\n|\r)$/, ""));
    if (!password.success) {
      throw new WebAccessConfigError("OMO_WEB_PASSWORD_FILE", "密码必须是 20–128 个可打印 ASCII 字符，只允许单个末尾换行。");
    }
    const credentials = Buffer.from(`omo:${password.data}`).toString("base64");
    digest = createHash("sha256").update(credentials).digest();
  }

  return {
    hostname: host.data, origin, tls,
    authorize(request: Request, expected: URL, token: Buffer): Response | undefined {
      const requestOrigin = request.headers.get("Origin");
      if (request.headers.get("Host") !== expected.host || (requestOrigin !== null && requestOrigin !== expected.origin) ||
          ["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "")) {
        throw new WebError(403, "origin_refused", "只接受同源请求。");
      }
      if (digest) {
        // Match only bounded Basic syntax, then compare two fixed-length digests.
        const auth = request.headers.get("Authorization") ?? "";
        const encoded = auth.length <= 182 ? /^Basic ([A-Za-z0-9+/]{30,176}={0,2})$/i.exec(auth)?.[1] : undefined;
        if (!encoded || !timingSafeEqual(createHash("sha256").update(encoded).digest(), digest)) {
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
