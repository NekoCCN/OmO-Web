import { button, el, errorText, field, list, notice, object, option, str } from "./dom.ts";
import type { Wire } from "./dom.ts";

type QuestionAnswer = { readonly selected: readonly string[]; readonly text?: string };
export type Answer = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true } | { readonly answers: Readonly<Record<string, QuestionAnswer>> };
type Submit = (id: string, answer: Answer) => Promise<void>;
const supported = new Set(["select", "confirm", "input", "editor", "question"]);
export const requestId = (request: Wire): string => str(request.id) || str(request.requestId);
export const isRequest = (request: Wire): boolean => Boolean(requestId(request) && supported.has(str(request.method)));

function questionFields(body: HTMLElement, request: Wire): () => Answer | undefined {
  const inputs: Array<() => readonly [string, QuestionAnswer] | undefined> = [];
  for (const [index, raw] of list(request.questions).entries()) {
    const question = object(raw);
    const id = str(question.id);
    if (!id) continue;
    const block = el("fieldset", "stack stack--tight");
    block.append(el("legend", "", str(question.header) || `问题 ${index + 1}`));
    if (str(question.question)) block.append(el("p", "plain", str(question.question)));
    const controls: HTMLInputElement[] = [];
    for (const value of list(question.options)) {
      const choice = object(value);
      const label = str(choice.label);
      if (!label) continue;
      const input = el("input");
      input.name = `question-${index}`;
      input.type = question.multiSelect === true ? "checkbox" : "radio";
      input.value = label;
      const control = el("label", "interaction-option");
      const text = el("span", "break", label);
      if (str(choice.description)) text.append(el("small", "muted", ` · ${str(choice.description)}`));
      control.append(input, text);
      controls.push(input);
      block.append(control);
    }
    const custom = el("input");
    custom.type = "text";
    custom.autocomplete = "off";
    block.append(field("自填回答（选填）", custom));
    body.append(block);
    inputs.push(() => {
      const selected = controls.filter(node => node.checked).map(node => node.value);
      const text = custom.value.trim();
      return selected.length || text ? [id, { selected, ...(text ? { text } : {}) }] : undefined;
    });
  }
  return () => {
    const pairs = inputs.flatMap(read => {
      const answer = read();
      return answer ? [answer] : [];
    });
    return pairs.length ? { answers: Object.fromEntries(pairs) } : undefined;
  };
}

const permissionOptions: Readonly<Record<string, string>> = {
  Allow: "允许", "Allow once": "仅允许这次", "Allow always": "始终允许", "Allow for session": "本会话始终允许",
  Deny: "拒绝", Block: "阻止", "Deny with feedback": "拒绝并说明原因",
};

function requestForm(request: Wire, submit: Submit): HTMLFormElement {
  const method = str(request.method);
  const title = str(request.title);
  const permission = Boolean(request.toolCallId) && method !== "question";
  const node = el("form", "request-form");
  const label = method === "question" ? "待回答问题" : permission ? "工具批准" : "等待你的决定";
  node.setAttribute("aria-label", label);
  const heading = el(title ? "p" : "h2", "request-kind", label);
  const copy = el("div", "request-copy");
  if (title) copy.append(el("h2", "plain request-title", title));
  if (str(request.message)) copy.append(el("p", "plain", str(request.message)));
  const remote = object(request.remoteOrigin);
  const origin = str(remote.deviceName) || str(remote.deviceId);
  if (origin) copy.append(el("p", "small muted break", `请求设备：${origin}`));
  if (permission) copy.append(el("p", "small muted path", `工具调用：${str(request.toolCallId)}`));

  const fields = el("div", "stack stack--tight request-fields");
  const status = el("p", "notice error small");
  status.setAttribute("role", "alert");
  status.hidden = true;
  const actions = el("div", "row request-actions");
  let sending = false;
  const send = async (answer: Answer) => {
    if (sending || node.dataset.offline === "true") return;
    sending = true;
    node.setAttribute("aria-busy", "true");
    notice(status);
    for (const control of actions.querySelectorAll("button")) control.disabled = true;
    try {
      await submit(requestId(request), answer);
    } catch (error) {
      notice(status, `未能提交：${errorText(error)}`);
    } finally {
      sending = false;
      node.removeAttribute("aria-busy");
      for (const control of actions.querySelectorAll("button")) control.disabled = node.dataset.offline === "true";
    }
  };
  let read: (() => Answer | undefined) | undefined;
  const isSecret = request.secret === true || Boolean(request.privateInput);
  switch (method) {
    case "question": read = questionFields(fields, request); break;
    case "confirm":
      actions.append(button("不批准", () => void send({ confirmed: false })), button("确认", () => void send({ confirmed: true })));
      break;
    case "select": {
      const select = el("select");
      const placeholder = option("请选择，不会自动批准", "");
      placeholder.disabled = true;
      select.append(placeholder);
      for (const item of list(request.options)) {
        if (typeof item === "string" && item) select.append(option(Object.hasOwn(permissionOptions, item) ? permissionOptions[item] ?? item : item, item));
      }
      select.value = "";
      fields.append(field("可选操作", select));
      read = () => select.value ? { value: select.value } : undefined;
      break;
    }
    case "input":
    case "editor": {
      if (isSecret) {
        fields.append(el("p", "muted", "此输入需要在原生客户端中处理。"));
        break;
      }
      const control = method === "editor" ? el("textarea") : el("input");
      if (control instanceof HTMLTextAreaElement) {
        control.rows = 5;
        control.value = str(request.prefill);
      } else control.autocomplete = "off";
      control.placeholder = str(request.placeholder);
      fields.append(field("输入内容", control));
      read = () => ({ value: control.value });
      break;
    }
  }
  if (!isSecret) actions.append(button("取消请求", () => void send({ cancelled: true }), "button--quiet"));
  if (read) {
    const submitButton = el("button", "button", "提交回答");
    submitButton.type = "submit";
    actions.append(submitButton);
  }
  node.addEventListener("submit", event => {
    event.preventDefault();
    if (!read) return;
    const answer = read();
    if (answer) void send(answer);
    else notice(status, "请至少填写一项回答或选择一个操作。");
  });
  const controls = el("div", method === "select" ? "request-controls request-controls--choice" : "request-controls");
  controls.append(fields, actions);
  const body = el("div", "request-body");
  body.append(copy, controls, status);
  node.append(heading, body);
  return node;
}

export class Interactions {
  private readonly nodes = new Map<string, HTMLFormElement>();

  constructor(private readonly root: HTMLElement) {}

  get first(): HTMLFormElement | undefined {
    return this.nodes.values().next().value;
  }

  render(requests: ReadonlyMap<string, Wire>, online: boolean, submit: Submit): void {
    for (const [id, node] of this.nodes) if (!requests.has(id)) {
      node.remove();
      this.nodes.delete(id);
    }
    for (const [id, request] of requests) {
      let node = this.nodes.get(id);
      if (!node) {
        node = requestForm(request, submit);
        this.nodes.set(id, node);
        this.root.append(node);
      }
      node.dataset.offline = String(!online);
      if (node.getAttribute("aria-busy") !== "true") {
        for (const control of node.querySelectorAll("button")) control.disabled = !online;
      }
    }
  }

  reset(): void {
    this.nodes.clear();
    this.root.replaceChildren();
  }
}
