import { version } from "../package.json";
import { webAssetPaths } from "../src/web-assets.ts";

const root = new URL("../", import.meta.url);
const name = `omo-web-${version}`;
const filename = `${name}.tar.gz`;
const files = [
  ["LICENSE", "LICENSE"],
  ...webAssetPaths.map(path => [path, path] as const),
  ["dist/server.js", "dist/server.js"],
  ["native/web-send-file.mjs", "native/web-send-file.mjs"],
  ["public/licenses/teenyicons.txt", "public/licenses/teenyicons.txt"],
  ["node_modules/zod/LICENSE", "public/licenses/zod.txt"],
  ["node_modules/markdown-it/LICENSE", "public/licenses/markdown-it.txt"],
  ["node_modules/@mdit/plugin-tex/LICENSE", "public/licenses/mdit-plugin-tex.txt"],
  ["node_modules/@mdit/plugin-tasklist/LICENSE", "public/licenses/mdit-plugin-tasklist.txt"],
  ["node_modules/@mdit/plugin-footnote/LICENSE", "public/licenses/mdit-plugin-footnote.txt"],
  ["node_modules/@mdit/helper/LICENSE", "public/licenses/mdit-helper.txt"],
  ["node_modules/katex/LICENSE", "public/licenses/katex.txt"],
  ["node_modules/highlight.js/LICENSE", "public/licenses/highlight-js.txt"],
  ["node_modules/entities/LICENSE", "public/licenses/entities.txt"],
  ["node_modules/linkify-it/LICENSE", "public/licenses/linkify-it.txt"],
  ["node_modules/mdurl/LICENSE", "public/licenses/mdurl.txt"],
  ["node_modules/punycode.js/LICENSE-MIT.txt", "public/licenses/punycode-js.txt"],
  ["node_modules/uc.micro/LICENSE.txt", "public/licenses/uc-micro.txt"],
] as const;
const entries = Object.fromEntries(await Promise.all(files.map(async ([source, target]) =>
  [`${name}/${target}`, await Bun.file(new URL(source, root)).bytes()] as const)));
const archive = await new Bun.Archive(entries, { compress: "gzip" }).bytes();
const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");

await Bun.write(new URL(`dist/${filename}`, root), archive);
await Bun.write(new URL(`dist/${filename}.sha256`, root), `${digest}  ${filename}\n`);
console.log(`dist/${filename}\ndist/${filename}.sha256`);
