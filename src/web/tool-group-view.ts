import { el } from "./dom.ts";

export class ToolGroupView {
  readonly node = el("details", "tool-group");
  private readonly body = el("ol", "tool-group-body");
  private readonly count = el("span", "tool-group-count");
  private readonly kinds = el("span", "tool-group-kinds");
  private readonly paths = el("span", "tool-group-paths");
  private readonly rows = new WeakMap<HTMLElement, HTMLLIElement>();

  constructor() {
    const summary = el("summary", "tool-group-summary");
    summary.append(this.count, " ", this.kinds, " ", this.paths);
    this.node.append(summary, this.body);
  }

  update(members: readonly HTMLElement[]): HTMLDetailsElement {
    const totals = new Map<string, number>();
    const paths = new Set<string>();
    let inspectOnly = true;
    let next = this.body.firstElementChild;
    for (const member of members) {
      const details = member.firstElementChild;
      if (details instanceof HTMLDetailsElement) {
        const name = details.dataset.groupTool;
        if (name) totals.set(name, (totals.get(name) ?? 0) + 1);
        inspectOnly &&= details.dataset.toolKind === "inspect";
        // Only the existing safe file-path slot can contribute, never the other recap fields.
        const path = details.querySelector(":scope > .tool-summary .tool-target:not([hidden])")?.textContent;
        if (path && paths.size < 2) paths.add(path);
      }
      let row = this.rows.get(member);
      if (!row) {
        row = el("li", "tool-group-row");
        this.rows.set(member, row);
      }
      if (member.parentElement !== row || row.parentElement !== this.body) {
        if (member.contains(document.activeElement) || (details instanceof HTMLDetailsElement && details.open)) this.node.open = true;
      }
      if (member.parentElement !== row) row.append(member);
      if (row !== next) this.body.insertBefore(row, next);
      next = row.nextElementSibling;
    }
    while (next) {
      const remaining = next.nextElementSibling;
      next.remove();
      next = remaining;
    }
    const count = `${inspectOnly ? "探查工具" : "工具调用"} · ${members.length} 项成功`;
    if (this.count.textContent !== count) this.count.textContent = count;
    const labels = [...totals].map(([name, total]) => `${name} ×${total}`);
    if (this.kinds.textContent !== labels.join(" ")) {
      this.kinds.replaceChildren(...labels.flatMap((value, index) => [
        ...(index ? [" "] : []), el("span", "tool-group-kind", value),
      ]));
    }
    if (this.paths.textContent !== [...paths].join(" ")) {
      this.paths.replaceChildren(...[...paths].flatMap((path, index) => [
        ...(index ? [" "] : []), el("code", "tool-group-path path", path),
      ]));
    }
    this.paths.hidden = !paths.size;
    return this.node;
  }
}
