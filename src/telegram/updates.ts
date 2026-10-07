import { z } from "zod";
import type { NormalizedUpdate } from "../core.js";

const telegramId = z.number().int().max(Number.MAX_SAFE_INTEGER).min(-Number.MAX_SAFE_INTEGER);
const person = z.object({ id: telegramId, is_bot: z.boolean().optional() });
const entity = z.object({ type: z.string(), offset: z.number().int().nonnegative(), length: z.number().int().positive(), user: person.optional() });
const message = z.object({
  message_id: z.number().int(), chat: z.object({ id: telegramId, type: z.string() }),
  from: person.optional(), sender_chat: z.object({ id: telegramId }).optional(),
  message_thread_id: z.number().int().optional(), text: z.string().max(16000).optional(),
  caption: z.string().max(16000).optional(), entities: z.array(entity).optional(), caption_entities: z.array(entity).optional(),
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
  migrate_to_chat_id: telegramId.optional(),
  document: z.object({ file_id: z.string(), file_name: z.string().optional(), mime_type: z.string().optional(), file_size: z.number().int().nonnegative().optional() }).optional(),
});
const member = z.object({
  chat: z.object({ id: telegramId }),
  new_chat_member: z.object({ user: person, status: z.string(), is_member: z.boolean().optional() }),
});
export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(), message: message.optional(), edited_message: message.optional(),
  callback_query: z.object({ id: z.string(), from: person, data: z.string().max(64).optional(), message: message.optional() }).optional(),
  chat_member: member.optional(), my_chat_member: member.optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export function normalizeUpdate(raw: unknown, bot: { id: string; username: string }): NormalizedUpdate | null {
  const update = telegramUpdateSchema.parse(raw);
  const changed = update.my_chat_member ?? update.chat_member;
  if (changed) {
    const next = changed.new_chat_member;
    const role = ["creator", "administrator"].includes(next.status) ? "manager" : next.status === "member" || (next.status === "restricted" && next.is_member) ? "member" : null;
    return { kind: "membership", botId: bot.id, updateId: update.update_id, chatId: String(changed.chat.id), userId: String(next.user.id), role, botRemoved: String(next.user.id) === bot.id && role !== "manager" };
  }
  if (update.callback_query) {
    const callback = update.callback_query;
    if (!callback.message || !callback.data || callback.from.is_bot) return null;
    return { kind: "callback", botId: bot.id, updateId: update.update_id, chatId: String(callback.message.chat.id), userId: String(callback.from.id), messageId: callback.message.message_id, data: callback.data };
  }
  const item = update.message ?? update.edited_message;
  if (!item || item.from?.is_bot) return null;
  if (item.migrate_to_chat_id !== undefined) return { kind: "migration", botId: bot.id, updateId: update.update_id, chatId: String(item.chat.id), newChatId: String(item.migrate_to_chat_id) };
  const text = item.text ?? item.caption ?? "";
  const mentioned = (item.entities ?? item.caption_entities ?? []).some(part => {
    const content = text.slice(part.offset, part.offset + part.length);
    return (part.type === "mention" && content.toLowerCase() === `@${bot.username.toLowerCase()}`) || (part.type === "text_mention" && String(part.user?.id) === bot.id);
  });
  const command = (item.entities ?? []).find(part => part.type === "bot_command" && part.offset === 0);
  if (command) {
    const target = text.slice(0, command.length).split("@")[1];
    if (target && target.toLowerCase() !== bot.username.toLowerCase()) return null;
  }
  return {
    kind: "message", botId: bot.id, updateId: update.update_id,
    chatId: String(item.chat.id), userId: item.sender_chat ? null : item.from ? String(item.from.id) : null,
    messageId: item.message_id, topicId: item.message_thread_id ?? null,
    text, mentioned: mentioned || item.chat.type === "private", replyTo: item.reply_to_message?.message_id ?? null,
    edited: update.edited_message !== undefined,
  };
}
