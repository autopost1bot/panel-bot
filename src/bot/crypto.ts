// ─── BEP20 (BSC) USDT payment watcher ────────────────────────────────────────
// Keyless verification: reads Transfer logs of the USDT contract from public
// BSC RPC endpoints. Each pending payment gets a unique cent suffix
// (e.g. 30.016) so an incoming transfer maps to exactly one payment.

import { getDb } from "./db";
import { sendHtml, money, escapeHtml } from "./tg";

export const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"; // USDT on BSC, 18 decimals
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPCS = [
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed.binance.org",
  "https://rpc.ankr.com/bsc",
];
const PAYMENT_TTL_MS = 60 * 60 * 1000; // pending payments expire after 1 hour
const MAX_BLOCK_SPAN = 5000;

async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown = null;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j: any = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all BSC RPC endpoints failed");
}

const hexToInt = (h: string) => parseInt(h, 16);
const pad32 = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** USDT amount (18 decimals) from a Transfer log's data field. */
function logAmount(data: string): number {
  return Number(BigInt(data)) / 1e18;
}

export type CryptoPayment = {
  id: number;
  account_id: number;
  tg_id: number;
  kind: "topup" | "sub";
  amount: number;
  status: string;
  tx_hash: string | null;
};

/** Create a pending payment with a unique cent suffix so the transfer is
 *  identifiable. Retries with a new suffix if the amount is taken. */
export async function createPayment(accountId: number, tgId: number, kind: "topup" | "sub", baseAmount: number): Promise<CryptoPayment | null> {
  const db = await getDb();
  const { data: pending } = await db.from("crypto_payments").select("amount").eq("status", "pending");
  const taken = new Set((pending ?? []).map((p: any) => Number(p.amount)));
  for (let attempt = 0; attempt < 20; attempt++) {
    const cents = Math.floor(Math.random() * 99) + 1; // .01 – .99
    const amount = Math.floor(baseAmount) + cents / 100;
    if (taken.has(amount)) continue;
    const { data, error } = await db.from("crypto_payments")
      .insert({ tenant_id: 0, account_id: accountId, tg_id: tgId, kind, amount, status: "pending" })
      .select("*").single();
    if (!error && data) return data as CryptoPayment;
    console.error("createPayment insert failed", error);
    if (error && !String(error.code ?? "").startsWith("23")) break; // not a duplicate -> retrying won't help
  }
  return null;
}

export async function getWallet(): Promise<string | null> {
  const db = await getDb();
  const { data } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "bep20_address").maybeSingle();
  const v = String(data?.value ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

/** One scan pass: fetch new USDT transfers to the wallet, fulfill matching
 *  pending payments, expire stale ones. Safe to call every minute. */
export async function scanPayments(notifyToken = "main"): Promise<{ scanned: number; paid: number }> {
  const db = await getDb();
  const wallet = await getWallet();
  if (!wallet) return { scanned: 0, paid: 0 };

  const { data: pending } = await db.from("crypto_payments").select("*").eq("status", "pending").order("id");
  const now = Date.now();
  for (const p of pending ?? []) {
    if (now - new Date(p.created_at).getTime() > PAYMENT_TTL_MS) {
      await db.from("crypto_payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
    }
  }
  const waiting = (pending ?? []).filter((p: any) => now - new Date(p.created_at).getTime() <= PAYMENT_TTL_MS);
  if (!waiting.length) return { scanned: 0, paid: 0 };

  const latest = hexToInt(await rpc("eth_blockNumber", []));
  const { data: s } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "bsc_last_block").maybeSingle();
  let fromBlock = Number(s?.value ?? 0);
  if (!fromBlock || fromBlock > latest) fromBlock = latest - MAX_BLOCK_SPAN;
  if (latest - fromBlock > MAX_BLOCK_SPAN) fromBlock = latest - MAX_BLOCK_SPAN;

  const logs = await rpc("eth_getLogs", [{
    address: USDT_CONTRACT,
    topics: [TRANSFER_TOPIC, null, pad32(wallet)],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + latest.toString(16),
  }]);

  let paid = 0;
  for (const log of logs ?? []) {
    const amount = logAmount(log.data);
    const match = waiting.find((p: any) => Math.abs(Number(p.amount) - amount) < 1e-9);
    if (!match) continue;
    const { data: res } = await db.rpc("fulfill_crypto_payment", { p_id: match.id, p_tx: log.transactionHash });
    if (!res || (res as any).err) continue;
    paid++;
    const r = res as any;
    const text = r.kind === "sub"
      ? `✅ <b>Payment received!</b>\n\n💳 ${money(r.amount)} USDT (BEP20) confirmed.\n🤖 Your bot subscription is active until <b>${escapeHtml(String(r.expires_at ?? "").slice(0, 10))}</b>.`
      : `✅ <b>Payment received!</b>\n\n💳 ${money(r.amount)} USDT (BEP20) confirmed.\n💰 New balance: <b>${money(r.balance)}</b>`;
    await sendHtml(notifyToken, Number(match.tg_id), text).catch(() => {});
  }

  await db.from("bot_settings").upsert({ tenant_id: 0, key: "bsc_last_block", value: String(latest) });
  return { scanned: (logs ?? []).length, paid };
}

/** Status of one payment, running a fresh scan first (for "I've paid" button). */
export async function checkPayment(id: number): Promise<string> {
  const db = await getDb();
  const { data: p } = await db.from("crypto_payments").select("status").eq("id", id).maybeSingle();
  if (!p) return "missing";
  if (p.status !== "pending") return p.status;
  await scanPayments().catch(() => {});
  const { data: after } = await db.from("crypto_payments").select("status").eq("id", id).maybeSingle();
  return after?.status ?? "missing";
}
