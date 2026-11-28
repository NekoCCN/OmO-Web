import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { z, ZodError } from "zod";
import { selectAttachmentRange } from "./attachment-range.ts";
import { sessionKey, WebError } from "./protocol.ts";
import type { SessionKey } from "./protocol.ts";

const attachmentId = z.uuid().regex(/^[a-f0-9-]+$/u);
const displayControls = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const nameSchema = z.string().min(1).max(255).refine(name => !displayControls.test(name) && !/[:/\\]/u.test(name));
const receiptSchema = z.strictObject({ omoWebAttachment: z.literal(1), id: attachmentId, name: nameSchema,
  size: z.number().int().nonnegative() });
const metadataSchema = z.strictObject({ sessionId: sessionKey, receipt: receiptSchema });
const registrationSchema = z.strictObject({ sessionId: z.string().min(1).max(200), sessionFile: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096) });
type Registration = Readonly<z.infer<typeof registrationSchema>>;
type Receipt = Readonly<z.infer<typeof receiptSchema>>;
export type AttachmentBinding = { readonly id: SessionKey; readonly verify: () => Promise<void> };
type ResolveBinding = (input: Registration) => Promise<AttachmentBinding>;
const refused = () => new WebError(403, "attachment_refused", "无法从此会话发送该文件。");
const missing = () => new WebError(404, "attachment_not_found", "找不到此附件。");
const quotaExceeded = () => new WebError(507, "attachment_quota_exceeded", "附件存储配额不足。");

function privateDirectory(info: Stats): boolean {
  return info.isDirectory() && (process.platform === "win32" ||
    (info.uid === process.getuid?.() && (info.mode & 0o077) === 0));
}

export class AttachmentStore {
  readonly #dataDir: string;
  #directory = "";
  #used = 0n;
  readonly #quota: bigint | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #lock: Database | undefined;
  #identity: { readonly dev: number; readonly ino: number } | undefined;

  constructor(dataDir: string, quotaBytes?: number) {
    this.#dataDir = resolve(dataDir);
    this.#quota = quotaBytes === undefined ? undefined : BigInt(quotaBytes);
  }

