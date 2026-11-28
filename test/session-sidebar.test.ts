import { expect, test } from "bun:test";

const chromium = process.env.OMO_HANDOFF_CHROMIUM ?? process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const sessions = ["alpha", "beta"].map(id => ({
  id, name: `侧栏 · ${id}`, cwd: `/fixture/${id}`, active: true, archived: false, settled: true, running: false,
}));
const ruleText = "# Local instructions\n<img src=x onerror='window.rulesExecuted=true'>\nOnly literal text.";
const question = {
  id: "question-one", requestId: "native-one", method: "question", title: "选择验收范围", waitForAnswer: false,
  questions: [{ id: "scope", options: [{ label: "侧栏" }] }],
};
type SnapshotFixture = { state?: object; generationSpeed?: object; messages?: object[] };
const firstMessage = { role: "user", content: "保留主区对话。" };

async function sidebar(width: number, run: (fixture: {
  browser: Bun.WebView;
  events: (value: object) => void;
  disconnect: () => void;
  reads: string[];
  actions: unknown[];
  setSnapshot: (data: SnapshotFixture) => void;
  setTodo: (content: string) => void;
  detailReads: string[];
  treeReplies: Array<Response | (() => Promise<Response>)>;
  nativeReplies: Response[];
  dagHistoryReplies: Response[];
  holdNextSnapshot: () => { requested: Promise<void>; release: () => void };
}) => Promise<void>, initialTodo: string | null = "核对侧栏") {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not build sidebar fixture");
  const reads: string[] = [];
  const actions: unknown[] = [];
  const detailReads: string[] = [];
  const treeReplies: Array<Response | (() => Promise<Response>)> = [];
  const nativeReplies: Response[] = [];
  const dagHistoryReplies: Response[] = [];
  let send: ReadableStreamDefaultController<string> | undefined;
  let alphaSnapshot: SnapshotFixture = {};
  let todoContent = initialTodo;
  let snapshotGate: { started: () => void; reply: Promise<void> } | undefined;
  const path = "/api/sessions";
  const state = {
    model: { provider: "fixture", id: "review", name: "Local review", reasoning: true },
    thinkingLevel: "high", fastMode: false, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 },
    usageTotals: { input: 20, cacheRead: 80, cacheWrite: 0, latestCacheHitRate: 80 },
  };
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/workbench.css": () => new Response(Bun.file("public/workbench.css")),
      "/tool-ledger.css": () => new Response(Bun.file("public/tool-ledger.css")),
      "/dag-graph.css": () => new Response(Bun.file("public/dag-graph.css")),
      "/icons.svg": () => new Response(Bun.file("public/icons.svg")),
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions, workspaces: sessions.map(row => row.cwd), engine: { online: true }, token: "fixture" }),
      [path]: Response.json({ sessions }),
      "/api/cli-history": Response.json({ available: true, sessions: [] }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { send = controller; controller.enqueue(": fixture\n\n"); },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`${path}/:id`]: async request => {
        const alpha = request.params.id === "alpha";
        const response = Response.json({
          session: sessions.find(row => row.id === request.params.id),
          state: alpha ? { ...state, ...alphaSnapshot.state } : {},
          messages: (alpha && alphaSnapshot.messages) || [firstMessage],
          ...(alpha ? { generationSpeed: alphaSnapshot.generationSpeed } : {}),
        });
        if (alpha && snapshotGate) {
          const gate = snapshotGate;
          snapshotGate = undefined;
          gate.started();
          await gate.reply;
        }
        return response;
      },
      [`${path}/:id/options`]: Response.json({ levels: ["off", "high"], models: [state.model] }),
      [`${path}/:id/workbench-status`]: Response.json({ status: "ok", currentTodo: "核对侧栏", pendingTodo: 1 }),
      [`${path}/:id/details`]: request => Response.json({
        stats: request.params.id === "alpha" ? { contextUsage: { tokens: 900, percent: 9, contextWindow: 10000 }, cost: 0 } : {},
        ...(request.params.id === "alpha" ? { generationSpeed: { tokensPerSecond: 52.1, measuredAt: 2 } } : {}),
      }),
      [`${path}/:id/tree`]: request => {
        detailReads.push(`${request.params.id}/tree${new URL(request.url).search}`);
        const reply = treeReplies.shift();
        return typeof reply === "function" ? reply() : reply ?? Response.json({ nodes: [], leafId: null });
      },
      [`${path}/:id/branch-runtime`]: request => {
        const { search } = new URL(request.url);
        detailReads.push(`${request.params.id}/branch-runtime${search}`);
        if (search && search !== "?scope=todo") return Response.json({ status: "unexpected_scope" }, { status: 400 });
        return Response.json({ status: "ok", leafId: "leaf-fixture", todo: todoContent === null ? { status: "none" }
          : { status: "ok", phases: [{ name: "验收", tasks: [{ status: "pending", content: todoContent }] }] },
          ...(!search && { memory: { status: "ok", recalledCount: 3 } }) });
      },
      [`${path}/:id/native-runtime`]: request => {
        detailReads.push(`${request.params.id}/native-runtime`);
        return nativeReplies.shift() ?? Response.json({
          tasks: { status: "empty" }, dag: { status: "unavailable", reason: "native_window_unverified" },
          memory: { status: "ok", totalSteps: 8, reflectedSteps: 0 },
        });
      },
      [`${path}/:id/native-runtime/dag-history`]: request => {
        detailReads.push(`${request.params.id}/native-runtime/dag-history`);
        return dagHistoryReplies.shift() ?? Response.json({ status: "unavailable", reason: "native_window_unverified" });
      },
      [`${path}/:id/activity`]: request => {
        detailReads.push(`${request.params.id}/activity`);
        return Response.json({ status: "ok", updatedAt: 2, tasks: [{ status: "completed" }], runs: [] });
      },
      [`${path}/:id/instructions`]: request => {
        reads.push(`${request.method} ${request.params.id}${new URL(request.url).search}`);
        return request.params.id === "beta" ? Response.json({ status: "missing" })
          : Response.json({ status: "ok", file: "AGENTS.md", content: ruleText });
      },
      [`${path}/:id/actions`]: async request => {
        const action = await request.json();
        actions.push(action);
        return Response.json({ session: sessions.find(row => row.id === request.params.id),
          result: action?.action === "navigate" ? { cancelled: false, leafId: action.targetId, editorText: "导航后的历史草稿" } : {} });
      },
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width, height: 720 });
  await browser.navigate(server.url.href);
  await browser.resize(width, 720);
  await wait(browser, `document.querySelector("#connection").dataset.state === "online"`);
  if (width <= 760) await browser.click("#open-navigation");
  await browser.click('[data-session="alpha"]');
  await wait(browser, `!document.querySelector("#details-button").hidden`);
  try { await run({
    browser, events: value => send?.enqueue(`event: omo\ndata: ${JSON.stringify({ sessionId: "alpha", ...value })}\n\n`),
    disconnect: () => send?.close(),
    reads, actions, detailReads, treeReplies, nativeReplies, dagHistoryReplies, setSnapshot: data => { alphaSnapshot = data; },
    setTodo: content => { todoContent = content; },
    holdNextSnapshot: () => {
      const started = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      snapshotGate = { started: started.resolve, reply: reply.promise };
      return { requested: started.promise, release: reply.resolve };
    },
  }); } catch (error) {
    if (detailReads.length) console.error("Fixture runtime reads:", detailReads);
    throw error;
  }
}

