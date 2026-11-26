import { expect, test } from "bun:test";

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const initialSession = {
  id: "workbench-alignment", name: "会话 · 上线检查", cwd: "/fixture/common/prefix/workbench-alpha",
  active: true, archived: false, settled: false, running: false,
};

async function workbench(width: number, height: number, run: (browser: Bun.WebView, actions: readonly unknown[]) => Promise<void>,
  running = false, beforeDetails?: (read: number) => Promise<void>, ledger = false) {
  const session = { ...initialSession, ...(ledger ? { name: "会话 · 工作台检查", cwd: "/fixture/workbench" } : {}), running };
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not build the alignment fixture");
  const actions: unknown[] = [];
  let detailsReads = 0;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/workbench.css": () => new Response(Bun.file("public/workbench.css")),
      "/tool-ledger.css": () => new Response(Bun.file("public/tool-ledger.css")),
      "/dag-graph.css": () => new Response(Bun.file("public/dag-graph.css")),
      "/icons.svg": () => new Response(Bun.file("public/icons.svg")),
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true }, token: "fixture" }),
      "/api/cli-history": Response.json({ available: true, sessions: [] }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { controller.enqueue(": fixture\n\n"); },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`/api/sessions/${session.id}`]: Response.json({
        session, state: { isStreaming: running, pendingMessageCount: running ? 2 : 0,
          effectivePermissionPreset: running ? "full-access" : "ask",
          model: { provider: "fixture", id: "review", reasoning: true }, thinkingLevel: "high",
          contextUsage: { percent: ledger ? 27.109 : 27.094 },
          ...(!ledger && { usageTotals: { latestCacheHitRate: 64, input: 36, cacheRead: 64, cacheWrite: 0 } }) },
        messages: ledger ? ledgerMessages : [{ role: "user", content: "做一次检查。" }, { role: "assistant", content: "检查完成。" }],
      }),
      [`/api/sessions/${session.id}/options`]: Response.json({ levels: ["off", "low", "high"], commands: [
        { invocation: "/other", description: "Session information", source: "extension" },
        { invocation: "$local-check", description: "Check current workspace", source: "skill" },
      ], models: [
        { provider: "fixture", id: "review", name: "Local review", reasoning: true },
        { provider: "fixture", id: "long", name: "很长的本地工作区模型名称 · Local reasoning and review for the workbench", reasoning: true },
      ] }),
      [`/api/sessions/${session.id}/model-preview`]: Response.json({
        status: "ok", level: "high", source: "session", availableLevels: ["off", "low", "high"],
      }),
      [`/api/sessions/${session.id}/actions`]: async (request: Request) => {
        actions.push(await request.json());
        return Response.json({ session, result: {} });
      },
      [`/api/sessions/${session.id}/workbench-status`]: Response.json({
        status: "ok", currentTodo: ledger ? "回看浏览器输出" : "检查窄屏", pendingTodo: 2,
      }),
      [`/api/sessions/${session.id}/details`]: async () => {
        const read = ++detailsReads;
        await beforeDetails?.(read);
        return Response.json({
          stats: { contextUsage: { tokens: 34700, contextWindow: 128000, percent: 27.109 }, cost: read === 1 ? 0 : 0.01234 },
          runtime: { status: "ok", todo: { status: "ok", phases: [{ name: "检查",
            tasks: [{ status: "in_progress", content: "检查窄屏" }, { status: "pending", content: "复查焦点" }] }] } },
        });
      },
      [`/api/sessions/${session.id}/native-runtime`]: Response.json({
        tasks: { status: "empty" }, memory: { status: "ok", totalSteps: 0, reflectedSteps: 0 },
        dag: { status: "ok", limitReached: false, rows: [{
          status: "running", createdAt: 1795636800000, updatedAt: 1795636800000,
          nodeCount: 2, counts: { running: 1, completed: 1 }, key: "b".repeat(64),
        }] },
      }),
      [`/api/sessions/${session.id}/native-runtime/dag/${"b".repeat(64)}`]: Response.json({
        status: "ok", runStatus: "running", waves: [{ index: 0, nodes: [0] }, { index: 1, nodes: [1] }],
        nodes: [{ id: 0, state: "completed", attempt: 1, upstream: [] },
          { id: 1, state: "running", attempt: 2, upstream: [0] }],
      }),
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width, height });
  await browser.navigate(server.url.href);
  const viewport = await browser.evaluate<[number, number]>("([innerWidth, innerHeight])");
  if (viewport[0] !== width || viewport[1] !== height) await browser.resize(width, height);
  expect(await browser.evaluate("([innerWidth, innerHeight])")).toEqual([width, height]);
  await browser.evaluate(`new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Workstation fixture not online")), 4000);
    const watcher = new MutationObserver(check);
    function check() {
      if (document.querySelector("#connection")?.dataset.state !== "online") return;
      watcher.disconnect(); clearTimeout(timer); done(true);
    }
    watcher.observe(document.body, { subtree: true, attributes: true }); check();
  })`);
  if (width <= 760) await browser.click("#open-navigation");
  await browser.click("#session-list button");
  await browser.evaluate(`new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Workstation fixture did not render")), 4000);
    const watcher = new MutationObserver(check);
    function check() {
      if (!document.querySelector("#messages article") || document.querySelector("#context-usage")?.hidden) return;
      watcher.disconnect(); clearTimeout(timer); done(true);
    }
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true }); check();
  })`);
  await run(browser, actions);
}

