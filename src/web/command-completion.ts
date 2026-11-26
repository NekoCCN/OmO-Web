import { BUILTIN_COMMANDS, parseBuiltinInput } from "./builtin-commands.ts";
import { el, list, object, str } from "./dom.ts";

export const commandToken = /^(?:\/(?:[A-Za-z0-9_-]{1,64}|skill:[A-Za-z0-9-]{1,64})|\$[A-Za-z0-9-]{1,64})$/;
const prefix = /^(?:\/(?:[A-Za-z0-9_-]{0,64}|skill:[A-Za-z0-9-]{0,64})|\$[A-Za-z0-9-]{0,64})$/;
type Candidate = { readonly invocation: string; readonly description: string };

export function commandCatalog(raw: unknown) {
  return [
    ...BUILTIN_COMMANDS.map(command => ({ ...command, source: "builtin" })),
    ...list(raw).map(object).filter(command => parseBuiltinInput(str(command.invocation)).kind === "plain"),
  ];
}

export function inlineCommandCompletion(input: HTMLTextAreaElement, popup: HTMLElement) {
  let choices: readonly Candidate[] = [];
  let active = -1;
  let dismissed: string | undefined;
  let composing = false;

  function close() {
    choices = [];
    active = -1;
    popup.hidden = true;
    input.removeAttribute("aria-activedescendant");
  }

  function select(index: number) {
    const choice = choices[index];
    if (!choice) return;
    input.value = `${choice.invocation} `;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  input.addEventListener("compositionstart", () => { composing = true; close(); });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("blur", close);
  popup.addEventListener("mousedown", event => event.preventDefault());
  popup.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const index = Array.from(popup.children).findIndex(row => row.contains(target));
    select(index);
  });

  return {
    get composing() { return composing; },
    reset() { dismissed = undefined; close(); },
    render(raw: unknown, canList: boolean) {
      const value = input.value;
      if (dismissed !== value) dismissed = undefined;
      if (!canList || composing || dismissed === value || document.activeElement !== input ||
          !prefix.test(value) || input.selectionStart !== value.length || input.selectionEnd !== value.length) {
        close();
        return;
      }
      const skill = value.startsWith("$") || value.startsWith("/skill:");
      const query = value.toLowerCase().replace(/^\/skill:/, "$");
      const matches = new Map<string, Candidate>();
      for (const command of commandCatalog(raw)) {
        const invocation = str(command.invocation);
        if (!commandToken.test(invocation) || invocation.startsWith("$") !== skill) continue;
        const normalized = invocation.toLowerCase();
        if (normalized.startsWith(query) && !matches.has(invocation)) {
          matches.set(invocation, { invocation, description: str(command.description) });
        }
      }
      const ordered = [...matches.values()].sort((a, b) =>
        Number(b.invocation === query) - Number(a.invocation === query) || a.invocation.localeCompare(b.invocation));
      const next = ordered.slice(0, 7);
      if (!next.length) { close(); return; }
      if (next.length === choices.length && next.every((item, index) =>
        item.invocation === choices[index]?.invocation && item.description === choices[index]?.description)) return;
      choices = next;
      active = -1;
      input.removeAttribute("aria-activedescendant");
      popup.replaceChildren(...next.map((choice, index) => {
        const row = el("li");
        row.id = `inline-command-${index}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.append(el("code", "", choice.invocation), el("span", "small muted", choice.description));
        return row;
      }));
      popup.hidden = false;
    },
    key(event: KeyboardEvent): boolean {
      if (composing || event.isComposing || popup.hidden || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      switch (event.key) {
        case "Escape":
          dismissed = input.value;
          close();
          break;
        case "ArrowDown":
        case "ArrowUp": {
          const length = choices.length;
          active = (active < 0 && event.key === "ArrowUp" ? length - 1 :
            (active + (event.key === "ArrowDown" ? 1 : -1) + length) % length);
          for (const [i, row] of Array.from(popup.children).entries()) row.setAttribute("aria-selected", String(i === active));
          const current = popup.children[active];
          if (current) {
            input.setAttribute("aria-activedescendant", current.id);
            current.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "Enter":
        case "Tab":
          if (active < 0) return false;
          select(active);
          break;
        default: return false;
      }
      event.preventDefault();
      return true;
    },
  };
}
