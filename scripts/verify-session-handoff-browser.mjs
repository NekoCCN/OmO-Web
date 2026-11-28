import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function openBrowserProof() {
  const library = process.env.OMO_HANDOFF_OMOWRIGHT;
  const browserPath = process.env.OMO_HANDOFF_CHROMIUM;
  assert(library && browserPath, "--browser requires OMO_HANDOFF_OMOWRIGHT and OMO_HANDOFF_CHROMIUM");
  const { loadOmowright } = await import(pathToFileURL(resolve(library)).href);
  const { omowright } = await loadOmowright();
  const storageRoot = await mkdtemp(join(tmpdir(), "omo-web-handoff-chromium-"));
  const shots = process.env.OMO_HANDOFF_EVIDENCE;
  let browser;
  let page;
  const close = async () => {
    try { await browser?.close(); } finally { await rm(storageRoot, { recursive: true, force: true }); }
  };
  try {
    browser = await omowright.connectPipe({ browserPath, storageRoot,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${storageRoot}`] });
    page = await browser.newTab("about:blank");
    await omowright.emulate(page, "desktop-1440");
  } catch (error) {
    await close();
    throw error;
  }

  async function ready(selector, text = "", { checkValue = false } = {}) {
    return page.evaluate(({ selector, text, checkValue }) => new Promise((finish, fail) => {
      const observe = new MutationObserver(check);
      const max = setTimeout(() => {
        observe.disconnect();
        const alerts = [...document.querySelectorAll("[role=alert]:not([hidden])")]
          .filter(node => node.getClientRects().length).map(node => node.textContent?.trim()).join(" | ");
        fail(new Error(`No visible ${selector}: ${alerts.slice(0, 400)}`));
      }, 10500);
      function check() {
        const element = [...document.querySelectorAll(selector)].find(node =>
          node.getClientRects().length && (checkValue ? node.value ?? node.textContent : node.textContent).includes(text));
        if (!element) return;
        clearTimeout(max);
        observe.disconnect();
        finish({ id: element.id, text: checkValue ? element.value ?? element.textContent : element.textContent });
      }
      observe.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      check();
    }), { selector, text, checkValue });
  }

  async function click(selector, text = "") {
    const { id } = await ready(selector, text);
    if (id) await page.locator(`[id=${JSON.stringify(id)}]`).click();
    else {
      const buttons = await page.evaluate(({ selector, text }) => [...document.querySelectorAll(selector)].findIndex(node =>
        node.getClientRects().length && node.textContent.includes(text)), { selector, text });
      assert(buttons >= 0, `Missing rendered control: ${selector}`);
      await page.locator(selector).nth(buttons).click();
    }
  }

  async function capture(name) {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    for (const [viewport, mode] of [["desktop-1440", "light"], ["desktop-1440", "dark"], ["iphone-14", "light"], ["iphone-14", "dark"]]) {
      await omowright.emulate(page, viewport);
      await page.evaluate(async theme => {
        const select = document.querySelector("#theme");
        select.value = theme;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        const frame = () => new Promise(requestAnimationFrame);
        // A theme switch transitions button colors. Capture the final painted
        // state rather than a low-contrast frame halfway through the change.
        await frame();
        await frame();
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      }, mode);
      const measured = await page.evaluate(() => {
        const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
        const controls = ["cli-history-resume", "handoff-copy", "resume", "send"]
          .map(id => document.getElementById(id)).filter(node => node?.getClientRects().length)
          .map(node => {
            const css = getComputedStyle(node);
            return { id: node.id, enabled: !node.disabled, height: node.getBoundingClientRect().height,
              foreground: css.color, background: css.backgroundColor };
          });
        return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          dialog: modal ? modal.scrollWidth - modal.clientWidth : 0, controls };
      });
      assert.equal(measured.document, 0, `${name}: page width at ${viewport}`);
      assert.equal(measured.dialog, 0, `${name}: dialog width at ${viewport}`);
      for (const control of measured.controls) {
        assert(control.height >= (viewport === "iphone-14" ? 44 : 24), `${control.id}: touch target at ${viewport}`);
        if (!control.enabled) continue;
        const luminance = rgb => {
          const channels = rgb.match(/[0-9.]+/g)?.slice(0, 3).map(value => {
            const n = Number(value) / 255;
            return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
          });
          assert(channels?.length === 3);
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const ink = luminance(control.foreground);
        const fill = luminance(control.background);
        assert((Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05) >= 4.5,
          `${control.id}: text contrast in ${mode} at ${viewport}`);
      }
      await Bun.write(join(shots, `${name}-${viewport}-${mode}.png`), await page.screenshot());
    }
    await omowright.emulate(page, "desktop-1440");
  }

  return {
    async enterNew(origin) {
      assert.equal(new URL(origin).hostname, "127.0.0.1");
      await page.goto(origin);
      await click("#new-welcome:not(:disabled)");
      await click("#create:not(:disabled)");
      await ready("#composer-shell:not([hidden]) #prompt");
    },
    async enterHistory(origin, marker) {
      assert.equal(new URL(origin).hostname, "127.0.0.1");
      await page.goto(origin);
      await click("#cli-history-button");
      await ready("#cli-history-directory:not(:disabled)");
      const cwd = await page.evaluate(() => document.querySelector("#cli-history-directory").options[1].value);
      await page.locator("#cli-history-directory").selectOption(cwd);
      await click("#cli-history-list button");
      await ready("#cli-history-messages article", marker);
      await ready("#cli-history-resume:not(:disabled)");
      await capture("cli-history-resume");
      await click("#cli-history-record button:not(:disabled)", "在 Web 继续");
      await ready("#messages article", `Reply ${marker}`);
      await ready("#composer-shell:not([hidden]) #prompt");
    },
    async send(marker) {
      await page.locator("#prompt").fill(marker);
      await click("#send:not(:disabled)");
    },
    async proveBuiltins(name) {
      const submit = async value => {
        const composer = page.locator("#prompt");
        await composer.fill(value);
        await composer.press("Control+Enter");
      };
      await submit(`/name ${name}`);
      await ready("#session-title", name);
      await submit("/session");
      await ready("#details-dialog[open]");
      await click("#details-dialog button[data-close]");
      await submit("/fork");
      await ready("#branch-dialog[open]");
      await ready("#branch-message:not(:disabled)");
      await click("#branch-close");
      await submit("/settings");
      await ready('#manage-dialog[open] [data-key="run-settings"]');
      await click("#manage-dialog button[data-close]");
      const localOnly = "/scoped-models SYNTHETIC-LOCAL-ONLY";
      await submit(localOnly);
      const refused = await ready("#compose-error:not([hidden])", "本机 OmO 终端");
      assert(!refused.text.includes("SYNTHETIC-LOCAL-ONLY"), "Local-only guidance must not echo the typed arguments");
      assert.equal(await page.evaluate(() => document.querySelector("#prompt").value), localOnly,
        "Local-only refusal keeps the draft without transferring its arguments");
    },
    async proveCopy(origin, text) {
      await browser.cdp.send("Browser.grantPermissions", {
        origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await page.locator("#prompt").fill("/copy");
      await click("#send-command:not(:disabled)");
      await ready("#composer-hint", "已复制上一条助手消息");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    },
    async proveThinking(level) {
      await page.locator("#prompt").fill(`/thinking ${level}`);
      await click("#send-command:not(:disabled)");
      await ready("#thinking", level, { checkValue: true });
    },
    async handoff(path) {
      const existing = await page.evaluate(() => [...document.querySelectorAll("button:not(:disabled)")].find(button =>
        button.getClientRects().length && button.textContent.trim() === "转到 CLI")?.id);
      if (!existing) await click("#manage-button:not([hidden]):not(:disabled)");
      await click("button:not(:disabled)", "转到 CLI");
      const rendered = await ready("pre, code, textarea[readonly], input[readonly]", path, { checkValue: true });
      assert(rendered.text.includes("--session"));
      const composerIsWritable = await page.evaluate(() => {
        const composer = document.querySelector("#composer-shell");
        const prompt = document.querySelector("#prompt");
        return Boolean(composer?.getClientRects().length && prompt?.getClientRects().length && !prompt?.disabled && !prompt?.readOnly);
      });
      assert.equal(composerIsWritable, false, "Handoff receipt must stop editing the released native session");
      await capture("handoff-command");
      return rendered.text;
    },
    async reopen(origin, marker) {
      assert.equal(new URL(origin).hostname, "127.0.0.1");
      await page.goto(origin);
      await click("#session-list button");
      await click("#resume:not(:disabled):not([hidden])");
      await ready("#messages article", `Reply ${marker}`);
      await capture("handoff-resumed-workbench");
    },
    close,
  };
}
