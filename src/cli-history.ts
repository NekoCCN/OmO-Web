import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebError, record, transcriptMessage } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import type { BranchSource } from "./session-branches.ts";
import { WorkspaceAccess } from "./workspace-access.ts";

/**
 * Scan and read budgets. list() stats every candidate, ranks newest first,
 * then fully parses only what fits: at most maxListFiles files and
 * maxListBytes aggregate content bytes, returning at most maxSessions
 * summaries. Single files above maxFileBytes are skipped by list() and
 * rejected by read(). read() returns at most maxMessages messages.
 */
export const CLI_HISTORY_LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxFilesPerDir: 2000,
  maxListFiles: 200,
  maxListBytes: 32 * 1024 * 1024,
  maxSessions: 500,
  maxMessages: 1000,
  maxHeaderBytes: 131_072,
} as const;

export type CliSessionSummary = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly updatedAt: number;
};

export type CliHistoryList = {
  readonly available: boolean;
  readonly sessions: readonly CliSessionSummary[];
};

export type CliSessionDetail = {
  readonly session: CliSessionSummary;
  readonly messages: readonly WireObject[];
  /** Server-only identity for workspace DAG matching. Never send to the browser. */
  readonly internal: { readonly nativeSessionId: string };
};

type FileRef = { readonly root: string; readonly dir: string; readonly path: string; readonly workspaceKey?: string };
export type ScopedBranchSource = BranchSource & { readonly workspaceKey?: string };
type ScopedSummary = CliSessionSummary & { readonly nativeSessionId: string; readonly workspaceKey?: string };

type LoadedContent = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly bytes: number;
  readonly entries: readonly WireObject[];
};

/**
 * Read-only view over native OmO CLI transcripts.
 *
 * Integrator notes: Main passes the resolved agent dir, or undefined when the
 * feature is off; undefined disables the reader (available:false, every read
 * rejected) and Main may skip instantiating it entirely. Pass
 * already-canonical workspace roots (the same roots given to Sessions).
 * Public session ids are the native header session ids, never file paths:
 * they are only matched against parsed headers, never used to touch the file
 * system. read() additionally returns internal.nativeSessionId, the durable
 * native session identity for workspace DAG matching; depend on that field,
 * not on the public id encoding, and never serialize it to the browser. The
 * reader is offline: it never contacts the engine and never touches the Web
 * data dir. Only <agentDir>/sessions/--<normalized cwd>-- directories of the
 * configured workspaces are scanned, newest first by file mtime; updatedAt is
 * that mtime. Raw history on the latest active branch is shown (compaction
 * summaries are not substituted), context edits are applied, and visible
 * messages go through the same transcriptMessage projection as Web snapshots.
 */
export type OwnedJournalHeader = { readonly sessionId: string; readonly cwd: string; readonly version: unknown };

/** Bounded canonical header read for an owned regular native journal: O_NOFOLLOW,
 * single-link, owner-only, descriptor-resolved, first 128 KiB only. Never parses the body,
 * so ordinary resume pays no full-transcript budget. Returns undefined when the file
 * cannot be proven to be the authorized journal (missing, link, foreign owner, oversized
 * header, or unparsable first line). */
