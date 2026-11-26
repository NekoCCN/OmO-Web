import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMANDS,
  BUILTIN_COMMAND_NAMES,
  parseBuiltinInput,
} from "../src/web/builtin-commands.ts";

describe("builtin command allowlist", () => {
  test("allowlist holds twenty-one names", () => {
    expect(BUILTIN_COMMAND_NAMES).toHaveLength(21);
  });

  test("every picker entry invokes its own parse path", () => {
    const seen = new Set<string>();
    for (const entry of BUILTIN_COMMANDS) {
      expect(entry.invocation).toBe(`/${entry.name}`);
      expect(seen.has(entry.name)).toBe(false);
      seen.add(entry.name);
      expect(parseBuiltinInput(entry.invocation)).toEqual({
        kind: "builtin",
        command: { name: entry.name },
      });
    }
    expect(seen.size).toBe(BUILTIN_COMMAND_NAMES.length);
  });
});

describe("ordinary input stays with existing dispatch", () => {
  test.each([
    ["empty", ""],
    ["plain prompt", "hello world"],
    ["leading space keeps literal meaning", " /model"],
    ["leading tab keeps literal meaning", "\t/model x"],
    ["file path is preserved", "/tmp/foo"],
    ["nested path is preserved", "/path/to/file"],
    ["unknown slash is not reserved", "/nope"],
    ["case differs from the exact TUI name", "/Model"],
    ["prefix of a builtin is not a builtin", "/modelx"],
    ["bare slash opens completion, not a command", "/"],
    ["extension command stays outside the parser", "/echo hi"],
    ["slash skill stays outside the parser", "/skill:pdf-tools"],
    ["punctuation glued to a builtin stays plain", "/name:foo"],
    ["control glued to an unknown name stays plain", "/nope\u0000"],
    ["dollar skill stays outside the parser", "$pdf-tools"],
  ])("%s", (_label, text) => {
    expect(parseBuiltinInput(text)).toEqual({ kind: "plain" });
  });
});

describe("no-argument builtins", () => {
  test.each([
    ["/new"],
    ["/resume"],
    ["/sessions"],
    ["/session"],
    ["/tree"],
    ["/todo"],
    ["/tasks"],
    ["/dag"],
    ["/help"],
    ["/hotkeys"],
    ["/reasoning"],
    ["/efforts"],
    ["/fork"],
    ["/clone"],
    ["/copy"],
  ])("%s parses with no parameters", (text) => {
    const parsed = parseBuiltinInput(text);
    expect(parsed.kind).toBe("builtin");
  });

  test("trailing whitespace is still a bare invocation", () => {
    expect(parseBuiltinInput("/new   ")).toEqual({
      kind: "builtin",
      command: { name: "new" },
    });
  });

  test.each([
    ["/new extra"],
    ["/resume yesterday"],
    ["/sessions all"],
    ["/session verbose"],
    ["/tree abc123"],
    ["/todo done one"],
    ["/tasks --all"],
    ["/dag dag_native_id"],
    ["/fork entry-1"],
    ["/clone here"],
    ["/copy all"],
  ])("%s with arguments is refused, never forwarded", (text) => {
    const parsed = parseBuiltinInput(text);
    expect(parsed.kind).toBe("malformed");
  });
});

describe("rename parameters", () => {
  test("bare invocation opens the rename path without a value", () => {
    expect(parseBuiltinInput("/rename")).toEqual({
      kind: "builtin",
      command: { name: "rename" },
    });
    expect(parseBuiltinInput("/name")).toEqual({
      kind: "builtin",
      command: { name: "name" },
    });
  });

  test("name value is carried through", () => {
    expect(parseBuiltinInput("/rename 新会话")).toEqual({
      kind: "builtin",
      command: { name: "rename", value: "新会话" },
    });
  });

  test("overlong name is refused", () => {
    expect(parseBuiltinInput(`/name ${"x".repeat(121)}`).kind).toBe("malformed");
    expect(parseBuiltinInput(`/name ${"x".repeat(120)}`).kind).toBe("builtin");
  });
});

