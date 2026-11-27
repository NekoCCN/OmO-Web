import { expect, test } from "bun:test";

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const roots = ["/fixture/alpha/desktop", "/fixture/beta/desktop"] as const;
const fixtureDate = Date.UTC(2026, 10, 27, 10);
const entries = [
  { id: "alpha", name: "Same name", cwd: roots[0], active: true, updatedAt: 2 },
  { id: "beta", name: "Same name", cwd: roots[1], active: true, updatedAt: 1 },
];
const baseMessage = "原始会话内容不翻译";
const todoText = "核对目录";

async function waitFor(browser: Bun.WebView, condition: string): Promise<void> {
  await browser.evaluate(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => { observer.disconnect(); reject(Error(${JSON.stringify(condition)})); }, 3000);
    function check() { if (${condition}) { clearTimeout(timeout); observer.disconnect(); resolve(true); } }
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  })`);
}

async function change(browser: Bun.WebView, id: string, value: string, event = "change"): Promise<void> {
  await browser.evaluate(`(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
}

async function withWorkbench(width: number, run: (browser: Bun.WebView, writes: { path: string; body: unknown }[]) => Promise<void>): Promise<void> {
  const built = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const bundle = built.outputs[0];
  if (!built.success || !bundle) throw new Error("Could not bundle the workbench");
  const writes: { path: string; body: unknown }[] = [];
  const sessions = [...entries];
  const asset = (path: string) => () => new Response(Bun.file(`public/${path}`));
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": asset("index.html"),
      "/styles.css": asset("styles.css"), "/workbench.css": asset("workbench.css"),
      "/tool-ledger.css": asset("tool-ledger.css"), "/dag-graph.css": asset("dag-graph.css"),
      "/icons.svg": asset("icons.svg"), "/app.js": () => new Response(bundle),
      "/api/bootstrap": () => Response.json({ sessions, workspaces: roots, fileBrowser: { platform: "posix" }, engine: { online: true } }),
      "/api/cli-history": () => Response.json({ available: true,
        sessions: roots.map((cwd, i) => ({ id: `cli-${i}`, name: `CLI ${i}`, cwd, updatedAt: fixtureDate + i * 1000 })) }),
      "/api/events": () => new Response(new ReadableStream({ start(controller) { controller.enqueue(": fixture\n\n"); } })
        .pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      "/api/workspaces/browse": async request => {
        const { path } = await request.json();
        return Response.json({ path, entries: [] });
      },
      "/api/workspaces/prepare": async request => {
        const { path } = await request.json();
        return Response.json({ status: "authorized", path, workspaces: roots });
      },
      "/api/sessions": {
        GET: () => Response.json({ sessions }),
        POST: async request => {
          const body = await request.json();
          writes.push({ path: "/api/sessions", body });
          const session = { id: "created", name: body.name ?? "Created", cwd: body.cwd, active: true, updatedAt: 3 };
          sessions.push(session);
          return Response.json({ session });
        },
      },
      "/api/sessions/:id": request => Response.json({
        session: sessions.find(row => row.id === request.params.id), state: {},
        messages: [{ role: "user", content: baseMessage },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "todo", arguments: { op: "append", items: [todoText] } }] },
          { role: "toolResult", toolCallId: "t1", toolName: "todo", isError: false, content: "原生回执" }],
      }),
      "/api/sessions/:id/options": () => Response.json({}),
      "/api/sessions/:id/details": () => Response.json({ stats: {}, runtime: {} }),
      "/api/sessions/:id/native-runtime": () => Response.json({ tasks: { status: "empty" }, dag: { status: "empty" }, memory: { status: "empty" } }),
      "/api/sessions/:id/workbench-status": () => Response.json({ status: "ok", pendingTodo: 1 }),
      "/api/sessions/:id/actions": async request => {
        const body = await request.json();
        writes.push({ path: new URL(request.url).pathname, body });
        return Response.json({ session: sessions.find(row => row.id === request.params.id), result: {} });
      },
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width, height: 844 });
  await browser.navigate(server.url.href);
  await waitFor(browser, `document.querySelector("#connection").dataset.state === "online"`);
  await run(browser, writes);
}

