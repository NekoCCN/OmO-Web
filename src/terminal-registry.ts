import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const registryName = /^[0-9a-f]{16}$/;
const socketName = /^t-[0-9a-f]{16}\.sock$/;
const MAX_REGISTRY_ENTRIES = 256;
const MAX_SOCKET_PATH_BYTES = 103;
const MAX_REGISTRY_BYTES = 8_192;
const SECRET_BYTES = 32;
const uid = process.getuid?.();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const manifest = z.object({
  layout: z.literal(2), registry_version: z.literal(1), endpoint_kind: z.literal("tui"),
  socket: z.string().min(1).max(MAX_SOCKET_PATH_BYTES), created_at: z.iso.datetime(),
});
const startTime = z.string().min(1).max(128);
const writer = z.object({ pid: z.int().positive(), startTime });
const pointer = z.object({
  layout: z.literal(2), instance_id: z.uuid(), generation_dir: z.string(), writer,
});
const generation = z.object({
  instance_id: z.uuid(), generation: z.literal(0), launchProfileId: z.literal("tui"),
  pid: z.int().positive(), processStartTime: startTime, socket: z.string(), writer,
});

export type TerminalRegistry = {
  readonly profile: string;
  readonly directory: string;
  readonly names: readonly string[];
};

export type TerminalEndpoint = {
  readonly instance: string;
  readonly socket: string;
  readonly stamp: string;
  readonly name: string;
};

async function fileOperation<T>(operation: Promise<T>): Promise<T | undefined> {
  try { return await operation; }
  catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") return undefined;
    throw error;
  }
}