const visible = (browser: Bun.WebView, selector: string) => browser.evaluate(`new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error(${JSON.stringify(`Not visible: ${selector}`)})), 3500);
  const watcher = new MutationObserver(check);
  function check() {
    if (!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length) return;
    watcher.disconnect(); clearTimeout(timer); done(true);
  }
  watcher.observe(document.body, { childList: true, subtree: true, attributes: true }); check();
})`);

async function captureAlignment(browser: Bun.WebView, name: string) {
  const directory = process.env.OMO_WORKBENCH_ALIGNMENT_EVIDENCE;
  if (!directory) return;
  for (const theme of ["light", "dark"]) {
    await browser.evaluate(`(async () => {
      const theme = document.querySelector("#theme");
      theme.value = "${theme}"; theme.dispatchEvent(new Event("change"));
      await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
    })()`);
    await Bun.write(`${directory}/${name}-${theme}.png`, await browser.screenshot());
  }
}

// Reproduce the supplied before capture's conversation, including the original call order.
const timestamp = Date.UTC(2026, 10, 26, 16);
const say = (role: "user" | "assistant", id: string, content: string) => ({ role, id, content, timestamp });
function calls(records: readonly (readonly [name: string, args: object, failed?: boolean])[], text?: string) {
  const ids = records.map(([name]) => `fixture-${name}`);
  return [{
    role: "assistant", id: ids.join("+"), stopReason: "toolUse", timestamp,
    content: [...(text ? [{ type: "text", text }] : []),
      ...records.map(([name, args], index) => ({ type: "toolCall", id: ids[index], name, arguments: args }))],
  }, ...records.map(([toolName, , failed], index) => ({
    role: "toolResult", toolCallId: ids[index], toolName, isError: failed ?? false, content: failed ? "同步插件未配置" : "检查记录",
  }))];
}
const ledgerMessages = [
  say("user", "input", "把上线前的检查跑一遍。先读项目说明，再核对待办和工具输出。"),
  say("assistant", "first", "我先查清工作区里的说明和当前待办。原有文件只读，不改动。"),
  ...calls([["read", { path: "README.md" }], ["grep", { path: "src" }]]),
  ...calls([["ctx_execute", { language: "shell", code: "pwd" }]]),
  ...calls([["eval", { action: "run", code: "print('fixture')" }]]),
  say("assistant", "second", "接下来单独确认终端、待办和记忆的展示，不把这些结果混成一条回复。"),
  ...calls([["bash", { command: "pwd" }]]),
  say("assistant", "third", "终端已返回。开始整理检查项。"),
  ...calls([["todo", { op: "view" }]]),
  ...calls([["memory", { command: "view" }]], "记忆与命令输出是两个独立来源。"),
  ...calls([["workspace_sync_extra", {}, true]]),
  say("assistant", "last", "## 检查小结\n工作区和待办已核对。**同步插件未配置**，这项单独留在执行记录里。"),
];