async function wait(browser: Bun.WebView, condition: string) {
  try {
    return await browser.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(Error(${JSON.stringify(condition)})); }, 2600);
    const observer = new MutationObserver(check);
    function check() {
      if (!(${condition})) return;
      clearTimeout(timer); observer.disconnect(); resolve(true);
    }
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true }); check();
  })`);
  } catch (error) {
    if (!/runtime-tree|runtime-memory-journal/.test(condition)) throw error;
    const state = await browser.evaluate(`({
      visible: document.querySelector("#details-dialog").open,
      active: document.activeElement.outerHTML.slice(0, 200),
      selected: document.querySelector('#runtime-shortcuts [aria-selected="true"]')?.id,
      title: document.querySelector("#session-title")?.textContent,
      tree: document.querySelector("#runtime-tree")?.innerText,
    })`);
    throw new Error(`${condition}: ${JSON.stringify(state)}`, { cause: error });
  }
}

async function accessibleNode(browser: Bun.WebView, selector: string) {
  const { root } = await browser.cdp<{ root: { nodeId: number } }>("DOM.getDocument");
  const { nodeId } = await browser.cdp<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { nodes } = await browser.cdp<{ nodes: {
    ignored: boolean; role?: { value: string }; name?: { value: string };
  }[] }>("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
  const node = nodes[0];
  return { ignored: node?.ignored, role: node?.role?.value, name: node?.name?.value };
}

async function capture(browser: Bun.WebView, name: string) {
  const dir = process.env.OMO_SESSION_SIDEBAR_EVIDENCE;
  if (!dir) return;
  for (const appearance of ["light", "dark"]) {
    await browser.evaluate(`(async () => {
      const theme = document.querySelector("#theme");
      theme.value = "${appearance}"; theme.dispatchEvent(new Event("change"));
      await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
    })()`);
    await Bun.write(`${dir}/${name}-${appearance}.png`, await browser.screenshot());
  }
}

const treeSummary = "#runtime-tree summary";
const todoRead = "alpha/branch-runtime?scope=todo";
const memoryRead = "alpha/branch-runtime";
const loadOlder = "#runtime-tree [data-tree-older]";
const reloadTree = "#runtime-tree [data-tree-reload]";
const treePage = (id: string, summary: string, leafId = id, nextCursor?: string) => Response.json({
  nodes: [{ id, parentId: `outside-${id}`, type: "message", role: "user", summary }], leafId,
  ...(nextCursor ? { nextCursor } : {}),
});
const treeFailure = (status: number) => Response.json({ error: "fixture tree failure", code: status === 409 ? "session_changed" : "internal" }, { status });

async function clickTreeControl(browser: Bun.WebView, selector: string) {
  await wait(browser, `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  expect(await browser.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y, width, height } = control.getBoundingClientRect();
    return control.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  })()`)).toBe(true);
  await browser.click(selector);
}

for (const width of [320, 1440]) browserTest(`lazy details reads each resource only on intent and adds one older page at a time at ${width}px`, async () => {
  await sidebar(width, async ({ browser, detailReads, treeReplies, setTodo }) => {
    if (width === 320) await browser.click("#details-button");
    await wait(browser, `document.querySelector(".metric-highlights")`);
    expect(detailReads).toEqual([]);
    await browser.click("#details-refresh");
    expect(detailReads).toEqual([]);
    treeReplies.push(treePage("new", "最新节点", "new", "opaque +/= cursor"), treePage("old", "过去节点", "new"));
    await clickTreeControl(browser, treeSummary);
    await wait(browser, `document.querySelector('#runtime-tree [aria-current="true"]')?.textContent.includes("最新节点")`);
    expect(detailReads).toEqual(["alpha/tree"]);
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(treeSummary)})`)).toBe(true);
    await clickTreeControl(browser, loadOlder);
    await wait(browser, `document.querySelector("#runtime-tree").innerText.includes("过去节点")`);
    expect(detailReads).toEqual(["alpha/tree", "alpha/tree?cursor=opaque+%2B%2F%3D+cursor"]);
    expect(await browser.evaluate(`[document.activeElement.matches(${JSON.stringify(loadOlder)}),
      document.querySelector('#runtime-tree [aria-current="true"]').textContent.includes("最新节点")]`)).toEqual([true, true]);
    expect(await browser.evaluate(`(() => {
      const scroller = document.querySelector("#details-scroll");
      const { top, bottom } = document.activeElement.getBoundingClientRect();
      const bounds = scroller.getBoundingClientRect();
      return [scroller.scrollWidth <= scroller.clientWidth, top >= bounds.top - 1 && bottom <= bounds.bottom + 1];
    })()`)).toEqual([true, true]);
    await capture(browser, `lazy-tree-pages-${width}`);
    const treeReads = [...detailReads];
    await browser.click("#runtime-open-todo");
    await wait(browser, `document.querySelector("[data-runtime-branch] details[open]")?.innerText.includes("核对侧栏")`);
    expect(detailReads).toEqual([...treeReads, todoRead]);
    setTodo("刷新后的待办");
    await browser.click("#details-refresh");
    await wait(browser, `document.querySelector("[data-runtime-branch] details[open]")?.innerText.includes("刷新后的待办")`);
    expect(detailReads).toEqual([...treeReads, todoRead, todoRead]);
    await clickTreeControl(browser, "#runtime-memory-branch summary");
    await wait(browser, `document.querySelector("#runtime-memory-journal dd")?.textContent === "8" &&
      document.querySelector("#runtime-memory-branch-content dd")?.textContent === "3"`);
    expect(detailReads).toEqual([...treeReads, todoRead, todoRead, memoryRead, "alpha/native-runtime"]);
    await browser.click("#runtime-open-dag");
    await wait(browser, `document.querySelector("#runtime-dag-current").innerText.includes("更早的匹配未知")`);
    expect(detailReads).toEqual([...treeReads, todoRead, todoRead, memoryRead, "alpha/native-runtime"]);
  });
});

