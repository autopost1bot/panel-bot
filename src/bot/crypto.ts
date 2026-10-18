// ─── USDT payment watcher (BEP20 on BSC + TRC20 on Tron) ─────────────────────
// Keyless verification: BEP20 reads Transfer logs from public BSC RPC
// endpoints, TRC20 reads incoming transfers from the public TronGrid API. Each pending payment gets a unique cent suffix
// (e.g. 30.016) so an incoming transfer maps to exactly one payment.

import { getDb } from "./db";
import { sendHtml, money, escapeHtml } from "./tg";
import { parseEmojiTheme, themeHtml } from "./emoji";
import { affiliateNotice, deliver } from "./reliability";

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
export const PAYMENT_TTL_MS = 20 * 60 * 1000; // pending payments expire after 20 minutes
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
 *  identifiable. Amounts climb sequentially from the exact price (30.00,
 *  30.01, 30.02, ... up to +$1.00 max) so the buyer sends as little as
 *  possible; retries with the next suffix if the amount is taken. */
export async function createPayment(accountId: number, tgId: number, kind: "topup" | "sub", baseAmount: number, network: Network = "bep20"): Promise<CryptoPayment | null> {
  const db = await getDb();
  // Enforce the block at the writer too, failing closed if the guard cannot be read.
  const { data: guard, error: guardError } = await db.from("bot_order_guards").select("blocked_until").eq("account_id", accountId).maybeSingle();
  if (guardError) throw guardError;
  if (guard?.blocked_until && new Date(guard.blocked_until).getTime() > Date.now()) return null;
  const { data: pending, error: readError } = await db.from("crypto_payments").select("amount").eq("status", "pending").eq("network", network);
  if (readError) throw readError;
  const taken = new Set((pending ?? []).map((p: any) => Math.round(Number(p.amount) * 100)));
  const baseCents = Math.round(baseAmount) * 100;
  for (let cents = 0; cents <= 99; cents++) {
    if (taken.has(baseCents + cents)) continue;
    taken.add(baseCents + cents);
    const amount = (baseCents + cents) / 100;
    const { data, error } = await db.from("crypto_payments")
      .insert({ tenant_id: 0, account_id: accountId, tg_id: tgId, kind, amount, status: "pending", network })
      .select("*").single();
    if (!error && data) return data as CryptoPayment;
    console.error("createPayment insert failed", error);
    if (error && !String(error.code ?? "").startsWith("23")) break; // not a duplicate -> retrying won't help
  }
  return null;
}

/** The account's still-open invoice (pending, younger than the TTL), if any. */
export async function openPayment(accountId: number): Promise<(CryptoPayment & { created_at: string }) | null> {
  const db = await getDb();
  const { data, error } = await db.from("crypto_payments").select("*").eq("account_id", accountId).eq("status", "pending");
  if (error) throw error;
  const now = Date.now();
  const live = (data ?? []).filter((p: any) => now - new Date(p.created_at ?? now).getTime() < PAYMENT_TTL_MS);
  live.sort((a: any, b: any) => b.id - a.id);
  return (live[0] as any) ?? null;
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

async function notifyPaid(notifyToken: string, tgId: number, r: any, network: Network, paymentId: number) {
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
  await deliver({ token: notifyToken, tenantId: 0 }, tgId, themed, {}, `payment:${paymentId}`);
  await affiliateNotice({ token: notifyToken, tenantId: 0 }, r.affiliate, `crypto:${paymentId}`);
}

/** TRC20 pass: incoming USDT transfers to the Tron wallet since the oldest
 *  waiting payment, matched by exact amount and created-before-transfer. */
async function scanTrc20(waiting: any[], notifyToken: string): Promise<{ scanned: number; paid: number }> {
  const wallet = await getWallet("trc20");
  if (!wallet || !waiting.length) return { scanned: 0, paid: 0 };
  const db = await getDb();
  const since = Math.min(...waiting.map((p: any) => new Date(p.created_at).getTime())) - 60_000;
  const baseUrl = new URL(`${TRONGRID}/v1/accounts/${wallet}/transactions/trc20`);
  baseUrl.search = new URLSearchParams({ only_to: "true", only_confirmed: "true", limit: "200", contract_address: TRC20_USDT, min_timestamp: String(since) }).toString();
  let next: string | undefined = baseUrl.toString();
  let paid = 0, scanned = 0;
  const used = new Set<number>();
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next)) throw new Error("Repeated TRC20 page");
    visited.add(next);
    const res = await fetch(next, { headers: { Accept: "application/json" } });
    if (res.ok === false) throw new Error(`TRC20 request failed: ${res.status}`);
    const j: any = await res.json();
    if (!Array.isArray(j?.data)) throw new Error("Invalid TRC20 response");
    const txs: any[] = j.data;
    scanned += txs.length;
    for (const tx of txs) {
      if (String(tx.to ?? "") !== wallet) continue;
      const dec = Number(tx.token_info?.decimals ?? 6);
      const amount = Number(tx.value) / 10 ** dec;
      const ts = Number(tx.block_timestamp ?? 0);
      const match = waiting.find((p: any) => !used.has(p.id) && Math.abs(Number(p.amount) - amount) < 1e-9 && ts >= new Date(p.created_at).getTime() - 60_000);
      if (!match) continue;
      const { error: queueError } = await db.from("bot_payment_transfers").upsert({ payment_id: match.id, tx_hash: tx.transaction_id }, { onConflict: "payment_id", ignoreDuplicates: true });
      if (queueError) throw queueError;
      const { data: r, error } = await db.rpc("fulfill_crypto_payment", { p_id: match.id, p_tx: tx.transaction_id });
      if (error) throw error;
      if (!r || r.err) continue;
      used.add(match.id);
      paid++;
      await notifyPaid(notifyToken, Number(match.tg_id), r, "trc20", match.id);
      await db.from("bot_payment_transfers").update({ done: true }).eq("payment_id", match.id);
    }
    const fingerprint = j.meta?.fingerprint;
    if (fingerprint) {
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.set("fingerprint", String(fingerprint));
      next = pageUrl.toString();
    } else if (j.meta?.links?.next) {
      const pageUrl = new URL(j.meta.links.next, TRONGRID);
      if (pageUrl.origin !== TRONGRID || pageUrl.pathname !== baseUrl.pathname) throw new Error("Invalid TRC20 next page");
      next = pageUrl.toString();
    } else next = undefined;
  }
  return { scanned, paid };
}

