import assert from "node:assert/strict";

export async function runExecutionReplay({
  baseline, page, tab, visible, toggle, click, text, focus, capture, open, theme, resize,
  current, history, probeCount, readCount, arm, held, release, select, ids,
}) {
  const task = "#runtime-subagent .task-run";
  const graph = `${current} .dag-run`;
  const past = `${history} .dag-run`;
  const node = (run, id) => `${run} [data-node-detail="${id}"]`;
  const fold = (run, id) => `${node(run, id)} > .runtime-execution`;
  const jump = `${task} .task-dag-jump`;
  const keyPress = (selector, key = "Enter") => page.locator(selector).press(key);
  const historyReads = () => readCount("/native-runtime/dag-history");
  const detailReads = scope => readCount(`?scope=${scope}`);
  const otherCalls = () => page.evaluate(id => window.runtimeProbe.reads
    .filter(({ route }) => route.startsWith(`/api/sessions/${id}/native-runtime/dag`)), ids["Other fixture"]);
  const openIfClosed = async selector => {
    if (await page.evaluate(selector => !document.querySelector(selector)?.open, selector)) await toggle(selector);
  };
  const scrollTo = selector => page.evaluate(selector =>
    document.querySelector(selector).scrollIntoView({ block: "start" }), selector);
  const closeInspector = () => click("#details-dialog [data-close]");
  const nodeJump = (run, id) => `${node(run, id)} .node-task-jump`;
  const taskHeading = `${task}[open] > summary`;
  const checkReadyJump = async (run, id) => {
    await visible(`${fold(run, id)}[open] > summary`);
    assert(await focus(`${fold(run, id)} > summary:focus-visible`), "Focus lands on the exact verified node disclosure");
  };
  const inspectFocused = async (selector, mobile) => {
    const frame = await page.evaluate(selector => {
      const control = document.querySelector(selector);
      const { x, y, width, height } = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      const painted = element => {
        for (let parent = element; parent; parent = parent.parentElement) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)") return color;
        }
      };
      const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
      const contrast = (fg, bg) => {
        const [dark, light] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
        return (light + .05) / (dark + .05);
      };
      return { width, height, hit: control.contains(document.elementFromPoint(x + width / 2, y + height / 2)),
        textContrast: contrast(style.color, painted(control)), ringContrast: contrast(style.outlineColor, painted(control.parentElement)),
        outline: style.outlineStyle, rootOverflow: document.documentElement.scrollWidth - innerWidth,
        panelOverflow: document.querySelector("#details-scroll").scrollWidth - document.querySelector("#details-scroll").clientWidth };
    }, selector);
    assert(frame.hit && frame.outline === "solid", JSON.stringify(frame));
    assert(frame.width >= (mobile ? 44 : 24) && frame.height >= (mobile ? 44 : 24), JSON.stringify(frame));
    assert.deepEqual([frame.rootOverflow, frame.panelOverflow], [0, 0]);
    assert(frame.textContrast >= 4.5 && frame.ringContrast >= 3, JSON.stringify(frame));
    return frame;
  };

  for (const [width, profile] of [[1440, "desktop-1440"],
    [1100, { width: 1100, height: 540, deviceScaleFactor: 1, mobile: false, hasTouch: false }],
    [390, "iphone-14"], [320, { width: 320, height: 700, deviceScaleFactor: 1, mobile: true, hasTouch: true }]]) {
    if (width !== 1440) { await closeInspector(); await resize(profile); await open(); }
    for (const mode of ["light", "dark"]) {
      await theme(mode);
      await tab("subagents");
      await visible("#runtime-subagent", baseline ? "Task 1" : "Review shared outline");
      const historyBefore = await probeCount();
      const currentBefore = await detailReads("current");
      await capture(`execution-task-roster-${width}-${mode}`);
      if (!baseline) {
        assert.equal(await page.evaluate(jump => document.querySelectorAll(jump).length, jump), 0,
          "No previously opened graph means no reverse shortcut");
        await keyPress("#runtime-subagent li:last-child > .task-run > summary");
        await visible(`${task}[open]`, "This detail is available without opening the DAG.");
        await capture(`execution-task-unlinked-${width}-${mode}`);
        assert.equal(await detailReads("current"), currentBefore);
        assert.equal(await probeCount(), historyBefore, "Standalone task detail must not probe either DAG scope");
      }
      await tab("dag");
      await visible(`${graph} > summary`, baseline ? "9 nodes" : "Release readiness review");
      await capture(`execution-dag-roster-${width}-${mode}`);
      await keyPress(`${graph} > summary`);
      await visible(`${graph} .dag-graph-map`);
      await openIfClosed(`${graph} .dag-graph-text`);
      if (baseline) {
        await scrollTo(`${graph} .dag-graph-text`);
        await capture(`execution-node-${width}-${mode}`);
      } else {
        const graphNode = `${graph} .dag-graph-node[data-node="2"]`;
        await visible(graphNode, "Verify document equations");
        await scrollTo(`${graph} .dag-graph-map`);
        await capture(`execution-topology-${width}-${mode}`);
        await click(graphNode);
        await visible(`${fold(graph, 2)}[open]`, "Verify equations and note missing citations.");
        await keyPress(`${fold(graph, 2)} > summary`);
        await keyPress(`${fold(graph, 2)} > summary`);
        const nodeMeasure = await inspectFocused(`${fold(graph, 2)} > summary`, width <= 390);
        assert.match(await text(fold(graph, 2)), /configured\/node-override.*requested\/model-1.*Effective model.*Not reported/su);
        await capture(`execution-node-${width}-${mode}`);
        await keyPress(nodeJump(graph, 2));
        await visible(`${task}[open]`, "Verify equations and note missing citations.");
        assert(await focus(`${taskHeading}:focus-visible`), "Forward shortcut selects the second identically named task by key");
        const taskMeasure = await inspectFocused(taskHeading, width <= 390);
        console.log(`EXECUTION_FOCUS ${width} ${mode} ${JSON.stringify({ node: nodeMeasure, task: taskMeasure })}`);
        assert.match(await text(`${task}[open]`), /process.*requested\/model-1.*Effective model.*Not reported/su);
        assert.doesNotMatch(await text(`${task}[open]`), /Compare headings|confirmed-v2/u);
        await capture(`execution-task-linked-${width}-${mode}`);
        await keyPress(`${task}[open] .task-dag-jump`);
        await checkReadyJump(graph, 2);
        assert.equal(await probeCount(), historyBefore, "The current shortcut must not prefetch history");
        assert.equal(await detailReads("current"), currentBefore + 2, "Only graph open and exact reverse jump read current");
        await openIfClosed(fold(graph, 0));
        const recorded = await text(fold(graph, 0));
        assert.match(recorded, /Compare headings.*observed\/confirmed-v2.*Reasoning.*high.*Elapsed.*1m 2s/su);
        assert.doesNotMatch(await text(fold(graph, 2)), /Elapsed/u, "A last activity clock is not a completion time");
        await openIfClosed(fold(graph, 3));
        assert.doesNotMatch(await text(fold(graph, 3)), /Elapsed/u, "A reversed clock pair cannot produce a duration");
        await openIfClosed(fold(graph, 6));
        assert.match(await text(fold(graph, 6)), /Not reported.*No verified subagent task/su);
        assert.equal(await page.evaluate(selector => document.querySelector(selector), nodeJump(graph, 6)), null);
        await openIfClosed(fold(graph, 7));
        await scrollTo(fold(graph, 7));
        await capture(`execution-node-end-${width}-${mode}`);
        assert.doesNotMatch(await text("#runtime-dag"), /PRIVATE_DAG_DENSITY_CANARY|dag_[a-f\d-]+|st_[a-f\d]{8}/u);
      }
      await keyPress(`${graph} > summary`);
      if (!baseline) {
        // Re-enter a fresh inspector for the next theme: associations are not persisted.
        await closeInspector();
        await open();
      }
    }
  }
  if (baseline) return;

  await tab("dag");
  await visible(`${graph} > summary`, "Release readiness review");
  // Leave a current snapshot open before testing a history jump, to catch accidental reopens.
  await toggle(graph);
  await visible(`${graph} .dag-graph-map`);
  await toggle(history);
  await visible(`${past} > summary`, "Archive review");
  await toggle(past);
  await visible(`${past} .dag-graph-map`);
  await openIfClosed(`${past} .dag-graph-text`);
  await openIfClosed(fold(past, 0));
  assert.match(await text(fold(past, 0)), /another\/routed\/v3.*Reasoning.*Not reported/su);
  await keyPress(nodeJump(past, 0));
  await visible(`${task}[open]`, "Check archive");
  const currentBefore = await detailReads("current");
  const historyBefore = await detailReads("history");
  const historyListsBefore = await historyReads();
  await keyPress(`${task}[open] .task-dag-jump`);
  await checkReadyJump(past, 0);
  assert.equal(await detailReads("current"), currentBefore, "History jump cannot reopen a prior Current graph");
  assert.equal(await detailReads("history"), historyBefore + 1);
  assert.equal(await historyReads(), historyListsBefore + 1);
  await capture("execution-history-exact-320-dark");

  await keyPress(nodeJump(past, 0));
  await arm("?scope=history", "stale-child");
  await keyPress(`${task}[open] .task-dag-jump`);
  await visible("#details-error", "no longer verified");
  await capture("execution-history-stale-320-dark");
  assert.equal(await page.evaluate(selector => document.querySelector(selector), `${fold(past, 0)}[open]`), null,
    "An obsolete link never selects a node from only its local index");
  await tab("subagents");
  await visible("#runtime-subagent", "Check archive");
  assert.doesNotMatch(await text("li:nth-child(3) > .task-run"), /Open DAG node/u);

  await tab("dag");
  await toggle(history);
  await visible(`${past} > summary`, "Archive review");
  await toggle(past);
  await visible(`${past} .dag-graph-map`);
  await openIfClosed(`${past} .dag-graph-text`);
  await openIfClosed(fold(past, 0));
  await keyPress(nodeJump(past, 0));
  await visible(`${task}[open]`, "Check archive");
  await arm("?scope=history", "hold");
  await keyPress(`${task}[open] .task-dag-jump`);
  await held("?scope=history");
  await visible(`${past}[open]`, "Loading waves and dependencies");
  assert(await page.evaluate(selector => {
    const loading = document.querySelector(selector);
    const { x, y, width, height } = loading.getBoundingClientRect();
    return loading.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  }, `${past} .dag-content > [role="status"]`), "The requested history run's pending indicator is in view");
  await capture("execution-history-held-320-dark");
  await closeInspector();
  await select("Other fixture");
  await open();
  await tab("subagents");
  await visible("#runtime-subagent", "Other session task");
  await release("?scope=history");
  await openIfClosed("li:nth-child(2) > .task-run");
  await visible(`${task}[open]`, "The report is readable, but its identity was not supplied.");
  assert.match(await text(`${task}[open]`), /No verified DAG node/u);
  assert.equal(await page.evaluate(jump => document.querySelectorAll(jump).length, jump), 0);
  assert.deepEqual(await otherCalls(), [], "Changing sessions from a held graph must not prefetch graph routes in the next session");
  await scrollTo(`${task}[open] .fold-body > p:last-child`);
  await capture("execution-identity-unreported-320-dark");

  await closeInspector();
  await select("Current fixture");
  await open();
  await tab("dag");
  await visible(`${graph} > summary`, "Release readiness review");
  await toggle(graph);
  await visible(`${graph} .dag-graph-map`);
  await openIfClosed(`${graph} .dag-graph-text`);
  await openIfClosed(fold(graph, 0));
  await keyPress(nodeJump(graph, 0));
  await visible(`${task}[open] .task-dag-jump`);
  const beforeGap = await probeCount();
  await page.evaluate(() => window.runtimeProbe.events.dispatchEvent(new Event("error")));
  await visible("#runtime-subagent", "Could not verify which host owns");
  assert.equal(await page.evaluate(jump => document.querySelectorAll(jump).length, jump), 0,
    "A transport discontinuity revokes the former binding's links before any new read");
  assert.equal(await probeCount(), beforeGap);
  await capture("execution-binding-unverified-320-dark");
  assert.deepEqual(await page.evaluate(() => window.runtimeProbe.reads.filter(({ method }) => method !== "GET")), [],
    "Inspector navigation does not dispatch commands or mutations");
}