browserTest("lazy details keeps overview usable through loading, retry and stale older cursors", async () => {
  await sidebar(1440, async ({ browser, detailReads, treeReplies }) => {
    await wait(browser, `document.querySelector(".metric-highlights")`);
    const held = Promise.withResolvers<Response>();
    treeReplies.push(() => held.promise, treePage("new", "当前节点", "new", "older-token"), treeFailure(500), treeFailure(409), Response.json({ nodes: [], leafId: null }));
    await clickTreeControl(browser, treeSummary);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("正在")`);
    held.resolve(treeFailure(500));
    await wait(browser, `document.querySelector(${JSON.stringify(reloadTree)})?.getClientRects().length`);
    expect(await browser.evaluate(`Boolean(document.querySelector(".metric-highlights")?.getClientRects().length)`)).toBe(true);
    expect(await browser.evaluate(`document.querySelector("#runtime-tree").innerText`)).not.toContain("没有可导航");
    await clickTreeControl(browser, reloadTree);
    await wait(browser, `document.querySelector('#runtime-tree [aria-current="true"]')`);
    await clickTreeControl(browser, loadOlder);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("失败")`);
    expect(await browser.evaluate(`document.querySelector('#runtime-tree [aria-current="true"]').textContent`)).toContain("当前节点");
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(loadOlder)})`)).toBe(true);
    await clickTreeControl(browser, loadOlder);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("重新读取")`);
    expect(detailReads).toEqual(["alpha/tree", "alpha/tree", "alpha/tree?cursor=older-token", "alpha/tree?cursor=older-token"]);
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(reloadTree)})`)).toBe(true);
    await clickTreeControl(browser, reloadTree);
    await wait(browser, `document.querySelector("#runtime-tree").innerText.includes("没有可导航")`);
    expect(detailReads.at(-1)).toBe("alpha/tree");
  });
});

browserTest("lazy details rejects late pages after close and session switch without stealing focus", async () => {
  await sidebar(1440, async ({ browser, detailReads, treeReplies }) => {
    await wait(browser, `document.querySelector(".metric-highlights")`);
    const closed = Promise.withResolvers<Response>();
    const switched = Promise.withResolvers<Response>();
    const closedStarted = Promise.withResolvers<void>();
    const switchedStarted = Promise.withResolvers<void>();
    treeReplies.push(() => { closedStarted.resolve(); return closed.promise; },
      () => { switchedStarted.resolve(); return switched.promise; }, treePage("beta-new", "乙会话节点"));
    await clickTreeControl(browser, treeSummary);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("正在")`);
    await closedStarted.promise;
    await browser.click("#details-button");
    closed.resolve(treePage("closed", "不应写入已关闭面板"));
    expect(await browser.evaluate("document.activeElement.id")).toBe("details-button");
    await browser.press("Enter");
    await wait(browser, `document.querySelector(${JSON.stringify(treeSummary)}) && document.querySelector(".metric-highlights")`);
    await clickTreeControl(browser, treeSummary);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("正在")`);
    await switchedStarted.promise;
    await browser.evaluate(`document.querySelector('button[data-session="beta"]').focus()`);
    await browser.press("Enter");
    await wait(browser, `document.querySelector("#session-title").textContent.endsWith("beta") &&
      document.querySelector("#details-dialog[open] #runtime-metrics .metric-highlights")?.getClientRects().length`);
    await browser.evaluate(`document.querySelector(${JSON.stringify(treeSummary)}).focus()`);
    expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(treeSummary)})`)).toBe(true);
    await browser.press("Enter");
    await wait(browser, `document.querySelector('#runtime-tree [aria-current="true"]')?.textContent.includes("乙会话节点")`);
    switched.resolve(treePage("late-alpha", "不应写入乙会话"));
    await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    expect(detailReads).toEqual(["alpha/tree", "alpha/tree", "beta/tree"]);
    expect(await browser.evaluate(`[
      document.querySelectorAll("#runtime-tree .tree li").length,
      document.querySelector('#runtime-tree [aria-current="true"]').textContent.includes("乙会话节点"),
      document.activeElement.matches(${JSON.stringify(treeSummary)})
    ]`)).toEqual([1, true, true]);
  });
});

