import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cliTr } from "./locale.js";
import { createWindowsPasswordFile } from "./windows-password.js";

const envKeys = [
  "OMO_WEB_HOST", "OMO_WEB_PASSWORD_FILE", "OMO_WEB_ALLOW_UNAUTHENTICATED",
  "OMO_WEB_ORIGIN", "OMO_WEB_TLS_CERT", "OMO_WEB_TLS_KEY", "OMO_WEB_PROXY_ORIGIN",
];
const keys = new Set([...envKeys, "savedPassword", "httpsEnabled"]);

async function atomicFile(path, create) {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await create(staged);
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

export async function loadLauncherSettings(base) {
  const dataDir = resolve(base.OMO_WEB_DATA ?? join(homedir(), ".omo-web"));
  const directory = join(dataDir, "launcher");
  const config = join(directory, "settings.json");
  let overrides = {};
  let warning = "";
  let readable = true;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || (process.platform !== "win32" &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      throw new Error("Expected a private launcher directory.");
    }
    const object = JSON.parse(await readFile(config, "utf8"));
    if (object === null || typeof object !== "object" || Array.isArray(object) ||
        Object.entries(object).some(([key, value]) => !keys.has(key) ||
          (key === "httpsEnabled" ? value !== "0" && value !== "1" : value !== null && typeof value !== "string"))) {
      throw new Error("Invalid launcher settings.");
    }
    overrides = object;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      readable = false;
      warning = cliTr("无法读取私密启动器设置。请检查设置目录后重试。",
        "Could not load private launcher settings. Check the settings directory and retry.");
    }
  }

  async function prepare() {
    if (!readable) throw new Error(warning);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (process.platform !== "win32" &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      throw new Error("Expected a private launcher directory.");
    }
    return directory;
  }

  async function save(patch) {
    await prepare();
    const next = { ...overrides, ...patch };
    await atomicFile(config, path => writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 }));
    overrides = next;
  }

  function effectiveEnv() {
    const env = { ...base };
    for (const key of envKeys) {
      const value = overrides[key];
      if (value === null) delete env[key];
      else if (value !== undefined) env[key] = value;
    }
    if (overrides.httpsEnabled === "0") {
      delete env.OMO_WEB_ORIGIN;
      delete env.OMO_WEB_TLS_CERT;
      delete env.OMO_WEB_TLS_KEY;
    }
    return env;
  }

  return {
    directory, warning, prepare, save, effectiveEnv,
    get hasListenerOverride() { return overrides.OMO_WEB_HOST !== undefined || overrides.httpsEnabled !== undefined; },
    async changePassword(password) {
      await prepare();
      const path = join(directory, "password.txt");
      await atomicFile(path, staged => process.platform === "win32" ? createWindowsPasswordFile(staged, password)
        : writeFile(staged, `${password}\n`, { flag: "wx", mode: 0o600 }));
      await save({ OMO_WEB_PASSWORD_FILE: path, savedPassword: path, OMO_WEB_ALLOW_UNAUTHENTICATED: null });
    },
    async setPasswordEnabled(enabled) {
      const current = effectiveEnv().OMO_WEB_PASSWORD_FILE;
      const path = current ? resolve(current) : overrides.savedPassword ?? base.OMO_WEB_PASSWORD_FILE;
      if (enabled && !path) return false;
      await save({
        OMO_WEB_PASSWORD_FILE: enabled ? resolve(path) : null,
        savedPassword: path === undefined ? null : resolve(path),
        OMO_WEB_ALLOW_UNAUTHENTICATED: null,
      });
      return true;
    },
    async setHttpsEnabled(enabled) {
      if (enabled && !["OMO_WEB_ORIGIN", "OMO_WEB_TLS_CERT", "OMO_WEB_TLS_KEY"].every(key =>
        overrides[key] === undefined ? base[key] : overrides[key])) return false;
      await save({ httpsEnabled: enabled ? "1" : "0" });
      return true;
    },
    async enableGeneratedTls({ origin, certFile, keyFile }) {
      await save({ httpsEnabled: "1", OMO_WEB_ORIGIN: origin, OMO_WEB_TLS_CERT: certFile, OMO_WEB_TLS_KEY: keyFile });
    },
  };
}
