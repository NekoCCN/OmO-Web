import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { WebError } from "./protocol.ts";

export const workspacePlatform = process.platform === "win32" ? "win32" : "posix";
const MAX_ENTRIES = 256;
const MAX_CONFIRMATIONS = 256;
const CONFIRMATION_MS = 120_000;
// Include Unicode format controls (including bidi overrides and isolates) and line separators.
const displayControls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const deviceName = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

function validWindowsPart(part: string): boolean {
  return !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
    !deviceName.test(part.split(".", 1)[0]?.trimEnd() ?? "");
}

function nativePath(input: string): string | undefined {
  if (displayControls.test(input)) return undefined;
  if (workspacePlatform === "win32") {
    if (!/^[a-z]:[/\\]/i.test(input)) return undefined;
    if (input.slice(3).split(/[/\\]/).some(part => part && part !== "." && part !== ".." && !validWindowsPart(part))) {
      return undefined;
    }
  } else if (!isAbsolute(input)) {
    return undefined;
  }
  return resolve(input);
}

function samePath(a: string, b: string): boolean {
  if (workspacePlatform === "win32") {
    return a[0]?.toUpperCase() === b[0]?.toUpperCase() && a.slice(1) === b.slice(1);
  }
  return a === b;
}

function contains(root: string, path: string, allowWindowsCase = false): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (allowWindowsCase && workspacePlatform === "win32") {
    return root.toLowerCase() === path.toLowerCase() || path.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return samePath(root, path) || samePath(prefix, path.slice(0, prefix.length));
}

function directoryKey(stat: BigIntStats): string | undefined {
  const { dev, ino, birthtimeNs } = stat;
  return stat.isDirectory() && typeof dev === "bigint" && typeof ino === "bigint" && ino !== 0n &&
    typeof birthtimeNs === "bigint" ? `${dev}:${ino}:${birthtimeNs}` : undefined;
}

async function windowsCaseOnly(path: string, canonical: string): Promise<boolean> {
  if (path.toLowerCase() !== canonical.toLowerCase()) return false;
  const parts = canonical.slice(3).split("\\");
  let prefix = path.slice(0, 3);
  for (const [index, part] of path.slice(3).split("\\").entries()) {
    prefix = join(prefix, part);
    // A same-fold alias in a Windows case-sensitive directory can also be a junction.
    if (part !== parts[index] && !(await lstat(prefix)).isDirectory()) return false;
  }
  return true;
}