browserTest("lazy details navigates with the rendered leaf, preserves confirmation and never submits the draft", async () => {
  await sidebar(1440, async ({ browser, detailReads, treeReplies, actions }) => {
    await wait(browser, `document.querySelector(".metric-highlights")`);
    treeReplies.push(treePage("history-user", "历史用户消息", "not-on-first-page"));
    await clickTreeControl(browser, treeSummary);
    await wait(browser, `document.querySelector("#runtime-tree [role=status]")?.textContent.includes("不在已加载")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-tree [aria-current]") === null`)).toBe(true);
    await browser.click("#prompt");
    await browser.type("保留的草稿");
    // Stub only the blocking platform dialog to inspect its copy and exercise both decisions.
    await browser.evaluate(`(() => { window.treeConfirmations = []; window.confirm = message => {
      window.treeConfirmations.push(message); return window.treeConfirmations.length > 1;
    }; })()`);
    const node = "#runtime-tree .tree button";
    await clickTreeControl(browser, node);
    expect(actions).toEqual([]);
    expect(await browser.evaluate(`[
      window.treeConfirmations[0].includes("替换当前草稿"), document.querySelector("#prompt").value
    ]`)).toEqual([true, "保留的草稿"]);
    await clickTreeControl(browser, node);
    await wait(browser, `document.querySelector("#prompt").value === "导航后的历史草稿" && document.querySelector(${JSON.stringify(reloadTree)})?.getClientRects().length`);
    expect(actions).toEqual([{ action: "navigate", targetId: "history-user", expectedLeafId: "not-on-first-page" }]);
    expect(detailReads).toEqual(["alpha/tree"]);
  });
});

browserTest("lazy details refreshes the visible runtime and falls back only when the live source is unsupported", async () => {
  await sidebar(1440, async ({ browser, detailReads, nativeReplies, dagHistoryReplies }) => {
    await wait(browser, `document.querySelector(".metric-highlights")`);
    const unsupported = { status: "unavailable", reason: "unsupported" };
    nativeReplies.push(Response.json({ tasks: unsupported, dag: unsupported, memory: { status: "empty" } }),
      Response.json({ code: "internal" }, { status: 500 }));
    dagHistoryReplies.push(Response.json(unsupported), Response.json({ code: "internal" }, { status: 500 }));
    await browser.click("#runtime-open-subagents");
    await wait(browser, `document.querySelector("#runtime-subagent").innerText.includes("非实时")`);
    const taskReads = ["alpha/native-runtime", "alpha/activity"];
    expect(detailReads).toEqual(taskReads);
    await browser.click("#runtime-open-dag");
    await wait(browser, `document.querySelector("#runtime-dag-current").innerText.includes("不支持此读取")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-dag-history").open`)).toBe(false);
    expect(await browser.evaluate(`document.querySelector("#runtime-dag").innerText`)).not.toContain("非实时");
    expect(detailReads).toEqual(taskReads);
    await clickTreeControl(browser, "#runtime-dag-history > summary");
    await wait(browser, `document.querySelector("#runtime-dag-history[open]").innerText.includes("非实时")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-dag-current").innerText`)).not.toContain("非实时");
    const withHistory = [...taskReads, "alpha/native-runtime/dag-history", "alpha/activity"];
    expect(detailReads).toEqual(withHistory);
    await clickTreeControl(browser, "#runtime-dag-history > summary");
    await browser.click("#details-refresh");
    await wait(browser, `document.querySelector("#runtime-dag-current").innerText.includes("读取失败或超时")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-dag").innerText`)).not.toContain("非实时");
    expect(detailReads).toEqual([...withHistory, "alpha/native-runtime"]);
    await clickTreeControl(browser, "#runtime-dag-history > summary");
    await wait(browser, `document.querySelector("#runtime-dag-history[open]").innerText.includes("读取失败或超时")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-dag").innerText`)).not.toContain("非实时");
    const afterFailure = [...withHistory, "alpha/native-runtime", "alpha/native-runtime/dag-history"];
    expect(detailReads).toEqual(afterFailure);
    await browser.click("#runtime-open-todo");
    await wait(browser, `document.querySelector("[data-runtime-branch] details[open]")?.innerText.includes("核对侧栏")`);
    expect(detailReads).toEqual([...afterFailure, todoRead]);
  });
});

browserTest("desktop dock opens without stealing focus and never becomes a modal when resized", async () => {
  await sidebar(1440, async ({ browser }) => {
    const pane = `document.querySelector("#details-dialog")`;
    expect(await browser.evaluate(`[${pane}.matches("[open]:not(:modal)"), document.activeElement.id]`))
      .toEqual([true, "conversation"]);
    await wait(browser, `document.querySelector(".metric-highlights")`);
    await capture(browser, "hud-1440-docked");
    await browser.click("#prompt");
    await browser.type("调整视口时保留的草稿");
    await browser.resize(1000, 720);
    await wait(browser, `!${pane}.open`);
    expect(await browser.evaluate(`document.activeElement.id`)).toBe("prompt");
    await browser.resize(320, 720);
    expect(await browser.evaluate(`${pane}.open`)).toBe(false);
    await capture(browser, "hud-320-closed");
    await browser.click("#details-button");
    expect(await browser.evaluate(`[${pane}.matches(":modal"), document.activeElement.id]`))
      .toEqual([true, "runtime-open-overview"]);
    await capture(browser, "hud-320-modal");
    await browser.resize(1100, 720);
    await wait(browser, `${pane}.matches("[open]:not(:modal)")`);
    expect(await browser.evaluate(`[document.activeElement.id, document.querySelector("#prompt").value]`))
      .toEqual(["runtime-open-overview", "调整视口时保留的草稿"]);
    await browser.resize(320, 720);
    await wait(browser, `!${pane}.open`);
    expect(await browser.evaluate(`document.activeElement.id`)).toBe("details-button");
  });
});

