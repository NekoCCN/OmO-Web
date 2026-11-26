import { expect, test } from "bun:test";

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const initialSession = {
  id: "workbench-alignment", name: "会话 · 上线检查", cwd: "/fixture/workbench",
  active: true, archived: false, settled: false, running: false,
};

async function workbench(width: number, height: number, run: (browser: Bun.WebView, actions: readonly unknown[]) => Promise<void>,
  running = false) {
  const session = { ...initialSession, running };
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not build the alignment fixture");
  const actions: unknown[] = [];
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": () => new Response(Bun.file("public/index.html")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/workbench.css": () => new Response(Bun.file("public/workbench.css")),
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true }, token: "fixture" }),
      "/api/cli-history": Response.json({ available: true, sessions: [] }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { controller.enqueue(": fixture\n\n"); },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`/api/sessions/${session.id}`]: Response.json({
        session, state: { isStreaming: running, pendingMessageCount: running ? 2 : 0,
          effectivePermissionPreset: running ? "full-access" : "ask",
          model: { provider: "fixture", id: "review", reasoning: true }, thinkingLevel: "high", contextUsage: { percent: 27.094 },
          usageTotals: { latestCacheHitRate: 64, input: 36, cacheRead: 64, cacheWrite: 0 } },
        messages: [{ role: "user", content: "做一次检查。" }, { role: "assistant", content: "检查完成。" }],
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
      [`/api/sessions/${session.id}/workbench-status`]: Response.json({ status: "ok", currentTodo: "检查窄屏", pendingTodo: 2 }),
      [`/api/sessions/${session.id}/details`]: Response.json({
        runtime: { status: "ok", todo: { status: "ok", phases: [{ name: "检查",
          tasks: [{ status: "in_progress", content: "检查窄屏" }, { status: "pending", content: "复查焦点" }] }] } },
      }),
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

for (const [width, height, docked, compact] of [
  [320, 640, false, true], [390, 844, false, true], [740, 720, false, false], [761, 720, false, true],
  [1001, 720, true, true],
  [1100, 540, true, true], [1440, 720, true, false], [1920, 900, true, false],
] as const) {
  browserTest(`panel-driven alignment at ${width}×${height}${docked ? " with inspector" : ""}`, async () => {
    await workbench(width, height, async browser => {
      if (docked) {
        await browser.click("#details-button");
        await visible(browser, "#runtime-metrics .metric-group");
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
        const header = ["#open-navigation", "#details-button", "#web-branch-button", "#manage-button"];
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
    await browser.click("#send-command");
    expect(await browser.evaluate(`document.querySelector("#composer-hint").textContent`)).toContain("开启（high）");
    await fill("/efforts high");
    expect(await browser.evaluate(`document.querySelector("#send-command").disabled`)).toBe(true);
    expect(actions).toEqual([]);
  }, true);
});
