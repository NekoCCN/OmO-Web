import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { Engine } from "./engine.ts";
import { actions, openInput, sessionKey, WebError } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import { authorizedRoots, Sessions } from "./sessions.ts";

export type AppSettings = {
  readonly dataDir: string;
  readonly workspaces: readonly string[];
  readonly engineCommand: readonly [string, ...string[]];
  readonly port: number;
};

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

const assets: Readonly<Record<string, string>> = {
  "/": "../public/index.html",
  "/styles.css": "../public/styles.css",
  "/app.js": "../dist/app.js",
  "/favicon.svg": "../public/favicon.svg",
};
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_STREAM_CLIENTS = 16;
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers });
}

async function payload(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.toLowerCase() !== "application/json") {
    throw new WebError(415, "json_required", "需要 application/json 请求体。");
  }
  try { return await request.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WebError(400, "invalid_json", "请求体不是有效 JSON。");
  }
}

export async function startApp(settings: AppSettings) {
  const roots = await authorizedRoots(settings.workspaces);
  const root = roots[0];
  if (!root) throw new WebError(400, "invalid_workspace", "至少需要一个允许的工作目录。");
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const tokenBytes = Buffer.from(secret);
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const disconnect = (client: ReadableStreamDefaultController<Uint8Array>) => {
    if (clients.delete(client)) client.close();
  };
  const frame = (event: WireObject) => encoder.encode(`event: omo\ndata: ${JSON.stringify(event)}\n\n`);
  const publish = (chunk: Uint8Array) => {
    for (const client of clients) {
      if ((client.desiredSize ?? 0) <= 0) disconnect(client);
      else client.enqueue(chunk);
    }
  };
  const fanout = (event: WireObject) => { if (clients.size) publish(frame(event)); };
  const engine = new Engine(settings.engineCommand, root, event => sessions.event(event), status => {
    if (!status.online) sessions.disconnected();
    fanout({ type: "engine", engine: status });
  });
  const sessions = new Sessions(settings.dataDir, roots, engine, fanout);
  await sessions.load();

  const fetch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    try {
      const origin = request.headers.get("Origin");
      if (request.headers.get("Host") !== server.url.host || (origin !== null && origin !== server.url.origin) ||
          ["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "")) {
        throw new WebError(403, "origin_refused", "只接受本机同源请求。");
      }
      if (request.method === "POST") {
        const provided = Buffer.from(request.headers.get("X-OmO-Token") ?? "");
        if (origin !== server.url.origin || provided.length !== tokenBytes.length || !timingSafeEqual(provided, tokenBytes)) {
          throw new WebError(403, "token_refused", "请刷新页面后重试。");
        }
      } else if (request.method !== "GET") {
        throw new WebError(405, "method_refused", "该 HTTP 方法不可用。");
      }

      if (request.method === "GET") {
        const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : undefined;
        if (asset) {
          const file = Bun.file(fileURLToPath(new URL(asset, import.meta.url)));
          if (!(await file.exists())) throw new WebError(404, "missing_asset", "静态资源不存在，请先执行 bun run build。");
          return new Response(file, { headers: { ...headers, "Content-Type": file.type } });
        }
        if (pathname === "/api/bootstrap") {
          try { await engine.probe(); } catch (error) {
            if (!(error instanceof WebError)) throw error;
          }
          return json({ token: secret, engine: engine.status, workspaces: roots, sessions: sessions.list() });
        }
        if (pathname === "/api/sessions") return json({ sessions: sessions.list() });
        if (pathname === "/api/events") {
          if (clients.size >= MAX_STREAM_CLIENTS) throw new WebError(429, "too_many_streams", "打开的页面太多，请关闭部分页面后重试。");
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(client) {
              controller = client;
              clients.add(client);
              client.enqueue(frame({ type: "ready", engine: engine.status }));
            },
            cancel() { if (controller) clients.delete(controller); },
          }, { highWaterMark: 1024 * 1024, size: chunk => chunk?.byteLength ?? 0 });
          request.signal.addEventListener("abort", () => { if (controller) disconnect(controller); }, { once: true });
          return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
        }
      } else if (pathname === "/api/sessions") {
        const { cwd, name } = openInput.parse(await payload(request));
        return json({ session: await sessions.create(cwd, name) }, 201);
      }

      const route = /^\/api\/sessions\/([a-z0-9-]+)(?:\/(options|details|actions))?$/i.exec(pathname);
      if (route) {
        const id = sessionKey.parse(route[1]);
        if (request.method === "POST" && route[2] === "actions") return json(await sessions.action(id, actions.parse(await payload(request))));
        if (request.method === "GET") {
          if (route[2] === "options") return json(await sessions.options(id));
          if (route[2] === "details") return json(await sessions.details(id));
          if (!route[2]) return json(await sessions.snapshot(id));
        }
      }
      throw new WebError(404, "not_found", "找不到这个地址。");
    } catch (error) {
      if (error instanceof WebError) return json({ code: error.code, error: error.message }, error.status);
      if (error instanceof ZodError) return json({ code: "invalid_request", error: "请求参数不正确。" }, 400);
      console.error("OmO Web request failed", error);
      return json({ code: "internal_error", error: "OmO Web 出现错误；请查看本机终端。" }, 500);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: settings.port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    fetch(request, listener) {
      listener.timeout(request, 0);
      return fetch(request);
    },
  });
  const heartbeat = setInterval(() => publish(encoder.encode(": keepalive\n\n")), 15_000);
  let closing: Promise<void> | undefined;
  return {
    url: server.url,
    fetch,
    stop() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        for (const client of clients) disconnect(client);
        await Promise.all([server.stop(true), engine.stop()]);
      })();
      return closing;
    },
  };
}
