import { getDb } from "./db";
import { editHtml, sendHtml } from "./tg";

async function sendRecorded(token: string, row: any) {
  const db = await getDb();
  const claimed = await db.rpc("claim_bot_delivery", { p_id: row.id });
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return false;
  row = claimed.data;
  const { receiptMessageId, ...extra } = row.extra ?? {};
  if (receiptMessageId) {
    const result = await editHtml(token, Number(row.chat_id), Number(receiptMessageId), row.html, extra);
    if (result !== "fail") return true;
  }
  const sent = await sendHtml(token, Number(row.chat_id), row.html, extra);
  if (!sent) {
    const retry = await db.from("bot_outbox").update({ lease_until: null }).eq("id", row.id);
    if (retry.error) throw retry.error;
  }
  return sent;
}

/** Persist before sending: retry delivery, never repeat the purchase. */
export async function deliver(bot: { token: string; tenantId: number }, chatId: number, html: string, extra: Record<string, unknown>, source: string) {
  const db = await getDb();
  const { data, error } = await db.from("bot_outbox").insert({ tenant_id: bot.tenantId, chat_id: chatId, html, extra, source }).select("*").single();
  let row = data;
  if (error?.code === "23505") {
    const existing = await db.from("bot_outbox").select("*").eq("source", source).maybeSingle();
    if (existing.error) throw existing.error;
    row = existing.data;
  } else if (error) throw error;
  if (!row) throw new Error("Delivery could not be recorded");
  if (row.status === "sent") return true;
  const sent = await sendRecorded(bot.token, row);
  if (sent) {
    const result = await db.from("bot_outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
    if (result.error) throw result.error;
  }
  return Boolean(sent);
}

export async function affiliateNotice(bot: { token: string; tenantId: number }, affiliate: any, source: string) {
  if (!affiliate?.ok || !affiliate.tg_id) return;
  const { money, escapeHtml } = await import("./tg");
  await deliver(bot, Number(affiliate.tg_id), `🎉 You earned <b>${money(affiliate.amount)}</b> commission from <b>${escapeHtml(affiliate.buyer ?? "a referral")}</b>!\n💰 New balance: <b>${money(affiliate.balance)}</b>`, {}, `affiliate:${source}`);
}

export async function enqueueUpdate(tenantId: number, update: any) {
  if (!Number.isSafeInteger(update?.update_id)) throw new Error("Invalid update ID");
  const db = await getDb();
  const { error } = await db.from("bot_update_queue").insert({ tenant_id: tenantId, update_id: update.update_id, payload: update });
  if (error && error.code !== "23505") throw error;
}

let draining = false;
export async function drainUpdates(resolveBot: (tenantId: number) => Promise<any>, processUpdate?: (bot: any, update: any) => Promise<void>) {
  if (draining) return;
  draining = true;
  try {
    const db = await getDb();
    const { data: rows, error } = await db.rpc("claim_bot_updates");
    if (error) throw error;
    const process = processUpdate ?? (await import("./engine")).handleUpdate;
    await Promise.all((rows ?? []).map(async (row: any) => {
      try {
        const bot = await resolveBot(Number(row.tenant_id));
        if (!bot) throw new Error("Bot unavailable");
        await process({ ...bot, durable: true }, row.payload);
        const done = await db.from("bot_update_queue").update({ status: "done", lease_until: null, payload: {} }).eq("tenant_id", row.tenant_id).eq("update_id", row.update_id);
        if (done.error) throw done.error;
      } catch {
        // Keep the persisted update and retry after the lease; never log keys/passwords.
        console.error("Queued bot update will retry", row.tenant_id, row.update_id);
      }
    }));
  } finally { draining = false; }
}

let delivering = false;
export async function drainOutbox(resolveBot: (tenantId: number) => Promise<any>) {
  if (delivering) return;
  delivering = true;
  try {
    const db = await getDb();
    const { data: rows, error } = await db.from("bot_outbox").select("*").eq("status", "pending").order("attempts").order("id").limit(20);
    if (error) throw error;
    for (const row of rows ?? []) {
      const bot = await resolveBot(Number(row.tenant_id));
      if (!bot) continue;
      const sent = await sendRecorded(bot.token, row);
      const result = await db.from("bot_outbox").update({ ...(sent ? { status: "sent", sent_at: new Date().toISOString() } : {}) }).eq("id", row.id);
      if (result.error) throw result.error;
    }
  } finally { delivering = false; }
}