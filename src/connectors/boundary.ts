import { createHash } from "node:crypto";
import { z } from "zod";
import { effectSchema } from "../core.js";
import type { Effect } from "../core.js";

export const receiptSchema = z.object({ providerId: z.string().min(1), url: z.string().url().nullable(), content: z.string() });
export const reconciliationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), receipt: receiptSchema }),
  z.object({ kind: z.literal("absent"), proof: z.string().min(1) }),
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1) }),
]);

export function parseEffect(raw: Effect) {
  const effect = effectSchema.parse(raw);
  if (effect.call.name !== "github_read_issues" && effect.call.name !== "github_create_issue") throw new Error("GitHub connector cannot run this tool");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(effect.call.input.repository)) throw new Error("Invalid repository name");
  return { ...effect, call: effect.call };
}

export function effectKey(effect: Effect) {
  return createHash("sha256").update(JSON.stringify([effect.workspaceId, effect.taskId, effect.id])).digest("hex");
}

export function effectFingerprint(effect: Effect) {
  return createHash("sha256").update(JSON.stringify([effect.hash, effect.call.name, effect.call.input])).digest("hex");
}

export function correlationMarker(effect: Effect) {
  return `<!-- asmo-effect:${effectKey(effect)}:${effectFingerprint(effect)} -->`;
}