browserTest("desktop rail and deliberate inspector close are independent across sessions and reload", async () => {
  await sidebar(1100, async ({ browser }) => {
    const pane = `document.querySelector("#details-dialog")`;
    const chrome = () => browser.evaluate(`(() => {
      const rail = document.querySelector("#navigation");
      const main = document.querySelector("#conversation").getBoundingClientRect();
      return [rail.getBoundingClientRect().width, main.left, main.right,
        ${pane}.open, document.documentElement.scrollWidth];
    })()`);
    expect(await chrome()).toEqual([256, 256, 780, true, 1100]);
    await capture(browser, "hud-1100-docked");
    await browser.press("Tab");
    expect(await browser.evaluate("document.activeElement.id")).toBe("session-path-trigger");
    await browser.press("Tab");
    expect(await browser.evaluate("document.activeElement.id")).toBe("rail-toggle");
    await browser.press("Enter");
    expect(await chrome()).toEqual([0, 0, 780, true, 1100]);
    expect(await browser.evaluate(`[document.activeElement.id,
      document.activeElement.matches(":focus-visible"), document.activeElement.getAttribute("aria-expanded")]`))
      .toEqual(["rail-toggle", true, "false"]);
    await capture(browser, "hud-1100-rail-collapsed");
    await browser.press("Escape");
    expect(await chrome()).toEqual([0, 0, 1100, false, 1100]);
    expect(await browser.evaluate(`[
      document.activeElement.id, document.activeElement.matches(":focus-visible")
    ]`)).toEqual(["details-button", true]);
    await browser.cdp("Page.reload");
    await wait(browser, `document.querySelector("#connection").dataset.state === "online"`);
    expect(await chrome()).toEqual([0, 0, 1100, false, 1100]);
    await browser.click("#rail-toggle");
    await browser.click('[data-session="beta"]');
    await wait(browser, `!document.querySelector("#details-button").hidden`);
    expect(await chrome()).toEqual([256, 256, 1100, false, 1100]);
    await browser.click("#details-button");
    expect(await chrome()).toEqual([256, 256, 780, true, 1100]);
    await browser.click("#rail-toggle");
    await browser.resize(320, 720);
    await wait(browser, `!${pane}.open`);
    await browser.click("#open-navigation");
    expect(await browser.evaluate(`[document.activeElement.id,
      document.querySelector("#open-navigation").getAttribute("aria-expanded")]`)).toEqual(["search", "true"]);
    await browser.press("Escape");
    expect(await browser.evaluate(`document.activeElement.id`)).toBe("open-navigation");
    await browser.resize(1100, 720);
    await wait(browser, `${pane}.matches("[open]:not(:modal)")`);
    expect(await chrome()).toEqual([0, 0, 780, true, 1100]);
  });
});

browserTest("HUD operation motion is finite and does not delay keyboard focus", async () => {
  await sidebar(320, async ({ browser }) => {
    const running = () => browser.evaluate<string[]>(`document.querySelector("#details-dialog")
      .getAnimations({ subtree: true }).map(animation => animation.animationName)`);
    await browser.cdp("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-reduced-motion", value: "no-preference" }, { name: "forced-colors", value: "none" },
    ] });
    await browser.click("#details-button");
    expect(await running()).toContain("hud-sweep");
    expect(await running()).toContain("hud-panel-arrival");
    expect(await browser.evaluate("document.activeElement.id")).toBe("runtime-open-overview");
    if (process.env.OMO_SESSION_SIDEBAR_EVIDENCE) {
      await Bun.write(`${process.env.OMO_SESSION_SIDEBAR_EVIDENCE}/hud-320-motion.png`, await browser.screenshot());
    }
    await browser.evaluate(`Promise.all(document.querySelector("#details-dialog").getAnimations({ subtree: true })
      .map(animation => animation.finished)).then(() => true)`);
    expect(await running()).toEqual([]);
    await browser.press("Escape");
    for (const feature of [
      [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "forced-colors", value: "none" }],
      [{ name: "prefers-reduced-motion", value: "no-preference" }, { name: "forced-colors", value: "active" }],
    ]) {
      await browser.cdp("Emulation.setEmulatedMedia", { features: feature });
      await browser.press("Enter");
      expect(await running()).toEqual([]);
      expect(await browser.evaluate(`[
        document.activeElement.id, document.activeElement.matches(":focus-visible"),
        document.activeElement.getAttribute("aria-selected")
      ]`)).toEqual(["runtime-open-overview", true, "true"]);
      await browser.press("Escape");
    }
  });
});

browserTest("a manually opened compact sidebar keeps its name and focus when it docks or disconnects", async () => {
  await sidebar(1000, async ({ browser, disconnect }) => {
    expect(await browser.evaluate(`(() => {
      const toggle = document.querySelector("#details-button");
      return [toggle.innerText, toggle.getAttribute("aria-controls"), toggle.getAttribute("aria-expanded")];
    })()`)).toEqual(["会话侧栏", "details-dialog", "false"]);
    await browser.click("#prompt");
    await browser.type("未发草稿");
    await browser.evaluate(`Boolean(window.sidebarPane = document.querySelector("#details-dialog"))`);
    await browser.click("#details-button");
    await wait(browser, `document.querySelector("#runtime-metrics .metric-highlights")`);
    await wait(browser, `document.querySelector("#details-dialog:modal")`);
    expect(await accessibleNode(browser, "#details-dialog")).toEqual({ ignored: false, role: "dialog", name: "运行详情" });
    await browser.resize(320, 640);
    expect(await browser.evaluate(`(() => {
      const tabs = [...document.querySelectorAll("#runtime-shortcuts [role=tab]")];
      return [tabs.length, document.documentElement.scrollWidth, tabs.every(tab => {
        const {x,y,width,height,right} = tab.getBoundingClientRect();
        return width >= 44 && height >= 44 && right <= 320 && tab.contains(document.elementFromPoint(x+width/2,y+height/2));
      })];
    })()`)).toEqual([5, 320, true]);
    await capture(browser, "320-overview");
    await browser.resize(1001, 720);
    await wait(browser, `document.querySelector("#details-dialog[open]:not(:modal)")`);
    expect(await browser.evaluate(`[document.querySelector("#details-dialog") === window.sidebarPane,
      document.querySelector("#details-dialog").getBoundingClientRect().right, document.activeElement.id]`))
      .toEqual([true, 1001, "runtime-open-overview"]);
    await capture(browser, "desktop-overview");
    disconnect();
    await wait(browser, `document.querySelector("#connection").dataset.state === "offline"`);
    expect(await browser.evaluate(`[
      document.querySelector("#banner:not([hidden])").innerText.includes("实时连接已断开"),
      document.activeElement.id,
      document.querySelector("#prompt").value
    ]`)).toEqual([true, "runtime-open-overview", "未发草稿"]);
    await browser.press("Escape");
    expect(await browser.evaluate(`[document.activeElement.id, document.querySelector("#prompt").value]`))
      .toEqual(["details-button", "未发草稿"]);
  });
});

