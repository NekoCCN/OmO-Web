import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Wire } from "../src/web/dom.ts";

const chromium = process.env.BUN_CHROME_PATH ?? Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome");
const browserTest = test.skipIf(!chromium || typeof Bun.WebView !== "function");
const evidence = process.env.OMO_TOOL_DISPLAY_EVIDENCE;
const session = { id: "tool-display-fixture", name: "工具调用 · 合成验收", cwd: "/fixture/workbench", active: true };
const assistant = (...content: Wire[]): Wire => ({ id: "assistant-fixture", role: "assistant", content });
const text = (value: string): Wire => ({ type: "text", text: value });
const call = (id: string, name: string, args: Wire): Wire => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, isError: boolean | undefined, output: string): Wire =>
  ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [text(output)] });

async function waitFor(browser: Bun.WebView, expression: string): Promise<void> {
  await browser.evaluate(`new Promise((resolve, reject) => {
    const check = () => {
      if (!(${expression})) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(${JSON.stringify(`Fixture condition not reached: ${expression}`)}));
    }, 3000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  })`);
}

async function withWorkbench(width: number, messages: readonly Wire[], run: (browser: Bun.WebView, emit: (event: Wire) => void) => Promise<void>) {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("Could not bundle the workbench browser fixture");
  let events: ReadableStreamDefaultController<string> | undefined;
  using server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/": async () => {
        const html = await Bun.file("public/index.html").text();
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
      "/icons.svg": () => new Response(Bun.file("public/icons.svg")),
      "/styles.css": () => new Response(Bun.file("public/styles.css")),
      "/workbench.css": () => new Response(Bun.file("public/workbench.css")),
      "/tool-ledger.css": async () => {
        const stylesheet = Bun.file("public/tool-ledger.css");
        return await stylesheet.exists() ? new Response(stylesheet) : new Response(null, { status: 404 });
      },
      "/app.js": () => new Response(script),
      "/api/bootstrap": Response.json({ sessions: [session], workspaces: [session.cwd], engine: { online: true } }),
      "/api/events": () => new Response(new ReadableStream<string>({
        start(controller) { events = controller; controller.enqueue(": fixture\n\n"); },
        cancel() { events = undefined; },
      }).pipeThrough(new TextEncoderStream()), { headers: { "Content-Type": "text/event-stream" } }),
      [`/api/sessions/${session.id}`]: () => Response.json({ session, messages, state: {} }),
      [`/api/sessions/${session.id}/options`]: Response.json({}),
    },
  });
  await using browser = new Bun.WebView({ backend: { type: "chrome", path: chromium ?? undefined, url: false }, width, height: width < 760 ? 844 : 900 });
  await browser.navigate(server.url.href);
  await waitFor(browser, `document.querySelector("#connection")?.dataset.state === "online"`);
  if (width < 760) await browser.click("#open-navigation");
  await browser.click(".session-link");
  await waitFor(browser, `!!document.querySelector("#messages article")`);
  await run(browser, event => {
    if (!events) throw new Error("Synthetic event stream is not connected");
    events.enqueue(`event: omo\ndata: ${JSON.stringify({ ...event, sessionId: session.id })}\n\n`);
  });
}

async function capture(browser: Bun.WebView, name: string): Promise<void> {
  if (evidence) await Bun.write(join(evidence, `${name}.png`), await browser.screenshot());
}

browserTest("A live tool keeps its open disclosure and keyboard focus when it succeeds", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查工作台里工具调用的渲染。" },
    assistant(text("先读取对话渲染代码，再核对结果是否就地更新。")),
  ], async (browser, emit) => {
    const tool = { toolCallId: "live-read", toolName: "read", args: { path: "src/web/transcript.ts" } };
    emit({ type: "tool_execution_start", ...tool });
    await waitFor(browser, `!!document.querySelector(".message--tool summary")`);
    const running = await browser.evaluate(`document.querySelector(".message--tool summary").textContent`);
    await capture(browser, "desktop-light-running");
    await browser.evaluate(`document.querySelector(".message--tool summary").focus()`);
    await browser.press("Enter");
    await waitFor(browser, `!!document.querySelector(".message--tool details[open]")`);
    emit({ type: "tool_execution_end", ...tool, isError: false, result: { content: [text("合成输出：读取完成。")] } });
    await waitFor(browser, `document.querySelector("#messages").textContent.includes("合成输出：读取完成。")`);
    const done = await browser.evaluate(`(() => {
      const details = document.querySelector(".message--tool details");
      const summary = details.querySelector("summary");
      return { open: details.open, focused: document.activeElement === summary, label: summary.textContent };
    })()`);
    await capture(browser, "desktop-light");
    expect(done).toMatchObject({ open: true, focused: true, label: expect.stringContaining("成功") });
    expect(running).toEqual(expect.stringContaining("运行中"));
    expect(running).toEqual(expect.stringContaining("src/web/transcript.ts"));
  });
});

