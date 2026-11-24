import { list, num, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import type { Answer } from "./interactions.ts";

export type Session = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly settled: boolean;
  readonly active: boolean;
  readonly running: boolean;
};

export function parseSession(value: unknown): Session | undefined {
  const raw = object(value);
  const id = str(raw.id);
  if (!id) return;
  return {
    id, name: str(raw.name) || "未命名会话", cwd: str(raw.cwd), updatedAt: num(raw.updatedAt) ?? 0,
    archived: raw.archived === true, settled: raw.settled === true, active: raw.active === true, running: raw.running === true,
  };
}

export const parseSessions = (data: Wire): Session[] => list(data.sessions).flatMap(value => {
  const session = parseSession(value);
  return session ? [session] : [];
});

export type Mode = "prompt" | "steer" | "follow_up";
export type Image = { readonly type: "image"; readonly data: string; readonly mimeType: string };
export type Action =
  | { readonly action: "resume" | "abort" | "clearQueue" }
  | { readonly action: "prompt"; readonly message: string; readonly mode: Mode; readonly expectedTurnId?: string; readonly clientMessageId: string; readonly images?: readonly Image[] }
  | { readonly action: "rename"; readonly name: string }
  | { readonly action: "archive" | "settle" | "fast" | "autoCompaction"; readonly enabled: boolean }
  | { readonly action: "model"; readonly provider: string; readonly modelId: string }
  | { readonly action: "thinking"; readonly level: string }
  | { readonly action: "compact"; readonly instructions?: string }
  | { readonly action: "navigate"; readonly targetId: string | null }
  | ({ readonly action: "answer"; readonly requestId: string } & Answer);

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export const sessionPath = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;

export class Api {
  token = "";

  async request(path: string, body?: object, signal?: AbortSignal): Promise<Wire> {
    const post = body !== undefined;
    const response = await fetch(path, {
      method: post ? "POST" : "GET",
      signal,
      cache: "no-store",
      ...(post ? { headers: { "Content-Type": "application/json", "X-OmO-Token": this.token }, body: JSON.stringify(body) } : {}),
    });
    let data: Wire;
    try {
      const raw: unknown = await response.json();
      data = object(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RequestError(`本机 Web 服务返回了无效响应（HTTP ${response.status}）`, response.status, "");
    }
    if (!response.ok) throw new RequestError(str(data.error) || `请求失败（HTTP ${response.status}）`, response.status, str(data.code));
    return data;
  }

  action(id: string, action: Action): Promise<Wire> {
    return this.request(`${sessionPath(id)}/actions`, action);
  }
}