for (const [width, height, baselineTranscript, baselineComposer, baselineComplete] of [
  [320, 640, 391, 151, 4], [390, 844, 595, 151, 7], [1100, 540, 342.109375, 115, 6], [1440, 900, 702.109375, 115, 11],
] as const) {
  browserTest(`center column at ${width}×${height} separates roles and editor controls without losing reading room`, async () => {
    await workbench(width, height, async (browser, actions) => {
      await browser.click("#prompt");
      await browser.type("只保留这条未发草稿。");
      await browser.evaluate(`document.querySelector("#transcript").scrollTop = 0`);
      await captureAlignment(browser, `ledger-${width}-top`);
      const layout = await browser.evaluate<{
        roleGlyphs: boolean; boundedInput: boolean; quietReply: boolean; sharedAxis: boolean;
        divider: number; transcript: number; composer: number; bodyFont: string[];
        complete: number; noOverflow: boolean; onePrimary: boolean;
      }>(`(() => {
        const find = selector => document.querySelector(selector);
        const rect = selector => find(selector).getBoundingClientRect();
        const user = find("#messages .message--user");
        const reply = find("#messages article:has(.prose)");
        const userBody = user.querySelector(".message-body");
        const userText = user.querySelector(".plain");
        const replyText = reply.querySelector(".prose");
        const edge = rect("#transcript");
        const icons = [user, reply].map(row => row.querySelector("header svg"));
        return {
          roleGlyphs: icons.every(icon => icon?.getBoundingClientRect().width > 0 && icon.getAttribute("aria-hidden") === "true") &&
            icons[0].querySelector("path").getAttribute("d") !== icons[1].querySelector("path").getAttribute("d"),
          boundedInput: getComputedStyle(userBody).borderTopStyle === "solid" &&
            getComputedStyle(userBody).backgroundColor !== getComputedStyle(reply).backgroundColor,
          quietReply: getComputedStyle(reply).backgroundColor === "rgba(0, 0, 0, 0)",
          sharedAxis: userText.getBoundingClientRect().left === replyText.firstElementChild.getBoundingClientRect().left &&
            rect("#messages .message--user").left === rect(".compose-box").left,
          divider: parseFloat(getComputedStyle(find(".compose-toolbar")).borderTopWidth),
          transcript: edge.height, composer: rect("#composer-shell").height,
          bodyFont: [userText, replyText, find("#prompt")].map(node => getComputedStyle(node).fontSize),
          complete: [...document.querySelector("#messages").children].filter(element => {
            const box = element.getBoundingClientRect();
            return box.height > 0 && box.top >= edge.top && box.bottom <= edge.bottom;
          }).length,
          noOverflow: [document.documentElement, find("#transcript")].every(node => node.scrollWidth === node.clientWidth),
          onePrimary: [...document.querySelectorAll(".compose-submit .button--primary:not([hidden])")].length === 1,
        };
      })()`);
      const directory = process.env.OMO_WORKBENCH_ALIGNMENT_EVIDENCE;
      if (directory) await Bun.write(`${directory}/ledger-${width}.json`, JSON.stringify(layout, null, 2));
      await browser.evaluate(`document.querySelector("#transcript").scrollTop = document.querySelector("#transcript").scrollHeight`);
      await captureAlignment(browser, `ledger-${width}-tail`);
      expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("只保留这条未发草稿。");
      expect(actions).toEqual([]);
      expect(layout).toMatchObject({
        roleGlyphs: true, boundedInput: true, quietReply: true, sharedAxis: true, divider: 1,
        bodyFont: ["16px", "16px", "16px"], noOverflow: true, onePrimary: true,
      });
      expect(layout.transcript).toBeGreaterThanOrEqual(baselineTranscript);
      expect(layout.composer).toBeLessThanOrEqual(baselineComposer);
      expect(layout.complete).toBeGreaterThanOrEqual(baselineComplete);
    }, false, undefined, true);
  });
}

