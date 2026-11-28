import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import { webAsset, webAssetPaths } from "../src/web-assets.ts";

test("release and npm packages ship the same private Native extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-web-send-file-pack-"));
  try {
    await Promise.all(["scripts", "src", "native", "packaging", "dist", "node_modules/zod", "public/licenses"]
      .map(path => mkdir(join(root, path), { recursive: true })));
    await Promise.all([
      cp("scripts/pack-release.ts", join(root, "scripts/pack-release.ts")),
      cp("scripts/pack-npm.ts", join(root, "scripts/pack-npm.ts")),
      cp("src/web-assets.ts", join(root, "src/web-assets.ts")),
      cp("native/web-send-file.mjs", join(root, "native/web-send-file.mjs")),
      cp("packaging/npm", join(root, "packaging/npm"), { recursive: true }),
      cp("package.json", join(root, "package.json")),
    ]);
    const licenseInputs = [
      "node_modules/zod/LICENSE",
      "node_modules/markdown-it/LICENSE",
      "node_modules/@mdit/plugin-tex/LICENSE",
      "node_modules/@mdit/plugin-tasklist/LICENSE",
      "node_modules/@mdit/plugin-footnote/LICENSE",
      "node_modules/@mdit/helper/LICENSE",
      "node_modules/katex/LICENSE",
      "node_modules/highlight.js/LICENSE",
      "node_modules/entities/LICENSE",
      "node_modules/linkify-it/LICENSE",
      "node_modules/mdurl/LICENSE",
      "node_modules/punycode.js/LICENSE-MIT.txt",
      "node_modules/uc.micro/LICENSE.txt",
    ];
    for (const path of [...webAssetPaths, "LICENSE", "dist/server.js", "public/licenses/teenyicons.txt", ...licenseInputs]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "pack fixture\n");
    }
    for (const script of ["pack-release.ts", "pack-npm.ts"]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "scripts", script)], {
        cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
    }
    const releaseRoot = join(root, "release");
    const npmRoot = join(root, "npm");
    await new Bun.Archive(await Bun.file(join(root, `dist/omo-web-${version}.tar.gz`)).bytes()).extract(releaseRoot);
    await new Bun.Archive(await Bun.file(join(root, `dist/npm/omo-web-${version}.tgz`)).bytes()).extract(npmRoot);
    const release = join(releaseRoot, `omo-web-${version}`);
    const npm = join(npmRoot, "package");
    const source = await readFile("native/web-send-file.mjs");
    expect(await Bun.file(join(release, "native/web-send-file.mjs")).exists()).toBe(true);
    expect(await Bun.file(join(npm, "native/web-send-file.mjs")).exists()).toBe(true);
    expect(await readFile(join(release, "native/web-send-file.mjs"))).toEqual(source);
    expect(await readFile(join(npm, "native/web-send-file.mjs"))).toEqual(source);
    expect(await Bun.file(join(release, "public/native/web-send-file.mjs")).exists()).toBe(false);
    expect(await Bun.file(join(npm, "public/native/web-send-file.mjs")).exists()).toBe(false);
    expect(webAsset("/native/web-send-file.mjs")).toBeUndefined();
    expect(webAsset("/public/native/web-send-file.mjs")).toBeUndefined();
    const licenseTargets = [
      "public/licenses/zod.txt",
      "public/licenses/markdown-it.txt",
      "public/licenses/mdit-plugin-tex.txt",
      "public/licenses/mdit-plugin-tasklist.txt",
      "public/licenses/mdit-plugin-footnote.txt",
      "public/licenses/mdit-helper.txt",
      "public/licenses/katex.txt",
      "public/licenses/highlight-js.txt",
      "public/licenses/entities.txt",
      "public/licenses/linkify-it.txt",
      "public/licenses/mdurl.txt",
      "public/licenses/punycode-js.txt",
      "public/licenses/uc-micro.txt",
    ];
    for (const target of licenseTargets) {
      expect(await Bun.file(join(release, target)).exists(), target).toBe(true);
      expect(await Bun.file(join(npm, target)).exists(), target).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