browserTest("session sidebar uses live readings and loads text-only project rules only on demand", async () => {
  await sidebar(320, async ({ browser, reads, events, setSnapshot }) => {
    await browser.click("#details-button");
    await wait(browser, `document.querySelector("#runtime-metrics .metric-highlights")`);
    const metrics = () => browser.evaluate<string>(`document.querySelector("#runtime-metrics").textContent`);
    expect(await metrics()).toMatch(/0 \(0%\).*128,000 token/);
    expect(await metrics()).toMatch(/模型fixture · Local review.*生效思考档高.*快速模式关闭.*最近流式 · Web 观测52.1 token\/s/);
    await browser.evaluate(`document.querySelector(".metric-breakdown summary").scrollIntoView({ block: "center" })`);
    await browser.click(".metric-breakdown summary");
    events({ type: "generation_speed", generationSpeed: { tokensPerSecond: 65, measuredAt: 4 } });
    await wait(browser, `document.querySelector("#runtime-metrics").textContent.includes("65 token/s")`);
    expect(await browser.evaluate(`document.activeElement.matches(".metric-breakdown summary")`)).toBe(true);
    events({ type: "service_tier_changed", fastMode: true });
    await wait(browser, `document.querySelector("#runtime-metrics").textContent.includes("快速模式开启")`);
    setSnapshot({ generationSpeed: { tokensPerSecond: 75, measuredAt: 5 },
      state: { fastMode: true, contextUsage: { tokens: 32000, percent: 25, contextWindow: 128000 } } });
    events({ type: "agent_settled" });
    await wait(browser, `document.querySelector("#runtime-metrics").textContent.includes("75 token/s")`);
    expect(await metrics()).toMatch(/上下文已用25%.*32,000 \(25%\)/);
    await browser.click("#runtime-open-todo");
    await clickTreeControl(browser, "#runtime-memory-branch summary");
    await wait(browser, `document.querySelector("#runtime-todo #runtime-journal dd")?.getClientRects().length`);
    expect(reads).toEqual([]);
    expect(await browser.evaluate(`[...document.querySelectorAll("#runtime-journal dd")].map(node => node.textContent)`))
      .toEqual(["8", "0"]);
    expect(await browser.evaluate(`document.querySelector("#runtime-memory-branch").innerText`)).toContain("3");
    await browser.evaluate(`document.querySelector("#runtime-instructions summary").scrollIntoView({ block: "center" })`);
    await browser.click("#runtime-instructions summary");
    await wait(browser, `!document.querySelector("#runtime-instructions-text").hidden`);
    expect(reads).toEqual(["GET alpha"]);
    expect(await browser.evaluate(`(() => {
      const raw = document.querySelector("#runtime-instructions-text");
      return [raw.textContent, raw.childElementCount, Boolean(window.rulesExecuted)];
    })()`)).toEqual([ruleText, 0, false]);
    await browser.evaluate(`document.querySelector("#runtime-instructions summary").scrollIntoView({block:"center"})`);
    await capture(browser, "320-materials");
    await browser.resize(1440, 720);
    await wait(browser, `document.querySelector("#details-dialog[open]:not(:modal)")`);
    expect(await browser.evaluate(`document.querySelector("#runtime-instructions").open`)).toBe(true);
    await capture(browser, "desktop-materials");
    await browser.click("#runtime-instructions summary");
    await browser.evaluate(`(() => {
      const fetch = window.fetch;
      window.interceptedRules = 0;
      window.fetch = (...args) => {
        if (!String(args[0]).endsWith("/alpha/instructions")) return fetch(...args);
        window.interceptedRules++;
        window.rulesSignal = args[1].signal;
        return new Promise(resolve => {
          window.deliverRules = () => resolve(Response.json({status:"ok",file:"AGENTS.md",content:"Old alpha reply"}));
        });
      };
    })()`);
    await browser.click("#runtime-instructions summary");
    await wait(browser, `window.interceptedRules === 1`);
    await browser.click("#runtime-instructions summary");
    await wait(browser, `window.rulesSignal.aborted`);
    await browser.evaluate(`(async () => { window.deliverRules(); await new Promise(requestAnimationFrame); })()`);
    expect(await browser.evaluate(`document.querySelector("#runtime-instructions-text").textContent`)).toBe("");
    await browser.click("#runtime-instructions summary");
    await wait(browser, `window.interceptedRules === 2`);
    await browser.click('[data-session="beta"]');
    await wait(browser, `!document.querySelector("#details-button").hidden && document.querySelector("#session-title").textContent.endsWith("beta")`);
    expect(await browser.evaluate(`window.rulesSignal.aborted`)).toBe(true);
    await wait(browser, `document.querySelector("#runtime-metrics .metric-highlights")`);
    expect(await metrics()).toContain("未测得");
    await browser.click("#runtime-open-todo");
    expect(await browser.evaluate(`document.querySelector("#runtime-instructions").open`)).toBe(false);
    await browser.click("#runtime-instructions summary");
    await wait(browser, `document.querySelector("#runtime-instructions-status").textContent.includes("没有 AGENTS.md")`);
    await browser.evaluate(`(async () => { window.deliverRules(); await new Promise(requestAnimationFrame); })()`);
    expect(await browser.evaluate(`document.querySelector("#runtime-instructions").textContent`)).not.toContain("Old alpha reply");
    expect(reads).toEqual(["GET alpha", "GET beta"]);
  });
});