browserTest("at 320×420 a multiline draft scrolls in the field without covering the keyboard controls", async () => {
  await workbench(320, 640, async (browser, actions) => {
    // Enter via the ordinary phone layout, then exercise the editor after the viewport shrinks.
    await browser.resize(320, 420);
    expect(await browser.evaluate("([innerWidth, innerHeight])")).toEqual([320, 420]);
    const lines = ["第一行草稿", "第二行仍可编辑", "第三行滚动保留", "第四行不盖住工具栏"];
    await browser.click("#prompt");
    for (const [index, line] of lines.entries()) {
      if (index) await browser.press("Enter");
      await browser.type(line);
    }
    await browser.press("Tab");
    expect(await browser.evaluate("document.activeElement.id")).toBe("compose-options-button");
    await browser.press("Enter");
    await visible(browser, "#model:enabled");
    await browser.press("Tab");
    expect(await browser.evaluate("document.activeElement.id")).toBe("model");
    await browser.press("Escape");
    expect(await browser.evaluate("document.activeElement.id")).toBe("compose-options-button");
    await captureAlignment(browser, "ledger-320x420-long-draft");
    expect(await browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      const send = document.querySelector("#send");
      const { x, y, width, height, bottom } = send.getBoundingClientRect();
      return {
        draft: prompt.value,
        fieldScroll: prompt.scrollHeight > prompt.clientHeight,
        sendHit: document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button") === send,
        inside: bottom <= innerHeight && height >= 44,
        pageOverflow: document.documentElement.scrollHeight - innerHeight,
      };
    })()`)).toEqual({ draft: lines.join("\n"), fieldScroll: true, sendHit: true, inside: true, pageOverflow: 0 });
    expect(actions).toEqual([]);
  }, false, undefined, true);
});

for (const [width, height, docked, compact] of [
  [320, 640, false, true], [390, 844, false, true], [740, 720, false, false], [761, 720, false, true],
  [1001, 720, true, true],
  [1100, 540, true, true], [1440, 720, true, false], [1920, 900, true, false],
] as const) {
  browserTest(`panel-driven alignment at ${width}×${height}${docked ? " with inspector" : ""}`, async () => {
    await workbench(width, height, async browser => {
      if (docked) {
        await visible(browser, "#runtime-metrics .metric-highlights");
      }
      await captureAlignment(browser, `alignment-${width}x${height}`);
      const layout = await browser.evaluate<{
        titleFits: boolean; toolbarRows: number; metaRows: number; options: boolean; model: boolean;
        titleX: number; traceX: number; ledgerX: number; editorX: number; transcript: number;
        accessibleActions: boolean; touch: boolean; pageOverflow: [number, number]; overflowingShells: string[];
      }>(`(() => {
        const find = selector => document.querySelector(selector);
        const rect = selector => find(selector).getBoundingClientRect();
        const shown = selector => Boolean(find(selector).getClientRects().length);
        const title = find("#session-title");
        const controls = ["#compose-options-button", "#model", "#thinking", "#prompt-mode", "#approval", "#attach", "#send"];
        const header = ["#open-navigation", "#rail-toggle", "#details-button", "#web-branch-button", "#manage-button"];
        const rows = selectors => new Set(selectors.filter(shown).map(selector => Math.round(rect(selector).top + rect(selector).height / 2))).size;
        return {
          titleFits: title.clientHeight <= parseFloat(getComputedStyle(title).lineHeight) + 1 && title.scrollWidth <= title.clientWidth,
          toolbarRows: rows(controls),
          metaRows: rows(["#current-todo", "#command-mode"]),
          options: shown("#compose-options-button"), model: shown("#model"),
          titleX: rect(".session-heading").left, traceX: rect(".trace-inner").left,
          ledgerX: rect("#messages .message header").left, editorX: rect(".compose-box").left,
          transcript: rect("#transcript").height,
          pageOverflow: [document.documentElement.scrollWidth - document.documentElement.clientWidth, document.documentElement.scrollHeight - innerHeight],
          overflowingShells: [".workspace", ".sidebar", ".main", "#details-dialog", "#details-scroll", "body"].map(selector =>
            [selector, rect(selector).bottom, find(selector).scrollHeight, find(selector).clientHeight, getComputedStyle(find(selector)).overflowY].join(":")),
          accessibleActions: header.filter(shown).every(selector => {
            const button = find(selector);
            return Boolean(button.getAttribute("aria-label") || button.textContent.trim());
          }),
          touch: [...header, ...controls].filter(shown).every(selector => rect(selector).width >= 44 && rect(selector).height >= 44)
        };
      })()`);
      const directory = process.env.OMO_WORKBENCH_ALIGNMENT_EVIDENCE;
      if (directory) await Bun.write(`${directory}/alignment-${width}x${height}.json`, JSON.stringify(layout, null, 2));
      expect(layout.titleFits).toBe(true);
      expect(layout.toolbarRows).toBe(1);
      expect(layout.metaRows).toBe(1);
      expect(layout.options).toBe(compact);
      expect(layout.model).toBe(!compact);
      expect(layout.accessibleActions).toBe(true);
      if (layout.pageOverflow.some(Boolean)) throw new Error(`Page overflow ${layout.pageOverflow}: ${layout.overflowingShells.join(", ")}`);
      expect(layout.ledgerX).toBe(layout.traceX);
      expect(layout.editorX).toBe(layout.traceX);
      if (width > 760) expect(layout.titleX).toBe(layout.traceX);
      else expect(layout.touch).toBe(true);
      if (width === 320) expect(layout.transcript).toBeGreaterThan(360);
      if (width === 1100) expect(layout.transcript).toBeGreaterThan(330);
    });
  });
}

browserTest("compact options keep the draft and keyboard focus through a panel width change", async () => {
  await workbench(1440, 720, async (browser, actions) => {
    const options = "#compose-options-button";
    const focus = () => browser.evaluate<string>("document.activeElement.id");
    const waitForFocus = (id: string) => browser.evaluate(`new Promise((done, fail) => {
      const events = new AbortController();
      const timer = setTimeout(() => { events.abort(); fail(new Error("Focus did not move to ${id}")); }, 3000);
      function check() {
        if (document.activeElement.id !== "${id}") return;
        events.abort(); clearTimeout(timer); done(true);
      }
      document.addEventListener("focusin", check, { signal: events.signal }); check();
    })`);
    await visible(browser, "#model:enabled");
    await browser.click("#prompt");
    await browser.type("keep this draft");
    await browser.evaluate(`document.querySelector("#model").focus()`);
    await browser.resize(761, 720);
    await visible(browser, options);
    await waitForFocus("compose-options-button");
    expect(await browser.evaluate(`document.querySelector("${options}").getAttribute("aria-expanded")`)).toBe("false");
    await browser.press("Enter");
    expect(await browser.evaluate(`document.querySelector("#model").getClientRects().length`)).toBe(1);
    await browser.press("Tab");
    await waitForFocus("model");
    await browser.evaluate(`(() => {
      const select = document.querySelector("#model");
      select.value = JSON.stringify(["fixture", "long"]); select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await visible(browser, "#apply-model");
    await captureAlignment(browser, "options-761x720");
    await browser.press("Escape");
    expect(await focus()).toBe("compose-options-button");
    await browser.resize(1440, 720);
    await visible(browser, "#apply-model");
    await waitForFocus("model");
    expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("keep this draft");
    await browser.resize(761, 720);
    await browser.click("#prompt");
    await browser.evaluate(`(() => {
      document.querySelector("#prompt").select();
      // The platform picker is outside the headless viewport. Verify focus and disclosure without it.
      document.querySelector("#model").showPicker = undefined;
    })()`);
    await browser.type("/model");
    await browser.click("#send-command");
    expect(await focus()).toBe("model");
    expect(await browser.evaluate(`document.querySelector("${options}").getAttribute("aria-expanded")`)).toBe("true");
    expect(actions).toEqual([]);
  });
});

browserTest("overview distinguishes measured zero from missing data and discloses exact telemetry by keyboard", async () => {
  await workbench(390, 844, async browser => {
    await browser.click("#details-button");
    await visible(browser, "#runtime-metrics .metric-tile");
    const read = () => browser.evaluate<{ tiles: Record<string, string>; exact: boolean; missing: string }>(`(() => {
      const panel = document.querySelector("#runtime-metrics");
      const tiles = Object.fromEntries([...panel.querySelectorAll(".metric-tile")].map(tile =>
        [tile.dataset.tone, tile.querySelector("dd [aria-hidden=true]")?.textContent ?? tile.querySelector("dd").innerText.trim()]));
      return { tiles, exact: panel.innerText.includes("34,700"), missing: panel.querySelector('[data-tone="tools"] dd').textContent };
    })()`);
    const collapsed = await read();
    expect(collapsed).toEqual({
      tiles: { context: "27.11%", cache: "64%", tools: "—", cost: "US$0.00" },
      exact: false, missing: expect.stringContaining("尚无数据"),
    });
    await browser.evaluate(`document.querySelector(".metric-breakdown summary").focus()`);
    await browser.press("Enter");
    expect((await read()).exact).toBe(true);
  });
});

browserTest("overview refresh preserves focus on the command reached while native details were loading", async () => {
  const requested = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const command = '#runtime-metrics button[aria-label="插入命令：/other"]';
  await workbench(1440, 900, async browser => {
    await visible(browser, "#runtime-metrics .metric-highlights");
    await browser.evaluate(`document.querySelector(${JSON.stringify(command)}).closest("details").querySelector("summary").focus()`);
    await browser.press("Enter");
    await browser.click("#details-refresh");
    try {
      await requested.promise;
      await browser.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(command)});
        button.closest("details").querySelector("summary").focus();
      })()`);
      await browser.press("Tab");
      expect(await browser.evaluate(`document.activeElement.matches(${JSON.stringify(command)})`)).toBe(true);
    } finally {
      reply.resolve();
    }
    const focused = await browser.evaluate(`new Promise((resolve, reject) => {
      const panel = document.querySelector("#runtime-metrics");
      const watchdog = setTimeout(() => { changes.disconnect(); reject(Error("Refreshed native details did not render")); }, 3500);
      const changes = new MutationObserver(check);
      function check() {
        if (!panel.querySelector('[data-tone="cost"]').innerText.includes("0.01234")) return;
        changes.disconnect(); clearTimeout(watchdog);
        resolve(document.activeElement.matches(${JSON.stringify(command)}));
      }
      changes.observe(panel, { subtree:true, childList:true }); check();
    })`);
    expect(focused).toBe(true);
  }, false, read => {
    if (read === 1) return Promise.resolve();
    requested.resolve();
    return reply.promise;
  });
});

browserTest("a narrow header identifies the work directory and reveals the full copyable path without leaving the draft", async () => {
  await workbench(320, 640, async (browser, actions) => {
    const identity = await browser.evaluate(`(() => {
      const compact = document.querySelector("#session-path-short");
      const button = document.querySelector("#session-path-trigger");
      const { x, y, width, height } = button?.getBoundingClientRect() ?? new DOMRect();
      return { compact: compact?.innerText, hit: document.elementFromPoint(x + width / 2, y + height / 2) === button,
        touch: width >= 44 && height >= 44 };
    })()`);
    expect(identity).toEqual({ compact: "workbench-alpha", hit: true, touch: true });
    await browser.click("#prompt");
    await browser.type("保留这条草稿");
    await browser.click("#session-path-trigger");
    expect(await browser.evaluate(`({
      modal: document.querySelector("#session-path-dialog").matches(":modal"),
      path: document.querySelector("#session-path-full").textContent
    })`)).toEqual({ modal: true, path: initialSession.cwd });
    await browser.press("Escape");
    expect(await browser.evaluate(`({
      focus: document.activeElement.id, draft: document.querySelector("#prompt").value
    })`)).toEqual({ focus: "session-path-trigger", draft: "保留这条草稿" });
    expect(actions).toEqual([]);
  });
});

browserTest("320px keeps stop, steer, attachment, approval and options reachable on one row", async () => {
  await workbench(320, 640, async (browser, actions) => {
    await browser.click("#prompt");
    await browser.type("先保留草稿");
    await browser.click("#compose-options-button");
    await browser.evaluate(`(() => {
      const mode = document.querySelector("#prompt-mode");
      mode.value = "steer"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await browser.press("Escape");
    expect(await browser.evaluate(`document.activeElement.id`)).toBe("compose-options-button");
    await captureAlignment(browser, "busy-steer-320x640");
    const toolbar = await browser.evaluate<{ sameRow: boolean; reachable: boolean; labels: string[] }>(`(() => {
      const controls = ["#compose-options-button", "#approval", "#attach", "#stop", "#send"]
        .map(id => document.querySelector(id));
      const boxes = controls.map(control => control.getBoundingClientRect());
      return {
        sameRow: new Set(boxes.map(box => box.top)).size === 1,
        reachable: boxes.every(({ x, y, width, height }, i) =>
          width >= 44 && height >= 44 && controls[i].contains(document.elementFromPoint(x + width / 2, y + height / 2))),
        labels: controls.slice(-2).map(control => control.textContent.trim())
      };
    })()`);
    expect(toolbar).toEqual({ sameRow: true, reachable: true, labels: ["停止", "发送引导"] });
    expect(actions).toEqual([]);
  }, true);
});