export async function readOwnedJournalHeader(path: string): Promise<OwnedJournalHeader | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const target = await handle.stat();
    if (!target.isFile() || target.nlink !== 1 || (process.getuid && target.uid !== process.getuid()) ||
      (process.platform === "linux" && await realpath(`/proc/self/fd/${handle.fd}`) !== path)) return undefined;
    const { header } = parse(await readPrefix(handle, CLI_HISTORY_LIMITS.maxHeaderBytes));
    if (!header || typeof header.cwd !== "string") return undefined;
    return { sessionId: header.id as string, cwd: header.cwd, version: header.version };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class CliHistory {
  readonly #agentDir: string | undefined;
  readonly #workspaces: readonly string[] | WorkspaceAccess;
  #roots: Promise<readonly string[]> | undefined;

  constructor(agentDir: string | undefined, workspaces: readonly string[] | WorkspaceAccess) {
    this.#agentDir = agentDir === undefined ? undefined : resolve(agentDir);
    this.#workspaces = workspaces instanceof WorkspaceAccess ? workspaces : [...workspaces];
  }

  async list(): Promise<CliHistoryList> {
    const detailed = await this.listWithIds();
    if (!detailed.available) return { available: false, sessions: [] };
    return { available: true,
      sessions: detailed.sessions.map(({ id, name, cwd, updatedAt }) => ({ id, name, cwd, updatedAt })) };
  }

  /** Server-only list carrying the durable native id per row for alias coalescing.
   * Never serialize nativeSessionId to the browser; the public list stays opaque. */
  async listWithIds(): Promise<{ readonly available: boolean;
    readonly sessions: readonly ScopedSummary[] }> {
    const scanned = await this.#scan();
    if (!scanned.available) return { available: false, sessions: [] };
    const candidates: { file: FileRef; mtimeMs: number; size: number }[] = [];
    for (const file of scanned.files) {
      try {
        const target = await lstat(file.path);
        if (!target.isFile()) continue;
        candidates.push({ file, mtimeMs: target.mtimeMs, size: target.size });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file.path < b.file.path ? -1 : 1));
    const sessions: ScopedSummary[] = [];
    let bytes = 0;
    let parsed = 0;
    for (const candidate of candidates) {
      if (sessions.length >= CLI_HISTORY_LIMITS.maxSessions ||
        parsed >= CLI_HISTORY_LIMITS.maxListFiles || bytes >= CLI_HISTORY_LIMITS.maxListBytes) break;
      if (candidate.size > CLI_HISTORY_LIMITS.maxFileBytes) continue;
      try {
        if (!await this.#rootMatches(candidate.file)) continue;
        const loaded = await this.#loadContent(candidate.file.path);
        parsed += 1;
        bytes += loaded.bytes;
        if (loaded.cwd !== candidate.file.root || !await this.#rootMatches(candidate.file)) continue;
        sessions.push({ id: loaded.sessionId, name: nameOf(loaded.entries, loaded.cwd),
          cwd: loaded.cwd, updatedAt: loaded.updatedAt, nativeSessionId: loaded.sessionId,
          ...(candidate.file.workspaceKey === undefined ? {} : { workspaceKey: candidate.file.workspaceKey }) });
      } catch {
        continue;
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { available: true, sessions: sessions.slice(0, CLI_HISTORY_LIMITS.maxSessions) };
  }

  async read(id: string, cwd?: string, workspaceKey?: string): Promise<CliSessionDetail> {
    checkId(id);
    const scanned = await this.#scan();
    if (!scanned.available) throw unavailable();
    for (const file of scanned.files) {
      if ((cwd !== undefined && cwd !== file.root) ||
          (workspaceKey !== undefined && workspaceKey !== file.workspaceKey) || !await this.#rootMatches(file)) continue;
      const header = await this.#headerOf(file.path);
      if (!header || header.sessionId !== id || header.cwd !== file.root) continue;
      if (!await this.#rootMatches(file)) throw notFound();
      const loaded = await this.#loadContent(file.path);
      if (loaded.cwd !== file.root || loaded.sessionId !== id) throw invalid();
      if (!await this.#rootMatches(file)) throw notFound();
      const session = { id: loaded.sessionId, name: nameOf(loaded.entries, loaded.cwd),
        cwd: loaded.cwd, updatedAt: loaded.updatedAt };
      return { session, messages: project(loaded.entries), internal: { nativeSessionId: loaded.sessionId } };
    }
    throw notFound();
  }

  /** Server-only branch source. Resolve the previously authorized history id AND cwd,
   * not any candidate path supplied by a client. Sessions revalidates the file on its own descriptor. */
  async branchSource(id: string, cwd: string, expectedKey?: string): Promise<ScopedBranchSource> {
    checkId(id);
    const policy = this.#workspaces;
    const workspaceKey = policy instanceof WorkspaceAccess ? await policy.exact(cwd) : undefined;
    if (policy instanceof WorkspaceAccess ? workspaceKey === undefined ||
      (expectedKey !== undefined && workspaceKey !== expectedKey) :
      !policy.includes(cwd) || await realpath(cwd).catch(() => undefined) !== cwd) throw notFound();
    const scanned = await this.#scan();
    if (!scanned.available) throw unavailable();
    let sourcePath: string | undefined;
    for (const file of scanned.files) {
      if (file.root !== cwd || file.workspaceKey !== workspaceKey ||
        await realpath(file.path).catch(() => undefined) !== file.path || !await this.#rootMatches(file)) continue;
      const header = await readOwnedJournalHeader(file.path);
      if (!header || header.sessionId !== id || header.cwd !== cwd || header.version !== 3) continue;
      if (sourcePath !== undefined) throw new WebError(409, "branch_stale", "CLI 会话身份不唯一，请刷新列表。");
      sourcePath = file.path;
    }
    if (!sourcePath || (policy instanceof WorkspaceAccess && await policy.exact(cwd) !== workspaceKey)) throw notFound();
    return { cwd, nativeSessionId: id, sourcePath, ...(workspaceKey === undefined ? {} : { workspaceKey }) };
  }

  async #rootsList(): Promise<readonly string[]> {
    const policy = this.#workspaces;
    if (policy instanceof WorkspaceAccess) return policy.paths();
    this.#roots ??= (async () => {
      const canonical: string[] = [];
      for (const root of policy) {
        try {
          const target = await realpath(root);
          if ((await lstat(target)).isDirectory() && !canonical.includes(target)) canonical.push(target);
        } catch {
          continue;
        }
      }
      return canonical;
    })();
    return this.#roots;
  }

  async #rootMatches(file: FileRef): Promise<boolean> {
    return !(this.#workspaces instanceof WorkspaceAccess) ||
      (file.workspaceKey !== undefined && await this.#workspaces.exact(file.root) === file.workspaceKey);
  }

  async #scan(): Promise<{ available: boolean; files: FileRef[] }> {
    if (this.#agentDir === undefined) return { available: false, files: [] };
    const base = join(this.#agentDir, "sessions");
    try {
      if (!(await lstat(base)).isDirectory()) return { available: false, files: [] };
    } catch {
      return { available: false, files: [] };
    }
    const files: FileRef[] = [];
    for (const root of await this.#rootsList()) {
      const workspaceKey = this.#workspaces instanceof WorkspaceAccess ? await this.#workspaces.exact(root) : undefined;
      if (this.#workspaces instanceof WorkspaceAccess && workspaceKey === undefined) continue;
      const dir = join(base, sessionDirName(root));
      try {
        if (!(await lstat(dir)).isDirectory()) continue;
        const dirents = await readdir(dir, { withFileTypes: true });
        const names = dirents.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name);
        names.sort();
        for (const name of names.slice(0, CLI_HISTORY_LIMITS.maxFilesPerDir)) {
          files.push({ root, dir, path: join(dir, name), ...(workspaceKey === undefined ? {} : { workspaceKey }) });
        }
      } catch {
        continue;
      }
    }
    return { available: true, files };
  }

  async #headerOf(path: string, branch = false): Promise<{ sessionId: string; cwd: string; version: unknown } | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const target = await handle.stat();
      if (!target.isFile() || (branch && (target.nlink !== 1 || (process.getuid && target.uid !== process.getuid()) ||
        (process.platform === "linux" && await realpath(`/proc/self/fd/${handle.fd}`) !== path)))) return undefined;
      const { header } = parse(await readPrefix(handle, CLI_HISTORY_LIMITS.maxHeaderBytes));
      if (!header || typeof header.cwd !== "string") return undefined;
      return { sessionId: header.id as string, cwd: header.cwd, version: header.version };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #loadContent(path: string): Promise<LoadedContent> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const target = await handle.stat();
      if (!target.isFile()) throw invalid();
      const { text, bytes } = await readText(handle, target.size, CLI_HISTORY_LIMITS.maxFileBytes);
      const { header, entries } = parse(text);
      if (!header || typeof header.cwd !== "string") throw invalid();
      return { sessionId: header.id as string, cwd: header.cwd, updatedAt: Math.floor(target.mtimeMs), bytes, entries };
    } catch (error) {
      if (error instanceof WebError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === "ELOOP") throw invalid();
      throw notFound();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

/** Native per-cwd journal bucket under `<profile>/sessions`. Shared by discovery and
 * shared-store placement verification: both sides must resolve the identical directory. */
export function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[/\\\0]/.test(value);
}

function checkId(id: string): void {
  if (!validId(id)) throw new WebError(400, "history_invalid", "CLI 历史 ID 不正确。");
}

function unavailable(): WebError {
  return new WebError(503, "history_unavailable", "CLI 历史不可用：未配置本机 OmO 会话目录。");
}

function notFound(): WebError {
  return new WebError(404, "history_not_found", "找不到这条 CLI 历史记录。");
}

function invalid(): WebError {
  return new WebError(400, "history_invalid", "这条 CLI 历史记录已损坏，无法读取。");
}

function tooLarge(): WebError {
  return new WebError(400, "history_too_large", "这条 CLI 历史记录过大，无法读取。");
}

async function readText(handle: FileHandle, size: number, cap: number): Promise<{ text: string; bytes: number }> {
  if (size > cap) throw tooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  const scratch = Buffer.allocUnsafe(65536);
  for (;;) {
    const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > cap) throw tooLarge();
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

async function readPrefix(handle: FileHandle, cap: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const scratch = Buffer.allocUnsafe(16384);
  for (;;) {
    const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, cap - total), null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    total += bytesRead;
    if (total >= cap) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parse(text: string): { header: WireObject | undefined; entries: WireObject[] } {
  let header: WireObject | undefined;
  const entries: WireObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record(parsed);
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (!header) {
      if (entry.type !== "session") return { header: undefined, entries: [] };
      if (!validId(entry.id) || typeof entry.cwd !== "string" || !entry.cwd) {
        return { header: undefined, entries: [] };
      }
      header = entry;
      continue;
    }
    if (entry.type === "session") continue;
    entries.push(entry);
  }
  return { header, entries };
}

function nameOf(entries: readonly WireObject[], cwd: string): string {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name.trim() || undefined;
  }
  return name ?? cwd;
}

function project(entries: readonly WireObject[]): readonly WireObject[] {
  const byId = new Map<string, WireObject>();
  for (const entry of entries) byId.set(entry.id as string, entry);
  const path: WireObject[] = [];
  const seen = new Set<WireObject>();
  let current = entries.length ? byId.get(entries[entries.length - 1].id as string) : undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    const parent = current.parentId;
    current = typeof parent === "string" && parent ? byId.get(parent) : undefined;
  }
  path.reverse();
  const edits = new Map<string, unknown>();
  for (const entry of path) {
    if (entry.type === "context_edit" && typeof entry.targetId === "string") edits.set(entry.targetId, entry.replacement ?? null);
  }
  const messages: WireObject[] = [];
  for (const entry of path) {
    if (entry.type !== "message") continue;
    const base = record(entry.message);
    if (edits.has(entry.id as string)) {
      const replacement = edits.get(entry.id as string);
      if (replacement === null || replacement === undefined) continue;
      const content = typeof replacement === "string" &&
        (base.role === "assistant" || base.role === "toolResult")
        ? [{ type: "text", text: replacement }]
        : replacement;
      const visible = transcriptMessage({ ...base, content });
      if (visible) messages.push(visible);
      continue;
    }
    const visible = transcriptMessage(entry.message);
    if (visible) messages.push(visible);
  }
  return messages.slice(-CLI_HISTORY_LIMITS.maxMessages);
}
