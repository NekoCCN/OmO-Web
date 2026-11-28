import assert from "node:assert/strict";

export async function runDagDensityReplay({
  baseline, page, tab, visible, toggle, click, text, focus, probeCount, readCount, capture, open,
  theme, resize, current, history,
}) {
  const currentRun = `${current} .dag-run`;
  const lastWaveNode = `${currentRun} .dag-wave:last-of-type li:first-child`;
  const countReads = scope => readCount(`?scope=${scope}`);
  const inspectOverflow = async () => {
    const result = await page.evaluate(() => {
      const panel = document.querySelector("#details-scroll");
      const text = panel.querySelector(".dag-readout");
      const map = panel.querySelector(".dag-graph-map");
      return { root: document.documentElement.scrollWidth - innerWidth, panel: panel.scrollWidth - panel.clientWidth,
        text: text.scrollWidth - text.clientWidth, topology: map.scrollWidth - map.clientWidth };
    });
    assert.deepEqual([result.root, result.panel, result.text], [0, 0, 0], "Only the topology can use horizontal scrolling");
    assert(result.topology > 0, "Wide topology still has its own intentional scroll region");
  };
  const verifyPrivate = async () => assert.doesNotMatch(await page.evaluate(() => document.querySelector("#runtime-dag").outerHTML),
    /PRIVATE_DAG_DENSITY_CANARY|dag_33333333|dag_22222222/u);

  for (const [width, profile] of [[1440, "desktop-1440"], [390, "iphone-14"], [320,
    { width: 320, height: 700, deviceScaleFactor: 1, mobile: true, hasTouch: true }]]) {
    if (width !== 1440) {
      await click("#details-dialog [data-close]");
      await resize(profile);
      await open();
    }
    await tab("dag");
    await visible(`${currentRun} > summary`, "9 nodes");
    const beforeGraph = await countReads("current");
    assert.equal(await probeCount(), 0, "An expanded-looking summary must not fetch DAG history");
    if (!baseline) {
      const roster = await text(`${currentRun} > summary`);
      assert.match(roster, /2 of 9 completed/u, "DAG roster must show completed out of total, using only list counts");
      for (const segment of ["Pending 1", "Scheduled 1", "Running 1", "Paused 1", "Blocked 1", "Failed 1", "Canceled 0"]) {
        assert(roster.includes(segment), `List summary is missing ${segment}: ${roster}`);
      }
      assert.doesNotMatch(roster, /Skipped 0/u, "Omitted status must not turn into zero");
      assert.match(roster, /Only reported states/u);
    }
    for (const appearance of ["light", "dark"]) {
      await theme(appearance);
      await capture(`dag-density-summary-${width}-${appearance}`);
      assert.equal(await countReads("current"), beforeGraph + Number(appearance === "dark"), "Collapsed rendering never reads topology");
      await page.locator(`${currentRun} > summary`).press("Enter");
      await visible(`${currentRun} .dag-graph-map`);
      assert(await focus(`${currentRun} > summary:focus-visible`));
      const textDisclosure = `${currentRun} .dag-graph-text`;
      if (width === 1440 && !baseline) {
        const preview = await text(`${textDisclosure} > summary`);
        assert.match(preview, /Wave 1: Running 1 · Paused 1 · Failed 1/u);
        assert.match(preview, /Wave 2: Scheduled 1 · Blocked 1/u);
        await capture(`dag-density-preview-${width}-${appearance}`);
      }
      if (await page.evaluate(selector => !document.querySelector(selector).open, textDisclosure)) await toggle(textDisclosure);
      await visible(lastWaveNode, "Node 6");
      if (!baseline) {
        const wave = await text(`${currentRun} .dag-wave:first-of-type`);
        for (const segment of ["Wave 1", "Running 1", "Paused 1", "Failed 1", "Skipped 1", "Agent: explore", "Attempts: 2"]) {
          assert(wave.includes(segment), `Verified first wave is missing ${segment}: ${wave}`);
        }
        const blocked = await text(lastWaveNode);
        for (const segment of ["Blocked by dependencies", "Category: quick", "Attempts: 0", "Node 1 (Completed)",
          "Node 2 (Failed)", "Node 3 (Running)", "Node 4 (Paused)", "Node 5 (Skipped)", "Unfinished upstream", "Failed upstream"]) {
          assert(blocked.includes(segment), `Blocked row is missing ${segment}: ${blocked}`);
        }
        assert.match(await text(`${currentRun} .dag-wave:last-of-type`), /Blocked 1/u);
        assert.match(await text(`${currentRun} .dag-graph-view`), /2 waves/u);
        await inspectOverflow();
      }
      await verifyPrivate();
      await capture(`dag-density-waves-${width}-${appearance}`);
      if (width <= 390) {
        await page.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: "center" }), lastWaveNode);
        await capture(`dag-density-blocked-${width}-${appearance}`);
      }
      await page.locator(`${currentRun} > summary`).press("Enter");
      // Reset the row between cases so each replay observes the same initial disclosure state.
      await page.evaluate(selector => document.querySelector(selector).setAttribute("data-density-old", ""), `${currentRun} > summary`);
      await click("#details-refresh");
      await visible(`${currentRun} > summary:not([data-density-old])`, "9 nodes");
    }
  }
  if (!baseline) {
    assert.equal(await countReads("current"), 6, "Only the six deliberate current graph opens make detail reads");
    assert.equal(await probeCount(), 0);
    await toggle(history);
    await visible(`${history} .dag-run > summary`, "2 of 9 completed");
    assert.equal(await countReads("history"), 0);
    assert.equal(await probeCount(), 1, "History toggle reads the terminal list, not a graph or disk");
    await toggle(`${history} .dag-run`);
    await visible(`${history} .dag-graph-map`);
    assert.equal(await countReads("history"), 1, "Terminal row uses the explicit history scope");
    assert.equal(await probeCount(), 2);
    await verifyPrivate();
  }
}
