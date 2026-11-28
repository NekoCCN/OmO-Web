export type AttachmentRangeSelection =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const HUGE = Number.POSITIVE_INFINITY;

function parseOffset(digits: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return HUGE;
  return value;
}

// Bounded magnitude compare on raw digit strings: strip leading zeros,
// then longer length wins, else lexicographic order. No BigInt allocation.
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+/, "") || "0";
  const y = b.replace(/^0+/, "") || "0";
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export function selectAttachmentRange(
  headers: Headers,
  size: number,
  etag: string,
): AttachmentRangeSelection {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "full" };
  const raw = headers.get("range");
  if (raw === null) return { kind: "full" };
  const ifRange = headers.get("if-range");
  if (ifRange !== null && ifRange !== etag) return { kind: "full" };
  const unitMatch = /^([A-Za-z]+)\s*=\s*([\s\S]*)$/.exec(raw.trim());
  if (unitMatch === null) return { kind: "full" };
  if (unitMatch[1].toLowerCase() !== "bytes") return { kind: "full" };
  const spec = unitMatch[2].trim();
  if (spec.includes(",")) return { kind: "full" };

  const suffix = /^\s*-\s*(\d+)\s*$/.exec(spec);
  if (suffix !== null) {
    const length = parseOffset(suffix[1]);
    if (length === 0 || size === 0) return { kind: "unsatisfiable" };
    if (length === HUGE || length >= size) {
      return { kind: "partial", start: 0, end: size - 1 };
    }
    return { kind: "partial", start: size - length, end: size - 1 };
  }

  const open = /^(\d+)\s*-\s*$/.exec(spec);
  if (open !== null) {
    const start = parseOffset(open[1]);
    if (start === HUGE || start >= size) return { kind: "unsatisfiable" };
    return { kind: "partial", start, end: size - 1 };
  }

  const closed = /^(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
  if (closed === null) return { kind: "full" };
  if (compareDigits(closed[1], closed[2]) > 0) return { kind: "full" };
  const start = parseOffset(closed[1]);
  if (start === HUGE || start >= size) return { kind: "unsatisfiable" };
  const end = parseOffset(closed[2]);
  const clamped = end === HUGE || end >= size ? size - 1 : end;
  return { kind: "partial", start, end: clamped };
}
