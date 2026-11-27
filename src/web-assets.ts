const assets: Readonly<Record<string, string>> = {
  "/": "public/index.html",
  "/styles.css": "public/styles.css",
  "/workbench.css": "public/workbench.css",
  "/tool-ledger.css": "public/tool-ledger.css",
  "/dag-graph.css": "public/dag-graph.css",
  "/app.js": "dist/app.js",
  "/favicon.svg": "public/favicon.svg",
  "/icons.svg": "public/icons.svg",
};

export const webAssetPaths: readonly string[] = Object.values(assets);

function assetFile(path: string) {
  // Both src/web-assets.ts and the bundled dist/server.js sit one level below the root.
  return Bun.file(new URL(`../${path}`, import.meta.url));
}

export function webAsset(pathname: string) {
  if (Object.hasOwn(assets, pathname)) return assetFile(assets[pathname]);
}

export async function missingWebAssets(): Promise<readonly string[]> {
  const present = await Promise.all(webAssetPaths.map(path => assetFile(path).exists()));
  return webAssetPaths.filter((_, index) => !present[index]);
}