browserTest("long localized desktop actions cannot displace the one-line session title", async () => {
  await workbench(900, 720, async browser => {
    const geometry = await browser.evaluate<{ lineHeight: number; titleHeight: number; allActionsFit: boolean }>(`(() => {
      const title = document.querySelector("#session-title");
      title.textContent = "Very long session name with enough words to wrap if the heading gives up its line";
      const actions = [...document.querySelectorAll(".workspace-actions .action-label")];
      actions.forEach(label => { label.textContent = "Öffnen und Einstellungen für diese Sitzung verwalten"; });
      const header = document.querySelector(".workspace-head-inner").getBoundingClientRect();
      return {
        lineHeight: parseFloat(getComputedStyle(title).lineHeight), titleHeight: title.clientHeight,
        allActionsFit: actions.every(label => {
          const box = label.parentElement.getBoundingClientRect();
          return box.right <= header.right && box.width >= 24;
        })
      };
    })()`);
    expect(geometry.titleHeight).toBeLessThanOrEqual(geometry.lineHeight);
    expect(geometry.allActionsFit).toBe(true);
  });
});

for (const [width, height, minimum] of [[320, 640, 360], [1100, 540, 330]] as const) {
  browserTest(`the settled ${width}×${height} workbench gives the conversation enough vertical room`, async () => {
    await workbench(width, height, async browser => {
      const layout = await browser.evaluate<{ transcript: number; send: number; overflow: number }>(`({
        transcript: document.querySelector("#transcript").getBoundingClientRect().height,
        send: document.querySelector("#send").getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - innerWidth
      })`);
      expect(layout.transcript).toBeGreaterThanOrEqual(minimum);
      expect(layout.send).toBeGreaterThanOrEqual(width <= 760 ? 44 : 24);
      expect(layout.overflow).toBe(0);
    });
  });
}

