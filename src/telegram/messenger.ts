import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Api } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { AbortController as TelegramAbortController } from "abort-controller";
import { z } from "zod";
import type { Delivery, Messenger, Scope, Store } from "../core.js";

export function createTelegramMessenger(token: string, miniAppLink?: string): Messenger {
  const api = new Api(token, { timeoutSeconds: 30 });
  return {
    simulated: false,
    async send(delivery, signal) {
      signal.throwIfAborted();
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const rows: InlineKeyboardButton[][] = delivery.buttons.map(button => [{ text: button.text, callback_data: button.data }]);
      if (miniAppLink) {
        rows.push([{ text: "Configure", url: `${miniAppLink}?startapp=${encodeURIComponent(`c_${delivery.taskId ?? delivery.scopeId}`)}` }]);
      }
      const text = delivery.text.length > 4000 ? `${delivery.text.slice(0, 3800)}\n\nFull saved result is available in the task inspector.` : delivery.text;
      const reply_markup = { inline_keyboard: rows };
      try {
      if (delivery.messageId !== null) {
        await api.editMessageText(delivery.chatId, delivery.messageId, text, { reply_markup }, controller.signal);
        return { messageId: delivery.messageId };
      }
      const result = await api.sendMessage(delivery.chatId, text, {
        reply_markup, ...(delivery.topicId !== null ? { message_thread_id: delivery.topicId } : {}),
        ...(delivery.replyTo !== undefined ? { reply_parameters: { message_id: delivery.replyTo, allow_sending_without_reply: true } } : {}),
      }, controller.signal);
      return { messageId: result.message_id };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

export function createFixtureMessenger(directory: string): Messenger {
  return {
    simulated: true,
    async send(delivery) {
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${delivery.id}.json`);
      try {
        return z.object({ messageId: z.number().int() }).parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const messageId = delivery.messageId ?? Number.parseInt(delivery.id.replace(/[^a-f0-9]/gi, "").slice(0, 10), 16) % 1000000000;
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ ...delivery, messageId, simulated: true }), { flag: "wx" });
      await rename(temp, path);
      return { messageId };
    },
  };
}

export class TelegramAuthority {
  private readonly api: Api;
  constructor(token: string, private readonly botId: string, private readonly store: Store) { this.api = new Api(token, { timeoutSeconds: 20 }); }

  async refresh(scope: Scope, userId: string): Promise<void> {
    if (scope.kind === "dm") {
      if (scope.ownerId !== userId) throw new Error("Access denied.");
      return;
    }
    if (scope.kind !== "group") throw new Error("Access denied.");
    const bot = await this.api.getChatMember(scope.chatId, Number(this.botId));
    if (bot.status !== "administrator" && bot.status !== "creator") throw new Error("Asmo needs administrator membership for reliable member checks.");
    const member = await this.api.getChatMember(scope.chatId, Number(userId));
    const role = ["creator", "administrator"].includes(member.status) ? "manager" : member.status === "member" || (member.status === "restricted" && member.is_member) ? "member" : null;
    await this.store.membership(scope.id, userId, role);
    if (role === null) throw new Error("Access denied.");
  }
}
