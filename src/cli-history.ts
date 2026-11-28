import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebError, record, transcriptMessage } from "./protocol.ts";
import type { WireObject } from "./protocol.ts";
import type { BranchSource } from "./session-branches.ts";
import { WorkspaceAccess } from "./workspace-access.ts";

/**
 * Scan and read budgets. An exact catalog checks only its native bucket and
 * ranks matching recorded cwd headers. Each exact summary samples at most
 * two maxHeaderBytes windows, regardless of journal size. Legacy list() stats
 * every candidate, ranks newest first,
 * then fully parses only what fits: at most maxListFiles files and
 * maxListBytes aggregate content bytes, returning at most maxSessions
 * summaries. Journals above maxFileBytes skip the full parse: list()
 * summarizes them from bounded head/tail windows (first and last
 * maxHeaderBytes, complete JSONL records only) so an oversized named journal
 * stays discoverable, while read() still refuses the full transcript and
 * branch/resume admission keeps its own bounded header checks. Sampling
 * misses renames that land strictly between the two windows; names found in
 * the tail window win over head names, otherwise the workspace cwd is shown.
 * read() returns at most maxMessages messages.
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

type HistoryDirectory = { readonly root: string; readonly workspaceKey?: string };
type FileRef = HistoryDirectory & { readonly path: string };
export type ScopedBranchSource = BranchSource & { readonly workspaceKey?: string };
export type ScopedSummary = CliSessionSummary & { readonly nativeSessionId: string; readonly workspaceKey?: string };

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
  async listWithIds(scope?: HistoryDirectory): Promise<{ readonly available: boolean;
    readonly sessions: readonly ScopedSummary[] }> {
    const scanned = await this.#scan(scope);
    if (!scanned.available) return { available: false, sessions: [] };
    const candidates: { file: FileRef; mtimeMs: number; size: number; sessionId?: string }[] = [];
    for (const file of scanned.files) {
      try {
        const target = await lstat(file.path);
        if (!target.isFile()) continue;
        // Native's flattened bucket name is not injective. In a scoped list,
        // ignore journals for a colliding cwd before ranking or sampling.
        const header = scope === undefined ? undefined : await this.#headerOf(file.path);
        if (scope !== undefined && header?.cwd !== scope.root) continue;
        candidates.push({ file, mtimeMs: target.mtimeMs, size: target.size,
          ...(header === undefined ? {} : { sessionId: header.sessionId }) });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file.path < b.file.path ? -1 : 1));
    const sessions: ScopedSummary[] = [];
    let bytes = 0;
    let parsed = 0;
    const sampleLimit = 2 * CLI_HISTORY_LIMITS.maxHeaderBytes;
    const fullLimit = scope === undefined ? CLI_HISTORY_LIMITS.maxFileBytes : sampleLimit;
    for (const candidate of candidates) {
      if (sessions.length >= CLI_HISTORY_LIMITS.maxSessions ||
        parsed >= CLI_HISTORY_LIMITS.maxListFiles || bytes >= CLI_HISTORY_LIMITS.maxListBytes) break;
      const budget = candidate.size <= fullLimit ? candidate.size : sampleLimit;
      // Reserve scoped bytes and attempts even if the candidate is invalidated
      // during the read. A growing small journal cannot exceed its reservation.
      if (scope !== undefined && budget > CLI_HISTORY_LIMITS.maxListBytes - bytes) continue;
      try {
        if (!await this.#rootMatches(candidate.file)) continue;
        if (scope !== undefined) {
          parsed += 1;
          bytes += budget;
        }
        const summary = candidate.size <= fullLimit
          ? await this.#loadContent(candidate.file.path, scope === undefined ? undefined : budget)
          : await this.#summarizeOversized(candidate.file.path, fullLimit);
        if (scope === undefined) {
          parsed += 1;
          bytes += summary.bytes;
        }
        if (summary.cwd !== candidate.file.root || (candidate.sessionId !== undefined && summary.sessionId !== candidate.sessionId) ||
          !await this.#rootMatches(candidate.file)) continue;
        const { sessionId, cwd, updatedAt } = summary;
        const name = "entries" in summary ? nameOf(summary.entries, cwd) : summary.name;
        sessions.push({ id: sessionId, name, cwd, updatedAt, nativeSessionId: sessionId,
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
    const scanned = await this.#scan(cwd === undefined ? undefined : { root: cwd, workspaceKey });
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
    const scanned = await this.#scan({ root: cwd, workspaceKey });
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

  async #scan(scope?: HistoryDirectory): Promise<{ available: boolean; files: FileRef[] }> {
    if (this.#agentDir === undefined) return { available: false, files: [] };
    const base = join(this.#agentDir, "sessions");
    try {
      if (!(await lstat(base)).isDirectory()) return { available: false, files: [] };
    } catch {
      return { available: false, files: [] };
    }
    const files: FileRef[] = [];
    const roots = await (scope === undefined || !(this.#workspaces instanceof WorkspaceAccess) ? this.#rootsList() : [scope.root]);
    for (const root of roots) {
      if (scope !== undefined && root !== scope.root) continue;
      const workspaceKey = this.#workspaces instanceof WorkspaceAccess ? await this.#workspaces.exact(root) : undefined;
      if ((this.#workspaces instanceof WorkspaceAccess && workspaceKey === undefined) ||
        (scope?.workspaceKey !== undefined && workspaceKey !== scope.workspaceKey)) continue;
      const dir = join(base, sessionDirName(root));
      try {
        if (!(await lstat(dir)).isDirectory()) continue;
        const dirents = await readdir(dir, { withFileTypes: true });
        const names = dirents.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name);
        names.sort();
        for (const name of names.slice(0, CLI_HISTORY_LIMITS.maxFilesPerDir)) {
          files.push({ root, path: join(dir, name), ...(workspaceKey === undefined ? {} : { workspaceKey }) });
        }
      } catch {
        continue;
      }
    }
    return { available: true, files };
  }

  async #headerOf(path: string): Promise<{ sessionId: string; cwd: string } | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const target = await handle.stat();
      if (!target.isFile()) return undefined;
      // A well-formed native header is the first line. Avoid reading a
      // whole prefix while classifying each candidate in an exact catalog.
      const opening = await readAt(handle, 0, Math.min(target.size, 4096));
      const end = opening.indexOf("\n");
      const first = end < 0 ? undefined : parse(opening.slice(0, end)).header;
      const header = first ?? parse(await readPrefix(handle, CLI_HISTORY_LIMITS.maxHeaderBytes)).header;
      if (!header || typeof header.cwd !== "string") return undefined;
      return { sessionId: header.id as string, cwd: header.cwd };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #loadContent(path: string, summaryBudget?: number): Promise<LoadedContent> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const target = await handle.stat();
      if (!target.isFile()) throw invalid();
      if (summaryBudget !== undefined && target.size > summaryBudget) throw tooLarge();
      const { text, bytes } = summaryBudget === undefined
        ? await readText(handle, target.size, CLI_HISTORY_LIMITS.maxFileBytes)
        : { text: await readAt(handle, 0, target.size), bytes: target.size };
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

  /** Bounded summary for a journal above the current list's full-parse limit: header plus newest sampled
   * rename from the first and last maxHeaderBytes windows, complete records
   * only. Never reads the body between the windows and never projects messages.
   * A journal that shrank to the full-parse cap after listing is skipped here
   * and picked up on the next refresh. Sampling misses renames strictly between
   * the windows, falling back to the workspace cwd. The caller charges
   * bytes against list budgets and revalidates cwd and workspace. */
  async #summarizeOversized(path: string, fullLimit: number): Promise<{ readonly sessionId: string;
    readonly cwd: string; readonly name: string; readonly updatedAt: number; readonly bytes: number }> {
    const window = CLI_HISTORY_LIMITS.maxHeaderBytes;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const target = await handle.stat();
      if (!target.isFile() || target.size <= fullLimit) throw invalid();
      const headText = await readAt(handle, 0, window);
      const cut = headText.lastIndexOf("\n");
      if (cut < 0) throw invalid();
      const { header, entries } = parse(headText.slice(0, cut));
      if (!header || typeof header.cwd !== "string") throw invalid();
      const tailLen = Math.min(target.size - window, window);
      const tailText = await readAt(handle, target.size - tailLen, tailLen);
      const first = tailText.indexOf("\n");
      const tailEntries: WireObject[] = [];
      for (const lineText of (first < 0 ? "" : tailText.slice(first + 1)).split("\n")) {
        if (!lineText.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(lineText);
        } catch {
          continue;
        }
        const entry = record(parsed);
        if (typeof entry.id !== "string" || !entry.id || entry.type === "session") continue;
        tailEntries.push(entry);
      }
      return { sessionId: header.id as string, cwd: header.cwd,
        name: nameOf([...entries, ...tailEntries], header.cwd),
        updatedAt: Math.floor(target.mtimeMs), bytes: window + tailLen };
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

async function readAt(handle: FileHandle, offset: number, length: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const scratch = Buffer.allocUnsafe(16384);
  while (total < length) {
    const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, length - total), offset + total);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    total += bytesRead;
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