browserTest("Persisted tools correlate at call position with safe recaps and bounded output on a phone", async () => {
  const long = Array.from({ length: 36 }, (_, i) => `${i + 1}  合成诊断 · ${"路径非常长".repeat(36)}`).join("\n");
  await withWorkbench(390, [
    { role: "user", content: "查找中文文档并查看失败原因。" },
    assistant(
      text("先搜索文档，再尝试更新。"),
      call("search", "grep", { path: "docs/工作台", pattern: "fixture-private-query" }),
      call("edit", "edit", { path: "docs/工作台/说明.md", newText: "fixture-private-edit" }),
      text("最后检查还有没有返回结果。"),
      call("unknown", "bash", { command: "echo fixture-private-argv" }),
    ),
    result("search", "grep", false, "过时的合成输出"),
    result("search", "grep", false, long),
    result("edit", "edit", true, "合成错误：<img src=x onerror=alert(1)>"),
  ], async browser => {
    await browser.evaluate(`document.documentElement.dataset.theme = "dark"`);
    await capture(browser, "phone-dark-collapsed");
    const rows = await browser.evaluate<string[]>(`Array.from(document.querySelectorAll("#messages .tool-details > summary"), node => node.textContent)`);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(expect.stringContaining("成功"));
    expect(rows[0]).toEqual(expect.stringContaining("docs/工作台"));
    expect(rows[1]).toEqual(expect.stringContaining("失败"));
    expect(rows[2]).toEqual(expect.stringContaining("未见结果"));
    expect(rows.join(" ")).not.toMatch(/fixture-private|合成诊断|合成错误/);
    await browser.click(".message--tool summary");
    const layout = await browser.evaluate<{
      pageWidth: number; transcriptWidth: number; outputHeight: number; outputScrollHeight: number;
      outputWidth: number; details: string; injected: boolean;
    }>(`(() => {
      const viewport = document.querySelector("#transcript");
      const output = document.querySelector(".tool-output");
      if (!output.hidden) output.scrollIntoView({ block: "end" });
      return {
        pageWidth: document.documentElement.scrollWidth,
        transcriptWidth: viewport.scrollWidth - viewport.clientWidth,
        outputHeight: output.clientHeight,
        outputScrollHeight: output.scrollHeight,
        outputWidth: output.scrollWidth - output.clientWidth,
        details: document.querySelector(".tool-details[open]").textContent,
        injected: !!document.querySelector("#messages img"),
      };
    })()`);
    await capture(browser, "phone-dark");
    expect(layout.pageWidth).toBe(390);
    expect(layout.transcriptWidth).toBe(0);
    expect(layout.injected).toBe(false);
    expect(layout.details).toContain("fixture-private-query");
    expect(layout.details).not.toContain("过时的合成输出");
    expect(layout.outputHeight).toBeLessThanOrEqual(352);
    expect(layout.outputScrollHeight).toBeGreaterThan(layout.outputHeight);
    expect(layout.outputWidth).toBeGreaterThan(0);
    console.info(`Tool output: viewport ${layout.pageWidth}px; ${layout.outputHeight}/${layout.outputScrollHeight}px visible/total; ${layout.outputWidth}px local horizontal overflow`);
  });
});