async function openSession(browser: Bun.WebView, id: string): Promise<void> {
  await browser.click(`#session-list button[data-session="${id}"]`);
  await waitFor(browser, `document.querySelector('#session-list button[data-session=${JSON.stringify(id)}]').hasAttribute("aria-current")
    && !document.querySelector("#composer-shell").hidden`);
}

browserTest("Directory filtering and browsing leave the active conversation and other drafts alone", async () => {
  await withWorkbench(1440, async (browser, writes) => {
    await waitFor(browser, `document.querySelectorAll("#cli-session-list button").length === 2`);
    const sidebar = () => browser.evaluate(`Array.from(document.querySelectorAll("#session-list .path"), row => [row.innerText, row.title])`);
    expect(await sidebar()).toEqual([["alpha/desktop", roots[0]], ["beta/desktop", roots[1]]]);
    await openSession(browser, "alpha");
    await change(browser, "prompt", "Unsent from alpha", "input");
    await change(browser, "workspace-select", roots[1]);
    expect(await sidebar()).toEqual([["beta/desktop", roots[1]]]);
    expect(await browser.evaluate(`[document.querySelector("#session-path").textContent, document.querySelector("#prompt").value]`))
      .toEqual([roots[0], "Unsent from alpha"]);
    await openSession(browser, "beta");
    expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("");
    await change(browser, "prompt", "Send only to beta", "input");
    await browser.click("#send");
    await waitFor(browser, `document.querySelector("#send").disabled`);
    expect(writes).toEqual([{ path: "/api/sessions/beta/actions", body: expect.objectContaining({ action: "prompt", message: "Send only to beta" }) }]);
    await browser.click("#new-sidebar");
    expect(await browser.evaluate(`document.querySelector("#new-cwd").value`)).toBe(roots[1]);
    await browser.click("#new-dialog [data-close]");
    await browser.click("#workspace-browser-button");
    await waitFor(browser, `document.querySelector("#workspace-browser-current").textContent === ${JSON.stringify(roots[1])}`);
    await change(browser, "workspace-browser-root", roots[0]);
    await waitFor(browser, `document.querySelector("#workspace-browser-current").textContent === ${JSON.stringify(roots[0])}`);
    await browser.click("#workspace-browser-use");
    await waitFor(browser, `!document.querySelector("#workspace-browser-dialog").open`);
    expect(await browser.evaluate(`[document.querySelector("#session-path").textContent, document.querySelector("#workspace-select").value]`))
      .toEqual([roots[1], roots[1]]);
    await browser.click("#new-sidebar");
    expect(await browser.evaluate(`document.querySelector("#new-cwd").value`)).toBe(roots[0]);
    await browser.click("#new-dialog [data-close]");
    await change(browser, "workspace-select", "");
    await openSession(browser, "alpha");
    expect(await browser.evaluate(`document.querySelector("#prompt").value`)).toBe("Unsent from alpha");
    await browser.click("#new-sidebar");
    await browser.click("#create");
    await waitFor(browser, `document.querySelector("#session-title").textContent === "Created"`);
    expect(writes.at(-1)).toEqual({ path: "/api/sessions", body: { cwd: roots[0] } });
  });
}, 12000);

