import { Api } from "grammy";
import { telegramUpdateSchema } from "./updates.js";
import type { NormalizedUpdate } from "../core.js";

const limit = 32768;
export type TelegramFileGateway = {
  locate(id: string): Promise<{ file_path?: string; file_size?: number }>;
  download(path: string, signal: AbortSignal): Promise<Response>;
};

export function createTelegramFileGateway(token: string): TelegramFileGateway {
  const api = new Api(token, { timeoutSeconds: 20 });
  return {
    locate: id => api.getFile(id),
    download(path, signal) {
      if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid attachment path.");
      return fetch(`https://api.telegram.org/file/bot${token}/${path}`, { signal, redirect: "error" });
    },
  };
}

export async function attachTextFile(raw: unknown, normalized: NormalizedUpdate, gateway: TelegramFileGateway): Promise<NormalizedUpdate> {
  if (normalized.kind !== "message" || normalized.edited || !normalized.userId) return normalized;
  const document = telegramUpdateSchema.parse(raw).message?.document;
  if (!document) return normalized;
  const name = document.file_name ?? "unnamed";
  const failure = () => ({ ...normalized, text: `${normalized.text}\nAttachment ${name.slice(0, 160)} was not parsed. Only bounded UTF-8 text files up to 32 KiB are supported.` });
  if (!/\.(txt|md|csv|log|json)$/i.test(name) || document.file_size === undefined || document.file_size > limit || (document.mime_type && !["text/plain", "text/markdown", "text/csv", "application/json"].includes(document.mime_type))) return failure();
  try {
    const file = await gateway.locate(document.file_id);
    if (!file.file_path || file.file_size === undefined || file.file_size > limit) return failure();
    const response = await gateway.download(file.file_path, AbortSignal.timeout(20000));
    if (!response.ok || !response.body) return failure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) { await reader.cancel(); return failure(); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (text.includes("\0")) return failure();
    return { ...normalized, file: { name: name.slice(0, 160), text } };
  } catch { return failure(); }
}
