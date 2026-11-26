import { expect, test } from "bun:test";

const chrome = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable");
const browserTest = test.skipIf(!chrome || typeof Bun.WebView !== "function");
const id = "dag-graph-fixture";
const cwd = "/fixture/dag-graph";
const session = { id, cwd, name: "DAG fixture", active: true };
const base = `/api/sessions/${id}`;
const dagPath = `${base}/native-runtime/dag/${"a".repeat(64)}`;
const run = { key: "a".repeat(64), status: "running", nodeCount: 6, createdAt: 1, updatedAt: 2 };
const branch = {
  status: "ok",
  waves: [{ index: 0, nodes: [0] }, { index: 1, nodes: [1, 2, 3, 4] }, { index: 2, nodes: [5] }],
  nodes: [[], [0], [0], [], [], [0, 1, 2]].map((upstream, id) => ({
    id, upstream, attempt: 1, state: id === 5 ? "skipped" : "completed",
    privatePrompt: "not projected into the DOM",
  })),
};
const invalid = {
  ...branch,
  nodes: branch.nodes.map(node => node.id === 5 ? { ...node, upstream: [999] } : node),
};

async function withWorkbench(size: number, snapshots: (() => Promise<unknown> | unknown)[],
  check: (browser: Bun.WebView, requests: string[]) => Promise<void>) {
  const result = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = result.outputs[0];
  if (!result.success || !script) throw new Error("Could not build the DAG fixture");
  const requests: string[] = [];
  let snapshotRead = 0;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html"), {
        headers: { "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'" },
      }),
      "/app.js": () => new Response(script),
      ...Object.fromEntries(["styles.css", "workbench.css", "tool-ledger.css", "dag-graph.css", "icons.svg", "favicon.svg"]
        .map(file => [`/${file}`, async () => {
          const asset = Bun.file(`public/${file}`);
          return await asset.exists() ? new Response(asset) : new Response("", { status: 404 });
        }])),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [cwd], engine: { online: true }, token: "fixture" }),
      "/api/cli-history": Response.json({ available: true, sessions: [] }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { controller.enqueue(": fixture\n\n"); },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [base]: Response.json({ session, state: {}, messages: [{ role: "user", content: "fixture" }] }),
      [`${base}/options`]: Response.json({}),
      [`${base}/workbench-status`]: Response.json({ status: "empty" }),
      [`${base}/details`]: Response.json({ stats: {} }),
      [`${base}/native-runtime`]: Response.json({
        tasks: { status: "empty" }, memory: { status: "ok", totalSteps: 0, reflectedSteps: 0 },
        dag: { status: "ok", rows: [run], limitReached: false },
      }),
      [dagPath]: async (request: Request) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json(await (snapshots[snapshotRead++]?.() ?? { status: "malformed" }));
      },
    },
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("Unexpected fixture request", { status: 404 });
    },
  });
  const width = size === 400 ? 1440 : size;
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chrome ?? undefined, url: false }, width, height: 700 });
  await browser.navigate(server.url.href);
  if (await browser.evaluate("innerWidth") !== width) await browser.resize(width, 700);
  await visible(browser, width < 760 ? "#open-navigation" : "#session-list button");
  if (width < 760) await browser.click("#open-navigation");
  await visible(browser, "#session-list button");
  await browser.click("#session-list button");
  await visible(browser, "#messages article");
  expect(await browser.evaluate("document.activeElement.id")).toBe("conversation");
  if (width <= 1000) {
    expect(await browser.evaluate(`document.querySelector("#details-dialog").open`)).toBe(false);
    await browser.click("#details-button");
    expect(await browser.evaluate(`[
      document.querySelector("#details-dialog").matches(":modal"), document.activeElement.id
    ]`)).toEqual([true, "runtime-open-overview"]);
  } else {
    expect(await browser.evaluate(`document.querySelector("#details-dialog").matches("[open]:not(:modal)")`)).toBe(true);
  }
  await browser.click("#runtime-open-dag");
  expect(await browser.evaluate("document.activeElement.id")).toBe("runtime-open-dag");
  await visible(browser, ".dag-run > summary");
  await browser.click(".dag-run > summary");
  await check(browser, requests);
}

const visible = (browser: Bun.WebView, selector: string) => browser.evaluate(`new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(${JSON.stringify(`Not visible: ${selector}`)})), 4000);
  const observer = new MutationObserver(check);
  function check() {
    if (!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length) return;
    clearTimeout(timer); observer.disconnect(); resolve(true);
  }
  observer.observe(document.body, { subtree: true, childList: true, attributes: true }); check();
})`);