const stat = (path: string) => fileOperation(lstat(path, { bigint: true }));
const inode = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const version = (info: BigIntStats) =>
  `${inode(info)}:${info.uid}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const permissions = (info: BigIntStats) => Number(info.mode & 0o7777n);
const owned = (info: BigIntStats) => uid !== undefined && info.uid === BigInt(uid);

// Reject symlinks and writable ancestors, except a root-owned sticky temp
// directory whose next component belongs to us (e.g. /tmp/agent-XXXX).
async function directoryChain(path: string, privateEnd: boolean): Promise<string | undefined> {
  const chain = [];
  for (let current = path; ; current = dirname(current)) {
    chain.unshift(current);
    if (dirname(current) === current) break;
  }
  const ids = [];
  let beneathSticky = false;
  for (const component of chain) {
    const info = await stat(component);
    if (!info?.isDirectory() || (!owned(info) && info.uid !== 0n) || (beneathSticky && !owned(info))) return;
    const mode = permissions(info);
    beneathSticky = (mode & 0o022) !== 0;
    if (beneathSticky && (info.uid !== 0n || (mode & 0o1000) === 0)) return;
    if (component === path && (!owned(info) || beneathSticky || (privateEnd && mode !== 0o700))) return;
    ids.push(inode(info));
  }
  return ids.join("/");
}

// O_NONBLOCK also prevents hanging if a file becomes a FIFO between lstat
// and open. Check both the opened inode and the name, before using its bytes.
async function protectedFile(path: string, maxBytes: number) {
  const valid = (info: BigIntStats) =>
    info.isFile() && owned(info) && permissions(info) === 0o600 && info.nlink === 1n && info.size <= BigInt(maxBytes);
  const before = await stat(path);
  if (!before || !valid(before)) return;
  const handle = await fileOperation(open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  if (!handle) return;
  try {
    const opened = await fileOperation(handle.stat({ bigint: true }));
    if (!opened || !valid(opened) || version(opened) !== version(before)) return;
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fileOperation(handle.read(bytes, offset, bytes.length - offset, offset));
      if (!read) return;
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await stat(path);
    if (offset !== Number(opened.size) || !after || version(after) !== version(opened)) return;
    return { bytes: bytes.subarray(0, offset), stamp: version(opened) };
  } finally {
    await fileOperation(handle.close());
  }
}

async function registryFile<T>(path: string, schema: z.ZodType<T>) {
  const file = await protectedFile(path, MAX_REGISTRY_BYTES);
  if (!file) return;
  try {
    const value = schema.safeParse(JSON.parse(file.bytes.toString("utf8")));
    if (value.success) return { value: value.data, stamp: `${file.stamp}:${hash(file.bytes)}` };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

export async function discoverTerminalRegistry(agentDir: string | undefined): Promise<TerminalRegistry | undefined> {
  if (!agentDir || uid === undefined || process.platform === "win32") return;
  const profile = resolve(agentDir);
  const directory = join(profile, "rpc-host-daemon");
  if (!(await directoryChain(directory, true)) || !(await directoryChain(profile, false))) return;
  const dir = await fileOperation(opendir(directory));
  if (!dir) return;
  const names = [];
  try {
    for (let count = 0; count <= MAX_REGISTRY_ENTRIES; count++) {
      const entry = await fileOperation(dir.read());
      if (entry === null) return { profile, directory, names };
      if (!entry || count === MAX_REGISTRY_ENTRIES) return;
      if (entry.isDirectory() && registryName.test(entry.name)) names.push(entry.name);
    }
  } finally {
    await fileOperation(dir.close());
  }
}

export async function registeredTerminal(registry: TerminalRegistry, name: string) {
  const dir = join(registry.directory, name);
  const directoryId = await directoryChain(dir, true);
  if (!directoryId || !(await directoryChain(registry.directory, true))) return;
  const endpointFile = await registryFile(join(dir, "endpoint.json"), manifest);
  if (!endpointFile) return;
  const socket = endpointFile.value.socket;
  const filename = basename(socket);
  if (!socketName.test(filename) || hash(socket).slice(0, 16) !== name) return;

  const primary = join(registry.profile, "rpc", "tui", filename);
  if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) {
    if (socket !== primary) return;
  } else {
    const fallbackName = `senpi-rpc-${hash(registry.profile).slice(0, 8)}`;
    const scopedRoot = join(tmpdir(), fallbackName);
    const scoped = join(scopedRoot, "tui", filename);
    const fallback = Buffer.byteLength(scoped) <= MAX_SOCKET_PATH_BYTES ? scopedRoot : join("/tmp", fallbackName);
    if (socket !== join(fallback, "tui", filename) || !(await directoryChain(fallback, true))) return;
  }
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) return;
  const socketDir = dirname(socket);
  const socketDirectoryId = await directoryChain(socketDir, true);
  if (!socketDirectoryId) return;

  const owner = await registryFile(join(dir, "host.pid"), pointer);
  if (!owner) return;
  const instance = owner.value.instance_id;
  if (filename !== `t-${hash(instance).slice(0, 16)}.sock` ||
      owner.value.generation_dir !== `generations/${instance}`) return;
  const generations = join(dir, "generations");
  const generationDir = join(generations, instance);
  const generationDirectoryId = await directoryChain(generationDir, true);
  if (!generationDirectoryId || !(await directoryChain(generations, true))) return;
  const entries = await fileOperation(opendir(generations));
  if (!entries) return;
  try {
    const first = await fileOperation(entries.read());
    if (!first?.isDirectory() || first.name !== instance || await fileOperation(entries.read()) !== null) return;
  } finally {
    await fileOperation(entries.close());
  }
  const current = await registryFile(join(generationDir, "host.pid"), generation);
  if (!current || current.value.instance_id !== instance || current.value.socket !== socket ||
      current.value.pid !== owner.value.writer.pid || current.value.writer.pid !== owner.value.writer.pid ||
      current.value.processStartTime !== owner.value.writer.startTime ||
      current.value.writer.startTime !== owner.value.writer.startTime) return;

  const socketInfo = await stat(socket);
  if (!socketInfo?.isSocket() || !owned(socketInfo) || permissions(socketInfo) !== 0o600 || socketInfo.nlink !== 1n) return;
  const secret = await protectedFile(`${socket}.secret`, SECRET_BYTES);
  if (!secret || secret.bytes.length !== SECRET_BYTES) return;
  const latest = await stat(socket);
  if (!latest || version(latest) !== version(socketInfo)) return;
  const stamp = hash(JSON.stringify([directoryId, socketDirectoryId, generationDirectoryId,
    endpointFile.stamp, owner.stamp, current.stamp, version(socketInfo), secret.stamp, hash(secret.bytes)]));
  const endpoint: TerminalEndpoint = { instance, socket, stamp, name };
  return { endpoint, secret: secret.bytes };
}