async function canonicalDirectory(path: string, allowWindowsCase = false) {
  try {
    const before = directoryKey(await lstat(path, { bigint: true }));
    if (before === undefined) return undefined;
    const canonical = nativePath(await realpath(path));
    if (!canonical) return undefined;
    if (!samePath(canonical, path)) {
      if (!allowWindowsCase || workspacePlatform !== "win32" || !await windowsCaseOnly(path, canonical) ||
          directoryKey(await lstat(canonical, { bigint: true })) !== before) return undefined;
    }
    if (directoryKey(await lstat(path, { bigint: true })) !== before) return undefined;
    return { path: canonical, key: before };
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}

const invalidPath = () => new WebError(400, "invalid_workspace", "请选择有效的本机绝对目录路径。");
const refused = () => new WebError(403, "workspace_refused", "此工作目录未获授权或已不可用。");
const stale = () => new WebError(409, "workspace_confirmation_stale", "目录确认已失效，请重新选择。");

type Directory = NonNullable<Awaited<ReturnType<typeof canonicalDirectory>>>;
type Entry = { readonly name: string; readonly path: string; readonly kind: "directory" | "file" };
type Pending = { readonly directory: Directory; readonly expiresAt: number };

/** Stable identity of an exact local directory, not a sandbox for the native runtime. */
export class WorkspaceAccess {
  readonly #roots = new Map<string, string>();
  readonly #launchRoots: ReadonlyMap<string, string>;
  readonly #pending = new Map<string, Pending>();

  private constructor(roots: readonly Directory[]) {
    for (const { path, key } of roots) this.#roots.set(path, key);
    this.#launchRoots = new Map(this.#roots);
  }

  static async fromConfig(roots: readonly string[]) {
    const directories = await Promise.all(roots.map(async root => {
      if (displayControls.test(root)) throw invalidPath();
      const input = nativePath(resolve(root));
      if (!input) throw invalidPath();
      const path = nativePath(await realpath(input));
      if (!path) throw invalidPath();
      const directory = await canonicalDirectory(path);
      if (!directory) throw invalidPath();
      return directory;
    }));
    return new WorkspaceAccess(directories);
  }

  launchKey(path: string): string | undefined {
    return this.#launchRoots.get(path);
  }

  async exact(path: string): Promise<string | undefined> {
    const key = this.#roots.get(path);
    if (key === undefined) return undefined;
    const current = await canonicalDirectory(path);
    if (this.#roots.get(path) !== key) return undefined;
    if (current?.key === key) return key;
    this.#roots.delete(path);
    return undefined;
  }

  async paths(): Promise<string[]> {
    const roots = [...this.#roots.keys()];
    const keys = await Promise.all(roots.map(path => this.exact(path)));
    return roots.filter((_, i) => keys[i] !== undefined);
  }

  async prepare(input: string) {
    const path = nativePath(input);
    const directory = path && await canonicalDirectory(path, true);
    if (!directory) throw invalidPath();
    if (await this.exact(directory.path) === directory.key) {
      return { status: "authorized", path: directory.path, workspaces: await this.paths() } as const;
    }
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(id);
    }
    if (this.#pending.size >= MAX_CONFIRMATIONS) {
      throw new WebError(429, "workspace_confirmation_limit", "待确认目录过多，请先确认或取消。");
    }
    const confirmation = randomUUID();
    const expiresAt = now + CONFIRMATION_MS;
    this.#pending.set(confirmation, { directory, expiresAt });
    return { status: "confirmation_required", path: directory.path, confirmation, expiresAt } as const;
  }

  async confirm(confirmation: string, allow: boolean) {
    const pending = this.#pending.get(confirmation);
    this.#pending.delete(confirmation);
    if (!pending || pending.expiresAt <= Date.now()) throw stale();
    if (!allow) return { status: "cancelled" } as const;
    const { path, key } = pending.directory;
    await this.paths();
    if ((await canonicalDirectory(path))?.key !== key || pending.expiresAt <= Date.now()) throw stale();
    this.#roots.set(path, key);
    return { path, workspaces: [...this.#roots.keys()] };
  }

  async browse(input: string) {
    const requested = nativePath(input);
    if (!requested) throw invalidPath();
    const roots = [...this.#roots.keys()].filter(root => contains(root, requested, true)).sort((a, b) => a.length - b.length);
    for (const path of roots) {
      const key = await this.exact(path);
      if (key === undefined) continue;
      const target = await canonicalDirectory(requested, true);
      if (!target || !contains(path, target.path)) throw refused();
      const entries = await this.#list({ path, key }, target);
      const parent = samePath(path, target.path) ? null : dirname(target.path);
      return { path: target.path, parent, ...entries };
    }
    throw refused();
  }

  async #verify(root: Directory, target: Directory) {
    if (await this.exact(root.path) !== root.key || (await canonicalDirectory(target.path))?.key !== target.key) {
      throw refused();
    }
  }

  async #list(root: Directory, target: Directory) {
    try {
      await this.#verify(root, target);
      // Pin the directory before enumerating on Linux. O_DIRECTORY prevents
      // opening any file even if a replacement races the path checks.
      const handle = process.platform === "linux"
        ? await open(target.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        : undefined;
      try {
        if (handle && directoryKey(await handle.stat({ bigint: true })) !== target.key) throw refused();
        const scanPath = handle ? `/proc/self/fd/${handle.fd}` : target.path;
        const entries: Entry[] = [];
        let truncated = false;
        await this.#verify(root, target);
        const directory = await opendir(scanPath);
        try {
          await this.#verify(root, target);
          for (let scanned = 0; scanned <= MAX_ENTRIES; scanned++) {
            const entry = await directory.read();
            if (!entry) break;
            if (scanned === MAX_ENTRIES) { truncated = true; break; }
            const { name } = entry;
            if (!name || name === "." || name === ".." || displayControls.test(name) || entry.isSymbolicLink() ||
                (workspacePlatform === "win32" && !validWindowsPart(name))) continue;
            if (entry.isFile() || entry.isDirectory()) {
              entries.push({ name, path: join(target.path, name), kind: entry.isDirectory() ? "directory" : "file" });
            }
          }
        } finally { await directory.close(); }
        await this.#verify(root, target);
        entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
        return { entries, truncated };
      } finally {
        await handle?.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) throw refused();
      throw error;
    }
  }
}
