import { z } from "zod";
import { array, record } from "./protocol.ts";

export const modelTarget = z.strictObject({ provider: z.string().min(1).max(120), modelId: z.string().min(1).max(250) });
export type ModelTarget = z.infer<typeof modelTarget>;

const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const thinkingProfile = z.object({
  level: thinkingLevel,
  source: z.enum(["explicit", "session", "global", "model-default", "default", "fallback", "clamped"]),
  availableLevels: z.array(thinkingLevel).min(1).max(thinkingLevel.options.length),
}).refine(({ level, availableLevels }) => availableLevels.includes(level) &&
  new Set(availableLevels).size === availableLevels.length);

export function modelProfile(value: unknown) {
  const parsed = thinkingProfile.safeParse(value);
  return parsed.success ? { status: "ok", ...parsed.data } as const : { status: "unavailable" } as const;
}

export function registeredModel(models: unknown, target: ModelTarget): boolean {
  return array(models).some(item => {
    const model = record(item);
    return model.provider === target.provider && model.id === target.modelId;
  });
}