browserTest("Loading older calls moves the open tool back into source order without losing its reading anchor", async () => {
  await withWorkbench(1440, [
    assistant(text("从这个较早的助手消息开始。\n\n工具行应回到调用原位。"), call("older", "grep", { path: "src" })),
    result("older", "grep", undefined, "已记录输出，未记录状态。"),
    ...Array.from({ length: 79 }, (_, index) => ({ id: `tail-${index}`, role: "user", content: `合成历史 ${index}` })),
  ], async browser => {
    await browser.evaluate(`(() => {
      document.querySelector("#transcript").scrollTop = 0;
      document.querySelector(".message--tool summary").focus({ preventScroll: true });
    })()`);
    await browser.press("Enter");
    const history = await browser.evaluate<{
      count: number; inline: boolean; open: boolean; focused: boolean; topDelta: number; recap: string;
    }>(`(() => {
      const row = document.querySelector(".message--tool");
      const summary = row.querySelector("summary");
      const top = row.getBoundingClientRect().top;
      document.querySelector(".transcript-load").click();
      return {
        count: document.querySelectorAll(".message--tool").length,
        inline: !!row.closest(".message-body"),
        open: row.querySelector("details").open,
        focused: document.activeElement === summary,
        topDelta: row.getBoundingClientRect().top - top,
        recap: summary.textContent,
      };
    })()`);
    expect(history.count).toBe(1);
    expect(history.inline).toBe(true);
    expect(history.open).toBe(true);
    expect(history.focused).toBe(true);
    expect(Math.abs(history.topDelta)).toBeLessThanOrEqual(1);
    expect(history.recap).toContain("src");
    expect(history.recap).toContain("状态未知");
    console.info(`Tool history: one open, focused tool at the original call; anchor Δ${history.topDelta}px`);
  });
});

browserTest("The tool trace focuses a visible group summary, and Tab reaches each original call after opening", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查源文件和测试。" },
    assistant(call("source", "read", { path: "src/web/transcript.ts" }), call("tests", "find", { path: "test" })),
    result("source", "read", false, "源文件输出"),
    result("tests", "find", false, "测试文件输出"),
  ], async browser => {
    await browser.click("#trace-jump-tool");
    const groupFocused = await browser.evaluate(`document.activeElement.matches(".tool-group-summary")`);
    expect(groupFocused).toBe(true);
    await browser.press("Enter");
    await waitFor(browser, `!!document.querySelector(".tool-group[open]")`);
    await browser.press("Tab");
    const first = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    await browser.press("Enter");
    const opened = await browser.evaluate(`document.activeElement.parentElement.open`);
    await browser.press("Enter");
    await browser.press("Tab");
    const second = await browser.evaluate(`document.activeElement.querySelector(".tool-target")?.textContent`);
    expect([first, second]).toEqual(["src/web/transcript.ts", "test"]);
    expect(opened).toBe(true);
  });
});

browserTest("Narrative before a read allows grouping, but narrative between reads keeps both separate", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "检查清单和工作区。" },
    { ...assistant(text("先核对检查清单。"), call("checklist", "read", { path: "release-checklist.md" })), stopReason: "toolUse" },
    result("checklist", "read", false, "检查清单输出"),
    { ...assistant(call("scope", "read", { path: "workspace-notes.md" })), id: "scope", stopReason: "toolUse" },
    result("scope", "read", false, "工作区输出"),
    { role: "user", content: "检查另外两个文件。" },
    { ...assistant(call("first", "read", { path: "first.md" }), text("第一份已核对。")), id: "first", stopReason: "toolUse" },
    result("first", "read", false, "第一份输出"),
    { ...assistant(call("next", "read", { path: "next.md" })), id: "next", stopReason: "toolUse" },
    result("next", "read", false, "下一份输出"),
  ], async browser => {
    const standalone = await browser.evaluate(`Array.from(document.querySelectorAll("#messages .tool-target"))
      .filter(target => !target.closest(".tool-group")).map(target => target.textContent)`);
    expect(standalone).toEqual(["first.md", "next.md"]);
    const groups = await browser.evaluate(`Array.from(document.querySelectorAll("#messages .tool-group"), group =>
      Array.from(group.querySelectorAll(".tool-summary .tool-target"), target => target.textContent))`);
    expect(groups).toEqual([["release-checklist.md", "workspace-notes.md"]]);
  });
});