browserTest("overview exposes rules and memory without another tab or an eager rules request", async () => {
  await sidebar(1440, async ({ browser, events, reads }) => {
    expect(await browser.evaluate(`(() => {
      const toggle = document.querySelector("#details-button svg");
      const navigation = document.querySelector("#open-navigation svg");
      return [toggle, navigation].map(icon => [icon.querySelector("use").getAttribute("href"), icon.getAttribute("viewBox")]);
    })()`)).toEqual([["/icons.svg#hud-panel", "0 0 15 15"], ["/icons.svg#hud-navigation", "0 0 15 15"]]);
    await wait(browser, `document.querySelector("#runtime-metrics .metric-tile")`);
    for (const width of [1440, 320]) {
      if (width === 320) {
        await browser.resize(width, 640);
        await wait(browser, `!document.querySelector("#details-dialog").open`);
        await browser.click("#details-button");
        await wait(browser, `document.querySelector("#details-dialog:modal")`);
        await wait(browser, `document.querySelector("#runtime-open-resources")`);
      }
      expect(await browser.evaluate(`(() => {
        const shortcut = document.querySelector("#runtime-open-resources");
        if (!shortcut) return null;
        const { x, y, width, height } = shortcut.getBoundingClientRect();
        return {
          tabs: document.querySelectorAll("#runtime-shortcuts [role=tab]").length,
          fits: shortcut.contains(document.elementFromPoint(x + width / 2, y + height / 2)),
          usable: innerWidth > 1000 || width >= 44 && height >= 44
        };
      })()`)).toEqual({ tabs: 5, fits: true, usable: true });
      expect(await accessibleNode(browser, "#runtime-open-resources")).toEqual({ ignored: false, role: "button", name: "规则与记忆" });
      await capture(browser, `${width}-overview-resources`);
      if (width === 1440) {
        await browser.evaluate(`document.querySelector("#runtime-open-resources").focus()`);
        events({ type: "generation_speed", generationSpeed: { tokensPerSecond: 65, measuredAt: 3 } });
        await wait(browser, `document.querySelector("#runtime-metrics").innerText.includes("65 token/s")`);
        expect(await browser.evaluate(`document.activeElement.id`)).toBe("runtime-open-resources");
        await browser.press("Enter");
      } else {
        await browser.click("#runtime-open-resources");
      }
      await wait(browser, `document.querySelector("#runtime-journal dd")?.getClientRects().length`);
      expect(await browser.evaluate(`[
        document.querySelector("#runtime-open-todo").getAttribute("aria-selected"),
        document.activeElement.id,
        document.querySelector("#runtime-instructions").open,
        Boolean(document.querySelector("#runtime-journal dd")?.getClientRects().length)
      ]`)).toEqual(["true", "runtime-resources-title", false, true]);
      expect(reads).toEqual([]);
      await capture(browser, `${width}-resources-destination`);
      if (width === 1440) await browser.click("#runtime-open-overview");
    }
  });
});

browserTest("session sidebar jumps from the narrow modal to the existing question and keeps both drafts", async () => {
  await sidebar(320, async ({ browser, events, actions, setSnapshot }) => {
    expect(await browser.evaluate(`document.querySelector("#details-dialog").open`)).toBe(false);
    expect(await accessibleNode(browser, "#details-button")).toEqual({ ignored: false, role: "button", name: "会话侧栏" });
    await browser.evaluate(`document.querySelector("#prompt").focus()`);
    await browser.type("正文草稿");
    events({ type: "ui_request_pending", request: { id: "approval", method: "confirm", title: "普通批准" } });
    events({ type: "ui_request_pending", request: question });
    events({ type: "ui_request_pending", request: { ...question, id: "question-two", requestId: "native-two" } });
    await wait(browser, `document.querySelector('#interactions form[data-method=question]')`);
    await browser.evaluate(`document.querySelector('#interactions form[data-method="question"] textarea').focus()`);
    await browser.type("问题草稿");
    await browser.click("#details-button");
    await wait(browser, `document.querySelector("#details-dialog:modal")`);
    expect(await browser.evaluate(`document.querySelector("#sidebar-question")?.innerText`)).toBe("Agent 提问 · 2");
    const timing = { deadlineAtMs: 1795688400000 };
    setSnapshot({ state: { pendingQuestions: [question] } });
    events({ type: "question_resolved", id: "question-two" });
    await wait(browser, `document.querySelector("#sidebar-question").textContent === "Agent 提问 · 1"`);
    expect(await browser.evaluate(`(() => {
      const shortcut = document.querySelector("#sidebar-question");
      const {x, y, width, height, right} = shortcut.getBoundingClientRect();
      return height >= 44 && right <= 320 && shortcut.contains(document.elementFromPoint(x+width/2,y+height/2));
    })()`)).toBe(true);
    await capture(browser, "320-pending");
    await browser.click("#sidebar-question");
    expect(await browser.evaluate(`({
      modal: document.querySelector("#details-dialog").open,
      focused: document.activeElement.dataset.method,
      forms: document.querySelectorAll("form[data-method=question]").length,
      draft: document.querySelector("#prompt").value
    })`)).toEqual({ modal: false, focused: "question", forms: 1, draft: "正文草稿" });
    setSnapshot({ state: { pendingQuestions: [{ ...question, ...timing }] } });
    events({ type: "question_updated", requestId: "native-one", ...timing });
    await wait(browser, `(() => {
      const metadata = document.querySelector("[data-question-metadata]");
      return metadata?.getClientRects().length &&
        metadata.innerText.includes(new Date(${timing.deadlineAtMs}).toLocaleString());
    })()`);
    expect(await browser.evaluate(`document.querySelector('form[data-method=question] textarea').value`)).toBe("问题草稿");
    setSnapshot({});
    await browser.click('form[data-method="question"] button[type=submit]');
    await wait(browser, `!document.querySelector('form[data-method=question]')`);
    await browser.click("#details-button");
    expect(await browser.evaluate(`document.querySelector("#sidebar-question").hidden`)).toBe(true);
    expect(actions).toHaveLength(1);
  });
});