  async load(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    // The configured root can be a Windows short path or a mounted alias;
    // the store itself must still be a real, stable private directory.
    this.#directory = join(await realpath(this.#dataDir), "attachments");
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#directory);
    if (!privateDirectory(directory) || await realpath(this.#directory) !== this.#directory) throw refused();
    const lockPath = join(dirname(this.#directory), ".attachments-lock.sqlite");
    const lockFile = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { if (!(await lockFile.stat()).isFile()) throw refused(); } finally { await lockFile.close(); }
    const lock = new Database(lockPath);
    try {
      lock.exec("BEGIN EXCLUSIVE");
      this.#used = 0n;
      for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
        if (!entry.isFile()) throw refused();
        if (this.#quota !== undefined) {
          this.#used += (await lstat(join(this.#directory, entry.name), { bigint: true })).size;
        }
      }
      this.#identity = { dev: directory.dev, ino: directory.ino };
      await this.#verifyDirectory();
      this.#lock = lock;
    } catch (error) {
      lock.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#lock?.close();
    this.#lock = undefined;
    this.#identity = undefined;
  }

  async #verifyDirectory(): Promise<void> {
    if (!this.#identity) throw refused();
    const directory = await lstat(this.#directory);
    if (!privateDirectory(directory) || directory.dev !== this.#identity.dev ||
      directory.ino !== this.#identity.ino || await realpath(this.#directory) !== this.#directory) throw refused();
  }

  register(input: Registration, binding: AttachmentBinding, signal?: AbortSignal): Promise<Receipt> {
    const operation = this.#queue.then(() => this.#copy(input, binding, signal));
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #copy(input: Registration, binding: AttachmentBinding, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    await binding.verify();
    await this.#verifyDirectory();
    if (displayControls.test(input.path) || !nameSchema.safeParse(basename(input.path)).success ||
      (process.platform === "win32" && input.path.replace(/^[a-z]:/iu, "").includes(":"))) throw refused();
    const workspace = resolve(input.cwd);
    const source = resolve(workspace, input.path);
    const local = relative(workspace, source);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ||
      await realpath(workspace) !== workspace || await realpath(source) !== source) throw refused();
    const name = basename(source);
    const before = await lstat(source, { bigint: true });
    if (!before.isFile() || before.nlink > 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw refused();
    const size = Number(before.size);
    const identity = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink &&
      a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
    const id = crypto.randomUUID();
    const receipt: Receipt = { omoWebAttachment: 1, id, name, size };
    const metadata = JSON.stringify({ sessionId: binding.id, receipt });
    const metadataSize = BigInt(Buffer.byteLength(metadata));
    if (this.#quota !== undefined && this.#used + before.size + metadataSize > this.#quota) throw quotaExceeded();
    const stage = join(this.#directory, `${id}.stage`);
    const blob = join(this.#directory, `${id}.blob`);
    const sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let staged = false;
    let reserved = false;
    let attemptedMetadata = false;
    try {
      if (!identity(before, await sourceFile.stat({ bigint: true }))) throw refused();
      const target = await open(stage, "wx", 0o600);
      staged = true;
      this.#used += before.size + metadataSize;
      reserved = true;
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const { bytesRead } = await sourceFile.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (!bytesRead) throw refused();
          await target.writeFile(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        await target.sync();
      } finally {
        await target.close();
      }
      if (!identity(before, await sourceFile.stat({ bigint: true })) ||
        !identity(before, await lstat(source, { bigint: true })) || await realpath(source) !== source) throw refused();
      await binding.verify();
      await this.#verifyDirectory();
      signal?.throwIfAborted();
      await rename(stage, blob);
      staged = false;
      attemptedMetadata = true;
      await writeFile(join(this.#directory, `${id}.json`), metadata, { flag: "wx", mode: 0o600 });
      return receipt;
    } finally {
      await sourceFile.close();
      if (staged) {
        await this.#verifyDirectory();
        await unlink(stage);
        this.#used -= before.size;
      }
      if (reserved && !attemptedMetadata) this.#used -= metadataSize;
    }
  }

  async download(sessionId: SessionKey, id: string, requestHeaders = new Headers()): Promise<Response> {
    await this.#verifyDirectory();
    const parsed = attachmentId.safeParse(id);
    if (!parsed.success) throw missing();
    const path = join(this.#directory, `${parsed.data}.json`);
    let data: unknown;
    try {
      const metadata = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await metadata.stat();
        if (!info.isFile() || info.size > 4096) throw missing();
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await metadata.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw missing();
          offset += bytesRead;
        }
        if ((await metadata.stat()).size !== info.size) throw missing();
        data = JSON.parse(bytes.toString("utf8"));
      } finally {
        await metadata.close();
      }
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) throw missing();
      throw error;
    }
    const meta = metadataSchema.safeParse(data);
    if (!meta.success || meta.data.sessionId !== sessionId || meta.data.receipt.id !== id) throw missing();
    await this.#verifyDirectory();
    const blob = join(this.#directory, `${id}.blob`);
    const file = await open(blob, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw missing();
      throw error;
    });
    const info = await file.stat({ bigint: true }).finally(() => file.close());
    const { name, size } = meta.data.receipt;
    if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(size)) throw missing();
    // A copy is never rewritten. Include its on-disk identity so even a
    // replaced blob cannot make a client splice bytes from two versions.
    const etag = `"${createHash("sha256")
      .update(`${id}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).digest("hex")}"`;
    const range = selectAttachmentRange(requestHeaders, size, etag);
    const headers = new Headers({
      "Accept-Ranges": "bytes", ETag: etag, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    });
    if (range.kind === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const encoded = encodeURIComponent(name).replace(/[!'()*]/gu,
      value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    const end = range.kind === "partial" ? range.end + 1 : size;
    const offset = range.kind === "partial" ? range.start : 0;
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encoded}`);
    headers.set("Content-Length", String(end - offset));
    if (range.kind === "partial") headers.set("Content-Range", `bytes ${offset}-${end - 1}/${size}`);
    if (offset === end) return new Response(null, { headers });
    await this.#verifyDirectory();
    const current = await lstat(blob, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.dev !== info.dev || current.ino !== info.ino ||
      current.size !== info.size || current.mtimeNs !== info.mtimeNs || current.ctimeNs !== info.ctimeNs) throw missing();
    // Bun gives a file-backed Blob a fixed wire length, including TLS. Its
    // async ReadableStream path strips Content-Length in supported Bun builds.
    const body = Bun.file(blob).slice(offset, end);
    return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
  }
}

export async function startSendFile(dataDir: string, resolveBinding: ResolveBinding, quotaBytes?: number) {
  const store = new AttachmentStore(dataDir, quotaBytes);
  await store.load();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const secretBytes = Buffer.from(`Bearer ${secret}`);
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8192,
    async fetch(request, listener) {
      try {
        const auth = Buffer.from(request.headers.get("authorization") ?? "");
        if (request.method !== "POST" || new URL(request.url).pathname !== "/register" ||
          request.headers.get("host") !== listener.url.host || request.headers.has("origin") ||
          request.headers.has("sec-fetch-site") || auth.length !== secretBytes.length || !timingSafeEqual(auth, secretBytes) ||
          request.headers.get("content-type") !== "application/json") throw refused();
        const text = await request.text();
        if (Buffer.byteLength(text) > 8192) throw refused();
        const input = registrationSchema.parse(JSON.parse(text));
        const binding = await resolveBinding(input);
        listener.timeout(request, 0);
        return Response.json(await store.register(input, binding, request.signal), { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (request.signal.aborted) return new Response(null, { status: 408 });
        if (error instanceof WebError && error.code === "attachment_quota_exceeded") {
          return Response.json({ code: error.code }, { status: error.status });
        }
        const expected = error instanceof WebError || error instanceof ZodError || error instanceof SyntaxError ||
          ("code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(String(error.code)));
        if (!expected) console.error("OmO Web attachment registration failed", error);
        return Response.json({ error: "File registration refused" }, { status: expected ? 403 : 500 });
      }
    },
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  return { store, url: new URL("/register", server.url).href, secret, async stop() {
    await server.stop(true);
    await store.close();
  } };
}