browserTest("Mixed execution results group by outer tool and keep their focused original disclosure on stream updates", async () => {
  await withWorkbench(1440, [
    { role: "user", content: "执行上下文检查" },
    { ...assistant(call("ctx", "ctx_execute", { code: "private-script" })), stopReason: "toolUse" },
    result("ctx", "ctx_execute", false, "private-context-output"),
    { ...assistant(call("eval", "eval", { language: "js", summary: "private-summary", code: "tool.memory({command:'view'})" })),
      id: "eval-assistant", stopReason: "toolUse" },
    result("eval", "eval", false, "private-eval-output"),
  ], async (browser, emit) => {
    const groups = await browser.evaluate(`Array.from(document.querySelectorAll(".tool-group"), group => ({
      open: group.open,
      label: group.querySelector(".tool-group-summary").textContent,
      chips: Array.from(group.querySelectorAll(".tool-group-kind"), chip => chip.textContent),
    }))`);
    expect(groups).toEqual([{ open: false, label: expect.stringContaining("2 项成功"), chips: ["Ctx Execute ×1", "Eval ×1"] }]);
    await capture(browser, "desktop-light-mixed-ledger");
    await browser.click("#trace-jump-tool");
    await browser.press("Enter");
    await browser.press("Tab");
    await browser.press("Enter");
    await browser.evaluate(`(() => {
      window.ledgerGroup = document.querySelector(".tool-group[open]");
      window.ledgerFold = window.ledgerGroup.querySelector(".tool-details[open]");
    })()`);
    emit({ type: "tool_execution_start", toolCallId: "next-live", toolName: "eval", args: { code: "private-next" } });
    await waitFor(browser, `!!document.querySelector('.tool-details[data-state="running"]')`);
    const settled = await browser.evaluate<{ summaries: string }>(`({
      same: window.ledgerGroup === document.querySelector(".tool-group[open]") &&
        window.ledgerFold === document.querySelector(".tool-group .tool-details[open]"),
      focused: document.activeElement === window.ledgerFold.querySelector(".tool-summary"),
      oldArgs: window.ledgerFold.querySelector("pre").textContent.includes("private-script"),
      oldOutput: window.ledgerFold.querySelector(".tool-output").textContent.includes("private-context-output"),
      order: Array.from(window.ledgerGroup.querySelectorAll(".tool-label"), label => label.textContent),
      summaries: Array.from(document.querySelectorAll("#messages summary"), node => node.textContent).join(" "),
    })`);
    expect(settled).toMatchObject({ same: true, focused: true, oldArgs: true, oldOutput: true, order: ["Ctx Execute", "Eval"] });
    expect(settled.summaries).not.toMatch(/private-|Memory/);
  });
});