browserTest("a held session snapshot cannot resurrect settled forms or rewind live question metadata", async () => {
  await sidebar(1440, async ({ browser, events, setSnapshot, holdNextSnapshot }) => {
    const deadlineAtMs = 1795688400000;
    const pending = { ...question, id: "pending", requestId: "native-pending", title: "等待保留的问题", deadlineAtMs: deadlineAtMs - 90_000 };
    const crossed = { ...question, id: "crossed", requestId: "native-crossed", title: "GET 发出后才出现的问题" };
    const questions = `Array.from(document.querySelectorAll('#interactions form[data-method=question]'))`;
    const count = () => browser.evaluate(`document.querySelector("#sidebar-question").textContent`);
    events({ type: "ui_request_pending", request: question });
    events({ type: "ui_request_pending", request: pending });
    await wait(browser, `${questions}.length === 2`);
    await browser.evaluate(`(() => {
      const survivor = ${questions}.find(form => form.textContent.includes("等待保留的问题"));
      survivor.querySelector("textarea").value = "保留答复";
    })()`);
    const marker = { role: "assistant", content: "已接纳挂起的 GET 响应。" };
    setSnapshot({ state: { pendingQuestions: [question, pending, crossed] }, messages: [firstMessage, marker] });
    const gate = holdNextSnapshot();
    try {
      events({ type: "agent_idle" });
      await gate.requested;
      setSnapshot({ state: { pendingQuestions: [{ ...pending, deadlineAtMs }] } });
      events({ type: "ui_request_pending", request: crossed });
      await wait(browser, `${questions}.length === 3`);
      events({ type: "question_updated", requestId: "native-pending", deadlineAtMs });
      events({ type: "question_resolved", id: question.id });
      events({ type: "question_resolved", requestId: "native-crossed" });
      await wait(browser, `${questions}.length === 1`);
      expect(await count()).toBe("Agent 提问 · 1");
    } finally {
      gate.release();
    }
    await wait(browser, `document.querySelector("#messages").textContent.includes(${JSON.stringify(marker.content)})`);
    expect(await browser.evaluate(`${questions}.map(form => [
      form.querySelector(".request-title").textContent,
      form.querySelector("[data-question-metadata]").innerText.includes(new Date(${deadlineAtMs}).toLocaleString()),
      form.querySelector("textarea").value
    ])`)).toEqual([[pending.title, true, "保留答复"]]);
    expect(await count()).toBe("Agent 提问 · 1");
  });
});

browserTest("a held session snapshot cannot restore generation speed after engine offline", async () => {
  await sidebar(1440, async ({ browser, events, setSnapshot, holdNextSnapshot }) => {
    const metrics = `document.querySelector("#runtime-metrics").innerText`;
    await wait(browser, `${metrics}.includes("52.1 token/s")`);
    const marker = { role: "assistant", content: "已接纳离线前发出的快照。" };
    setSnapshot({ generationSpeed: { tokensPerSecond: 73, measuredAt: 4 }, messages: [firstMessage, marker] });
    const gate = holdNextSnapshot();
    try {
      events({ type: "agent_idle" });
      await gate.requested;
      events({ type: "engine", engine: { online: false } });
      await wait(browser, `document.querySelector("#connection").dataset.state === "offline" && ${metrics}.includes("未测得")`);
    } finally {
      gate.release();
    }
    await wait(browser, `document.querySelector("#messages").textContent.includes(${JSON.stringify(marker.content)})`);
    expect(await browser.evaluate(metrics)).toContain("未测得");
    expect(await browser.evaluate(metrics)).not.toContain("73 token/s");
  });
});

browserTest("settled turns update the open dock's Todo and retain disclosure focus and newer speed", async () => {
  await sidebar(1440, async ({ browser, events, setSnapshot, setTodo }) => {
    const todo = `document.querySelector("#runtime-todo [data-runtime-branch]")`;
    // The overview load is lazy and leaving its tab cancels an unfinished read.
    await wait(browser, `document.querySelector("#runtime-metrics").textContent.includes("52.1 token/s")`);
    await browser.click("#runtime-open-todo");
    await wait(browser, `${todo}?.textContent.includes("没有当前待办")`);
    expect(await browser.evaluate(`${todo}.querySelector("summary") === null`)).toBe(true);
    setTodo("新原生待办");
    events({ type: "agent_settled" });
    await wait(browser, `${todo}.querySelector("summary")`);
    expect(await browser.evaluate("document.activeElement.id")).toBe("runtime-open-todo");

    await browser.press("Tab");
    await browser.press("Tab");
    expect(await browser.evaluate(`document.activeElement === ${todo}.querySelector("summary")`)).toBe(true);
    expect(await browser.evaluate(`${todo}.querySelector("details").open`)).toBe(true);
    await browser.press("Enter");
    expect(await browser.evaluate(`${todo}.querySelector("details").open`)).toBe(false);
    await browser.press("Enter");
    setSnapshot({ generationSpeed: { tokensPerSecond: 71, measuredAt: 3 } });
    events({ type: "generation_speed", generationSpeed: { tokensPerSecond: 71, measuredAt: 3 } });
    setTodo("已刷新原生待办");
    events({ type: "agent_settled" });
    await wait(browser, `${todo}.textContent.includes("已刷新原生待办")`);
    expect(await browser.evaluate(`[
      ${todo}.querySelector("details").open,
      document.activeElement === ${todo}.querySelector("summary"),
      document.activeElement.matches(":focus-visible"),
      document.querySelector("#runtime-metrics").textContent.includes("71 token/s")
    ]`)).toEqual([true, true, true, true]);
  }, null);
});
