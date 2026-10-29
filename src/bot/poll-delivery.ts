import { getDb } from "./db";
import { tgCall } from "./tg";

type Bot = { token: string; tenantId: number };
export type PollDeliveryCounts = { sent: number; blocked: number; failed: number; pending: number; deleted: number; deleteFailed: number };

export async function pollDeliveryCounts(pollId: number): Promise<PollDeliveryCounts> {
  const db = await getDb();
  const { data, error } = await db.from("poll_deliveries").select("status,message_id,delete_status").eq("poll_id", pollId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    sent: rows.filter((r: any) => r.message_id != null).length,
    blocked: rows.filter((r: any) => r.status === "blocked").length,
    failed: rows.filter((r: any) => r.status === "failed").length,
    pending: rows.filter((r: any) => ["pending", "sending", "retry"].includes(r.status)).length,
    deleted: rows.filter((r: any) => r.delete_status === "deleted").length,
    deleteFailed: rows.filter((r: any) => r.delete_status === "failed").length,
  };
}

/** The unique poll/chat key survives repeated /start and concurrent broadcasters. */
export async function queuePoll(bot: Bot, poll: any, chatId: number, html: string, extra: any) {
  const db = await getDb();
  const { data: active, error: readError } = await db.from("polls").select("status").eq("id", poll.id).eq("tenant_id", bot.tenantId).maybeSingle();
  if (readError) throw readError;
  if (active?.status !== "open") return;
  const { error } = await db.from("poll_deliveries").upsert({ poll_id: poll.id, tenant_id: bot.tenantId, chat_id: chatId, html, extra }, { onConflict: "poll_id,chat_id", ignoreDuplicates: true });
  if (error) throw error;
}

const failure = (error: unknown) => {
  const text = String(error instanceof Error ? error.message : error);
  const blocked = /403:.*bot was blocked/i.test(text);
  const retry = /TG \w+ (429|5\d\d):/.test(text);
  const seconds = Number(text.match(/"retry_after"\s*:\s*(\d+)/)?.[1] ?? 0);
  return { text: text.slice(0, 500), blocked, retry, seconds };
};

async function updateRow(id: number, values: any) {
  const db = await getDb();
  const { error } = await db.from("poll_deliveries").update(values).eq("id", id);
  if (error) throw error;
}

async function sendRow(bot: Bot, row: any) {
  const db = await getDb();
  const { data: poll, error } = await db.from("polls").select("status").eq("id", row.poll_id).eq("tenant_id", bot.tenantId).maybeSingle();
  if (error) throw error;
  if (poll?.status !== "open") {
    await updateRow(row.id, { status: "cancelled", lease_until: null });
    return;
  }
  let sent: any;
  try {
    const body = { chat_id: Number(row.chat_id), text: row.html, parse_mode: "HTML", ...row.extra };
    try { sent = await tgCall(bot.token, "sendMessage", body); }
    catch (error) {
      if (!/400:.*(entity|parse|emoji|BUTTON_STYLE|icon|style)/i.test(String(error))) throw error;
      const extra = structuredClone(row.extra ?? {});
      for (const buttons of extra.reply_markup?.inline_keyboard ?? []) for (const button of buttons) {
        delete button.icon_custom_emoji_id; delete button.style;
      }
      sent = await tgCall(bot.token, "sendMessage", { ...body, text: row.html.replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1"), ...extra });
    }
    if (!Number.isSafeInteger(sent?.message_id)) throw new Error("Telegram did not return a message ID");
  } catch (error) {
    const f = failure(error);
    const retry = f.retry && row.attempts < 5;
    await updateRow(row.id, { status: f.blocked ? "blocked" : retry ? "retry" : "failed", lease_until: null, last_error: f.text,
      next_attempt_at: new Date(Date.now() + Math.max(f.seconds, 2 ** Number(row.attempts ?? 1)) * 1000).toISOString() });
    return;
  }
  // A failed write after successful sending must not trigger a duplicate send.
  await updateRow(row.id, { status: "sent", message_id: sent.message_id, sent_at: new Date().toISOString(), lease_until: null, last_error: null });
}

async function deleteRow(bot: Bot, row: any) {
  try {
    await tgCall(bot.token, "deleteMessage", { chat_id: Number(row.chat_id), message_id: Number(row.message_id) });
  } catch (error) {
    const f = failure(error);
    if (!/message to delete not found/i.test(f.text)) {
      const retry = f.retry && row.delete_attempts < 5;
      await updateRow(row.id, { delete_status: retry ? "pending" : "failed", lease_until: null, last_error: f.text,
        next_attempt_at: new Date(Date.now() + Math.max(f.seconds, 2 ** Number(row.delete_attempts ?? 1)) * 1000).toISOString() });
      return;
    }
  }
  await updateRow(row.id, { delete_status: "deleted", lease_until: null, last_error: null });
}

/** Claimed by PostgreSQL; a restart never blindly resends an ambiguous send. */
export async function drainPollDeliveries(resolveBot: (tenant: number) => Promise<Bot | null>, pollId: number | null = null, chatId: number | null = null) {
  const db = await getDb();
  for (let n = 0; n < 20; n++) {
    const { data: row, error } = await db.rpc("claim_poll_delivery", { p_poll: pollId, p_chat: chatId });
    if (error) throw error;
    if (!row) return;
    const bot = await resolveBot(Number(row.tenant_id));
    if (!bot) { await updateRow(row.id, { status: "failed", lease_until: null, last_error: "Bot unavailable" }); continue; }
    if (row.delete_status === "deleting") await deleteRow(bot, row);
    else await sendRow(bot, row);
    if (!process.env["VITEST"]) await new Promise(r => setTimeout(r, 60));
  }
}

export async function deletePoll(bot: Bot, pollId: number) {
  const db = await getDb();
  const { error } = await db.from("polls").update({ status: "deleted" }).eq("id", pollId).eq("tenant_id", bot.tenantId);
  if (error) throw error;
  const votes = await db.from("poll_votes").delete().eq("poll_id", pollId);
  if (votes.error) throw votes.error;
  await drainPollDeliveries(async () => bot, pollId);
  return pollDeliveryCounts(pollId);
}