browserTest("Category rows expose only recognized operations and reserve the Bash command for the open terminal", async () => {
  const payloads = [
    ["memory", { command: "str_replace", file_path: "private-memory-path", new_string: "private-memory-data" }],
    ["bash", { command: "printf private-command" }],
    ["todo", { op: "init", list: [{ phase: "private-phase", items: ["private-first", "private-second"] }] }],
    ["todo", { op: "private-unknown-op", items: ["private-don't-count"] }],
    ["read", { path: "src" }],
    ["apply_patch", { patch: "private-edit" }],
    ["task", { task_summary: "private-agent-prompt" }],
    ["web_search", { query: "private-query" }],
    ["mcp_plugin:custom", { command: "private-plugin-value" }],
    ["shell", { command: "private-shell-command" }],
    ["powershell", { command: "private-powershell-command" }],
  ] as const;
  await withWorkbench(390, [
    { role: "user", content: "检查工具类别" },
    assistant(...payloads.map(([name, args], i) => call(String(i), name, args))),
    ...payloads.map(([name], i) => ({ ...result(String(i), name, i === 1 ? true : false, "private-result"),
      details: { command: "private-opaque-details" } })),
  ], async browser => {
    if (evidence) {
      await browser.evaluate(`document.documentElement.dataset.theme = "light"`);
      await capture(browser, "phone-light-tool-hud");
      await browser.evaluate(`document.documentElement.dataset.theme = "dark"`);
      await capture(browser, "phone-dark-tool-hud");
      await browser.evaluate(`delete document.documentElement.dataset.theme`);
    }
    await browser.cdp("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    const view = await browser.evaluate<{
      categories: string[]; operations: string[]; glyphs: string[]; summaries: string[]; forced: boolean; folded: boolean;
    }>(`(() => {
      const rows = Array.from(document.querySelectorAll("#messages .tool-details"));
      return {
        categories: rows.map(row => row.dataset.toolKind),
        operations: rows.map(row => row.querySelector(".tool-operation")?.textContent ?? ""),
        glyphs: rows.map(row => row.querySelector(".tool-kind-icon path")?.getAttribute("d")),
        summaries: rows.map(row => row.querySelector("summary").innerText),
        forced: matchMedia("(forced-colors: active)").matches,
        folded: rows.every(row => !row.open),
      };
    })()`);
    expect(view.categories).toEqual(["memory", "terminal", "todo", "todo", "inspect", "modify", "agent", "web", "unknown", "terminal", "terminal"]);
    expect(view.operations.slice(0, 4)).toEqual(["替换", "运行命令", "初始化 · 2 项", ""]);
    expect(view.operations.slice(-2)).toEqual(["运行命令", "运行命令"]);
    expect(new Set(view.glyphs).size).toBe(8);
    expect(view.glyphs.every(Boolean)).toBe(true);
    expect(view.forced && view.folded).toBe(true);
    expect(view.summaries.join(" ")).not.toMatch(/private-/);
    expect(view.summaries[1]).toContain("失败");
    expect(view.summaries[1]).toContain("Bash");
    expect(view.summaries[8]).toContain("mcp_plugin:custom");
    expect(view.summaries[9]).toContain("Shell");
    expect(view.summaries[10]).toContain("PowerShell");
    await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="terminal"][data-state="error"] > summary').focus()`);
    await browser.press("Enter");
    await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="terminal"][open] .tool-raw-args > summary').focus()`);
    await browser.press("Enter");
    const terminal = await browser.evaluate(`(() => {
      const fold = document.querySelector('.tool-details[data-tool-kind="terminal"][open]');
      const command = fold.querySelector(".tool-command-preview");
      const transcript = document.querySelector("#transcript");
      return { text: command?.innerText, font: command && getComputedStyle(command.querySelector("code")).fontFamily,
        inside: !!command?.closest(".fold-body"), rawCommand: JSON.parse(fold.querySelector(".tool-raw-args[open] pre").textContent).command,
        output: fold.querySelector(".tool-output").textContent,
        overflow: transcript.scrollWidth - transcript.clientWidth };
    })()`);
    expect(terminal).toMatchObject({ text: expect.stringContaining("printf private-command"),
      font: expect.stringContaining("monospace"), inside: true, rawCommand: "printf private-command", output: "private-result", overflow: 0 });
    await browser.press("Enter");
    await capture(browser, "phone-forced-colors-terminal");
  });
});

browserTest("Todo separates the submitted list from the receipt; Memory disclosures stay opt-in", async () => {
  await withWorkbench(390, [
    { role: "user", content: "检查工具回执" },
    assistant(call("todo-detail", "todo", { op: "init", list: [{ phase: "检查", items: ["核对渲染", "保留草稿"] }] }),
      call("memory-detail", "memory", { command: "update_description", file_path: "private-project.md", description: "private-description" })),
    result("todo-detail", "todo", false, "原生待办回执"),
    result("memory-detail", "memory", false, "原生记忆回执"),
  ], async browser => {
    const read = (kind: string) => browser.evaluate<{ submitted: string[]; hasReceipt: boolean; rawVisible: boolean; shown: string }>(`(() => {
      const fold = document.querySelector('.tool-details[data-tool-kind="${kind}"]');
      const args = fold.querySelector('.tool-raw-args');
      return { submitted: [...fold.querySelectorAll('.tool-todo-list li')].map(item => item.innerText),
        hasReceipt: fold.querySelector('.tool-output').innerText.includes("原生"),
        rawVisible: !!args?.querySelector('pre').getClientRects().length,
        shown: fold.innerText };
    })()`);
    for (const kind of ["todo", "memory"] as const) {
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="${kind}"] > summary').focus()`);
      await browser.press("Enter");
      const opened = await read(kind);
      expect(opened).toMatchObject({ submitted: kind === "todo" ? ["核对渲染", "保留草稿"] : [], hasReceipt: kind === "todo", rawVisible: false });
      expect(opened.shown).not.toMatch(/private-|\"items\"/);
      if (kind === "memory") {
        await browser.evaluate(`document.querySelector('.tool-memory-receipt > summary').focus()`);
        await browser.press("Enter");
        const receipt = await read(kind);
        expect(receipt).toMatchObject({ hasReceipt: true, rawVisible: false });
        expect(receipt.shown).toContain("原生记忆回执");
      }
      await browser.evaluate(`document.querySelector('.tool-details[data-tool-kind="${kind}"] .tool-raw-args > summary').focus()`);
      await browser.press("Enter");
      expect(await read(kind)).toMatchObject({ rawVisible: true });
    }
  });
});

