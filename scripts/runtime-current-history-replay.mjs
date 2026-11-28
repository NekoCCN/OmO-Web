import assert from "node:assert/strict";

export async function runReplay({
  page, ids, request, visible, click, toggle, tab, text, readCount, probeCount, arm, held, release,
  collapsed, focus, select, open, capture, ensureCurrent, resize, theme, history, current,
}) {
  const todo = history("todo");
  const dag = history("dag");
  const liveTodo = current("todo");
  const liveDag = current("dag");
  const refresh = () => click("#details-refresh");
  const close = () => click("#details-dialog [data-close]");
  const dagRoute = "/native-runtime/dag-history";
  const todoRoute = "/todo-history";
  const assertCollapsed = async selector => {
    assert(await collapsed(selector), `${selector} must stay collapsed`);
    assert.doesNotMatch(await text(selector), /Recorded-only item|Run 1|Saved snapshot/);
  };

  await visible("#current-todo:not([hidden])", "Current-only item");
  assert.match(await text(liveTodo), /In progress · Current-only item.*Completed · Done in current/);
  assert.doesNotMatch(await text(liveTodo), /Recorded-only item|Sibling-only item/);
  assert.equal(await readCount("/branch-runtime"), 0, "Do not read the Memory branch projection before intent");
  await assertCollapsed(todo);
  await ensureCurrent("dag");
  await assertCollapsed(dag);
  assert.match(await text(liveDag), /Run 1 · Running/);
  assert.doesNotMatch(await text(liveDag), /Run 1 · Completed/);
  assert.equal(await probeCount(), 0, "Neither current pane may prefetch history, graphs or disk snapshots");
  assert.equal(await page.evaluate(() => window.runtimeProbe.reads.filter(({ route }) => /\/dag\/[a-f0-9]/u.test(route)).length), 0);
  const row = `${liveDag} .dag-run`;
  await toggle(row);
  await visible(`${row} .dag-graph-view`);
  await arm("/native-runtime", "hold");
  await refresh();
  await held("/native-runtime");
  await page.evaluate(selector => document.querySelector(selector).focus(), `${row} > summary`);
  await release("/native-runtime");
  await visible(`${row}[open] .dag-graph-view`);
  assert(await focus(`${row} > summary`), "Refreshed active graph retains its owning key and the focus");
  assert.equal(await probeCount(), 0, "Refreshing current DAG must not activate its history");
  await capture("dag-active-graph-focus-1440-light");
  await toggle(row);

  for (const width of [1440, 390]) {
    if (width === 390) {
      await close();
      await resize("iphone-14");
      await open();
    }
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      for (const kind of ["todo", "dag"]) {
        const selector = history(kind);
        await ensureCurrent(kind);
        await assertCollapsed(selector);
        await capture(`${kind}-current-${width}-${mode}`);
        if (width === 390) {
          const size = await page.evaluate(selector => {
            const { width, height } = document.querySelector(`${selector} > summary`).getBoundingClientRect();
            return [width, height];
          }, selector);
          assert(size.every(value => value >= 44), `History summary should be a 44px touch target: ${size}`);
        }
        await page.locator(`${selector} > summary`).press("Enter");
        await visible(`${selector}[open]`, kind === "todo" ? "Recorded-only item" : "Run 1 · Completed");
        assert(await focus(`${selector} > summary:focus-visible`), "Keyboard-opened History keeps its visible focus");
        await capture(`${kind}-history-${width}-${mode}`);
        await toggle(selector);
      }
    }
  }
  await close();
  assert(await focus("#details-button"), "Closing the compact inspector restores its trigger");
  await resize("desktop-1440");
  await open();

  await tab("todo");
  await visible(liveTodo, "Current-only item");
  await arm(todoRoute, "hold");
  await toggle(todo);
  await held(todoRoute);
  await visible(`${todo}[open]`, "Loading");
  await capture("todo-history-held-1440-dark");
  await toggle(todo);
  await release(todoRoute);
  await assertCollapsed(todo);
  await arm(todoRoute, "mismatch");
  await toggle(todo);
  await visible(`${todo}[open]`, "could not be verified");
  assert.doesNotMatch(await text(todo), /Recorded-only item/);
  await toggle(todo);

  await toggle("#runtime-memory-branch");
  await visible("#runtime-memory-branch-content", "Recall gate");
  await visible("#runtime-journal", "Recorded steps");
  assert((await readCount("/branch-runtime")) > 0);
  await toggle("#runtime-memory-branch");
  await tab("subagents");
  await visible("#runtime-subagent", "Task 1 · Completed");

  await tab("dag");
  await toggle(dag);
  const past = `${dag} .dag-run`;
  await visible(`${past} > summary`, "Completed");
  assert.equal(await readCount("?scope=history"), 0, "Historical graph only loads on its own row toggle");
  await toggle(past);
  await visible(`${past} .dag-graph-view`);
  assert.equal(await readCount("?scope=history"), 1);
  assert.doesNotMatch(await text(liveDag), /Run 1 · Completed/);
  await capture("dag-history-graph-1440-dark");
  await toggle(dag);
  await toggle(dag);
  await visible(`${past} > summary`, "Completed");
  await arm("?scope=history", "hold");
  await toggle(past);
  await held("?scope=history");
  await toggle(dag);
  await release("?scope=history");
  await assertCollapsed(dag);
  await arm(dagRoute, "fail");
  await toggle(dag);
  await visible(`${dag}[open]`, "failed or timed out");
  assert.equal(await readCount("/activity"), 0, "HTTP 500 never falls back to disk");
  assert.match(await text(liveDag), /Run 1 · Running/);
  await capture("dag-history-failed-1440-dark");
  await toggle(dag);

  await select("Older fixture");
  await open();
  await tab("dag");
  await visible(liveDag, "does not support this read");
  assert.equal(await readCount("/activity"), 0, "An unsupported current DAG never loads a snapshot");
  await toggle(dag);
  await visible(`${dag}[open]`, "Saved snapshot · Read-only");
  await visible(`${dag}[open]`, "Not live");
  assert.doesNotMatch(await text(liveDag), /Saved snapshot|Run 1/);
  assert.equal(await readCount("/activity"), 1);
  await capture("dag-history-saved-1440-dark");

  await toggle(dag);
  await arm(dagRoute, "hold");
  await toggle(dag);
  await held(dagRoute);

  await select("Current fixture");
  await open();
  await tab("dag");
  await visible(liveDag, "Run 1 · Running");
  await release(dagRoute);
  await assertCollapsed(dag);
  assert.equal(await readCount("/activity"), 1, "A late unsupported reply after session switch must not read disk");
  await tab("todo");
  await visible(liveTodo, "Current-only item");
  await arm(todoRoute, "hold");
  await toggle(todo);
  await held(todoRoute);
  await tab("overview");
  await toggle("#runtime-tree details");
  const reset = "#runtime-tree button:not([data-tree-older], [data-tree-reload]):not(.button--quiet)";
  await visible(reset, "Switch to an empty context");
  await click(reset);
  await visible("#details-dialog:not([aria-busy]) #runtime-tree details[open]", "The session position changed");
  await tab("todo");
  await visible(liveTodo, "No current Todo");
  await release(todoRoute);
  await assertCollapsed(todo);
  await toggle(todo);
  await visible(`${todo}[open]`, "No recorded lists");
  assert.doesNotMatch(await text(todo), /Recorded-only item|Sibling-only item/);
  await toggle(todo);
  await arm("/branch-runtime?scope=todo", "fail");
  await refresh();
  await visible(liveTodo, "unavailable");
  assert.doesNotMatch(await text(liveTodo), /No current Todo|Recorded-only item/);
  await capture("todo-current-failed-1440-dark");

  await select("Other fixture");
  await open();
  await tab("dag");
  await visible(liveDag, "Running");
  await arm(dagRoute, "hold");
  await toggle(dag);
  await held(dagRoute);
  await close();
  await open();
  await tab("dag");
  await visible(liveDag, "Running");
  await release(dagRoute);
  await assertCollapsed(dag);
  await tab("todo");
  await visible(liveTodo, "Current-only item");
  await visible("#current-todo:not([hidden])", "Current-only item");
  const historyBeforeSettlement = await probeCount();
  const settled = await request(`/api/sessions/${ids["Other fixture"]}/actions`, { action: "rename", name: "Settled fixture" });
  assert.equal(settled.status, 200);
  await visible(liveTodo, "No current Todo");
  await page.evaluate(() => {
    if (document.querySelector("#current-todo").hidden) return;
    return new Promise((done, fail) => {
      const hud = document.querySelector("#current-todo");
      const timer = setTimeout(() => { observer.disconnect(); fail(new Error("Settlement did not clear the current Todo HUD")); }, 5000);
      const observer = new MutationObserver(() => {
        if (!hud.hidden) return;
        clearTimeout(timer);
        observer.disconnect();
        done();
      });
      observer.observe(hud, { attributes: true, attributeFilter: ["hidden"] });
    });
  });
  await toggle(todo);
  await visible(`${todo}[open]`, "Settled item");
  assert.doesNotMatch(await text(liveTodo), /Settled item/);
  assert.equal(await probeCount(), historyBeforeSettlement + 1, "Settlement did not reopen collapsed history");
  await capture("todo-history-settled-1440-dark");
  await ensureTerminalDAG();
  assert.deepEqual(await page.evaluate(() => window.runtimeProbe.reads.filter(({ method }) => method !== "GET")),
    [{ route: `/api/sessions/${ids["Current fixture"]}/actions`, method: "POST" }],
    "Only deliberate tree navigation writes; Inspector and all History actions are read-only");

  async function ensureTerminalDAG() {
    await tab("dag");
    await visible(liveDag, "Older matches are unknown");
    assert.doesNotMatch(await text(liveDag), /Run [12] ·/);
    await assertCollapsed(dag);
    await toggle(dag);
    await visible(`${dag}[open]`, "Run 2 · Completed");
    assert.doesNotMatch(await text(liveDag), /Run [12] ·/);
    await capture("dag-history-terminal-1440-dark");
  }
}
