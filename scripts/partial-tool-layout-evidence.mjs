export function measureToolLayout(page, terminal) {
  return page.evaluate(terminal => {
    const tool = document.querySelector(terminal);
    const card = tool.closest(".message--tool");
    const output = tool.querySelector(".tool-output");
    const command = tool.querySelector(".tool-command-preview");
    const metrics = element => [element.clientWidth, element.scrollWidth, element.clientHeight, element.scrollHeight];
    const rect = element => {
      const box = element.getBoundingClientRect();
      return [box.left, box.right, box.height];
    };
    return {
      viewport: document.documentElement.clientWidth,
      window: [innerWidth, screen.width, visualViewport?.width, devicePixelRatio],
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      offViewport: [...document.querySelectorAll("body *")].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.right > document.documentElement.clientWidth + 1 &&
          !node.closest(".tool-output, pre");
      }).slice(0, 12).map(node => [node.tagName, node.id || node.getAttribute("class"), rect(node),
        node.parentElement.id || node.parentElement.className, node.textContent.slice(0, 48)]),
      toolRects: [...document.querySelectorAll("#transcript .message--tool")].map(rect),
      card: metrics(card),
      summary: rect(tool.querySelector("summary")),
      glyphs: [...card.querySelectorAll("svg")].map(svg => {
        const { width, height } = svg.getBoundingClientRect();
        return [width, height];
      }),
      output: metrics(output),
      command: metrics(command),
      outputOverflow: getComputedStyle(output).overflow,
      display: getComputedStyle(tool.querySelector("summary")).display,
      localScroll: [...tool.querySelectorAll("*")].filter(node => node.clientHeight && node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)).map(node => node.className),
    };
  }, terminal);
}

export function toolLayoutDefects(key, reading, open) {
  const { viewport, document, body, toolRects, card, summary, glyphs, output, command, outputOverflow } = reading;
  const defects = [];
  const check = (condition, message) => { if (!condition) defects.push(`${key}: ${message}`); };
  check(document <= viewport + 1 && body <= viewport + 1, `page width doc=${document} body=${body} viewport=${viewport}`);
  check(toolRects.every(([left, right]) => left >= -1 && right <= viewport + 1), `tools leave viewport: ${JSON.stringify(toolRects)}`);
  check(card[1] <= card[0] + 1, `tool overflows horizontally ${card[1]} > ${card[0]}`);
  check(glyphs.slice(0, 2).every(([width, height]) => width > 0 && width <= 24 && height > 0 && height <= 24),
    `oversized/missing summary glyphs: ${JSON.stringify(glyphs)}`);
  check(summary[2] >= (viewport <= 760 ? 44 : 24), `disclosure hit target is only ${summary[2]}px tall`);
  check(summary[2] <= 100 && (open || card[2] <= 260), `expanded disclosure geometry ${summary[2]} / ${card[2]}`);
  if (open) {
    check(output[2] > 0 && output[2] <= 352 && output[3] > output[2] && output[1] > output[0] && outputOverflow === "auto",
      `output is not bounded and scrollable: ${output} (${outputOverflow})`);
    check(command[0] <= card[0] && command[1] > command[0], `the long command lacks its own overflow boundary: ${command}`);
  }
  return defects;
}

export async function scrollOutputByKey(page, selector) {
  await page.locator(selector).press("End");
  return page.evaluate(selector => new Promise(done => {
    const node = document.querySelector(selector);
    if (node.scrollTop > 0) { done(true); return; }
    const timeout = setTimeout(() => { node.removeEventListener("scroll", scrolled); done(false); }, 1500);
    function scrolled() {
      clearTimeout(timeout);
      done(node.scrollTop > 0);
    }
    node.addEventListener("scroll", scrolled, { once: true });
  }), selector);
}