browserTest("Unproven results and approval, user, or native Bash records split execution runs", async () => {
  const exec = (id: string) => call(id, "ctx_execute", {});
  const done = (id: string) => result(id, "ctx_execute", false, id);
  await withWorkbench(1440, [
    { role: "user", content: "检查分组边界" },
    assistant(exec("a"), exec("b"), exec("fail"), exec("c"), exec("clip"), exec("d"), exec("no-status"), exec("e"),
      exec("no-content"), exec("f"), call("unknown", "plugin", {}), exec("g"), exec("pending"), exec("h")),
    done("a"), done("b"), result("fail", "ctx_execute", true, "failure"), done("c"), { ...done("clip"), truncated: true },
    done("d"), result("no-status", "ctx_execute", undefined, "unknown"), done("e"), { ...done("no-content"), content: undefined },
    done("f"), result("unknown", "plugin", false, "plugin"), done("g"), done("h"),
    { role: "custom", content: [text("审批边界")] },
    { ...assistant(exec("i")), id: "after-approval" }, done("i"),
    { role: "bashExecution", output: "原生命令输出" },
    { ...assistant(exec("j")), id: "after-bash" }, done("j"),
    { role: "user", content: "新回合" },
    { ...assistant(exec("k")), id: "new-turn" }, done("k"),
  ], async browser => {
    const layout = await browser.evaluate(`({
      groups: Array.from(document.querySelectorAll(".tool-group-body"), body =>
        Array.from(body.querySelectorAll(".tool-output"), output => output.textContent)),
      rows: Array.from(document.querySelectorAll(".tool-details:not(.tool-group *)"), row =>
        [row.querySelector(".tool-output").textContent, row.querySelector(".tool-state-text").textContent]),
    })`);
    expect(layout).toEqual({ groups: [["a", "b"]], rows: [
      ["failure", "失败"], ["c", "成功"], ["clip", "结果不完整"], ["d", "成功"], ["unknown", "状态未知"],
      ["e", "成功"], ["", "结果不完整"], ["f", "成功"], ["plugin", "成功"], ["g", "成功"], ["", "未见结果"],
      ["h", "成功"], ["i", "成功"], ["j", "成功"], ["k", "成功"],
    ] });
  });
});