browserTest("Changing UI language keeps the session and does not translate its content", async () => {
  for (const width of process.env.OMO_SESSION_LOCALE_EVIDENCE ? [1440, 320] : [1440]) {
    await withWorkbench(width, async browser => {
      const mobile = width < 760;
      if (mobile) await browser.click("#open-navigation");
      await openSession(browser, "alpha");
      await change(browser, "prompt", "Don't discard this", "input");
      if (mobile) await browser.click("#open-navigation");
      await change(browser, "language-select", "en");
      expect(await browser.evaluate(`[document.documentElement.lang, document.querySelector("#prompt").value, document.querySelector("#language-feedback").hidden]`))
        .toEqual(["zh-CN", "Don't discard this", false]);
      if (mobile) await browser.click("#close-navigation");
      await change(browser, "prompt", "", "input");
      const switchTo = async (locale: string) => {
        if (mobile) await browser.click("#open-navigation");
        const loaded = Promise.withResolvers<void>();
        browser.onNavigated = () => loaded.resolve();
        await change(browser, "language-select", locale);
        const timeout = setTimeout(() => loaded.reject(new Error("Language change did not reload the page")), 3000);
        try { await loaded.promise; } finally { clearTimeout(timeout); browser.onNavigated = null; }
        await waitFor(browser, `document.documentElement.lang === ${JSON.stringify(locale)} && !document.querySelector("#composer-shell").hidden
          && document.querySelector("#session-list [data-session='alpha'][aria-current='true']")
          && document.querySelector("#messages").textContent.includes(${JSON.stringify(baseMessage)})`);
      };
      await switchTo("en");
      const english = await browser.evaluate<readonly [string, string, string, string, number]>(`[
        document.querySelector("#new-sidebar").innerText.trim(),
        document.querySelector("#prompt-label").textContent, document.querySelector("#send-label").textContent,
        document.querySelector("#messages").innerText, document.documentElement.scrollWidth - innerWidth
      ]`);
      expect(english).toEqual(["New session", "Message", "Send", expect.stringContaining(baseMessage), 0]);
      expect(english).toEqual(["New session", "Message", "Send", expect.stringContaining(todoText), 0]);
      expect(String(english[3])).not.toMatch(/非当前进度|助手|运行中/);
      expect(await browser.evaluate(`(() => {
        const emblem = document.querySelector(".tool-card-emblem");
        return emblem.getBoundingClientRect().bottom <= emblem.closest("article").getBoundingClientRect().bottom;
      })()`)).toBe(true);
      const evidence = process.env.OMO_SESSION_LOCALE_EVIDENCE;
      if (evidence) {
        await Bun.write(`${evidence}/${width}-english.png`, await browser.screenshot());
        if (mobile) {
          await browser.click("#open-navigation");
          await browser.evaluate(`Promise.allSettled(document.getAnimations().map(animation => animation.finished))`);
          await Bun.write(`${evidence}/${width}-english-navigation.png`, await browser.screenshot());
          await browser.click("#close-navigation");
        }
      }
      if (mobile) await browser.click("#details-button");
      await waitFor(browser, `document.querySelector("#runtime-metrics").textContent.includes("Runtime and usage")`);
      expect(await browser.evaluate(`document.querySelector("#details-title").textContent`)).toBe("Run details");
      if (evidence) {
        await browser.evaluate(`Promise.allSettled(document.getAnimations().map(animation => animation.finished))`);
        await Bun.write(`${evidence}/${width}-english-details.png`, await browser.screenshot());
      }
      if (mobile) await browser.click("#details-dialog [data-close]");
      if (evidence) {
        if (mobile) await browser.click("#open-navigation");
        await change(browser, "theme", "dark");
        if (mobile) await browser.click("#close-navigation");
        await Bun.write(`${evidence}/${width}-english-dark.png`, await browser.screenshot());
      }
      await switchTo("zh-CN");
      const chinese = await browser.evaluate<readonly [string, string, string]>(`[
        document.querySelector("#prompt-label").textContent, document.querySelector("#messages").innerText,
        localStorage.getItem("omo-web-language")
      ]`);
      expect(chinese).toEqual(["消息", expect.stringContaining(baseMessage), "zh-CN"]);
      expect(String(chinese[1])).not.toContain("非当前进度");
      if (evidence) await Bun.write(`${evidence}/${width}-chinese-dark.png`, await browser.screenshot());
    });
  }
}, 15000);
