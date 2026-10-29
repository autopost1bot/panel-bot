// ─── Database backup (main bot admins only) ──────────────────────────────────
// Reads every business table page by page, gzips one JSON document and sends it
// to Telegram as a file. Restore is done on the VPS with restore.mjs (never from
// inside the bot, so a mis-tap can never wipe data).
import { gzipSync } from "node:zlib";
import { getDb } from "./db";

/** Tables in restore order (parents before children) with a stable sort key. */
export const BACKUP_TABLES: [string, string[]][] = [
  ["bot_settings", ["tenant_id", "key"]],
  ["bot_accounts", ["id"]],
  ["tenant_bots", ["id"]],
  ["tenant_bot_payments", ["id"]],
  ["categories", ["id"]],
  ["products", ["id"]],
  ["product_keys", ["id"]],
  ["account_prices", ["account_id", "product_id"]],
  ["shop_orders", ["id"]],
  ["crypto_payments", ["id"]],
  ["bot_payment_transfers", ["payment_id"]],
  ["affiliate_earnings", ["id"]],
  ["trial_claims", ["tg_id"]],
  ["trial_claims_acc", ["account_id"]],
  ["polls", ["id"]],
  ["poll_votes", ["poll_id", "account_id"]],
  ["poll_deliveries", ["id"]],
  ["coupons", ["id"]],
  ["coupon_uses", ["id"]],
  ["bot_sessions", ["tenant_id", "tg_id"]],
];

const PAGE = 1000;
/** Telegram bots may upload files up to 50 MB; stay safely below. */
export const PART_BYTES = 45 * 1024 * 1024;

export async function buildBackup(): Promise<{ file: Buffer; counts: Record<string, number> }> {
  const db = await getDb();
  const tables: Record<string, any[]> = {};
  const counts: Record<string, number> = {};
  for (const [name, keys] of BACKUP_TABLES) {
    const rows: any[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = db.from(name).select("*");
      for (const k of keys) q = q.order(k, { ascending: true });
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(`backup ${name}: ${error.message ?? error}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    tables[name] = rows;
    counts[name] = rows.length;
  }
  const json = JSON.stringify({ version: 1, created_at: new Date().toISOString(), tables });
  return { file: gzipSync(Buffer.from(json, "utf8")), counts };
}

function resolveToken(token: string): string {
  return token === "main" ? process.env["ADMIN_BOT_TOKEN"] ?? "" : token;
}

async function sendDocument(token: string, chatId: number, name: string, data: Buffer, caption: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([new Uint8Array(data)]), name);
  const res = await fetch(`https://api.telegram.org/bot${resolveToken(token)}/sendDocument`, { method: "POST", body: form });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`TG sendDocument ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
}

export function backupCaption(counts: Record<string, number>, at: Date, size: number): string {
  const c = (k: string) => counts[k] ?? 0;
  return `💾 <b>Database backup</b> · ${at.toISOString().slice(0, 16).replace("T", " ")} UTC\n` +
    `👤 Accounts: ${c("bot_accounts")} · 🤖 Bots: ${c("tenant_bots")}\n` +
    `📦 Products: ${c("products")} · 🔑 Keys: ${c("product_keys")}\n` +
    `🧾 Orders: ${c("shop_orders")} · 💳 Payments: ${c("crypto_payments")}\n` +
    `🏷 Coupons: ${c("coupons")} · Size: ${(size / 1024).toFixed(0)} KB\n\n` +
    `⚠️ Contains keys and bot tokens — do not forward.`;
}

/** Builds a backup and sends it to every chat; returns the size in bytes. */
export async function sendBackup(token: string, chatIds: number[]): Promise<{ size: number; counts: Record<string, number> }> {
  const { file, counts } = await buildBackup();
  const at = new Date();
  const base = `backup-${at.toISOString().slice(0, 10)}.json.gz`;
  const parts: Buffer[] = [];
  for (let i = 0; i < file.length; i += PART_BYTES) parts.push(file.subarray(i, i + PART_BYTES));
  const caption = backupCaption(counts, at, file.length);
  for (const chat of chatIds) {
    for (let i = 0; i < parts.length; i++) {
      const name = parts.length > 1 ? `${base}.part${i + 1}` : base;
      await sendDocument(token, chat, name, parts[i]!, i === 0 ? caption + (parts.length > 1 ? `\n📎 ${parts.length} parts — join them in order before restoring.` : "") : `📎 Part ${i + 1}/${parts.length}`);
    }
  }
  const db = await getDb();
  await db.from("bot_settings").upsert({ tenant_id: 0, key: "backup_last", value: `${at.toISOString()}|${file.length}` });
  return { size: file.length, counts };
}

/** Dhaka date (UTC+6) used for the once-a-day schedule. */
export function dhakaDate(d: Date): string {
  return new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
}

/** True when the daily backup is due: enabled, after 03:00 Dhaka, none sent today. */
export function backupDue(now: Date, enabled: string | null, last: string | null): boolean {
  if (enabled === "0") return false;
  const dhakaHour = new Date(now.getTime() + 6 * 3600_000).getUTCHours();
  if (dhakaHour < 3) return false;
  const lastAt = last ? new Date(last.split("|")[0] ?? "") : null;
  return !lastAt || Number.isNaN(lastAt.getTime()) || dhakaDate(lastAt) !== dhakaDate(now);
}
