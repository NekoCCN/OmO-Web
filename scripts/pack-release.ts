import { version } from "../package.json";
import { webAssetPaths } from "../src/web-assets.ts";

const root = new URL("../", import.meta.url);
const name = `omo-web-${version}`;
const filename = `${name}.tar.gz`;
const files = [
  ...webAssetPaths.map(path => [path, path] as const),
  ["dist/server.js", "dist/server.js"],
  ["public/licenses/teenyicons.txt", "public/licenses/teenyicons.txt"],
  ["node_modules/zod/LICENSE", "public/licenses/zod.txt"],
] as const;
const entries = Object.fromEntries(await Promise.all(files.map(async ([source, target]) =>
  [`${name}/${target}`, await Bun.file(new URL(source, root)).bytes()] as const)));
const archive = await new Bun.Archive(entries, { compress: "gzip" }).bytes();
const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");

await Bun.write(new URL(`dist/${filename}`, root), archive);
await Bun.write(new URL(`dist/${filename}.sha256`, root), `${digest}  ${filename}\n`);
console.log(`dist/${filename}\ndist/${filename}.sha256`);