browserTest("Tool scenes render the connected wire as distinct workspaces without revealing folded data", async () => {
  const fixtures = [
    ["bash", { command: "printf first\nprintf second" }],
    ["powershell", { command: "Write-Output fixture-shell" }],
    ["todo", { op: "init", list: [{ phase: "验收", items: ["核对主题", "核对输出"] }, { phase: "交付", items: ["记录截图"] }] }],
    ["memory", { command: "str_replace", file_path: "/fixture/private-memory.md", new_string: "private-memory-source" }],
    ["eval", { language: "js", summary: "private-eval-summary", code: "print('private-eval-source')" }],
    ["ctx_execute", { language: "python", code: "print('private-ctx-source')", file: "/fixture/private-context.txt" }],
    ["write", { path: "src/界面/工具.ts", content: "private-file-source" }],
    ["task", { category: "quick", run_in_background: true, task_summary: "private-agent-summary", prompt: "private-agent-prompt" }],
    ["mcp_fixture:plugin", { args: "generic-call-args" }],
  ] as const;
  for (const width of evidence ? [1440, 390, 320] : [390]) {
    await withWorkbench(width, [
      { role: "user", content: "请检查工具界面与回执。" },
      assistant(...fixtures.map(([name, args], i) => call(String(i), name, args))),
      ...fixtures.map(([name], i) => ({ ...result(String(i), name, false, `${i} · ${i === 3 ? "private-memory-output" : "原生工具输出"}`),
        details: { internal: "private-opaque-details" } })),
    ], async browser => {
      if (width === 390) {
        const shown = await browser.evaluate(`(() => {
          const rows = [...document.querySelectorAll(".tool-details")];
          const summaries = rows.map(row => row.querySelector("summary").innerText);
          document.querySelectorAll(".tool-group").forEach(group => group.open = true);
          rows.forEach(row => row.open = true);
          const [bash, ps, todo, memory, evaluate, ctx, file, agent, plugin] = rows;
          const visible = (row, token) => row.innerText.includes(token);
          const attached = (row, selector) => !!row.querySelector(selector)?.getClientRects().length;
          return {
            summaries: summaries.join(" "),
            commands: [bash, ps].map(row => row.querySelector(".tool-command-preview code")?.textContent),
            terminalOutput: [bash, ps].map(row => attached(row, ".tool-terminal .tool-output")),
            phases: [...todo.querySelectorAll(".tool-todo-board ol")].map(lane => [...lane.children].map(item => item.innerText)),
            todoReceipt: visible(todo, "待办工具回执") && visible(todo, "2 · 原生工具输出"),
            memoryAudit: attached(memory, ".tool-memory-audit") && visible(memory, "替换"),
            memoryHidden: !visible(memory, "private-memory") && !attached(memory, ".tool-output"),
            execution: [evaluate, ctx].map(row => row.querySelector(".tool-code-desk .tool-scene-meta")?.innerText),
            codeHidden: [evaluate, ctx].every(row => !visible(row, "-source") && !attached(row, ".tool-source pre")),
            file: file.querySelector(".tool-file-target code")?.innerText,
            agent: agent.querySelector(".tool-agent-routing")?.innerText,
            agentOutput: visible(agent, "7 · 原生工具输出"),
            extraHidden: ![evaluate, ctx, file, agent, plugin].some(row => /private-/.test(row.innerText)),
            generic: !plugin.querySelector(".tool-scene") && visible(plugin, "generic-call-args") && visible(plugin, "8 · 原生工具输出"),
          };
        })()`);
        expect(shown).toMatchObject({
          summaries: expect.not.stringMatching(/private-|printf|Write-Output|核对主题|quick|原生工具输出/),
          commands: ["printf first\nprintf second", "Write-Output fixture-shell"],
          terminalOutput: [true, true], phases: [["核对主题", "核对输出"], ["记录截图"]],
          todoReceipt: true, memoryAudit: true, memoryHidden: true,
          execution: [expect.stringContaining("JavaScript"), expect.stringContaining("Python")], codeHidden: true,
          file: "src/界面/工具.ts", agent: expect.stringContaining("quick"), agentOutput: true, extraHidden: true, generic: true,
        });
        for (const [selector, token] of [
          ['[data-tool-kind="memory"] .tool-memory-receipt > summary', "private-memory-output"],
          ['[data-tool-kind="execution"] .tool-source > summary', "private-eval-source"],
          ['[data-tool-kind="context"] .tool-source > summary', "private-ctx-source"],
          ['[data-tool-kind="agent"] .tool-raw-args > summary', "private-agent-prompt"],
        ]) {
          await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
          await browser.press("Enter");
          expect(await browser.evaluate(`document.activeElement.parentElement.innerText.includes(${JSON.stringify(token)})`)).toBe(true);
          await browser.press("Enter");
        }
      }
      if (evidence) for (const theme of ["light", "dark"]) {
        await browser.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
        for (const [i, [name]] of fixtures.entries()) {
          const sizing = await browser.evaluate(`(() => {
            const rows = [...document.querySelectorAll(".tool-details")];
            document.querySelectorAll(".tool-group").forEach(group => group.open = group.contains(rows[${i}]));
            rows.forEach((row, index) => row.open = index === ${i});
            rows[${i}].querySelectorAll(".tool-source").forEach(source => source.open = false);
            rows[${i}].scrollIntoView({ block: "center" });
            const transcript = document.querySelector("#transcript");
            return [document.documentElement.scrollWidth, transcript.scrollWidth - transcript.clientWidth];
          })()`);
          expect(sizing).toEqual([width, 0]);
          await capture(browser, `scene-${width}-${theme}-${name.replace(":", "-")}`);
          if (i === 4 || i === 5) {
            await browser.evaluate(`document.querySelector(".tool-details[open] .tool-source > summary").focus()`);
            await browser.press("Enter");
            await capture(browser, `scene-${width}-${theme}-${name}-source`);
          }
        }
      }
    });
  }
}, 20000);