browserTest("inline slash and skill discovery fills the active draft without submitting", async () => {
  await workbench(1100, 600, async (browser, actions) => {
    const fill = (value: string) => browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.focus(); prompt.value = ${JSON.stringify(value)}; prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      prompt.dispatchEvent(new InputEvent("input", { bubbles:true }));
    })()`);
    const shown = () => browser.evaluate<string[]>(`[...document.querySelectorAll("#inline-commands:not([hidden]) [role=option]")]
      .map(row => row.querySelector("code").textContent)`);
    await fill("/ses");
    expect((await shown()).slice(0, 2)).toEqual(["/session", "/sessions"]);
    await browser.press("ArrowDown");
    await browser.press("Enter");
    expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("/session ");
    expect(await shown()).toEqual([]);
    await fill("$local");
    expect(await shown()).toEqual(["$local-check"]);
    await browser.press("Escape");
    expect(await shown()).toEqual([]);
    await fill("/tmp/");
    expect(await shown()).toEqual([]);
    await browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.dispatchEvent(new CompositionEvent("compositionstart", { bubbles:true }));
    })()`);
    await fill("/ses");
    expect(await shown()).toEqual([]);
    await browser.evaluate(`document.querySelector("#prompt").dispatchEvent(new KeyboardEvent("keydown",
      { key: "Enter", ctrlKey: true, bubbles: true }))`);
    expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("/ses");
    expect(actions).toEqual([]);
  });
});