describe("compact parameters", () => {
  test("bare and instructed invocations both parse", () => {
    expect(parseBuiltinInput("/compact")).toEqual({
      kind: "builtin",
      command: { name: "compact" },
    });
    expect(parseBuiltinInput("/compact 关注鉴权逻辑")).toEqual({
      kind: "builtin",
      command: { name: "compact", instructions: "关注鉴权逻辑" },
    });
  });

  test("overlong instructions are refused", () => {
    expect(parseBuiltinInput(`/compact ${"x".repeat(6001)}`).kind).toBe("malformed");
  });
});

describe("model parameters", () => {
  test("bare invocation opens the picker", () => {
    expect(parseBuiltinInput("/model")).toEqual({
      kind: "builtin",
      command: { name: "model" },
    });
  });

  test("exact provider/id reference is carried through", () => {
    expect(parseBuiltinInput("/model openai/gpt-5")).toEqual({
      kind: "builtin",
      command: { name: "model", reference: "openai/gpt-5" },
    });
  });

  test.each([
    ["/model --default"],
    ["/model openai/gpt-5 --default"],
    ["/model --persist openai/gpt-5"],
    ["/model two words here"],
  ])("%s is refused: Web only takes an exact reference, never persistence flags", (text) => {
    expect(parseBuiltinInput(text).kind).toBe("malformed");
  });
});

describe("thinking parameters", () => {
  test("bare invocation opens the picker", () => {
    expect(parseBuiltinInput("/thinking")).toEqual({
      kind: "builtin",
      command: { name: "thinking" },
    });
  });

  test("level token is normalized for later validation against real options", () => {
    expect(parseBuiltinInput("/thinking HIGH")).toEqual({
      kind: "builtin",
      command: { name: "thinking", level: "high" },
    });
  });

  test("multi-token level is refused", () => {
    expect(parseBuiltinInput("/thinking very high").kind).toBe("malformed");
  });
});

describe("fast parameters", () => {
  test("bare invocation toggles without touching global defaults", () => {
    expect(parseBuiltinInput("/fast")).toEqual({
      kind: "builtin",
      command: { name: "fast" },
    });
  });

  test("on/off is normalized", () => {
    expect(parseBuiltinInput("/fast OFF")).toEqual({
      kind: "builtin",
      command: { name: "fast", mode: "off" },
    });
  });

  test.each([["/fast yes"], ["/fast on off"]])("%s is refused", (text) => {
    expect(parseBuiltinInput(text).kind).toBe("malformed");
  });
});

describe("known TUI-only commands never reach the model", () => {
  test.each([
    ["/settings"],
    ["/scoped-models"],
    ["/reasoning off"],
    ["/efforts high"],
    ["/favorite-models"],
    ["/task-kill"],
    ["/login"],
    ["/logout"],
    ["/trust"],
    ["/export"],
    ["/import"],
    ["/share"],
    ["/reload"],
    ["/keybindings"],
    ["/changelog"],
    ["/quit"],
    ["/exit"],
    ["/bug"],
    ["/debug"],
  ])("%s is reported as unsupported in the browser", (text) => {
    const parsed = parseBuiltinInput(text);
    expect(parsed.kind).toBe("tui-only");
  });

  test("unsupported form carries the name for the UI report", () => {
    expect(parseBuiltinInput("/settings")).toEqual({
      kind: "tui-only",
      name: "settings",
    });
  });
});

describe("malformed builtin attempts never fall through", () => {
  test.each([
    ["newline splits the single-line boundary", "/compact a\nb"],
    ["carriage return splits the single-line boundary", "/model x\ry"],
    ["control code is rejected", "/rename \u0001"],
    ["control glued to a builtin head is refused", "/model\u0000"],
    ["vertical tab glued to a builtin head is refused", "/copy\u000b"],
    ["control glued to a TUI-only head is refused", "/settings\u0000"],
    ["persistence flag is rejected", "/model --default"],
    ["extra arguments are rejected", "/copy all"],
  ])("%s", (_label, text) => {
    expect(parseBuiltinInput(text).kind).toBe("malformed");
  });
});