browserTest("Malformed metadata and oversized Todo submissions still leave raw detail reachable", async () => {
  await withWorkbench(390, [
    { role: "user", content: "检查投影边界。" },
    assistant(call("unsafe-file", "read", { path: "../../ghp_private-path" }),
      call("unsafe-agent", "task", { category: "private category with spaces", prompt: "private-task-source" }),
      call("unsafe-eval", "eval", { action: "private-action", language: "private-lang", code: "private-script" }),
      call("large-todo", "todo", { op: "init", items: ["过长".repeat(400)] })),
  ], async browser => {
    const found = await browser.evaluate(`(() => {
      const [file, agent, execution, todo] = [...document.querySelectorAll(".tool-details")];
      const rows = [file, agent, execution, todo];
      rows.forEach(row => row.open = true);
      return {
        untrusted: rows.map(row => /private-|过长/.test(row.innerText)),
        boardItems: todo.querySelectorAll(".tool-todo-board li").length,
        raw: rows.map(row => !!row.querySelector(".tool-raw-args > summary")?.getClientRects().length),
      };
    })()`);
    expect(found).toEqual({ untrusted: [false, false, false, false], boardItems: 0, raw: [true, true, true, true] });
  });
});

browserTest("Streaming terminal retains its viewport and finite signals respect reduced motion and forced colors", async () => {
  const output = Array.from({ length: 48 }, (_, i) => `${i} ${"stream-text ".repeat(55)}`).join("\n");
  await withWorkbench(390, [
    { role: "user", content: "检查流式输出和辅助显示模式。" },
    assistant(text("读取回执。")),
  ], async (browser, emit) => {
    const shell = { toolCallId: "live-terminal", toolName: "bash", args: { command: "printf fixture" } };
    emit({ type: "tool_execution_start", ...shell });
    await waitFor(browser, `!!document.querySelector(".tool-details[data-state=running]")`);
    const motion = () => browser.evaluate<string>(`getComputedStyle(document.querySelector(".tool-summary"), "::after").animationName`);
    const entry = await motion();
    expect(entry).not.toBe("none");
    await browser.evaluate(`document.querySelector(".tool-summary").focus()`);
    await browser.press("Enter");
    emit({ type: "tool_execution_update", ...shell, partialResult: { content: [text(output)] } });
    await waitFor(browser, `document.querySelector(".tool-output").textContent.includes("47 stream-text")`);
    await browser.evaluate(`(() => {
      const viewport = document.querySelector(".tool-output");
      viewport.focus();
      viewport.scrollTo(52, 96);
    })()`);
    emit({ type: "tool_execution_end", ...shell, result: { content: [text(`${output}\nfinal receipt`)] }, isError: true });
    await waitFor(browser, `document.querySelector(".tool-output").textContent.includes("final receipt")`);
    const settlement = await motion();
    expect(settlement).not.toBe(entry);
    expect(settlement).not.toBe("none");
    const retained = await browser.evaluate(`(() => {
      const viewport = document.querySelector(".tool-terminal .tool-output");
      return { focused: document.activeElement === viewport, scroll: [viewport?.scrollLeft, viewport?.scrollTop],
        state: viewport?.closest(".tool-details").dataset.state,
        iterations: getComputedStyle(document.querySelector(".tool-summary"), "::after").animationIterationCount };
    })()`);
    expect(retained).toEqual({ focused: true, scroll: [52, 96], state: "error", iterations: "1" });
    for (const feature of [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "forced-colors", value: "active" }]) {
      await browser.cdp("Emulation.setEmulatedMedia", { features: [feature] });
      expect(await motion()).toBe("none");
      expect(await browser.evaluate(`document.activeElement.matches(".tool-terminal .tool-output") &&
        document.activeElement.getClientRects().length > 0 &&
        getComputedStyle(document.activeElement).outlineStyle === "solid"`)).toBe(true);
      if (evidence) {
        await browser.evaluate(`document.querySelector(".tool-details").scrollIntoView({ block: "start" })`);
        await capture(browser, `scene-${feature.name}`);
      }
    }
  });
});
