// ─── USDT payment watcher (BEP20 on BSC + TRC20 on Tron) ─────────────────────
// Keyless verification: BEP20 reads Transfer logs from public BSC RPC
// endpoints, TRC20 reads incoming transfers from the public TronGrid API. Each pending payment gets a unique cent suffix
// (e.g. 30.016) so an incoming transfer maps to exactly one payment.

import { getDb } from "./db";
import { sendHtml, money, escapeHtml } from "./tg";
import { parseEmojiTheme, themeHtml } from "./emoji";

export const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"; // USDT on BSC, 18 decimals
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Order matters: many public nodes refuse eth_getLogs ("limit exceeded"),
// publicnode answers it for 5000-block ranges.
const RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed.binance.org",
  "https://rpc.ankr.com/bsc",
];
export const TRC20_USDT = "TR7NHqjeKQxGTCi8q8ZY4pDH7UfE1bQqZ5"; // USDT on Tron, 6 decimals
const TRONGRID = "https://api.trongrid.io";
export type Network = "bep20" | "trc20";
export const NETWORK_LABEL: Record<Network, string> = { bep20: "BEP20", trc20: "TRC20" };
export const NETWORK_CHAIN: Record<Network, string> = { bep20: "BNB Smart Chain / BEP20", trc20: "Tron / TRC20" };
export const isTronAddress = (v: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v);
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
  network?: Network;
};

/** Create a pending payment with a unique cent suffix so the transfer is
 *  identifiable. Retries with a new suffix if the amount is taken. */
export async function createPayment(accountId: number, tgId: number, kind: "topup" | "sub", baseAmount: number, network: Network = "bep20"): Promise<CryptoPayment | null> {
  const db = await getDb();
  const { data: pending } = await db.from("crypto_payments").select("amount").eq("status", "pending").eq("network", network);
  const taken = new Set((pending ?? []).map((p: any) => Number(p.amount)));
  for (let attempt = 0; attempt < 20; attempt++) {
    const cents = Math.floor(Math.random() * 99) + 1; // .01 – .99
    const amount = Math.floor(baseAmount) + cents / 100;
    if (taken.has(amount)) continue;
    const { data, error } = await db.from("crypto_payments")
      .insert({ tenant_id: 0, account_id: accountId, tg_id: tgId, kind, amount, status: "pending", network })
      .select("*").single();
    if (!error && data) return data as CryptoPayment;
    console.error("createPayment insert failed", error);
    if (error && !String(error.code ?? "").startsWith("23")) break; // not a duplicate -> retrying won't help
  }
  return null;
}

export async function getWallet(network: Network = "bep20"): Promise<string | null> {
  const db = await getDb();
  const key = network === "trc20" ? "trc20_address" : "bep20_address";
  const { data } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", key).maybeSingle();
  const v = String(data?.value ?? "").trim();
  if (network === "trc20") return isTronAddress(v) ? v : null;
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

/** Networks that have a wallet configured, in display order. */
export async function availableNetworks(): Promise<Network[]> {
  const out: Network[] = [];
  for (const n of ["trc20", "bep20"] as Network[]) if (await getWallet(n)) out.push(n);
  return out;
}

async function notifyPaid(notifyToken: string, tgId: number, r: any, network: Network) {
  const label = `USDT (${NETWORK_LABEL[network]})`;
  const text = r.kind === "sub"
    ? `✅ <b>Payment received!</b>\n\n💳 ${money(r.amount)} ${label} confirmed.\n🤖 Your bot subscription is active until <b>${escapeHtml(String(r.expires_at ?? "").slice(0, 10))}</b>.`
    : `✅ <b>Payment received!</b>\n\n💳 ${money(r.amount)} ${label} confirmed.\n💰 New balance: <b>${money(r.balance)}</b>`;
  // Apply the main bot's Premium emoji theme (set in Admin → Premium emoji).
  let themed = text;
  try {
    const db = await getDb();
    const { data } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "premium_emoji").maybeSingle();
    themed = themeHtml(text, parseEmojiTheme(data?.value ?? null));
  } catch { /* keep plain emoji */ }
  await sendHtml(notifyToken, tgId, themed).catch(() => {});
}

/** TRC20 pass: incoming USDT transfers to the Tron wallet since the oldest
 *  waiting payment, matched by exact amount and created-before-transfer. */
async function scanTrc20(waiting: any[], notifyToken: string): Promise<{ scanned: number; paid: number }> {
  const wallet = await getWallet("trc20");
  if (!wallet || !waiting.length) return { scanned: 0, paid: 0 };
  const db = await getDb();
  const since = Math.min(...waiting.map((p: any) => new Date(p.created_at).getTime())) - 60_000;
  const url = `${TRONGRID}/v1/accounts/${wallet}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${TRC20_USDT}&min_timestamp=${since}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const j: any = await res.json();
  const txs: any[] = Array.isArray(j?.data) ? j.data : [];
  let paid = 0;
  const used = new Set<number>();
  for (const tx of txs) {
    if (String(tx.to ?? "") !== wallet) continue;
    const dec = Number(tx.token_info?.decimals ?? 6);
    const amount = Number(tx.value) / 10 ** dec;
    const ts = Number(tx.block_timestamp ?? 0);
    const match = waiting.find((p: any) => !used.has(p.id) && Math.abs(Number(p.amount) - amount) < 1e-9 && ts >= new Date(p.created_at).getTime() - 60_000);
    if (!match) continue;
    const { data: r } = await db.rpc("fulfill_crypto_payment", { p_id: match.id, p_tx: tx.transaction_id });
    if (!r || (r as any).err) continue;
    used.add(match.id);
    paid++;
    await notifyPaid(notifyToken, Number(match.tg_id), r, "trc20");
  }
  return { scanned: txs.length, paid };
}

/** One scan pass: fetch new USDT transfers to the wallet, fulfill matching
 *  pending payments, expire stale ones. Safe to call every minute. */
export async function scanPayments(notifyToken = "main"): Promise<{ scanned: number; paid: number }> {
  const db = await getDb();
  const { data: pending } = await db.from("crypto_payments").select("*").eq("status", "pending").order("id");
  const now = Date.now();
  for (const p of pending ?? []) {
    if (now - new Date(p.created_at).getTime() > PAYMENT_TTL_MS) {
      await db.from("crypto_payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
    }
  }
  const live = (pending ?? []).filter((p: any) => now - new Date(p.created_at).getTime() <= PAYMENT_TTL_MS);
  const tron = live.filter((p: any) => p.network === "trc20");
  const waiting = live.filter((p: any) => (p.network ?? "bep20") === "bep20");
  const t = await scanTrc20(tron, notifyToken).catch((e) => { console.error("trc20 scan failed", e); return { scanned: 0, paid: 0 }; });
  const wallet = await getWallet("bep20");
  if (!wallet || !waiting.length) return t;

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
    await notifyPaid(notifyToken, Number(match.tg_id), res, "bep20");
  }

  await db.from("bot_settings").upsert({ tenant_id: 0, key: "bsc_last_block", value: String(latest) });
  return { scanned: (logs ?? []).length + t.scanned, paid: paid + t.paid };
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