for (const size of [320, 400]) {
  browserTest(`draws exactly the branch, merge and cross-wave edges in a ${size}px panel`, async () => {
    await withWorkbench(size, [() => branch], async (browser, requests) => {
      await visible(browser, ".dag-graph-map");
      const graph = await browser.evaluate<{
        edges: number[][]; directions: boolean[]; ys: number[]; states: string[];
        collapsed: boolean; outsideOverflow: boolean; localOverflow: boolean;
        panelWidth: number; mapFits: boolean; firstNodeFits: boolean; privateText: boolean;
      }>(`(() => {
        const map = document.querySelector(".dag-graph-map");
        const panel = document.querySelector("#details-dialog");
        const readout = document.querySelector("#runtime-dag");
        const edges = [...map.querySelectorAll("path[data-from][data-to]")];
        const nodes = [...map.querySelectorAll("[data-node]")];
        return {
          edges: edges.map(path => [+path.dataset.from, +path.dataset.to]),
          directions: edges.map(path => {
            const length = path.getTotalLength();
            const marker = document.querySelector(path.getAttribute("marker-end").slice(4, -1));
            return marker?.getAttribute("orient") === "auto" &&
              path.getPointAtLength(length).y > path.getPointAtLength(0).y;
          }),
          ys: nodes.map(node => node.getBoundingClientRect().top),
          states: nodes.map(node => node.innerText),
          collapsed: !document.querySelector(".dag-graph-text").open &&
            !document.querySelector(".dag-wave li").getClientRects().length,
          outsideOverflow: document.querySelector("#details-scroll").scrollWidth >
            document.querySelector("#details-scroll").clientWidth || document.documentElement.scrollWidth > innerWidth,
          localOverflow: map.scrollWidth > map.clientWidth,
          panelWidth: panel.getBoundingClientRect().width,
          mapFits: map.getBoundingClientRect().right <= panel.getBoundingClientRect().right,
          firstNodeFits: nodes[0].getBoundingClientRect().right <= map.getBoundingClientRect().right,
          privateText: readout.textContent.includes("not projected into the DOM"),
        };
      })()`);
      expect(graph.edges).toEqual([[0, 1], [0, 2], [0, 5], [1, 5], [2, 5]]);
      expect(graph.directions).not.toContain(false);
      expect(graph.ys[0]!).toBeLessThan(graph.ys[1]!);
      expect(graph.ys.slice(1, 5)).toEqual(Array(4).fill(graph.ys[1]));
      expect(graph.ys[1]!).toBeLessThan(graph.ys[5]!);
      expect(graph.states[5]).toContain("已跳过");
      expect(graph.panelWidth).toBe(size);
      expect(graph.collapsed).toBe(true);
      expect(graph.outsideOverflow).toBe(false);
      expect(graph.localOverflow).toBe(true);
      expect(graph.mapFits).toBe(true);
      expect(graph.firstNodeFits).toBe(true);
      expect(graph.privateText).toBe(false);
      if (process.env.OMO_DAG_GRAPH_EVIDENCE) {
        await Bun.write(`${process.env.OMO_DAG_GRAPH_EVIDENCE}/dag-graph-${size}.png`, await browser.screenshot());
      }
      expect(await browser.evaluate(`document.activeElement.matches(".dag-run > summary")`)).toBe(true);
      await browser.press("Tab");
      expect(await browser.evaluate(`document.activeElement.matches(".dag-graph-map")`)).toBe(true);
      expect(await browser.evaluate(`[
        document.activeElement.matches(":focus-visible"), getComputedStyle(document.activeElement).outlineStyle
      ]`)).toEqual([true, "solid"]);
      await browser.press("ArrowRight");
      await browser.evaluate(`new Promise(resolve => {
        const map = document.querySelector(".dag-graph-map");
        if (map.scrollLeft) return resolve(true);
        const timer = setTimeout(() => resolve(false), 1000);
        map.addEventListener("scroll", () => { clearTimeout(timer); resolve(true); }, { once: true });
      })`);
      expect(await browser.evaluate(`document.querySelector(".dag-graph-map").scrollLeft`)).toBeGreaterThan(0);
      await browser.press("Tab");
      expect(await browser.evaluate(`document.activeElement.matches(".dag-graph-text > summary")`)).toBe(true);
      await browser.press("Enter");
      await visible(browser, ".dag-wave:last-child li");
      expect(await browser.evaluate(`document.querySelector(".dag-wave:last-child li").innerText`))
        .toContain("依赖：节点 1、节点 2、节点 3");
      expect(requests).toEqual([`GET ${dagPath}`]);
    });
  });
}

browserTest("invalid topology draws no edges and the old fenced response cannot overwrite a fresh run", async () => {
  let release!: (snapshot: unknown) => void;
  let started!: () => void;
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  await withWorkbench(320, [() => { started(); return pending; }, () => branch, () => invalid,
    () => ({ status: "ownership_changed", private: "other owner" })],
    async (browser, requests) => {
      // Hold the first per-run response until the second fenced read has already rendered.
      await firstRead;
      expect(requests).toEqual([`GET ${dagPath}`]);
      await browser.click("#details-refresh");
      await visible(browser, ".dag-graph-map");
      release({ ...branch, nodes: branch.nodes.map(node => ({ ...node, state: "failed" })) });
      await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      expect(await browser.evaluate(`document.querySelector(".dag-graph-map").innerText`)).toContain("已跳过");
      await browser.click("#details-refresh");
      await visible(browser, ".dag-graph-text[open] .dag-wave");
      expect(await browser.evaluate(`document.querySelector("#runtime-dag .dag-content").innerText`)).not.toContain("节点 1000");
      expect(await browser.evaluate(`document.querySelector(".dag-graph-map, path[data-from][data-to]") === null`)).toBe(true);
      await browser.click("#details-refresh");
      await visible(browser, ".dag-content > .dag-readout");
      expect(await browser.evaluate(`document.querySelector(".dag-content").innerText`)).toContain("会话归属已变化");
      expect(await browser.evaluate(`document.querySelector("#runtime-dag").textContent`)).not.toContain("other owner");
      expect(requests).toEqual(Array(4).fill(`GET ${dagPath}`));
    });
}, 15_000);
