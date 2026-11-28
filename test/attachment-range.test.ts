import { expect, test } from "bun:test";
import { selectAttachmentRange } from "../src/attachment-range.ts";

const ETAG = '"abc123"';
const headers = (range?: string, ifRange?: string): Headers => {
  const h = new Headers();
  if (range !== undefined) h.set("range", range);
  if (ifRange !== undefined) h.set("if-range", ifRange);
  return h;
};

test("no range header returns full", () => {
  expect(selectAttachmentRange(headers(), 200, ETAG)).toEqual({ kind: "full" });
});

test("unsupported unit is ignored", () => {
  expect(selectAttachmentRange(headers("items=0-10"), 200, ETAG)).toEqual({ kind: "full" });
});

test("byte unit is case insensitive", () => {
  expect(selectAttachmentRange(headers("BYTES=0-9"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 0,
    end: 9,
  });
});

test("closed range selects inclusive bytes", () => {
  expect(selectAttachmentRange(headers("bytes=0-99"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 0,
    end: 99,
  });
});

test("open-ended range runs to EOF", () => {
  expect(selectAttachmentRange(headers("bytes=50-"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 50,
    end: 199,
  });
});

test("end beyond EOF clamps to size-1", () => {
  expect(selectAttachmentRange(headers("bytes=50-500"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 50,
    end: 199,
  });
});

test("suffix range selects trailing bytes", () => {
  expect(selectAttachmentRange(headers("bytes=-50"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 150,
    end: 199,
  });
});

test("oversized suffix selects whole file", () => {
  expect(selectAttachmentRange(headers("bytes=-500"), 200, ETAG)).toEqual({
    kind: "partial",
    start: 0,
    end: 199,
  });
});

test("leading zeros parse as decimal", () => {
  expect(selectAttachmentRange(headers("bytes=007-010"), 20, ETAG)).toEqual({
    kind: "partial",
    start: 7,
    end: 10,
  });
});

test("zero suffix is unsatisfiable", () => {
  expect(selectAttachmentRange(headers("bytes=-0"), 200, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
});

test("start beyond EOF is unsatisfiable", () => {
  expect(selectAttachmentRange(headers("bytes=200-"), 200, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
  expect(selectAttachmentRange(headers("bytes=500-600"), 200, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
});

test("empty file ranges are unsatisfiable", () => {
  expect(selectAttachmentRange(headers("bytes=0-"), 0, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
  expect(selectAttachmentRange(headers("bytes=-5"), 0, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
});

test("huge offsets stay safe: huge start unsatisfiable, huge end clamps", () => {
  expect(selectAttachmentRange(headers("bytes=99999999999999999999-"), 100, ETAG)).toEqual({
    kind: "unsatisfiable",
  });
  expect(selectAttachmentRange(headers("bytes=0-99999999999999999999"), 100, ETAG)).toEqual({
    kind: "partial",
    start: 0,
    end: 99,
  });
});

test("malformed ranges are ignored", () => {
  for (const value of ["bytes=", "bytes=-", "bytes=5", "bytes=abc-def", "bytes=--5"]) {
    expect(selectAttachmentRange(headers(value), 200, ETAG)).toEqual({ kind: "full" });
  }
});

test("reversed ranges are ignored", () => {
  expect(selectAttachmentRange(headers("bytes=10-5"), 200, ETAG)).toEqual({ kind: "full" });
});

test("reversed ranges past EOF are ignored, not unsatisfiable", () => {
  expect(selectAttachmentRange(headers("bytes=900-5"), 200, ETAG)).toEqual({ kind: "full" });
});

test("huge reversed ranges are ignored without big allocations", () => {
  expect(selectAttachmentRange(headers("bytes=99999999999999999999-5"), 100, ETAG)).toEqual({
    kind: "full",
  });
  expect(
    selectAttachmentRange(headers("bytes=99999999999999999999-88888888888888888888"), 100, ETAG),
  ).toEqual({ kind: "full" });
});

test("multiple ranges are unsupported and ignored", () => {
  expect(selectAttachmentRange(headers("bytes=0-1,2-3"), 200, ETAG)).toEqual({ kind: "full" });
});

test("stale, weak, or date If-Range is ignored", () => {
  expect(selectAttachmentRange(headers("bytes=0-9", '"other"'), 200, ETAG)).toEqual({
    kind: "full",
  });
  expect(selectAttachmentRange(headers("bytes=0-9", 'W/"abc123"'), 200, ETAG)).toEqual({
    kind: "full",
  });
  expect(selectAttachmentRange(headers("bytes=0-9", "Wed, 21 Oct 2015 07:28:00 GMT"), 200, ETAG)).toEqual({
    kind: "full",
  });
});

test("exact strong If-Range equality honors the range", () => {
  expect(selectAttachmentRange(headers("bytes=0-9", ETAG), 200, ETAG)).toEqual({
    kind: "partial",
    start: 0,
    end: 9,
  });
});