browserTest("command picker browses real results by keyboard and inserts without sending", async () => {
  await workbench(320, 480, async (browser, actions) => {
    await browser.click("#command-mode");
    await browser.click("#command-picker");
    await visible(browser, "#command-list button[data-invocation]");
    const row = () => browser.evaluate<string>("document.activeElement.dataset.invocation");
    const invocations = await browser.evaluate<string[]>(`Array.from(
      document.querySelectorAll("#command-list button"), button => button.dataset.invocation)`);
    await browser.press("PageDown");
    expect(await row()).toBe(invocations[0]);
    await browser.press("ArrowDown");
    expect(await row()).toBe(invocations[1]);
    await browser.press("Enter");
    expect(await browser.evaluate(`[
      document.querySelector("#command-dialog").open, document.activeElement.id, document.querySelector("#prompt").value
    ]`)).toEqual([false, "prompt", `${invocations[1]} `]);
    expect(actions).toEqual([]);
  });
});

browserTest("the current Todo opens its list in one tap and restores focus without dropping the draft", async () => {
  await workbench(320, 640, async (browser, actions) => {
    await browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = "未发草稿"; prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
    })()`);
    await visible(browser, "#current-todo:not([hidden])");
    await browser.click("#current-todo");
    await visible(browser, "#runtime-todo details[open] li li");
    expect(await browser.evaluate(`document.querySelector("#runtime-todo").innerText`)).toContain("复查焦点");
    await browser.press("Escape");
    expect(await browser.evaluate(`({
      focus: document.activeElement.id, draft: document.querySelector("#prompt").value
    })`)).toEqual({ focus: "current-todo", draft: "未发草稿" });
    expect(actions).toEqual([]);
  });
});

browserTest("slash DAG opens a read-only wave view and never sends a model prompt or command", async () => {
  await workbench(1100, 600, async (browser, actions) => {
    await browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = "/dag"; prompt.focus(); prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
    })()`);
    await browser.click("#send-command");
    await visible(browser, "#runtime-dag .dag-run > summary");
    await browser.click("#runtime-dag .dag-run > summary");
    await visible(browser, "#runtime-dag .dag-graph-map");
    expect(await browser.evaluate(`getComputedStyle(document.querySelector(".dag-graph-map")).overflowX`)).toBe("auto");
    await browser.click("#runtime-dag .dag-graph-text > summary");
    await visible(browser, "#runtime-dag .dag-wave li");
    expect(await browser.evaluate<string[]>(`[...document.querySelectorAll(".dag-wave li")].map(node => node.textContent)`))
      .toEqual([expect.stringContaining("节点 1"), expect.stringContaining("依赖：节点 1")]);
    expect(await browser.evaluate(`document.querySelectorAll("#runtime-dag button, #runtime-dag input").length`)).toBe(0);
    expect(actions).toEqual([]);
  });
});

browserTest("busy sessions allow local reasoning inspection but keep native commands blocked", async () => {
  await workbench(320, 640, async (browser, actions) => {
    const fill = (value: string) => browser.evaluate(`(() => {
      const prompt = document.querySelector("#prompt");
      prompt.value = ${JSON.stringify(value)}; prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
    })()`);
    expect(await browser.evaluate(`document.querySelector("#activity").textContent`)).toContain("排队 2");
    await fill("/reasoning");
    expect(await browser.evaluate(`(() => {
      const stop = document.querySelector("#stop");
      const execute = document.querySelector("#send-command");
      return !stop.hidden && !execute.hidden && !execute.disabled &&
        getComputedStyle(stop).backgroundColor !== getComputedStyle(execute).backgroundColor;
    })()`)).toBe(true);
    await captureAlignment(browser, "busy-command-320x640");
    await browser.click("#send-command");
    expect(await browser.evaluate(`document.querySelector("#composer-hint").textContent`)).toContain("开启（high）");
    await fill("/efforts high");
    expect(await browser.evaluate(`document.querySelector("#send-command").disabled`)).toBe(true);
    expect(actions).toEqual([]);
  }, true);
});
