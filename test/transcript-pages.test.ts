import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptCache, TRANSCRIPT_CACHE_COUNT, TRANSCRIPT_CAPTURE_BYTES, TRANSCRIPT_CAPTURE_ROWS,
  TRANSCRIPT_STAGING_COUNT, TRANSCRIPT_TTL_MS } from "../src/transcript-pages.ts";

function withCache(run: (cache: TranscriptCache, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "omo-transcript-test-"));
  const cache = new TranscriptCache(root);
  try { run(cache, root); }
  finally {
    cache.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

const begin = (cache: TranscriptCache, owner: string) => cache.begin(owner, () => {}, async () => {});

test("wraps the capped file and retains newest rows and their content", () => {
  withCache((cache, root) => {
    const capture = begin(cache, "owner");
    const text = "x".repeat(2_050_000);
    for (let timestamp = 0; timestamp < 34; timestamp++) {
      capture.append({ role: "assistant", content: `${timestamp}-${text}`, timestamp });
    }
    cache.commit(capture);
    const [directory] = readdirSync(root);
    expect(statSync(join(root, directory!, "capture")).size).toBeLessThanOrEqual(TRANSCRIPT_CAPTURE_BYTES);
    let page = capture.page();
    const rows = [...page.messages];
    while (page.page.olderCursor) {
      page = capture.page(capture.cursor(page.page.olderCursor, false).row);
      rows.unshift(...page.messages);
    }
    expect(page.transcript).toEqual({ status: "truncated" });
    expect(rows[0]!.timestamp).toBeGreaterThan(0);
    const stamps = rows.map(row => row.timestamp);
    expect(stamps).toEqual(Array.from({ length: rows.length }, (_, i) => 34 - rows.length + i));
    const newest = rows.at(-1)!.historyContent as { cursor: string };
    expect(capture.content(capture.cursor(newest.cursor, true)).text).toStartWith("33-x");
  });
});

test("caps the small-row index independently of the disk cap", () => {
  withCache(cache => {
    const capture = begin(cache, "owner");
    for (let timestamp = 0; timestamp < TRANSCRIPT_CAPTURE_ROWS + 15; timestamp++) {
      capture.append({ role: "assistant", content: "small", timestamp });
    }
    cache.commit(capture);
    let page = capture.page();
    let count = page.messages.length;
    while (page.page.olderCursor) {
      page = capture.page(capture.cursor(page.page.olderCursor, false).row);
      count += page.messages.length;
    }
    expect(count).toBe(TRANSCRIPT_CAPTURE_ROWS);
    expect(page.messages[0]!.timestamp).toBe(15);
    expect(page.transcript).toEqual({ status: "truncated" });
  });
});

test("locally omits non-inline binary and unsupported content without dropping the caption", () => {
  withCache(cache => {
    const capture = begin(cache, "owner");
    capture.append({ role: "user", content: [
      { type: "text", text: "attachment caption" },
      { type: "image", data: "a".repeat(400_000), mimeType: "image/png" },
      { type: "private_binary", data: "do-not-publish" },
    ], timestamp: 1 });
    cache.commit(capture);
    expect(capture.page()).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: "attachment caption" }], timestamp: 1 }],
      page: { id: capture.id },
      transcript: { status: "truncated" },
    });
  });
});

test("bounds staging and resident files, evicts oldest and expires generations", () => {
  withCache((cache, root) => {
    const stages = Array.from({ length: TRANSCRIPT_STAGING_COUNT }, (_, i) => begin(cache, `stage-${i}`));
    expect(() => begin(cache, "overflow")).toThrow(expect.objectContaining({ code: "history_capture_busy" }));
    for (const stage of stages) cache.commit(stage);
    for (let i = stages.length; i <= TRANSCRIPT_CACHE_COUNT; i++) cache.commit(begin(cache, `stage-${i}`));
    expect(readdirSync(root)).toHaveLength(TRANSCRIPT_CACHE_COUNT);
    expect(() => cache.current("stage-0")).toThrow(expect.objectContaining({ code: "transcript_cursor_stale" }));
    const later = Date.now() + TRANSCRIPT_TTL_MS;
    const clock = spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(() => cache.current("stage-1")).toThrow(expect.objectContaining({ code: "transcript_cursor_stale" }));
      expect(readdirSync(root)).toHaveLength(TRANSCRIPT_CACHE_COUNT - 1);
    } finally {
      clock.mockRestore();
    }
  });
});
