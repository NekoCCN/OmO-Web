import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../package.json";
import manifest from "../packaging/npm/manifest.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "npm");
const npm = Bun.which("npm");
if (!npm) throw new Error("npm is required to create the npm tarball.");

const staging = await mkdtemp(join(tmpdir(), "omo-web-npm-"));
try {
  const release = new Bun.Archive(await Bun.file(join(root, "dist", `omo-web-${version}.tar.gz`)).bytes());
  await release.extract(staging);
  const packageDir = join(staging, `omo-web-${version}`);
  const bin = join(packageDir, "bin", "omo-web.js");
  await Promise.all([mkdir(join(packageDir, "bin")), mkdir(output, { recursive: true })]);
  await Promise.all([
    copyFile(join(root, "packaging/npm/omo-web.js"), bin),
    ...["tui.js", "locale.js", "windows-password.js", "launcher-settings.js", "launcher-tls.js", "listen-address.js", "access-policy.js"]
      .map(file => copyFile(join(root, "packaging/npm", file), join(packageDir, "bin", file))),
    copyFile(join(root, "packaging/npm/README.md"), join(packageDir, "README.md")),
    Bun.write(join(packageDir, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`),
  ]);
  await chmod(bin, 0o755);
  const pack = Bun.spawn([npm, "pack", "--offline", "--ignore-scripts", "--pack-destination", output], {
    cwd: packageDir, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await pack.exited;
  if (code !== 0) throw new Error(`npm pack failed with exit code ${code}.`);
  console.log(join(output, `${manifest.name}-${version}.tgz`));
} finally {
  await rm(staging, { recursive: true, force: true });
}