/** One scan pass: fetch new USDT transfers to the wallet, fulfill matching
 *  pending payments, expire stale ones. Safe to call every minute. */
export async function scanPayments(notifyToken = "main"): Promise<{ scanned: number; paid: number }> {
  const db = await getDb();
  const { data: pending, error: pendingError } = await db.from("crypto_payments").select("*").eq("status", "pending").order("id");
  if (pendingError) throw pendingError;
  const { data: retries, error: retryError } = await db.from("bot_payment_transfers").select("*").eq("done", false);
  if (retryError) throw retryError;
  for (const retry of retries ?? []) {
    const { data: p, error: readError } = await db.from("crypto_payments").select("*").eq("id", retry.payment_id).maybeSingle();
    if (readError) throw readError;
    if (!p) continue;
    if (p.status === "paid") {
      // A crash after commit must still restore the confirmation/commission notice.
      const { data: result, error } = await db.rpc("payment_delivery_result", { p_id: p.id });
      if (error) throw error;
      if (!result) continue;
      await notifyPaid(notifyToken, Number(p.tg_id), result, p.network ?? "bep20", p.id);
    } else {
      const { data: result, error } = await db.rpc("fulfill_crypto_payment", { p_id: p.id, p_tx: retry.tx_hash });
      if (error || !result || result.err) continue;
      await notifyPaid(notifyToken, Number(p.tg_id), result, p.network ?? "bep20", p.id);
    }
    await db.from("bot_payment_transfers").update({ done: true }).eq("payment_id", p.id);
  }
  const retryIds = new Set((retries ?? []).map((r: any) => r.payment_id));
  const now = Date.now();
  for (const p of pending ?? []) {
    if (!retryIds.has(p.id) && now - new Date(p.created_at).getTime() > PAYMENT_TTL_MS) {
      await db.from("crypto_payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
    }
  }
  const live = (pending ?? []).filter((p: any) => !retryIds.has(p.id) && now - new Date(p.created_at).getTime() <= PAYMENT_TTL_MS);
  const tron = live.filter((p: any) => p.network === "trc20");
  const waiting = live.filter((p: any) => (p.network ?? "bep20") === "bep20");
  const t = await scanTrc20(tron, notifyToken).catch((e) => { console.error("trc20 scan failed", e); return { scanned: 0, paid: 0 }; });
  const wallet = await getWallet("bep20");
  if (!wallet || !waiting.length) return t;

  const latest = hexToInt(await rpc("eth_blockNumber", []));
  const { data: s } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "bsc_last_block").maybeSingle();
  let fromBlock = Number(s?.value ?? 0);
  if (!fromBlock || fromBlock > latest) fromBlock = latest - MAX_BLOCK_SPAN;
  fromBlock = Math.max(0, fromBlock);
  const toBlock = Math.min(latest, fromBlock + MAX_BLOCK_SPAN);

  const logs = await rpc("eth_getLogs", [{
    address: USDT_CONTRACT,
    topics: [TRANSFER_TOPIC, null, pad32(wallet)],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
  }]);

  let paid = 0;
  let failed = false;
  const used = new Set<number>();
  for (const log of logs ?? []) {
    const amount = logAmount(log.data);
    const match = waiting.find((p: any) => !used.has(p.id) && Math.abs(Number(p.amount) - amount) < 1e-9);
    if (!match) continue;
    const { error: queueError } = await db.from("bot_payment_transfers").upsert({ payment_id: match.id, tx_hash: log.transactionHash }, { onConflict: "payment_id", ignoreDuplicates: true });
    if (queueError) { failed = true; continue; }
    const { data: res, error } = await db.rpc("fulfill_crypto_payment", { p_id: match.id, p_tx: log.transactionHash });
    if (error || !res || (res.err && !String(res.err).startsWith("already "))) { failed = true; continue; }
    if (res.err) continue;
    used.add(match.id);
    paid++;
    await notifyPaid(notifyToken, Number(match.tg_id), res, "bep20", match.id);
    await db.from("bot_payment_transfers").update({ done: true }).eq("payment_id", match.id);
  }

  if (!failed) {
    const { error } = await db.from("bot_settings").upsert({ tenant_id: 0, key: "bsc_last_block", value: String(toBlock) });
    if (error) throw error;
  }
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
