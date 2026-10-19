// ─── Webhook-based shop bot engine ───────────────────────────────────────────
// One engine serves the MAIN bot (tenant_id = 0) and every tenant (reseller)
// bot. State lives in bot_sessions (workers are stateless). Purchases and
// subscriptions go through atomic Postgres functions (buy_keys,
// buy_subscription).

import { getDb, hashPassword } from "./db";
import { affiliateNotice, deliver } from "./reliability";
import {
  btn, copyBtn, entitiesToHtml, escapeHtml, fmtDate, kb, money, plainLabel,
  editHtml, sendHtml, tgCall, urlBtn, webhookSecret, type TgEntity,
} from "./tg";

import { EMOJI_ICONS, EMOJI_LABELS, emojiTag, parseEmojiTheme, replaceNameIcon, resolveEmojiTheme, themeExtra, themeHtml, titlePrefix, type EmojiTheme } from "./emoji";
import { BUTTON_COLORS, COLOR_BUTTONS, isButtonColor, parseButtonColors } from "./colors";
import { availableNetworks, checkPayment, createPayment, getWallet, openPayment, PAYMENT_TTL_MS, isTronAddress, NETWORK_CHAIN, NETWORK_LABEL, type CryptoPayment, type Network } from "./crypto";
import { isLang, LANGS, translateExtra, translateHtml, translateLabel } from "./lang";

export const MY_BOT_LABEL = "🤖 My Own Bot";
export const TRIAL_DAYS = 3;
const L = { buy: "🛍 Buy keys", acc: "🏛 Account", out: "🚀 Log out", man: "🔧 Reseller", stock: "📦 Stock", stats: "📊 Statistics", lang: "🌐 Language" };

// ─── Welcome message ─────────────────────────────────────────────────────────
// Professional default shown on /start and in the shop menu. {name} is replaced
// with the account name (or the visitor's first name before approval), so every
// user is greeted personally without any admin setup.
const DEFAULT_WELCOME =
  "👋 <b>Welcome, {name}!</b>\n\n" +
  "🤖 <b>Create your own Telegram shop bot</b> — no coding needed.\n" +
  "🛒 Sell keys and digital products with automatic delivery.\n" +
  "👥 Manage customers, orders and resellers from one panel.\n" +
  "💳 Accept USDT payments — verified automatically.\n\n" +
  "Tap <b>🤖 Make My own Bot</b> below to get started.";

// Short greeting a reseller bot shows before sign-in. The login prompt follows it,
// so the very first screen stays clean until the customer has logged in.
const DEFAULT_LOGIN_WELCOME = "👋 <b>Welcome, {name}!</b>";


const renderWelcome = (html: string, name: string | null | undefined): string =>
  html.replace(/\{name\}/gi, name ? escapeHtml(name) : "Guest");
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const APP_BASE = (process.env["PUBLIC_URL"] ?? "").replace(/\/+$/, "");

const PRESETS: [string, string][] = [
  ["1", "1 Day"], ["3", "3 Days"], ["7", "7 Days"], ["14", "14 Days"],
  ["30", "30 Days"], ["60", "60 Days"], ["90", "90 Days"],
];

// Professional prompt used whenever the bot needs a price from the admin.
export const PRICE_ASK = "💵 Enter the price for this key type (USD $):";

// Prompts of the product flow: shown as one line with a Cancel button below.
const PRODUCT_PROMPTS: string[] = ["add_name", "add_vars", "var_price", "var_cost", "set_price", "set_cost", "set_name", "set_desc"];



type Step =
  | { s: "login_user" } | { s: "login_pass"; username: string }
  | { s: "add_name"; cat: number | null }
  | { s: "add_vars"; pid: number } | { s: "var_price"; pid: number; label: string } | { s: "var_cost"; pid: number; label: string; price: number }
  | { s: "var_confirm"; pid: number; label: string; price: number; cost: number }
  | { s: "set_price"; pid: number } | { s: "set_cost"; pid: number } | { s: "set_name"; pid: number }
  | { s: "set_desc"; pid: number } | { s: "add_keys"; pid: number }
  | { s: "stock_keys"; pid: number } | { s: "stock_review"; pid: number; keys: string[]; request: string }
  | { s: "cat_new"; then: "add" | "list" } | { s: "cat_name"; cid: number }
  | { s: "acc_user" } | { s: "acc_pass"; username: string } | { s: "bal_add" }
  | { s: "broadcast" } | { s: "welcome" } | { s: "trial_text" } | { s: "support" } | { s: "aff_amount" } | { s: "aff_cu" } | { s: "aff_ca"; acc: number; name: string } | { s: "rm_user" }
  | { s: "topup"; cid: number } | { s: "deduct"; cid: number }
  | { s: "buy_qty"; pid: number } | { s: "cprice"; cid: number; pid: number }
  | { s: "pay_amount"; net?: Network }
  | { s: "await_token" }
  | { s: "emoji_icon"; icon: string }
  | { s: "emoji_catalog"; kind: "products" | "categories"; id: number };

type Session = { qc?: { brush: string; draft: Record<string, string> } | undefined; refBy?: number | undefined; accountId?: number | undefined; username?: string | undefined; step?: Step | null | undefined; approvalSent?: boolean | undefined; trialPending?: boolean | undefined; kbShown?: boolean | undefined; kbLang?: string | undefined; lang?: string | undefined; identity?: { accountId: number; name: string; username: string } };

export type BotInfo = {
  token: string;
  tenantId: number;       // 0 = main bot
  ownerTgId: number;      // tenant owner (0 for main)
  isMain: boolean;
  adminTgIds: number[];   // main bot admins
  durable?: boolean;
};

type Ctx = {
  bot: BotInfo;
  chatId: number;
  tgId: number;
  firstName: string;
  tgUsername: string;
  session: Session;
  isBoss: boolean;
  emoji: EmojiTheme;
  emojiOwn: EmojiTheme;
  emojiDefaults: EmojiTheme;
  hide: boolean;                 // customer view: show "$" instead of prices
  requestId: string;
  prices: Map<number, number>;   // customer view: account-specific prices
  lang: string;                  // session language code (en default)
};

const lastNum = (t: string) => {
  const m = t.replace(",", ".").match(/-?\d+(?:\.\d+)?/g);
  return m ? Number(m[m.length - 1]) : NaN;
};

function parseVariantLine(line: string): { label: string; price: number; cost: number } | null {
  const m = line.trim().match(/^(.*?)[\s:=\-–|]+\$?(\d+(?:[.,]\d+)?)\s*\$?(?:\s*[-–|/]\s*\$?(\d+(?:[.,]\d+)?)\s*\$?)?$/);
  if (!m || !m[1]!.trim() || !m[2]) return null;
  return { label: m[1]!.trim().replace(/[\s:=\-–|]+$/, ""), price: Number(m[2]!.replace(",", ".")), cost: m[3] ? Number(m[3]!.replace(",", ".")) : 0 };
}

// ─── Duration shorthand: a bare number becomes a readable duration ───────────
// "1" → "1 Day", "3" → "3 Days", "7 days" → "7 Days"
function normalizeDuration(line: string): string {
  const m = line.trim().match(/^(\d+)\s*(?:d|day|days)?$/i);
  if (!m || !m[1]) return line;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return line;
  return `${n} ${n === 1 ? "Day" : "Days"}`;
}

// ─── Duration ordering: variants list serially 1 Day, 3 Days, 7 Days, 30 Days… ─
const DURATION_UNITS: [RegExp, number][] = [
  [/^min(?:ute)?s?$/i, 1 / 1440],
  [/^h(?:r|rs|our|ours)?$/i, 1 / 24],
  [/^d(?:ay|ays)?$/i, 1],
  [/^w(?:k|ks|eek|eeks)?$/i, 7],
  [/^m(?:on|onth|onths)?$/i, 30],
  [/^y(?:r|rs|ear|ears)?$/i, 365],
];
function durationDays(name: string): number {
  const text = name.replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/g, " ");
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?/);
  if (!m || !m[1]) return Number.POSITIVE_INFINITY;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  const unit = DURATION_UNITS.find(([re]) => re.test(m[2] ?? "d"));
  return (unit ? unit[1] : 1) * n;
}
function byDuration(a: { name: string; id: number }, b: { name: string; id: number }): number {
  return durationDays(a.name) - durationDays(b.name) || a.id - b.id;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function handleUpdate(bot: BotInfo, update: any): Promise<void> {
  const db = await getDb();
  const msg = update.message ?? update.edited_message;
  const cq = update.callback_query;
  const from = msg?.from ?? cq?.from;
  if (!from?.id) return;
  const tgId: number = from.id;
  const chatId: number = msg?.chat?.id ?? cq?.message?.chat?.id ?? tgId;

  // Tenant gate: subscription must be active (main bot never expires).
  // Fire the callback ack immediately (removes Telegram's loading spinner) and
  // run all independent lookups in parallel to minimise reply latency.
  const ackP = cq ? tgCall(bot.token, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {}) : Promise.resolve();
  const isBoss0 = bot.isMain ? bot.adminTgIds.includes(tgId) : tgId === bot.ownerTgId;
  const [tRes, sRes, hideRaw, cpRes, emojiRaw, defaultEmojiRaw] = await Promise.all([
    bot.isMain ? Promise.resolve({ data: null as any }) : db.from("tenant_bots").select("*").eq("id", bot.tenantId).maybeSingle(),
    db.from("bot_sessions").select("state").eq("tenant_id", bot.tenantId).eq("tg_id", tgId).maybeSingle(),
    isBoss0 ? Promise.resolve(null) : getSetting(bot, "hide_prices"),
    isBoss0 ? Promise.resolve({ data: [] as any[] }) : tenantPrices(db, bot.tenantId),
    getSetting(bot, "premium_emoji"),
    bot.isMain ? Promise.resolve(null) : getSetting({ ...bot, tenantId: 0 }, "premium_emoji"),
  ]);
  if ((tRes as any).error) throw (tRes as any).error;
  if (sRes.error) throw sRes.error;
  if (!bot.isMain) {
    const t = tRes.data;
    if (!t || t.status === "disabled") return;
    if (t.status !== "active" || new Date(t.expires_at) <= new Date()) {
      await ackP;
      await sendHtml(bot.token, chatId, tgId === bot.ownerTgId
        ? "⛔️ Your subscription has expired. Renew it from the main reseller bot → " + MY_BOT_LABEL
        : "⛔️ This shop is temporarily unavailable.");
      return;
    }
  }

  // Register /start in the Telegram command menu once per reseller bot; the
  // MENU button stays empty on bots connected before this existed.
  if (!bot.isMain) void ensureMenuCommands(bot).catch(() => {});

  // Load session
  const srow = sRes.data as any;
  const session: Session = (srow?.state as Session) ?? {};
  let savedState = JSON.stringify(srow?.state ?? {});
  const save = async () => {
    const next = JSON.stringify(session);
    if (srow && next === savedState) return; // unchanged — skip the DB write
    const { error } = await db.from("bot_sessions").upsert({ tenant_id: bot.tenantId, tg_id: tgId, state: session as any, updated_at: new Date().toISOString() });
    if (error) throw error;
    savedState = next;
  };

  const isBoss = bot.isMain ? bot.adminTgIds.includes(tgId) : tgId === bot.ownerTgId;
  const emojiOwn = parseEmojiTheme(emojiRaw);
  const emojiDefaults = parseEmojiTheme(defaultEmojiRaw);
  const ctx: Ctx = { bot, chatId, tgId, firstName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "", tgUsername: String(from.username ?? ""), session, isBoss, requestId: String(update.update_id ?? cq?.id ?? msg?.message_id ?? crypto.randomUUID()), emoji: resolveEmojiTheme(emojiOwn, emojiDefaults), emojiOwn, emojiDefaults, hide: false, prices: new Map(), lang: isLang(session.lang) ? session.lang : autoLang(from.language_code) };
  (ctx as any).__msgId = msg?.message_id ?? null;
  // Customers see prices hidden (only "$") when the shop owner enabled it,
  // and their own account-specific prices when set.
  if (!isBoss) {
    ctx.hide = hideRaw === "1";
    if (session.accountId) {
      for (const r of ((cpRes as any)?.data ?? []).filter((x: any) => Number(x.account_id) === Number(session.accountId))) ctx.prices.set(Number((r as any).product_id), Number((r as any).price));
    }
  }
  // Retry failed writes and refresh changed Telegram profiles, including legacy sessions.
  const identity = session.identity;
  if (session.accountId && (identity?.accountId !== session.accountId || identity?.name !== ctx.firstName || identity?.username !== ctx.tgUsername)) {
    await recordLogin(ctx, Number(session.accountId), false);
  }

  // Button taps edit the tapped message in place (no new message per step);
  // later replies in the same update (e.g. long lists) still send fresh ones.
  const cqMsgId: number | null = cq?.message?.message_id ?? null;
  let navigated = false;
  const reply = async (html: string, extra: Record<string, unknown> = {}) => {
    html = translateHtml(themeHtml(html, ctx.emoji), ctx.lang);
    extra = translateExtra(themeExtra(extra, ctx.emoji), ctx.lang);
    if ((extra as any)?.reply_markup?.keyboard) ctx.session.kbLang = ctx.lang;
    if (cqMsgId && !navigated) {
      navigated = true;
      const r = await editHtml(bot.token, chatId, cqMsgId, html, extra);
      if (r !== "fail") return r === "ok";
    }
    return sendHtml(bot.token, chatId, html, extra);
  };

  try {
    if (cq) {
      await handleCallback(ctx, reply, String(cq.data ?? ""), save);
    } else if (msg?.text) {
      await handleText(ctx, reply, msg.text, (msg.entities ?? []) as TgEntity[], save);
    }
    await save();
  } catch (err) {
    console.error("bot update failed", err);
    await reply("⚠️ Something went wrong. Please try again.").catch(() => {});
    if (bot.durable) throw err;
  }
  await ackP;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function orderDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC";
}

async function historyEntry(bot: BotInfo, order: { id: number; product_id?: number | null; product_name?: string | null; key?: string | null; price: number; created_at?: string | null }, hide = false): Promise<string> {
  // Older order snapshots contain only the key type, so recover the position
  // from this shop's catalog while keeping the purchased duration snapshot.
  const db = await getDb();
  const { data: variant } = order.product_id
    ? await db.from("products").select("name,parent_id").eq("tenant_id", bot.tenantId).eq("id", order.product_id).maybeSingle()
    : { data: null };
  const { data: position } = variant?.parent_id
    ? await db.from("products").select("name").eq("tenant_id", bot.tenantId).eq("id", variant.parent_id).maybeSingle()
    : { data: null };
  const snapshot = plainLabel(order.product_name ?? "");
  const product = plainLabel(position?.name ?? variant?.name ?? snapshot) || "Unavailable";
  const duration = position ? snapshot || plainLabel(variant?.name ?? "") : "";
  return `🧾 <b>#${order.id}</b> · <b>${escapeHtml(product)}</b>` +
    (duration ? ` · ${escapeHtml(duration)}` : "") +
    ` · ${hide ? "$" : money(order.price)} · ${orderDate(order.created_at)} · 🔑 <code>${escapeHtml(order.key ?? "")}</code>`;
}

// Preserve complete keys and HTML entities when a large page needs more than
// one Telegram message; ordinary ten-order pages remain a single message.
async function replyLines(reply: (h: string, e?: any) => any, lines: string[], extra: any = {}) {
  let chunk = "";
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > 3800) {
      await reply(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  await reply(chunk, extra);
}

async function historyPage(ctx: Ctx, reply: (h: string, e?: any) => any, requested: number, prefix: string, accountId?: number) {
  const db = await getDb();
  // Main bot: show the customer's reseller-bot subscription above their key orders.
  let subLines: string[] = [];
  if (prefix === "c:orders" && ctx.bot.isMain && accountId !== undefined) {
    const { data: t } = await db.from("tenant_bots").select("*").eq("owner_account_id", accountId).maybeSingle();
    if (t) {
      const { data: pays } = await db.from("tenant_bot_payments").select("*").eq("tenant_id", t.id).order("id", { ascending: false });
      const now = Date.now();
      const exp = new Date(t.expires_at).getTime();
      const live = t.status === "active" && exp > now;
      const daysLeft = Math.max(0, Math.ceil((exp - now) / 86400000));
      subLines = [
        `🤖 Bot: <b>${t.bot_username ? "@" + escapeHtml(t.bot_username) : "not connected yet"}</b>`,
        `📊 Status: ${live ? "🟢 Live" : t.status !== "active" ? "🔴 Disabled by admin" : "⛔️ Expired"}`,
        `📅 Expires: <b>${fmtDate(t.expires_at)}</b>${live ? ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : ""}`,
        `💳 Payments (${(pays ?? []).length}):`,
        ...((pays ?? []).slice(0, 20).map((p: any) => `· ${money(p.amount)} — ${p.days} day${p.days === 1 ? "" : "s"} · ${orderDate(p.created_at)}`)),
        ...((pays ?? []).length ? [] : ["No payments recorded yet."]),
        "",
        "🛍 Key orders:",
      ];
    }
  }
  const query = () => {
    const q = db.from("shop_orders").select("*", { count: "exact" }).eq("tenant_id", ctx.bot.tenantId);
    return accountId === undefined ? q : q.eq("account_id", accountId);
  };
  const { count, error: countError } = await query().limit(0);
  if (countError) throw countError;
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / 10));
  const page = Math.min(Math.max(0, requested), pages - 1);
  const { data: orders, error } = await query().order("id", { ascending: false }).range(page * 10, page * 10 + 9);
  if (error) throw error;
  const lines = [`🧾 <b>Purchase history</b> · Page ${page + 1}/${pages}`, `${total} order${total === 1 ? "" : "s"}`, "", ...subLines];
  for (const order of orders ?? []) {
    let username = "";
    if (accountId === undefined) {
      const { data: account } = await db.from("bot_accounts").select("username").eq("tenant_id", ctx.bot.tenantId).eq("id", order.account_id).maybeSingle();
      username = ` · 👤 ${escapeHtml(plainLabel(account?.username ?? "Unavailable"))}`;
    }
    lines.push(await historyEntry(ctx.bot, order, ctx.hide) + username);
  }
  if (!orders?.length) lines.push("No purchases yet.");
  const nav = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `${prefix}:${page - 1}`));
  if (page < pages - 1) nav.push(btn("Next ➡️", `${prefix}:${page + 1}`));
  const rows = nav.length ? [nav] : [];
  rows.push([btn("⬅️ Back", prefix === "a:purch" ? "a:manage" : prefix.startsWith("a:mo:") ? `a:m:${accountId}` : "c:me")]);
  if (prefix === "c:orders") rows.push([btn("🛍 Buy keys", "c:shop")]);
  await replyLines(reply, lines, kb(...rows));
}

// Short in-memory cache: settings are read on every update but change rarely.
// All writes go through setSetting (same process), which refreshes the cache.
const settingCache = new Map<string, { at: number; value: string | null }>();
const SETTING_TTL = 60_000;
export function clearSettingCache() { settingCache.clear(); }
// Per-tenant custom prices, cached briefly; the admin price editor clears it on change.
const priceCache = new Map<number, { at: number; res: any }>();
async function tenantPrices(db: any, tenantId: number): Promise<any> {
  const hit = priceCache.get(tenantId);
  if (hit && Date.now() - hit.at < SETTING_TTL) return hit.res;
  const res = await db.from("account_prices").select("product_id, price, account_id").eq("tenant_id", tenantId).then((r: any) => r, () => ({ data: [] }));
  if (!res?.error) priceCache.set(tenantId, { at: Date.now(), res });
  return res;
}

async function getSetting(bot: BotInfo, key: string): Promise<string | null> {
  const ck = `${bot.tenantId}:${key}`;
  const hit = settingCache.get(ck);
  if (hit && Date.now() - hit.at < SETTING_TTL) return hit.value;
  const db = await getDb();
  const { data } = await db.from("bot_settings").select("value").eq("tenant_id", bot.tenantId).eq("key", key).maybeSingle();
  const value = data?.value ?? null;
  settingCache.set(ck, { at: Date.now(), value });
  return value;
}
async function setSetting(bot: BotInfo, key: string, value: string) {
  const db = await getDb();
  settingCache.delete(`${bot.tenantId}:${key}`);
  await db.from("bot_settings").upsert({ tenant_id: bot.tenantId, key, value });
  settingCache.set(`${bot.tenantId}:${key}`, { at: Date.now(), value });
}
// Telegram's MENU button shows a command list only after setMyCommands; register
// /start once per reseller bot per process so every shop opens from the menu
// button. Kept in memory only — the call is idempotent, so re-registering after
// a restart is harmless and keeps bot_settings untouched.
const menuCommandsDone = new Set<string>();
export function clearMenuCommandsCache() { menuCommandsDone.clear(); }
async function ensureMenuCommands(bot: BotInfo): Promise<void> {
  if (menuCommandsDone.has(bot.token)) return;
  menuCommandsDone.add(bot.token);
  try {
    await tgCall(bot.token, "setMyCommands", { commands: [{ command: "start", description: "Open the shop" }] });
  } catch (e: unknown) {
    menuCommandsDone.delete(bot.token); // retry on the next update
    console.error("setMyCommands failed", e);
  }
}
async function saveEmojiTheme(ctx: Ctx) {
  await setSetting(ctx.bot, "premium_emoji", JSON.stringify(ctx.emojiOwn));
  ctx.emoji = resolveEmojiTheme(ctx.emojiOwn, ctx.emojiDefaults);
}
/** Persist identity before saving the session; a failed write must remain retryable. */
async function recordLogin(ctx: Ctx, accountId: number, login = true) {
  try {
    const db = await getDb();
    const { error } = await db.from("bot_accounts").update({
      tg_id: ctx.tgId, tg_name: ctx.firstName || null, tg_username: ctx.tgUsername || null,
      ...(login ? { last_login_at: new Date().toISOString() } : {}),
    }).eq("id", accountId).eq("tenant_id", ctx.bot.tenantId);
    if (error) { console.error("record login failed", error.message); return; }
    ctx.session.identity = { accountId, name: ctx.firstName, username: ctx.tgUsername };
  } catch { /* Retry on the next user update. */ }
}
/** Telegram IDs rejected by the admin — they cannot request access again. */
async function blockedUsers(bot: BotInfo): Promise<number[]> {
  try {
    const raw = await getSetting(bot, "blocked_users");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}
async function getPrice(bot: BotInfo): Promise<number> {
  const v = Number((await getSetting(bot, "bot_price")) ?? 30);
  return Number.isFinite(v) && v > 0 ? v : 30;
}
async function getDays(bot: BotInfo): Promise<number> {
  const v = Number((await getSetting(bot, "bot_days")) ?? 30);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

async function getAccount(ctx: Ctx) {
  if (!ctx.session.accountId) return null;
  const db = await getDb();
  const { data } = await db.from("bot_accounts").select("*").eq("id", ctx.session.accountId).eq("tenant_id", ctx.bot.tenantId).maybeSingle();
  return data;
}

// Catalog helpers — batched: one keys query per screen instead of one per row.
async function stockMap(db: any, ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!ids.length) return map;
  const { data } = await db.from("product_keys").select("product_id").in("product_id", ids).eq("sold", false);
  for (const k of data ?? []) map.set(Number(k.product_id), (map.get(Number(k.product_id)) ?? 0) + 1);
  return map;
}
async function stockOf(db: any, tenantId: number, pid: number): Promise<number> {
  const { data: vars } = await db.from("products").select("id").eq("tenant_id", tenantId).eq("parent_id", pid);
  const ids = [pid, ...(vars ?? []).map((v: any) => v.id)];
  const map = await stockMap(db, ids);
  return ids.reduce((n, id) => n + (map.get(id) ?? 0), 0);
}
async function getProduct(db: any, tenantId: number, pid: number) {
  const { data: p } = await db.from("products").select("*").eq("id", pid).eq("tenant_id", tenantId).maybeSingle();
  if (!p) return null;
  const { data: vars } = await db.from("products").select("id").eq("tenant_id", tenantId).eq("parent_id", pid);
  const ids = [pid, ...(vars ?? []).map((v: any) => v.id)];
  const map = await stockMap(db, ids);
  return { ...p, stock: ids.reduce((n, id) => n + (map.get(id) ?? 0), 0), nvars: (vars ?? []).length };
}
async function variantsOf(db: any, tenantId: number, pid: number) {
  const { data: vs } = await db.from("products").select("*").eq("tenant_id", tenantId).eq("parent_id", pid).order("price").order("id");
  const rows = (vs ?? []).slice().sort(byDuration);
  const map = await stockMap(db, rows.map((v: any) => v.id));
  return rows.map((v: any) => ({ ...v, stock: map.get(Number(v.id)) ?? 0 }));
}
async function topProducts(db: any, tenantId: number, cat: number | null | "all") {
  let q = db.from("products").select("*").eq("tenant_id", tenantId).is("parent_id", null).order("id");
  if (cat === null) q = q.is("category_id", null);
  else if (cat !== "all") q = q.eq("category_id", cat);
  const [psRes, vsRes] = await Promise.all([
    q,
    db.from("products").select("id,parent_id,price").eq("tenant_id", tenantId).not("parent_id", "is", null),
  ]);
  const ps = psRes.data ?? [];
  const allVars = vsRes.data ?? [];
  const varsByParent = new Map<number, any[]>();
  for (const v of allVars) {
    const k = Number(v.parent_id);
    if (!varsByParent.has(k)) varsByParent.set(k, []);
    varsByParent.get(k)!.push(v);
  }
  const ids = [...ps.map((p: any) => Number(p.id)), ...allVars.map((v: any) => Number(v.id))];
  const map = await stockMap(db, ids);
  return ps.map((p: any) => {
    const vs = varsByParent.get(Number(p.id)) ?? [];
    const stock = (map.get(Number(p.id)) ?? 0) + vs.reduce((n, v) => n + (map.get(Number(v.id)) ?? 0), 0);
    const from_price = vs.length ? Math.min(...vs.map((v) => Number(v.price))) : null;
    return { ...p, stock, nvars: vs.length, from_price };
  });
}
/** Remove one reseller shop's catalog; keys, variants and custom prices cascade. Never the main shop. */
async function clearCatalog(db: any, tenantId: number) {
  if (!tenantId) return;
  await db.from("products").delete().eq("tenant_id", tenantId);
  await db.from("categories").delete().eq("tenant_id", tenantId);
}

const TOKEN_COOLDOWN_MS = 24 * 3600000;
/** Milliseconds until this account may change its bot token again (0 = allowed). */
export async function tokenCooldown(db: any, accountId: number): Promise<number> {
  const { data } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", `token_changed_${accountId}`).maybeSingle();
  const at = Number(data?.value ?? 0);
  return at ? Math.max(0, at + TOKEN_COOLDOWN_MS - Date.now()) : 0;
}

async function categories(db: any, tenantId: number) {
  const [csRes, psRes] = await Promise.all([
    db.from("categories").select("*").eq("tenant_id", tenantId).order("id"),
    db.from("products").select("category_id").eq("tenant_id", tenantId).is("parent_id", null),
  ]);
  const counts = new Map<number, number>();
  for (const p of psRes.data ?? []) {
    const k = Number(p.category_id);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (csRes.data ?? []).map((c: any) => ({ ...c, n: counts.get(Number(c.id)) ?? 0 }));
}
const priceLabel = (p: any) => Number(p.nvars) ? `from ${money(p.from_price ?? 0)}` : money(p.price);
async function fullName(db: any, tenantId: number, p: any): Promise<string> {
  if (!p.parent_id) return p.name;
  const parent = await getProduct(db, tenantId, Number(p.parent_id));
  return `${parent?.name ?? ""} — ${p.name}`;
}

// ─── Menus ───────────────────────────────────────────────────────────────────

/** First visit: follow the Telegram app language when the bot supports it, else English.
 *  A language picked with the Language button always wins (stored in the session). */
export function autoLang(code: unknown): string {
  const base = String(code ?? "").toLowerCase().split(/[-_]/)[0];
  return base !== "en" && isLang(base) ? base : "en";
}

function menuKb(ctx: Ctx) {
  // English source labels: colors/icons are resolved first, then the reply
  // boundary translates, so translated keyboards keep their styling.
  const t = (value: string) => value;
  const rows: any[][] = [[{ text: t(L.buy) }], [{ text: t(L.acc) }, { text: t(L.out) }]];
  if (ctx.bot.isMain) rows.push([{ text: t(MY_BOT_LABEL) }]);
  if (ctx.isBoss) rows.push([{ text: t(L.man) }, { text: t(L.stock) }], [{ text: t(L.stats) }]);
  // Admins type commands from the panels; the Language keyboard button stays customer-only.
  if (!ctx.isBoss) rows.push([{ text: t(L.lang) }]);
  return { reply_markup: { resize_keyboard: true, keyboard: rows } };
}

async function adminMenu(ctx: Ctx, reply: (h: string, e?: any) => any) {
  const hidden = (await getSetting(ctx.bot, "hide_prices")) === "1";
  await reply("📊 <b>Statistics & tools</b>", kb(
    [btn("➕ Add product", "a:add"), btn("📦 Products", "a:list")],
    [btn("📂 Categories", "a:cats"), btn("📦 Stock", "a:stock")],
    [btn("🔧 Reseller", "a:manage"), btn("🛍 View shop", "c:shop")],
    ctx.bot.isMain ? [btn("💰 Add balance", "a:bal")] : [btn("👤 Add account", "a:acc"), btn("💰 Add balance", "a:bal")],
    [btn("📊 Orders & profit", "a:stats"), btn("📣 Broadcast", "a:bc")],
    [btn("👋 Welcome text", "a:wel"), btn(hidden ? "👁 Show prices" : "🙈 Hide prices", "a:hide")],
    [btn("💬 Support username", "a:sup"), btn("👥 Logged-in users", "a:users:0")],
    [btn("✨ Premium emoji", "a:emoji"), btn("🎨 Button colors", "a:colors")],
    ...(ctx.bot.isMain ? [] : [[btn("💲 Custom prices", "a:cpu")]]),
    ...(ctx.bot.isMain ? [[btn("🤖 Reseller bots", "a:tb"), btn("💰 Affiliates", "a:aff:0")], [btn("🎁 Free trial bots", "a:ftb:0"), btn("🎁 Trial text", "a:trt")], [btn("🚫 Remove user", "a:rmu")]] : []),
  ));
}

async function colorsMenu(ctx: Ctx, reply: (h: string, e?: any) => any, requested = 0, selected?: string) {
  const colors = parseButtonColors(ctx.emoji.buttons);
  const pages = Math.ceil(COLOR_BUTTONS.length / 8);
  const page = Math.max(0, Math.min(requested, pages - 1));
  const items = COLOR_BUTTONS.slice(page * 8, page * 8 + 8);
  const colorOf = (id: string) => colors.items?.[id] ?? "default";
  const colorLabel = (id: string) => BUTTON_COLORS.find(color => color.value === colorOf(id))?.label ?? "Default";
  const rows: any[][] = [];
  const item = COLOR_BUTTONS.find(button => button.id === selected);
  if (item) {
    rows.push(BUTTON_COLORS.map(color => ({
      ...btn(`${colorOf(item.id) === color.value ? "✓ " : ""}${color.value === "default" ? "Remove color" : color.label}`, `a:colors:set:${item.id}:${color.value}:${page}`),
      ...(color.value === "default" ? {} : { style: color.value }),
    })));
    rows.push([btn("⬅️ Go back", `a:colors:page:${page}`)]);
    return reply(`🎨 <b>${item.label} button</b>\n\nCurrent: ${colorLabel(item.id)}`, kb(...rows));
  }
  for (const button of items) rows.push([btn(`${colorLabel(button.id)} · ${button.label} button`, `a:colors:item:${button.id}:${page}`)]);
  const nav = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `a:colors:page:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `a:colors:page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.unshift([btn("🖌 Quick color admin panel", "a:qc")]);
  rows.push([btn("⬅️ Go back", "a:home")]);
  await reply(`🎨 <b>Button Colors (${page + 1}/${pages})</b>\n\n${items.map(button => `· ${button.label} — ${colorLabel(button.id)}`).join("\n")}`, kb(...rows));
}

async function emojiMenu(ctx: Ctx, reply: (h: string, e?: any) => any) {
  await reply("✨ <b>Premium emoji</b>\n\nYour bot's BotFather owner must have Telegram Premium, or the bot must have an eligible Fragment username. Premium on a different reseller account does not grant permission.\n\nSend custom emoji directly from Telegram's emoji picker. Buttons show one custom icon; message text can contain several. Without permission, use ordinary emoji mode.", kb(
    [btn("🔘 Button & message icons", "a:emoji:icons")],
    [btn("📦 Product & duration emoji", "a:emoji:products"), btn("📂 Category emoji", "a:emoji:categories")],
    [btn("👋 Welcome text", "a:wel")],
    [btn(ctx.emoji.enabled ? "✨ Premium: ON" : "😀 Ordinary emoji mode", "a:emoji:toggle")],
    [btn("⬅️ Go back", "a:home")],
  ));
}
async function emojiList(ctx: Ctx, reply: (h: string, e?: any) => any, kind: "icons" | "products" | "categories", requested: number) {
  const db = await getDb();
  const items = kind === "icons" ? EMOJI_ICONS.map((icon, id) => ({ id, name: `${icon} ${EMOJI_LABELS[icon] ?? "Message icon"}` }))
    : ((await db.from(kind).select("id,name").eq("tenant_id", ctx.bot.tenantId).order("id")).data ?? []);
  const pages = Math.max(1, Math.ceil(items.length / 10));
  const page = Math.min(Math.max(0, requested), pages - 1);
  const rows = items.slice(page * 10, page * 10 + 10).map(item => [btn(item.name, kind === "icons" ? `a:emoji:icon:${item.id}` : `a:emoji:item:${kind}:${item.id}`)]);
  const nav = [];
  if (page) nav.push(btn("⬅️ Previous", `a:emoji:${kind}:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `a:emoji:${kind}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("⬅️ Go back", "a:emoji")]);
  await reply(`✨ <b>Choose ${kind === "icons" ? "an icon" : "a " + (kind === "products" ? "product / duration" : "category")}</b> · Page ${page + 1}/${pages}` + (items.length ? "" : "\nNo items yet."), { ...kb(...rows), noButtonColors: true });
}

const pr = (ctx: Ctx, p: any) => ctx.hide ? "$" : money(ctx.prices.get(Number(p.id)) ?? p.price);

/** Support contact username (without @) set by the admin, or null. */
async function supportUsername(bot: BotInfo): Promise<string | null> {
  const v = String((await getSetting(bot, "support_username")) ?? "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{4,32}$/.test(v) ? v : null;
}

/** Inline buttons shown under the welcome message. */
async function welcomeRows(ctx: Ctx): Promise<any[][]> {
  if (ctx.bot.isMain) {
    // The main bot promotes subscriptions only — the key-shop buttons stay off
    // the welcome message (the persistent keyboard still opens the shop).
    const rows: any[][] = [[{ text: "🤖 Make My own Bot", callback_data: "tsub:cancel", style: "primary" }]];
    if ((await getSetting(ctx.bot, "aff_enabled")) !== "0") rows.push([btn("💰 Affiliates", "aff:menu")]);
    const sup = await supportUsername(ctx.bot);
    if (sup) rows.push([urlBtn("💬 Support", `https://t.me/${sup}`)]);
    rows.push([btn(L.lang, "lang")]);
    return rows;
  }
  const rows: any[][] = [[btn("🔑 Buy keys", "c:shop")], [btn("👤 Account", "c:me"), btn("🧾 My orders", "c:orders")]];
  const sup = await supportUsername(ctx.bot);
  if (sup) rows.push([urlBtn("💬 Support", `https://t.me/${sup}`)]);
  rows.push([btn(L.lang, "lang")]);
  return rows;
}

/** Language picker — available to every user in both bots. The choice is
 *  saved in the session and applies to all following replies. */
async function languageMenu(ctx: Ctx, reply: (h: string, e?: any) => any) {
  ctx.session.step = null;
  const rows: any[][] = LANGS.map(l => [btn(`${ctx.lang === l.code ? "✓ " : ""}${l.label}`, `lang:set:${l.code}`)]);
  rows.push([btn("⬅️ Menu", ctx.isBoss || ctx.session.accountId ? "c:home" : "x:cancel")]);
  await reply("🌐 <b>Language</b>\n\nChoose your language:", kb(...rows));
}

async function shopMenu(ctx: Ctx, reply: (h: string, e?: any) => any) {
  const acc = await getAccount(ctx);
  const welcome = renderWelcome((await getSetting(ctx.bot, "welcome")) ?? (ctx.bot.isMain ? DEFAULT_WELCOME : DEFAULT_LOGIN_WELCOME), acc?.username ?? ctx.session.username);
  const balanceIcon = ctx.bot.isMain ? "💰" : "💬";
  await reply(`${welcome}\n\n${balanceIcon} Balance: <b>${money(acc?.balance ?? 0)}</b>`, kb(...(await welcomeRows(ctx))));
}

/** /start for a logged-in customer: welcome + inline buttons, and the
 *  persistent bottom keyboard once per session. */
/** Send a fresh persistent keyboard: themed (icons/colors) then translated. */
async function sendMenuKb(ctx: Ctx, text: string) {
  ctx.session.kbShown = true;
  ctx.session.kbLang = ctx.lang;
  await sendHtml(ctx.bot.token, ctx.chatId, translateHtml(themeHtml(text, ctx.emoji), ctx.lang), translateExtra(themeExtra(menuKb(ctx), ctx.emoji), ctx.lang));
}

async function startWelcome(ctx: Ctx, reply: (h: string, e?: any) => any) {
  if (ctx.bot.isMain && await showOrderBlock(ctx, reply)) return;
  // Re-send when missing or still in another language (older keyboards survive updates).
  if (!ctx.session.kbShown || (ctx.session.kbLang ?? "en") !== ctx.lang) {
    await sendMenuKb(ctx, "⌨️ Menu");
  }
  return shopMenu(ctx, reply);
}

async function ask(ctx: Ctx, reply: (h: string, e?: any) => any, step: Step, text: string, extra?: any) {
  ctx.session.step = step;
  if (["var_confirm", "add_keys", "stock_keys"].includes(step.s)) {
    await reply(text, extra ?? {});
    return;
  }
  // Product prompts stay short — a Cancel button below instead of extra instructions.
  if (!extra && PRODUCT_PROMPTS.includes(step.s)) {
    const pid = "pid" in step ? Number(step.pid) : NaN;
    await reply(text, kb([btn("✖️ Cancel", Number.isFinite(pid) ? `x:ap:${pid}` : "x:cancel")]));
    return;
  }
  await reply(text + "\n\n/cancel to stop", extra ?? kb([btn("✖️ Cancel", "x:cancel")]));
}

// ─── Text messages ───────────────────────────────────────────────────────────

async function handleText(ctx: Ctx, reply: (h: string, e?: any) => any, text: string, entities: TgEntity[], save: () => Promise<void>): Promise<void> {
  const { bot, tgId } = ctx;
  const db = await getDb();
  let raw = text.trim();
  const refM = /^\/start\s+(?:ref_(\d+)|([A-Za-z0-9]{5,11}))$/.exec(raw);
  if (refM) {
    raw = "/start";
    if (bot.isMain && refM[1]) ctx.session.refBy = Number(refM[1]);
    else if (bot.isMain && refM[2]) {
      const { data: r } = await db.from("bot_accounts").select("id").eq("tenant_id", 0).eq("ref_code", refM[2]).maybeSingle();
      if (r) ctx.session.refBy = r.id;
    }
  }
  const html = entitiesToHtml(text, entities).trim();

  if (raw === "/cancel") {
    ctx.session.step = null;
    await reply("Cancelled.");
    return;
  }

  if (raw === "/start" || raw === "/admin") {
    ctx.session.step = null;
    if (ctx.isBoss) {
      await reply("🛠 <b>Admin panel</b>\nUse the buttons below. Premium emoji you type are saved automatically.", menuKb(ctx));
    } else if (ctx.session.accountId) {
      await startWelcome(ctx, reply);
      if (bot.isMain) await trialInvite(ctx, reply);
    } else {
      const blocked = await blockedUsers(bot);
      if (blocked.includes(tgId)) {
        await reply("🚫 Access denied.");
        return;
      }
      // Main bot: open access — no username/password. Reuse or auto-create the account by Telegram ID.
      if (bot.isMain) {
        let { data: acc } = await db.from("bot_accounts").select("id,username").eq("tenant_id", bot.tenantId).eq("tg_id", tgId).order("id").limit(1).maybeSingle();
        if (!acc) {
          const base = (ctx.tgUsername || `user${String(tgId).slice(-6)}`).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24) || `user${tgId}`;
          let uname = base;
          for (let i = 1; ; i++) {
            const { data: exists } = await db.from("bot_accounts").select("id").eq("tenant_id", bot.tenantId).eq("username", uname).maybeSingle();
            if (!exists) break;
            uname = `${base}${i}`;
          }
          const pass = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16)).join("");
          const hash = await hashPassword(bot.tenantId, uname, pass);
          const { data: created } = await db.from("bot_accounts").insert({ tenant_id: bot.tenantId, username: uname, password_hash: hash, tg_id: tgId, balance: 0 }).select("id,username").single();
          acc = created;
          if (acc && ctx.session.refBy && ctx.session.refBy !== acc.id) {
            const { data: refAcc } = await db.from("bot_accounts").select("id,tg_id").eq("tenant_id", 0).eq("id", ctx.session.refBy).maybeSingle();
            if (refAcc && Number(refAcc.tg_id) !== tgId) {
              await db.from("bot_accounts").update({ referred_by: refAcc.id }).eq("id", acc.id).is("referred_by", null);
              if (refAcc.tg_id) await sendHtml(bot.token, Number(refAcc.tg_id), `👥 New referral joined: ${escapeHtml(ctx.firstName || ctx.tgUsername || "a user")}`).catch(() => {});
            }
          }
          ctx.session.refBy = undefined;
          if (acc) {
            const notice =
              `🆕 <b>New user started the bot</b>\n\n` +
              `👤 Name: ${escapeHtml(ctx.firstName || "—")}\n` +
              `Username: ${ctx.tgUsername ? `@${escapeHtml(ctx.tgUsername)}` : "—"}\n` +
              `ID: <code>${tgId}</code>`;
            for (const adminId of bot.adminTgIds) await sendHtml(bot.token, adminId, notice).catch(() => {});
          }
        }
        if (!acc) { await reply("⚠️ Something went wrong. Please send /start again."); return; }
        ctx.session.accountId = acc.id; ctx.session.username = acc.username;
        await recordLogin(ctx, acc.id);
        await startWelcome(ctx, reply);
        await trialInvite(ctx, reply);
        return;
      }
      // Reseller bots: notify the owner once, then ask for the username + password the owner created.
      if (!ctx.session.approvalSent) {
        ctx.session.approvalSent = true;
        const notice =
          `🆕 <b>New user started the bot</b>\n\n` +
          `👤 Name: ${escapeHtml(ctx.firstName || "—")}\n` +
          `Username: ${ctx.tgUsername ? `@${escapeHtml(ctx.tgUsername)}` : "—"}\n` +
          `ID: <code>${tgId}</code>\n\n` +
          `Create an account for them from 🛠 Admin panel → 👤 Add account and send them the username + password.`;
        await sendHtml(bot.token, bot.ownerTgId, notice).catch(() => {});
      }
      ctx.session.step = { s: "login_user" };
      const greet = renderWelcome((await getSetting(bot, "welcome")) ?? DEFAULT_LOGIN_WELCOME, ctx.firstName);
      await reply(`${greet}\n\n🔐 Please log in.\n\n👤 Send your <b>username</b>:`);
    }
    return;
  }

  // Bottom keyboard labels
  const label = plainLabel(raw);
  const menuLabel = (value: string) => plainLabel(value).replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "");
  const tL = (value: string) => translateLabel(value, ctx.lang);
  const matchesMenu = (value: string) => menuLabel(label) === menuLabel(value);
  if (matchesMenu(tL(L.buy))) { ctx.session.step = null; return ctx.isBoss ? ownerShop(ctx, reply) : shopCustomer(ctx, reply); }
  if (matchesMenu(tL(L.acc))) {
    ctx.session.step = null;
    const acc = await getAccount(ctx);
    await reply(`👤 <b>Your account:</b>\n- Username: <code>${escapeHtml(acc?.username ?? ctx.session.username ?? "")}</code>\n- Balance: <code>${money(acc?.balance ?? 0)}</code>`, kb(...(ctx.bot.isMain ? [[btn("💳 Add balance with Crypto", "pay:top")]] : []), [btn("📜 Purchase History", "c:orders")], [btn("⬅️ Go back", "c:home")]));
    return;
  }
  if (matchesMenu(tL(L.out))) {
    ctx.session.step = null; ctx.session.accountId = undefined; ctx.session.username = undefined;
    await reply("👋 Logged out. Send /start to open the menu again.", { reply_markup: { remove_keyboard: true } });
    return;
  }
  if (matchesMenu(tL(L.man)) && ctx.isBoss) { ctx.session.step = null; return manageList(ctx, reply); }
  if (matchesMenu(tL(L.stock)) && ctx.isBoss) { ctx.session.step = null; return stockView(ctx, reply); }
  if (matchesMenu(tL(L.stats)) && ctx.isBoss) { ctx.session.step = null; return adminMenu(ctx, reply); }
  if (matchesMenu(tL(MY_BOT_LABEL)) && bot.isMain) { ctx.session.step = null; return showMyBot(ctx, reply); }
  if (matchesMenu(tL(L.lang))) { ctx.session.step = null; return languageMenu(ctx, reply); }

  // Legacy keyboard labels from older bot versions (persistent keyboards survive updates)
  const low = label.toLowerCase();
  if (low.includes("admin panel") && ctx.isBoss) { ctx.session.step = null; return adminMenu(ctx, reply); }
  // Persistent keyboards on older phones still carry the "Manage" label, so it keeps opening the same panel.
  if (low === "manage" && ctx.isBoss) { ctx.session.step = null; return manageList(ctx, reply); }
  if (low.includes("buy keys") || low === menuLabel(tL(L.buy)).toLowerCase()) { ctx.session.step = null; return ctx.isBoss ? ownerShop(ctx, reply) : shopCustomer(ctx, reply); }
  if (low.includes("log out") || low === menuLabel(tL(L.out)).toLowerCase()) {
    ctx.session.step = null; ctx.session.accountId = undefined; ctx.session.username = undefined;
    await reply("👋 Logged out. Send /start to open the menu again.", { reply_markup: { remove_keyboard: true } });
    return;
  }
  if (low.includes("my orders") || low === "account" || low === menuLabel(tL(L.acc)).toLowerCase()) {
    ctx.session.step = null;
    const acc = await getAccount(ctx);
    await reply(`👤 <b>Your account:</b>\n- Username: <code>${escapeHtml(acc?.username ?? ctx.session.username ?? "")}</code>\n- Balance: <code>${money(acc?.balance ?? 0)}</code>`, kb(...(ctx.bot.isMain ? [[btn("💳 Add balance with Crypto", "pay:top")]] : []), [btn("📜 Purchase History", "c:orders")], [btn("⬅️ Go back", "c:home")]));
    return;
  }

  // Main-admin slash commands
  if (bot.isMain && ctx.isBoss && raw.startsWith("/")) {
    const [cmd, ...args] = raw.slice(1).split(/\s+/);
    if (cmd === "tenantbots") return cmdTenantBots(ctx, reply);
    if (cmd === "extendbot") return cmdExtendBot(ctx, reply, Number(args[0]), Number(args[1]));
    if (cmd === "disablebot") return cmdSetBotStatus(ctx, reply, Number(args[0]), "disabled");
    if (cmd === "enablebot") return cmdSetBotStatus(ctx, reply, Number(args[0]), "active");
    if (cmd === "setbotprice") {
      const v = Number(args[0]);
      if (!(v > 0)) { await reply("Usage: /setbotprice 20"); return; }
      await setSetting(bot, "bot_price", String(v));
      await reply(`✅ Monthly bot price is now ${money(v)}.`);
      return;
    }
    if (cmd === "setwallet") {
      const addr = String(args[0] ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { await reply("Usage: /setwallet 0x... (your BEP20 USDT address)"); return; }
      await setSetting(bot, "bep20_address", addr);
      await reply(`✅ BEP20 USDT wallet saved:\n<code>${escapeHtml(addr)}</code>\n\nCrypto payments are now live. Incoming transfers are checked automatically every minute.`);
      return;
    }
    if (cmd === "settrc20") {
      const addr = String(args[0] ?? "").trim();
      if (!isTronAddress(addr)) { await reply("Usage: /settrc20 T... (your TRC20 USDT address)"); return; }
      await setSetting(bot, "trc20_address", addr);
      await reply(`✅ TRC20 USDT wallet saved:\n<code>${escapeHtml(addr)}</code>\n\nTRC20 payments are now live. Incoming transfers are checked automatically every minute.`);
      return;
    }
    if (cmd === "setaff") {
      const v = Number(String(args[0] ?? "").replace(/[$\s]/g, "").replace(",", "."));
      if (!args[0] || !Number.isFinite(v) || v < 0 || v > 1000) { await reply(`Usage: /setaff 5\nCurrent commission: <b>${money(await affAmount(bot))}</b> per subscription.`); return; }
      await setSetting(bot, "aff_amount", String(v));
      await reply(`✅ Affiliate commission is now <b>${money(v)}</b> per subscription.`);
      return;
    }
    if (cmd === "affon" || cmd === "affoff") {
      await setSetting(bot, "aff_enabled", cmd === "affon" ? "1" : "0");
      await reply(cmd === "affon" ? "🟢 Affiliate program is ON." : "🔴 Affiliate program is OFF.");
      return;
    }
  }

  const step = ctx.session.step;
  if (!step) {
    return ctx.isBoss ? adminMenu(ctx, reply) : ctx.session.accountId ? shopMenu(ctx, reply) : handleText(ctx, reply, "/start", [], save);
  }

  const num = lastNum(raw);
  const needNum = () => reply("❌ Please send a number (e.g. 3 or 3.50).");

  switch (step.s) {
    case "emoji_icon": case "emoji_catalog": {
      if (!ctx.isBoss) return;
      const tag = raw === "-" ? null : emojiTag(text, entities);
      if (raw !== "-" && !tag) {
        await reply("❌ Send one Premium emoji from your emoji picker, or - to remove it.", kb([btn("✖️ Cancel", "x:cancel")]));
        return;
      }
      if (step.s === "emoji_icon") {
        if (tag) {
          ctx.emojiOwn.icons[step.icon] = tag;
          ctx.emojiOwn.removedIcons = (ctx.emojiOwn.removedIcons ?? []).filter(icon => icon !== step.icon);
        } else {
          delete ctx.emojiOwn.icons[step.icon];
          ctx.emojiOwn.removedIcons = [...new Set([...(ctx.emojiOwn.removedIcons ?? []), step.icon])];
        }
        await saveEmojiTheme(ctx);
      } else {
        const { data: item } = await db.from(step.kind).select("name").eq("tenant_id", bot.tenantId).eq("id", step.id).maybeSingle();
        if (!item) { ctx.session.step = null; await reply("❌ Item not found.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
        const { error } = await db.from(step.kind).update({ name: replaceNameIcon(item.name, tag) }).eq("tenant_id", bot.tenantId).eq("id", step.id);
        if (error) throw error;
      }
      ctx.session.step = null;
      await reply("✅ Emoji saved. Preview:", menuKb(ctx));
      return emojiMenu(ctx, reply);
    }
    // ── Login (username + 8-digit password)
    case "login_user": {
      const uname = raw.toLowerCase();
      if (!/^[a-z0-9_.]{3,32}$/.test(uname)) { await reply("❌ Invalid username. Send the username given by the seller.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: acc } = await db.from("bot_accounts").select("id").eq("tenant_id", bot.tenantId).eq("username", uname).maybeSingle();
      if (!acc) { await reply("❌ Unknown username. Try again.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      ctx.session.step = { s: "login_pass", username: uname };
      await reply("🔑 Now send your <b>password</b>:", kb([btn("✖️ Cancel", "x:cancel")]));
      return;
    }
    case "login_pass": {
      if (!/^\S{8,32}$/.test(raw)) { await reply("❌ Password must be 8–32 characters (letters, numbers, symbols — no spaces).", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const hash = await hashPassword(bot.tenantId, step.username, raw);
      const { data: acc } = await db.from("bot_accounts").select("*").eq("tenant_id", bot.tenantId).eq("username", step.username).eq("password_hash", hash).maybeSingle();
      // Delete the password message for safety
      if (ctx.chatId && update_message_id(ctx)) await tgCall(bot.token, "deleteMessage", { chat_id: ctx.chatId, message_id: update_message_id(ctx) }).catch(() => {});
      if (!acc) { await reply("❌ Wrong password. Try again, or /cancel.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      await recordLogin(ctx, acc.id);
      ctx.session.accountId = acc.id;
      ctx.session.username = acc.username;
      ctx.session.step = null;
      await reply(`✅ Logged in as <b>${escapeHtml(acc.username)}</b>.`, menuKb(ctx));
      return;
    }

    // ── Shopping
    case "buy_qty": {
      if (!(Number.isInteger(num) && num >= 1 && num <= 100)) { await reply("❌ Send a number from 1 to 100.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      ctx.session.step = null;
      return buy(ctx, reply, step.pid, num);
    }

    // ── Crypto top-up amount
    case "pay_amount": {
      if (!bot.isMain || !ctx.session.accountId) { ctx.session.step = null; return; }
      if (!(num > 0 && num <= 100000)) { await reply("❌ Send an amount between 1 and 100000 (e.g. 50).", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      ctx.session.step = null;
      return startCryptoPayment(ctx, reply, "topup", num, step.net ?? "bep20");
    }

    // ── Admin steps
    case "add_name": {
      if (!ctx.isBoss) return;
      const { data: p } = await db.from("products").insert({ tenant_id: bot.tenantId, name: html, category_id: step.cat }).select("id").single();
      if (!p) { ctx.session.step = null; await reply("❌ Could not create the product.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      return variantPrompt(ctx, reply, Number(p.id));
    }
    case "add_vars": {
      if (!ctx.isBoss) return;
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(normalizeDuration);
      if (lines.length === 1 && !parseVariantLine(lines[0]!)) {
        return ask(ctx, reply, { s: "var_price", pid: step.pid, label: normalizeDuration(html.trim()) }, PRICE_ASK);
      }
      const parsed = lines.map(parseVariantLine);
      const bad = lines.filter((_, i) => !parsed[i]);
      let n = 0;
      const { data: parent } = await db.from("products").select("category_id").eq("id", step.pid).eq("tenant_id", bot.tenantId).single();
      for (const v of parsed) if (v) {
        await db.from("products").insert({ tenant_id: bot.tenantId, name: v.label, price: v.price, cost: v.cost, parent_id: step.pid, category_id: parent?.category_id ?? null });
        n++;
      }
      await reply(`✅ Added ${n} variant(s).` + (bad.length ? `\n❌ Could not read: ${bad.map(escapeHtml).join(", ")}\nFormat: <code>7 Days - 10 - 3</code> (duration - price - cost)` : ""));
      return variantPrompt(ctx, reply, step.pid);
    }
    case "var_price": {
      if (!ctx.isBoss) return;
      if (!(Number.isFinite(num) && num >= 0)) return needNum();
      return ask(ctx, reply, { s: "var_cost", pid: step.pid, label: step.label, price: num }, "🏷 Now send the cost — what you pay per key (e.g. 3). Send - to skip (0):");
    }
    case "var_cost": {
      if (!ctx.isBoss) return;
      let cost = 0;
      if (raw.trim() !== "-") {
        if (!(Number.isFinite(num) && num >= 0)) return needNum();
        cost = num;
      }
      const { data: prod } = await db.from("products").select("name").eq("id", step.pid).eq("tenant_id", bot.tenantId).maybeSingle();
      ctx.session.step = { s: "var_confirm", pid: step.pid, label: step.label, price: step.price, cost };
      await reply(`📋 <b>Review before saving</b>\n\n📦 Product: <b>${prod?.name ?? ""}</b>\n⏱ Duration: <b>${step.label}</b>\n💵 Price: <b>${money(step.price)}</b>\n🏷 Cost: <b>${money(cost)}</b>`,
        kb([btn("✅ Save", "a:vsave"), btn("✖️ Cancel", "a:vcancel")]));
      return;
    }
    case "cat_new": {
      if (!ctx.isBoss) return;
      const { data: c } = await db.from("categories").insert({ tenant_id: bot.tenantId, name: html }).select("id").single();
      if (!c) { ctx.session.step = null; await reply("❌ Could not create the category.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      if (step.then === "add") return ask(ctx, reply, { s: "add_name", cat: Number(c.id) }, "📝 Type product name:");
      ctx.session.step = null;
      await reply(`✅ Category created: ${html}`, kb([btn("➕ Add product here", `a:addc:${c.id}`)], [btn("📂 Categories", "a:cats")], [btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "cat_name": {
      if (!ctx.isBoss) return;
      await db.from("categories").update({ name: html }).eq("id", step.cid).eq("tenant_id", bot.tenantId);
      ctx.session.step = null;
      await reply("✅ Saved.", kb([btn("⬅️ Category", `a:c:${step.cid}`)]));
      return;
    }
    case "set_price": case "set_cost": {
      if (!ctx.isBoss) return;
      if (!(num >= 0)) return needNum();
      await db.from("products").update(step.s === "set_price" ? { price: num } : { cost: num }).eq("id", step.pid).eq("tenant_id", bot.tenantId);
      ctx.session.step = null;
      await reply("✅ Saved.", kb([btn("⬅️ Back", `a:p:${step.pid}`)]));
      return;
    }
    case "set_name": {
      if (!ctx.isBoss) return;
      await db.from("products").update({ name: html }).eq("id", step.pid).eq("tenant_id", bot.tenantId);
      ctx.session.step = null;
      await reply("✅ Saved.", kb([btn("⬅️ Back", `a:p:${step.pid}`)]));
      return;
    }
    case "set_desc": {
      if (!ctx.isBoss) return;
      await db.from("products").update({ description: raw === "-" ? null : html }).eq("id", step.pid).eq("tenant_id", bot.tenantId);
      ctx.session.step = null;
      await reply("✅ Saved.", kb([btn("⬅️ Back", `a:p:${step.pid}`)]));
      return;
    }
    case "stock_keys":
    case "stock_review": {
      if (!ctx.isBoss) return;
      const p = await getProduct(db, bot.tenantId, step.pid);
      if (!p || p.nvars) { ctx.session.step = null; return stockView(ctx, reply); }
      const keys = raw.split(/\r?\n/).map(k => k.trim()).filter(Boolean);
      if (!keys.length) return stockKeyPrompt(ctx, reply, step.pid);
      ctx.session.step = { s: "stock_review", pid: step.pid, keys, request: `stock:${ctx.requestId}` };
      await reply(`📦 <b>Review stock</b>\n\n${await stockSelectionLabel(db, bot.tenantId, p)}\n🔢 Keys to add: <b>${keys.length}</b>\n📦 Available now: <b>${p.stock}</b>`, kb(
        [btn("✅ Save", `a:stocksave:${step.pid}`)],
        [btn("✏️ Edit keys", `a:stockkeys:${step.pid}`), btn("✖️ Cancel", "a:stock")]));
      return;
    }
    case "add_keys": {
      if (!ctx.isBoss) return;
      const { data: p } = await db.from("products").select("id").eq("id", step.pid).eq("tenant_id", bot.tenantId).maybeSingle();
      if (!p) { ctx.session.step = null; return; }
      const keys = raw.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
      if (!keys.length) { await reply("❌ Send at least one key.", kb([btn("✖️ Cancel", `x:ak:${step.pid}`)])); return; }
      const { error } = await db.rpc("add_bot_keys", { p_tenant: bot.tenantId, p_product: step.pid, p_keys: keys, p_request: ctx.requestId });
      if (error) { if (bot.durable) throw error; await reply("❌ Keys were not saved. Please resend them.", kb([btn("✖️ Cancel", `x:ak:${step.pid}`)])); return; }
      ctx.session.step = null;
      await reply(`✅ Added ${keys.length} key(s).`, kb([btn("🔑 Add more", `a:k:${step.pid}`), btn("⬅️ Back", `a:p:${step.pid}`)]));
      return;
    }
    case "acc_user": {
      if (!ctx.isBoss) return;
      const uname = raw.toLowerCase();
      if (!/^[a-z0-9_.]{3,32}$/.test(uname)) { await reply("❌ That username can't be used. Send 3–32 characters: letters, numbers, <code>_</code> or <code>.</code>", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: ex } = await db.from("bot_accounts").select("id").eq("tenant_id", bot.tenantId).eq("username", uname).maybeSingle();
      if (ex) { await reply("❌ That username is taken. Send another one.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      ctx.session.step = { s: "acc_pass", username: uname };
      await reply(`🔐 Now create a <b>password</b> for <code>${escapeHtml(uname)}</code>:\n\n8–32 characters — letters, numbers or symbols, no spaces.`, kb([btn("✖️ Cancel", "x:cancel")]));
      return;
    }
    case "acc_pass": {
      if (!ctx.isBoss) return;
      if (!/^\S{8,32}$/.test(raw)) { await reply("❌ Password must be 8–32 characters (letters, numbers, symbols — no spaces).", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const hash = await hashPassword(bot.tenantId, step.username, raw);
      const { data: acc } = await db.from("bot_accounts").insert({ tenant_id: bot.tenantId, username: step.username, password_hash: hash }).select("id").single();
      ctx.session.step = null;
      if (!acc) { await reply("❌ Could not create the account.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const creds = encodeURIComponent(`Username: ${step.username}\nPassword: ${raw}`);
      await reply(`✅ Account ${escapeHtml(step.username)}:${escapeHtml(raw)} added!`, kb(
        [urlBtn("✉️ Send credentials", `https://t.me/share/url?url=${creds}`)],
        [btn("💰 Top up", `a:mt:${acc.id}`)],
        [btn("⬅️ Back to accounts", "a:accs")]));
      return;
    }
    case "bal_add": {
      if (!ctx.isBoss) return;
      const [uname, amt] = raw.split(/\s+/);
      const a = Number(amt);
      if (!uname || !Number.isFinite(a) || a === 0) { await reply("❌ Format: <code>USERNAME AMOUNT</code>", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: acc } = await db.from("bot_accounts").select("*").eq("tenant_id", bot.tenantId).eq("username", uname.toLowerCase()).maybeSingle();
      if (!acc) { await reply("❌ Unknown username.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: c, error: balanceError } = await db.rpc("adjust_bot_balance", { p_tenant: bot.tenantId, p_account: acc.id, p_delta: a, p_request: ctx.requestId });
      if (balanceError && bot.durable) throw balanceError;
      ctx.session.step = null;
      if (!c) { await reply("❌ Update failed.", kb([btn("⬅️ Menu", "a:home")])); return; }
      if (c.tg_id) await sendHtml(bot.token, Number(c.tg_id), translateHtml(`💰 Your balance was ${a > 0 ? "credited" : "debited"} <b>${money(Math.abs(a))}</b>. New balance: <b>${money(c.balance)}</b>`, ctx.lang)).catch(() => {});
      await reply(`✅ New balance for <code>${escapeHtml(uname)}</code>: ${money(c.balance)}`, kb([btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "cprice": {
      if (!ctx.isBoss) return;
      const reset = raw.trim() === "-";
      if (!reset && !(num >= 0)) return needNum();
      const { data: c } = await db.from("bot_accounts").select("id").eq("id", step.cid).eq("tenant_id", bot.tenantId).maybeSingle();
      const p = await getProduct(db, bot.tenantId, step.pid);
      ctx.session.step = null;
      if (!c || !p) { await reply("❌ Not found.", kb([btn("⬅️ Menu", "a:home")])); return; }
      priceCache.delete(bot.tenantId);
      if (reset) await db.from("account_prices").delete().eq("account_id", step.cid).eq("product_id", step.pid);
      else await db.from("account_prices").upsert({ tenant_id: bot.tenantId, account_id: step.cid, product_id: step.pid, price: num });
      priceCache.delete(bot.tenantId);
      await reply(reset ? "✅ Default price restored for this account." : `✅ Special price set: <b>${money(num)}</b>`, kb([btn("💲 Custom prices", `a:cp:${step.cid}`)]));
      return;
    }
    case "topup": case "deduct": {
      if (!ctx.isBoss) return;
      if (!(num > 0)) return needNum();
      const amount = step.s === "topup" ? num : -num;
      const { data: acc } = await db.from("bot_accounts").select("*").eq("id", step.cid).eq("tenant_id", bot.tenantId).maybeSingle();
      if (!acc) { ctx.session.step = null; await reply("❌ Account not found.", kb([btn("⬅️ Menu", "a:home")])); return; }
      const { data: c, error: balanceError } = await db.rpc("adjust_bot_balance", { p_tenant: bot.tenantId, p_account: acc.id, p_delta: amount, p_request: ctx.requestId });
      if (balanceError && bot.durable) throw balanceError;
      ctx.session.step = null;
      if (!c) { await reply("❌ Update failed.", kb([btn("⬅️ Menu", "a:home")])); return; }
      if (c.tg_id) await sendHtml(bot.token, Number(c.tg_id), translateHtml(`💰 Your balance was ${amount > 0 ? "credited" : "debited"} <b>${money(Math.abs(amount))}</b>. New balance: <b>${money(c.balance)}</b>`, ctx.lang)).catch(() => {});
      await reply(`✅ New balance for <b>${escapeHtml(c.username)}</b>: <b>${money(c.balance)}</b>`, kb([btn("⬅️ Account", `a:m:${step.cid}`)]));
      return;
    }
    case "broadcast": {
      if (!ctx.isBoss) return;
      ctx.session.step = null;
      const { data: cs } = await db.from("bot_accounts").select("tg_id").eq("tenant_id", bot.tenantId).not("tg_id", "is", null);
      let ok = 0;
      for (const c of cs ?? []) { if (await sendHtml(bot.token, Number(c.tg_id), html)) ok++; await new Promise((r) => setTimeout(r, 40)); }
      await reply(`📣 Sent to ${ok}/${(cs ?? []).length} accounts.`, kb([btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "rm_user": {
      if (!ctx.isBoss || !bot.isMain) return;
      const q = raw.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
      let tg: number | null = /^\d{3,20}$/.test(q) ? Number(q) : null;
      if (tg === null) {
        const { data: a } = await db.from("bot_accounts").select("tg_id").eq("tenant_id", 0).ilike("tg_username", q).not("tg_id", "is", null).limit(1).maybeSingle();
        tg = a?.tg_id ? Number(a.tg_id) : null;
      }
      if (tg === null) { await reply("❌ User not found. Send their Telegram ID (numbers) or @username.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: gone } = await db.from("bot_accounts").update({ tg_id: null }).eq("tenant_id", 0).eq("tg_id", tg).select("id");
      await db.from("bot_sessions").delete().eq("tenant_id", 0).eq("tg_id", tg);
      ctx.session.step = null;
      if (tg === tgId) ctx.session.accountId = undefined;
      await reply(`✅ User <code>${tg}</code> removed (${(gone ?? []).length} account). Next /start will be a fresh start.`, kb([btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "aff_cu": {
      if (!ctx.isBoss || !bot.isMain) return;
      const q = raw.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
      let qb = db.from("bot_accounts").select("id,username,tg_name").eq("tenant_id", 0).not("tg_id", "is", null);
      qb = /^\d{3,20}$/.test(q) ? qb.eq("tg_id", Number(q)) : qb.ilike("tg_username", q);
      const { data: a } = await qb.limit(1).maybeSingle();
      if (!a) { await reply("❌ User not found. Send their Telegram ID or @username (they must have started the bot).", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const name = a.tg_name || a.username;
      return ask(ctx, reply, { s: "aff_ca", acc: a.id, name }, `🎯 Send the commission in $ for <b>${escapeHtml(name)}</b> (e.g. 10).\nSend <b>reset</b> to use the default again.`);
    }
    case "aff_ca": {
      if (!ctx.isBoss || !bot.isMain) return;
      if (/^reset$/i.test(raw)) {
        await db.from("bot_accounts").update({ aff_amount: null }).eq("id", step.acc).eq("tenant_id", 0);
        ctx.session.step = null;
        await reply(`✅ <b>${escapeHtml(step.name)}</b> now uses the default commission.`, kb([btn("⬅️ Go back", "a:aff:0")]));
        return;
      }
      const n = Number(raw.replace(/[$\s]/g, "").replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 1000) { await reply("❌ Send a number, e.g. 10 — or reset", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      await db.from("bot_accounts").update({ aff_amount: n }).eq("id", step.acc).eq("tenant_id", 0);
      ctx.session.step = null;
      await reply(`✅ <b>${escapeHtml(step.name)}</b> now earns <b>${money(n)}</b> per subscription from their link.`, kb([btn("⬅️ Go back", "a:aff:0")]));
      return;
    }
    case "aff_amount": {
      if (!ctx.isBoss || !bot.isMain) return;
      const n = Number(raw.replace(/[$\s]/g, "").replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 1000) { await reply("❌ Send a number, e.g. 5", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      await setSetting(bot, "aff_amount", String(n));
      ctx.session.step = null;
      await reply(`✅ Commission set to <b>${money(n)}</b> per subscription.`, kb([btn("⬅️ Go back", "a:aff:0")]));
      return;
    }
    case "support": {
      if (!ctx.isBoss) return;
      const u = raw.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
      if (!/^[A-Za-z0-9_]{4,32}$/.test(u)) { await reply("❌ Send a valid Telegram username, e.g. @YOUR_TELEGRAM", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      await setSetting(bot, "support_username", u);
      ctx.session.step = null;
      await reply(`✅ Support username saved: @${escapeHtml(u)}\nThe 💬 Support button now opens this chat.`, kb([btn("⬅️ Go back", "a:sup")]));
      return;
    }
    case "trial_text": {
      if (!ctx.isBoss) return;
      await setSetting(bot, "trial_text", html);
      ctx.session.step = null;
      await reply("✅ Trial text saved:\n\n" + html, kb([btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "welcome": {
      if (!ctx.isBoss) return;
      await setSetting(bot, "welcome", html);
      ctx.session.step = null;
      await reply("✅ Welcome text saved:\n\n" + html, kb([btn("⬅️ Menu", "a:home")]));
      return;
    }
    case "await_token": {
      if (!bot.isMain) return;
      if (!TOKEN_RE.test(raw)) { await reply("❌ That doesn't look like a bot token. Copy the full token from @BotFather (like <code>123456:ABC...</code>), or send /cancel.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const me = await tgCall(raw, "getMe").catch(() => null);
      if (!me) { await reply("❌ Telegram rejected this token. Check it in @BotFather and send again.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: clash } = await db.from("tenant_bots").select("id").eq("token", raw).maybeSingle();
      if (clash) { await reply("❌ This bot is already used by another account.", kb([btn("✖️ Cancel", "x:cancel")])); return; }
      const { data: prev } = await db.from("tenant_bots").select("id, token").eq("owner_account_id", ctx.session.accountId!).maybeSingle();
      let trialEnds: string | null = null;
      if (ctx.session.trialPending || !prev) {
        if (!ctx.session.trialPending) { ctx.session.step = null; await reply("⛔️ Please start a subscription or free trial first.", kb([btn("⬅️ Back", "tsub:cancel")])); return; }
        const { data: tr } = await db.rpc("claim_trial", { p_account: ctx.session.accountId!, p_tg: tgId, p_days: TRIAL_DAYS });
        if (!tr?.ok) { ctx.session.step = null; ctx.session.trialPending = undefined; await reply("ℹ️ Your free trial was already used.", kb([btn(`🚀 Make my bot — ${money(await getPrice(bot))}`, "tsub:buy")])); return; }
        trialEnds = fmtDate(tr.expires_at);
      }
      ctx.session.trialPending = undefined;
      const changing = !!(prev && prev.token);
      const freeChange = changing && !(await getSetting(bot, `free_token_change_${ctx.session.accountId}`));
      if (freeChange) await setSetting(bot, `free_token_change_${ctx.session.accountId}`, String(Date.now()));
      if (changing && !freeChange && (await tokenCooldown(db, ctx.session.accountId!)) > 0) { ctx.session.step = null; await reply("⏳ You can change the bot token once every 24 hours."); return; }
      // Changing the token wipes the shop (categories, products, durations, keys); emoji/colors/settings stay.
      if (changing) {
        await clearCatalog(db, Number(prev.id));
        await db.from("bot_settings").upsert({ tenant_id: 0, key: `token_changed_${ctx.session.accountId}`, value: String(Date.now()) }, { onConflict: "tenant_id,key" });
      }
      const { data: t } = await db.from("tenant_bots").update({ token: raw, bot_username: me.username, owner_tg_id: tgId }).eq("owner_account_id", ctx.session.accountId!).select("id").single();
      ctx.session.step = null;
      // Register the tenant webhook so the bot runs 24/7 on this server
      const secret = await webhookSecret(raw);
      await tgCall(raw, "setWebhook", {
        url: `${APP_BASE}/tenant/${raw}`,
        secret_token: secret,
        allowed_updates: ["message", "edited_message", "callback_query"],
        drop_pending_updates: true,
      }).catch((e: unknown) => console.error("tenant setWebhook failed", e));
      await ensureMenuCommands({ ...bot, token: raw, tenantId: Number(t.id), ownerTgId: tgId, isMain: false, adminTgIds: [] }).catch(() => {});
      await reply(`🎉 <b>Your bot is live!</b>\n\nOpen @${escapeHtml(me.username)} and press /start — you are the admin there.` +
        (trialEnds ? `\n\n🎁 <b>You got a ${TRIAL_DAYS}-day free trial subscription!</b>\nTrial ends: <b>${trialEnds}</b>\nRenew for ${await getDays(bot)} days anytime from 🤖 My Own Bot to keep it running.` : ""));
      return;
    }
  }
}

function update_message_id(_ctx: Ctx): number | null {
  return (_ctx as any).__msgId ?? null;
}

// ─── Callback queries ────────────────────────────────────────────────────────

async function handleCallback(ctx: Ctx, reply: (h: string, e?: any) => any, data: string, save: () => Promise<void>) {
  const { bot } = ctx;
  const db = await getDb();
  const own = ctx.isBoss;
  let m: RegExpMatchArray | null;

  const ak = own ? data.match(/^x:ak:(\d+)$/) : null;
  if (ak) { ctx.session.step = null; return adminProduct(ctx, reply, Number(ak[1])); }
  const ap = own ? data.match(/^x:ap:(\d+)$/) : null;
  if (ap) { ctx.session.step = null; return adminProduct(ctx, reply, Number(ap[1])); }
  if (data === "x:cancel") { ctx.session.step = null; return own ? adminMenu(ctx, reply) : ctx.session.accountId ? shopMenu(ctx, reply) : handleText(ctx, reply, "/start", [], save); }
  if (data === "a:home" && own) return adminMenu(ctx, reply);

  // ── Language picker (both bots, every user)
  if (data === "lang") return languageMenu(ctx, reply);
  const langSet = data.match(/^lang:set:(en|ar|ru|tr|hi)$/);
  if (langSet) {
    ctx.session.lang = langSet[1];
    ctx.lang = langSet[1];
    ctx.session.kbShown = true;
    ctx.session.kbLang = ctx.lang;
    await save();
    await reply("✅ Language saved.");
    // Telegram keeps the old persistent keyboard until a fresh message replaces it.
    await sendMenuKb(ctx, "⌨️ Menu");
    return ctx.isBoss ? adminMenu(ctx, reply) : ctx.session.accountId ? startWelcome(ctx, reply) : undefined;
  }

  if ((m = data.match(/^a:stockadd(?::(\d+))?$/)) && own) {
    ctx.session.step = null;
    const ps = await topProducts(db, bot.tenantId, "all");
    const { items, page, pages } = pageSlice(ps, Number(m[1] ?? 0));
    await reply(`➕ <b>Add stock</b>\n\n📝 Choose product:${pageLabel(page, pages)}`, { ...kb(
      ...items.map(p => [btn(p.name, `a:stockprod:${p.id}`)]),
      ...(ps.length ? [] : [[btn("➕ Add product", "a:add")]]),
      ...pageNav("a:stockadd", page, pages),
      [btn("⬅️ Back", "a:stock")]), noButtonColors: true });
    return;
  }
  const stockProduct = own ? data.match(/^a:stockprod:(\d+)$/) : null;
  if (stockProduct) {
    ctx.session.step = null;
    const pid = Number(stockProduct[1]);
    const p = await getProduct(db, bot.tenantId, pid);
    if (!p || p.parent_id) return stockView(ctx, reply);
    const variants = await variantsOf(db, bot.tenantId, pid);
    if (!variants.length) return stockKeyPrompt(ctx, reply, pid);
    await reply(`➕ <b>Add stock</b>\n\n📝 Product: <b>${p.name}</b>\n⏱ Choose duration:`, { ...kb(
      ...variants.map(v => [btn(`${v.name} · ${v.stock} available`, `a:stockkeys:${v.id}`)]),
      [btn("⬅️ Back", "a:stockadd"), btn("✖️ Cancel", "a:stock")]), noButtonColors: true });
    return;
  }
  const stockKeys = own ? data.match(/^a:stockkeys:(\d+)$/) : null;
  if (stockKeys) return stockKeyPrompt(ctx, reply, Number(stockKeys[1]));
  const stockSave = own ? data.match(/^a:stocksave:(\d+)$/) : null;
  if (stockSave) {
    const st = ctx.session.step;
    if (st?.s !== "stock_review" || st.pid !== Number(stockSave[1])) return;
    const p = await getProduct(db, bot.tenantId, st.pid);
    if (!p || p.nvars) { ctx.session.step = null; return stockView(ctx, reply); }
    const { error } = await db.rpc("add_bot_keys", { p_tenant: bot.tenantId, p_product: st.pid, p_keys: st.keys, p_request: st.request });
    if (error) {
      if (bot.durable) throw error;
      await reply("❌ Stock was not saved. Please try again.", kb([btn("✅ Save", `a:stocksave:${st.pid}`)], [btn("✖️ Cancel", "a:stock")]));
      return;
    }
    ctx.session.step = null;
    await reply(`✅ <b>Stock added</b>\n\n${await stockSelectionLabel(db, bot.tenantId, p)}\n🔑 Added: <b>${st.keys.length}</b>\n📦 Available: <b>${await stockOf(db, bot.tenantId, st.pid)}</b>`, kb(
      [btn("➕ Add more keys", `a:stockkeys:${st.pid}`)],
      [btn("📝 Choose product", "a:stockadd"), btn("📦 Stock", "a:stock")]));
    return;
  }

  // ── New-user approval (admin only)
  const apMatch = data.match(/^ap:(ok|no):(\d+)$/);
  if (apMatch) {
    if (!own) return;
    const targetTg = Number(apMatch[2]);
    if (apMatch[1] === "no") {
      const blocked = await blockedUsers(bot);
      if (!blocked.includes(targetTg)) {
        blocked.push(targetTg);
        await setSetting(bot, "blocked_users", JSON.stringify(blocked));
      }
      await sendHtml(bot.token, targetTg, "🚫 Your access request was rejected.").catch(() => {});
      await reply(`🚫 Rejected user <code>${targetTg}</code>. They can no longer request access.`);
      return;
    }
    // Approve: create an account with generated credentials and send them to the user.
    const base = `user${String(targetTg).slice(-6)}`;
    let uname = base;
    for (let i = 1; ; i++) {
      const { data: exists } = await db.from("bot_accounts").select("id").eq("tenant_id", bot.tenantId).eq("username", uname).maybeSingle();
      if (!exists) break;
      uname = `${base}${i}`;
    }
    const pass = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("") + String(targetTg % 100).padStart(2, "0");
    const hash = await hashPassword(bot.tenantId, uname, pass);
    const { data: acc, error } = await db.from("bot_accounts").insert({ tenant_id: bot.tenantId, username: uname, password_hash: hash, tg_id: targetTg, balance: 0 }).select("id").single();
    if (error || !acc) { await reply("⚠️ Could not create the account. Try again."); return; }
    await sendHtml(bot.token, targetTg,
      `✅ <b>Approved!</b> Your account is ready.\n\n` +
      `👤 Username: <code>${escapeHtml(uname)}</code>\n` +
      `🔑 Password: <code>${escapeHtml(pass)}</code>\n\n` +
      `Send /start and log in with these credentials.`).catch(() => {});
    await reply(`✅ Approved <code>${targetTg}</code> — account <code>${escapeHtml(uname)}</code> created and credentials sent.`);
    return;
  }


  if (data.startsWith("a:qc") && own) return quickColors(ctx, reply, data);
  if (data.startsWith("a:colors")) {
    if (!own) return;
    ctx.session.step = null;
    if (data === "a:colors") return colorsMenu(ctx, reply);
    const pageMatch = data.match(/^a:colors:page:(\d+)$/);
    if (pageMatch) return colorsMenu(ctx, reply, Number(pageMatch[1]));
    const itemMatch = data.match(/^a:colors:item:([a-z_]+):(\d+)$/);
    if (itemMatch && COLOR_BUTTONS.some(button => button.id === itemMatch[1])) return colorsMenu(ctx, reply, Number(itemMatch[2]), itemMatch[1]);
    const setMatch = data.match(/^a:colors:set:([a-z_]+):(default|primary|success|danger):(\d+)$/);
    if (setMatch && COLOR_BUTTONS.some(button => button.id === setMatch[1]) && isButtonColor(setMatch[2])) {
      const colors = parseButtonColors(ctx.emoji.buttons);
      // Explicit default overrides legacy group-wide preferences too.
      colors.items = { ...colors.items, [setMatch[1]]: setMatch[2] };
      ctx.emojiOwn.buttons = colors;
      await saveEmojiTheme(ctx);
      await sendMenuKb(ctx, "✅ Button color updated.");
      return colorsMenu(ctx, reply, Number(setMatch[3]));
    }
    const match = data.match(/^a:colors:(inline|keyboard):(default|primary|success|danger)$/);
    if (!match || !isButtonColor(match[2])) return;
    const group = match[1] as "inline" | "keyboard";
    const colors = parseButtonColors(ctx.emoji.buttons);
    colors[group] = match[2];
    ctx.emojiOwn.buttons = colors;
    await saveEmojiTheme(ctx);
    // A reply keyboard is replaced with a fresh message, not editMessageText.
    if (group === "keyboard") {
      await sendMenuKb(ctx, "✅ Bottom keyboard color updated.");
    }
    return colorsMenu(ctx, reply);
  }

  // Emoji settings are strictly scoped to the authenticated Telegram owner.
  if (data.startsWith("a:emoji") && !own) return;
  if (data === "a:emoji") { ctx.session.step = null; return emojiMenu(ctx, reply); }
  if (data === "a:emoji:toggle") {
    ctx.emojiOwn.enabled = !ctx.emoji.enabled;
    await saveEmojiTheme(ctx);
    await reply("✅ Emoji display updated.", menuKb(ctx));
    return emojiMenu(ctx, reply);
  }
  const emojiMatch = data.match(/^a:emoji:(icons|products|categories)(?::(\d+))?$/);
  if (emojiMatch) return emojiList(ctx, reply, emojiMatch[1] as "icons" | "products" | "categories", Number(emojiMatch[2] ?? 0));
  const iconMatch = data.match(/^a:emoji:icon:(\d+)$/);
  if (iconMatch) {
    const icon = EMOJI_ICONS[Number(iconMatch[1])];
    if (!icon) return;
    return ask(ctx, reply, { s: "emoji_icon", icon }, `${icon} <b>${EMOJI_LABELS[icon] ?? "Message icon"}</b>\n\nSend a Premium emoji, or - to restore the default:`, kb([btn("⬅️ Go back", `a:emoji:icons:${Math.floor(Number(iconMatch[1]) / 10)}`)]));
  }
  const itemMatch = data.match(/^a:emoji:item:(products|categories):(\d+)$/);
  if (itemMatch) {
    const kind = itemMatch[1] as "products" | "categories";
    const id = Number(itemMatch[2]);
    const { data: item } = await db.from(kind).select("name").eq("tenant_id", bot.tenantId).eq("id", id).maybeSingle();
    if (!item) return;
    return ask(ctx, reply, { s: "emoji_catalog", kind, id }, `✨ Send a Premium emoji for <b>${item.name}</b>, or - to remove it:`, kb([btn("⬅️ Go back", `a:emoji:${kind}`)]));
  }
  // ── My Own Bot (main bot only)
  if (bot.isMain && data.startsWith("tsub:")) return handleSubscription(ctx, reply, data);
  // ── Crypto top-up (main bot only)
  if (bot.isMain && data.startsWith("pay:")) return handleCryptoPay(ctx, reply, data);

  // ── Admin callbacks
  if (data === "a:add" && own) {
    const cs = await categories(db, bot.tenantId);
    if (!cs.length) return ask(ctx, reply, { s: "cat_new", then: "add" }, "📂 No categories yet — create one first.\nSend the category name (premium emoji allowed):");
    await reply("📂 Choose a category for the new product:", kb(
      ...cs.map((c) => [btn(c.name, `a:addc:${c.id}`)]),
      [btn("➕ New category", "a:catnew:add")], [btn("⬅️ Back", "a:home")]));
    return;
  }
  if ((m = data.match(/^a:addc:(\d+)$/)) && own) return ask(ctx, reply, { s: "add_name", cat: Number(m[1]) }, "📝 Type product name:");
  if ((m = data.match(/^a:pre:(\d+):(\d+)$/)) && own) {
    const label = PRESETS.find(([d]) => d === m![2])?.[1] ?? `${m[2]} Days`;
    return ask(ctx, reply, { s: "var_price", pid: Number(m[1]), label }, PRICE_ASK);
  }
  if ((m = data.match(/^a:v:(\d+)$/)) && own) return variantPrompt(ctx, reply, Number(m[1]));
  if ((data === "a:vsave" || data === "a:vcancel") && own) {
    const st = ctx.session.step;
    if (!st || st.s !== "var_confirm") { await reply("⚠️ Nothing to save."); return; }
    ctx.session.step = null;
    if (data === "a:vsave") {
      const { data: parent } = await db.from("products").select("category_id").eq("id", st.pid).eq("tenant_id", bot.tenantId).single();
      await db.from("products").insert({ tenant_id: bot.tenantId, name: st.label, price: st.price, cost: st.cost, parent_id: st.pid, category_id: parent?.category_id ?? null });
    }
    await reply(data === "a:vsave"
      ? `✅ <b>Saved!</b>\n⏱ ${st.label} — <b>${money(st.price)}</b> · 🏷 <b>${money(st.cost)}</b>\n\nWould you like to add another duration to this product?`
      : "✖️ Not saved.\n\nWould you like to add a duration to this product?",
      kb([btn("➕ Add another duration", `a:v:${st.pid}`)], [btn("✅ Finish", `a:p:${st.pid}`)]));
    return;
  }

  if ((m = data.match(/^a:cats(?::(\d+))?$/)) && own) {
    const cs = await categories(db, bot.tenantId);
    if (!cs.length) { await reply("📂 <b>Categories</b>\n\nNone yet.", kb([btn("➕ New category", "a:catnew:list")], [btn("⬅️ Back", "a:home")])); return; }
    const { items, page, pages } = pageSlice(cs, Number(m[1] ?? 0));
    await reply(`📂 <b>Categories</b>${pageLabel(page, pages)}`, kb(
      ...items.map((c) => [btn(`${c.name} (${c.n})`, `a:c:${c.id}`)]),
      ...pageNav("a:cats", page, pages),
      [btn("➕ New category", "a:catnew:list")], [btn("⬅️ Back", "a:home")]));
    return;
  }
  if ((m = data.match(/^a:catnew:(add|list)$/)) && own) return ask(ctx, reply, { s: "cat_new", then: m[1] as "add" | "list" }, "📂 Send the category name (premium emoji allowed):");
  if ((m = data.match(/^a:c:(\d+)(?::(\d+))?$/)) && own) {
    const cid = Number(m[1]);
    const { data: c } = await db.from("categories").select("*").eq("id", cid).eq("tenant_id", bot.tenantId).maybeSingle();
    if (!c) return;
    const ps = await topProducts(db, bot.tenantId, cid);
    const { items, page, pages } = pageSlice(ps, Number(m[2] ?? 0));
    await reply(`${titlePrefix("📂", c.name)}<b>${c.name}</b>\n${ps.length} product(s)${pageLabel(page, pages)}`, kb(
      ...items.map((p) => [btn(`${p.name} · ${priceLabel(p)} · stock ${p.stock}`, `a:p:${p.id}`)]),
      ...pageNav(`a:c:${cid}`, page, pages),
      [btn("➕ Add product here", `a:addc:${cid}`)],
      [btn("✏️ Rename", `a:cn:${cid}`), btn("🗑 Delete", `a:cdel:${cid}`)], [btn("⬅️ Categories", "a:cats")]));
    return;
  }
  if ((m = data.match(/^a:cn:(\d+)$/)) && own) return ask(ctx, reply, { s: "cat_name", cid: Number(m[1]) }, "✏️ Send the new category name:");
  if ((m = data.match(/^a:cdel:(\d+)$/)) && own) {
    await reply("Delete this category? Products stay (moved to “No category”).", kb([btn("🗑 Yes, delete", `a:cdelok:${m[1]}`), btn("Cancel", `a:c:${m[1]}`)]));
    return;
  }
  if ((m = data.match(/^a:cdelok:(\d+)$/)) && own) {
    await db.from("categories").delete().eq("id", Number(m[1])).eq("tenant_id", bot.tenantId);
    await reply("🗑 Category deleted.", kb([btn("📂 Categories", "a:cats")]));
    return;
  }
  if ((m = data.match(/^a:pc:(\d+)$/)) && own) {
    const cs = await categories(db, bot.tenantId);
    await reply("📂 Move product to:", kb(...cs.map((c) => [btn(c.name, `a:pcs:${m![1]}:${c.id}`)]),
      [btn("📄 No category", `a:pcs:${m[1]}:0`), btn("⬅️ Back", `a:p:${m[1]}`)]));
    return;
  }
  if ((m = data.match(/^a:pcs:(\d+):(\d+)$/)) && own) {
    await db.from("products").update({ category_id: Number(m[2]) || null }).eq("id", Number(m[1])).eq("tenant_id", bot.tenantId);
    await reply("✅ Moved.", kb([btn("⬅️ Product", `a:p:${m[1]}`)]));
    return;
  }

  if ((m = data.match(/^a:list(?::(\d+))?$/)) && own) {
    const ps = await topProducts(db, bot.tenantId, "all");
    if (!ps.length) { await reply("No products yet.", kb([btn("➕ Add product", "a:add")], [btn("⬅️ Back", "a:home")])); return; }
    const cs = await categories(db, bot.tenantId);
    const catName = (id: number | null) => cs.find((c) => c.id === id)?.name;
    const { items, page, pages } = pageSlice(ps, Number(m[1] ?? 0));
    await reply(`📦 <b>Products</b>${pageLabel(page, pages)}`, kb(
      ...items.map((p) => [btn(`${p.category_id ? plainLabel(catName(p.category_id) ?? "") + " › " : ""}${p.name} · ${priceLabel(p)} · stock ${p.stock}`, `a:p:${p.id}`)]),
      ...pageNav("a:list", page, pages),
      [btn("➕ Add product", "a:add"), btn("⬅️ Back", "a:home")]));
    return;
  }
  if ((m = data.match(/^a:p:(\d+)$/)) && own) return adminProduct(ctx, reply, Number(m[1]));
  if ((m = data.match(/^a:k:(\d+)$/)) && own) return ask(ctx, reply, { s: "add_keys", pid: Number(m[1]) }, "📝 Send keys, one per line:\n\n<code>DEMO-KEY1</code>\n\n<code>DEMO-KEY2</code>", kb([btn("✖️ Cancel", `x:ak:${m[1]}`)]));
  if ((m = data.match(/^a:sp:(\d+)$/)) && own) return ask(ctx, reply, { s: "set_price", pid: Number(m[1]) }, "📝 Type new price:");
  if ((m = data.match(/^a:sc:(\d+)$/)) && own) return ask(ctx, reply, { s: "set_cost", pid: Number(m[1]) }, "🏷 Send the new cost — what you pay per key (e.g. 3):");
  if ((m = data.match(/^a:sn:(\d+)$/)) && own) return ask(ctx, reply, { s: "set_name", pid: Number(m[1]) }, "✏️ Send the new name (premium emoji allowed):");
  if ((m = data.match(/^a:sd:(\d+)$/)) && own) return ask(ctx, reply, { s: "set_desc", pid: Number(m[1]) }, "📝 Send the description (premium emoji allowed), or - to remove:");
  if ((m = data.match(/^a:del:(\d+)$/)) && own) {
    await reply("Delete this and its unsold keys (and variants)?", kb([btn("🗑 Yes, delete", `a:delok:${m[1]}`), btn("Cancel", `a:p:${m[1]}`)]));
    return;
  }
  if ((m = data.match(/^a:delok:(\d+)$/)) && own) {
    const { data: d } = await db.from("products").delete().eq("id", Number(m[1])).eq("tenant_id", bot.tenantId).select("parent_id").maybeSingle();
    await reply("🗑 Deleted.", kb([d?.parent_id ? btn("⬅️ Product", `a:p:${d.parent_id}`) : btn("📦 Products", "a:list")]));
    return;
  }

  if (data === "a:acc" && own) return ask(ctx, reply, { s: "acc_user" }, "👤 Choose a <b>username</b> for the new account:\n\n3–32 characters — letters, numbers, <code>_</code> or <code>.</code>");
  if ((m = data.match(/^a:bal(?::(\d+))?$/)) && own) return balPicker(ctx, reply, Number(m[1] ?? 0));
  if (data === "a:manage" && own) {
    await reply("🔧 Choose action", kb(
      [btn("🔓 Manage accounts", "a:accs")],
      [btn("🔍 Look at purchases", "a:purch")],
      ...(bot.isMain ? [] : [[btn("🗑 Delete all products", "a:wipe")]]),
      [btn("⬅️ Go back", "a:home")]));
    return;
  }
  if (data === "a:wipe" && own && !bot.isMain) {
    await reply("⚠️ Delete <b>all</b> categories, products and keys in this bot?\nEmoji, colors, accounts and balances stay.", kb([btn("🗑 Yes, delete all", "a:wipeok"), btn("Cancel", "a:manage")]));
    return;
  }
  if (data === "a:wipeok" && own && !bot.isMain) {
    await clearCatalog(db, bot.tenantId);
    await reply("🗑 All products and categories deleted. The shop is empty now.", kb([btn("➕ Add product", "a:add")], [btn("⬅️ Go back", "a:home")]));
    return;
  }
  if ((m = data.match(/^a:accs(?::(\d+))?$/)) && own) return manageList(ctx, reply, Number(m[1] ?? 0));
  if ((m = data.match(/^a:cpu(?::(\d+))?$/)) && own) return manageList(ctx, reply, Number(m[1] ?? 0), true);
  if ((m = data.match(/^a:users:(\d+)$/)) && own) return usersPage(ctx, reply, Number(m[1]));
  if ((m = data.match(/^a:purch(?::(\d+))?$/)) && own) {
    return historyPage(ctx, reply, Number(m[1] ?? 0), "a:purch");
  }
  if ((m = data.match(/^a:m:(\d+)$/)) && own) {
    const cid = Number(m[1]);
    const { data: c } = await db.from("bot_accounts").select("*").eq("id", cid).eq("tenant_id", bot.tenantId).maybeSingle();
    if (!c) return;
    const { data: s } = await db.from("shop_orders").select("price").eq("account_id", cid);
    const spent = (s ?? []).reduce((a: number, o: any) => a + Number(o.price), 0);
    await reply(`👤 <b>${escapeHtml(c.username)}</b>\n💰 Balance: <b>${money(c.balance)}</b>\n🧾 Orders: ${(s ?? []).length} · Spent: ${money(spent)}`, kb(
      [btn("💰 Top up", `a:mt:${cid}`), btn("➖ Deduct", `a:md:${cid}`)],
      [btn("🧾 Purchase history", `a:mo:${cid}`), btn("💲 Custom prices", `a:cp:${cid}`)],
      [btn("⬅️ Go back", "a:manage")]));
    return;
  }
  if ((m = data.match(/^a:mt:(\d+)$/)) && own) return ask(ctx, reply, { s: "topup", cid: Number(m[1]) }, "✏️ Type sum to top up:");
  if ((m = data.match(/^a:md:(\d+)$/)) && own) return ask(ctx, reply, { s: "deduct", cid: Number(m[1]) }, "✏️ Type sum to deduct:");
  if ((m = data.match(/^a:mo:(\d+)(?::(\d+))?$/)) && own) {
    const cid = Number(m[1]);
    return historyPage(ctx, reply, Number(m[2] ?? 0), `a:mo:${cid}`, cid);
  }
  if (data === "a:stats" && own) {
    const { data: os } = await db.from("shop_orders").select("*").eq("tenant_id", bot.tenantId).order("id", { ascending: false });
    const all = os ?? [];
    const rev = all.reduce((a: number, o: any) => a + Number(o.price), 0);
    const profit = all.reduce((a: number, o: any) => a + Number(o.price) - Number(o.cost), 0);
    const today = all.filter((o: any) => new Date(o.created_at) > new Date(Date.now() - 86400000)).reduce((a: number, o: any) => a + Number(o.price), 0);
    const last = all.slice(0, 10);
    const ids = [...new Set(last.map((o: any) => o.account_id))];
    const { data: accs } = ids.length ? await db.from("bot_accounts").select("id, username").in("id", ids) : { data: [] };
    const nameOf = (id: number) => (accs ?? []).find((a: any) => a.id === id)?.username ?? "?";
    await reply(`📊 <b>Orders</b>\nTotal: ${all.length}\nRevenue: ${money(rev)}\nProfit: ${money(profit)}\nToday: ${money(today)}\n\n` +
      last.map((o: any) => `#${o.id} ${escapeHtml(nameOf(o.account_id))} — ${o.product_name ?? ""} — ${money(o.price)}`).join("\n"), kb([btn("⬅️ Back", "a:home")]));
    return;
  }
  if (data === "a:bc" && own) return ask(ctx, reply, { s: "broadcast" }, "📣 Send the message for all accounts (premium emoji allowed):");
  if (data === "a:sup" && own) {
    const sup = await supportUsername(bot);
    await reply(`💬 <b>Support button</b>\n\nCurrent: ${sup ? "@" + escapeHtml(sup) : "— not set (button hidden)"}`, kb(
      [btn(sup ? "✏️ Change username" : "✏️ Set username", "a:sup:set")],
      ...(sup ? [[btn("🗑 Remove", "a:sup:del")]] : []),
      [btn("⬅️ Go back", "a:home")],
    ));
    return;
  }
  if (data === "a:sup:set" && own) return ask(ctx, reply, { s: "support" }, "💬 Send the Telegram username for support (e.g. @YOUR_TELEGRAM):");
  if (data === "a:sup:del" && own) {
    await setSetting(bot, "support_username", "");
    await reply("🗑 Support button removed.", kb([btn("⬅️ Go back", "a:sup")]));
    return;
  }
  if (data === "a:wel" && own) return ask(ctx, reply, { s: "welcome" }, "👋 Send the new welcome text (premium emoji allowed):\n\nUse <code>{name}</code> where the account name should appear.");
  if ((m = data.match(/^a:stock(?::(\d+))?$/)) && own) return stockView(ctx, reply, Number(m[1] ?? 0));

  // ── One-click hide/show prices for customers
  if (data === "a:hide" && own) {
    const on = (await getSetting(bot, "hide_prices")) === "1";
    await setSetting(bot, "hide_prices", on ? "0" : "1");
    await reply(on ? "👁 Prices are now <b>visible</b> to customers." : "🙈 Prices are now <b>hidden</b> from customers — only <b>$</b> is shown, including order history.", kb([btn("⬅️ Back", "a:home")]));
    return;
  }

  // ── Per-account custom prices
  if ((m = data.match(/^a:cp:(\d+)(?::(\d+))?$/)) && own) {
    const cid = Number(m[1]);
    const { data: c } = await db.from("bot_accounts").select("username").eq("id", cid).eq("tenant_id", bot.tenantId).maybeSingle();
    if (!c) return;
    const { data: cps } = await db.from("account_prices").select("product_id, price").eq("tenant_id", bot.tenantId).eq("account_id", cid);
    const custom = new Map<number, number>((cps ?? []).map((r: any) => [Number(r.product_id), Number(r.price)]));
    const rows: any[][] = [];
    for (const p of await topProducts(db, bot.tenantId, "all")) {
      const vars = Number(p.nvars) ? await variantsOf(db, bot.tenantId, Number(p.id)) : [p];
      for (const v of vars) {
        const cp = custom.get(Number(v.id));
        const label = v.id === p.id ? plainLabel(p.name) : `${plainLabel(p.name)} — ${plainLabel(v.name)}`;
        rows.push([btn(`${label} · ${cp !== undefined ? "⭐ " + money(cp) : money(v.price)}`, `a:cps:${cid}:${v.id}`)]);
      }
    }
    const { items, page, pages } = pageSlice(rows, Number(m[2] ?? 0));
    await reply(`💲 <b>Custom prices for ${escapeHtml(c.username)}</b>\n\nTap a key type to set a special price for this account.\n⭐ = custom price, others use the default price.${pageLabel(page, pages)}`,
      kb(...items, ...pageNav(`a:cp:${cid}`, page, pages), [btn("⬅️ Account", `a:m:${cid}`)]));
    return;
  }
  if ((m = data.match(/^a:cps:(\d+):(\d+)$/)) && own) {
    return ask(ctx, reply, { s: "cprice", cid: Number(m[1]), pid: Number(m[2]) }, "💵 Enter the special price for this account (USD $), or send <code>-</code> to use the default price:");
  }

  if (data === "a:trt" && own && bot.isMain) return ask(ctx, reply, { s: "trial_text" }, "🎁 Send the new free-trial offer shown on /start (premium emoji allowed).\n\nUse <code>{days}</code> for the trial length.");
  const ftb = data.match(/^a:ftb:(\d+)$/);
  if (ftb && own && bot.isMain) {
    const { data: pays } = await db.from("tenant_bot_payments").select("tenant_id, note");
    const trialIds = [...new Set((pays ?? []).filter((p: any) => p.note === "trial").map((p: any) => p.tenant_id))];
    const paidIds = new Set((pays ?? []).filter((p: any) => p.note !== "trial").map((p: any) => p.tenant_id));
    const { data: ts } = trialIds.length ? await db.from("tenant_bots").select("id, bot_username, owner_account_id, status, expires_at").in("id", trialIds).order("id") : { data: [] };
    const ids = (ts ?? []).map((t: any) => t.owner_account_id);
    const { data: accs } = ids.length ? await db.from("bot_accounts").select("id, username").in("id", ids) : { data: [] };
    const nameOf = (id: number) => (accs ?? []).find((a: any) => a.id === id)?.username ?? "?";
    const freeCount = (ts ?? []).filter((t: any) => !paidIds.has(t.id)).length;
    const { items, page, pages } = pageSlice(ts ?? [], Number(ftb[1]));
    const lines = items.map((t: any) => {
      const live = t.status === "active" && new Date(t.expires_at) > new Date();
      const kind = paidIds.has(t.id) ? "💳 Paid subscription" : live ? "🎁 Free trial" : "⛔️ Trial ended";
      return `${kind} — ${escapeHtml(plainLabel(nameOf(t.owner_account_id)))}${t.bot_username ? " · @" + escapeHtml(t.bot_username) : ""} — until ${fmtDate(t.expires_at)}`;
    });
    await reply(`🎁 <b>Free trial bots</b>\nFree now: <b>${freeCount}</b> · Moved to paid: <b>${(ts ?? []).length - freeCount}</b>${pageLabel(page, pages)}\n\n${lines.join("\n") || "None yet."}`,
      kb(...items.map((t: any) => [btn(`${paidIds.has(t.id) ? "💳" : "🎁"} ${plainLabel(nameOf(t.owner_account_id))}${t.bot_username ? " · @" + t.bot_username : ""}`, `a:tb:${t.id}`)]), ...pageNav("a:ftb", page, pages), [btn("⬅️ Back", "a:home")]));
    return;
  }
  // ── Main admin: view every reseller bot's catalog & keys
  const tbp = data.match(/^a:tbl:(\d+)$/);
  if ((data === "a:tb" || tbp) && own && bot.isMain) {
    const { data: ts } = await db.from("tenant_bots").select("id, bot_username, owner_account_id, status, expires_at").order("id");
    const ids = (ts ?? []).map((t: any) => t.owner_account_id);
    const { data: accs } = ids.length ? await db.from("bot_accounts").select("id, username").in("id", ids) : { data: [] };
    const nameOf = (id: number) => (accs ?? []).find((a: any) => a.id === id)?.username ?? "?";
    const { items, page, pages } = pageSlice(ts ?? [], tbp ? Number(tbp[1]) : 0);
    await reply(`🤖 <b>Reseller bots</b> (${(ts ?? []).length})${pageLabel(page, pages)}`, kb(
      ...items.map((t: any) => [btn(`${t.status === "active" ? "🟢" : "🔴"} ${plainLabel(nameOf(t.owner_account_id))}${t.bot_username ? " · @" + t.bot_username : ""}`, `a:tb:${t.id}`)]),
      ...pageNav("a:tbl", page, pages),
      [btn("⬅️ Back", "a:home")]));
    return;
  }
  if ((m = data.match(/^a:tb:(\d+)$/)) && own && bot.isMain) {
    const tid = Number(m[1]);
    const { data: t } = await db.from("tenant_bots").select("*").eq("id", tid).maybeSingle();
    if (!t) return;
    const cs = await categories(db, tid);
    const ps = await topProducts(db, tid, "all");
    const lines = [`🤖 <b>${t.bot_username ? "@" + escapeHtml(t.bot_username) : "Reseller bot #" + tid}</b>`, `📅 Active until ${fmtDate(t.expires_at)} · ${escapeHtml(t.status)}`, `📂 ${cs.length} categories · 📦 ${ps.length} products`];
    for (const group of [...cs.map((c) => ({ id: c.id as number | null, name: c.name })), { id: null, name: "No category" }]) {
      const gp = ps.filter((p) => (p.category_id ?? null) === group.id);
      if (!gp.length) continue;
      lines.push("", `${titlePrefix("📂", group.name)}<b>${group.name}</b>`);
      for (const p of gp) {
        const vars = Number(p.nvars) ? await variantsOf(db, tid, Number(p.id)) : [];
        lines.push(`${titlePrefix("🛒", p.name)}<b>${p.name}</b>` + (vars.length ? "" : ` · ${money(p.price)} · stock ${p.stock}`));
        for (const v of vars) lines.push(`   · ${v.name} · ${money(v.price)} · stock ${v.stock}`);
      }
    }
    await replyLines(reply, lines, kb(
      ...ps.map((p) => [btn(`🔑 Keys: ${plainLabel(p.name)}`, `a:tbk:${tid}:${p.id}`)]),
      [btn(t.status === "active" ? "⛔️ Turn off bot" : "✅ Turn on bot", `a:tbs:${tid}`)],
      [btn("⬅️ Reseller bots", "a:tb")]));
    return;
  }
  if ((m = data.match(/^a:tbs:(\d+)$/)) && own && bot.isMain) {
    const tid = Number(m[1]);
    const { data: t } = await db.from("tenant_bots").select("id, status, bot_username").eq("id", tid).maybeSingle();
    if (!t) return;
    const next = t.status === "active" ? "disabled" : "active";
    await db.from("tenant_bots").update({ status: next }).eq("id", tid);
    await reply(next === "disabled"
      ? `⛔️ Bot ${t.bot_username ? "@" + escapeHtml(t.bot_username) : "#" + tid} is now <b>OFF</b>. It will not respond to anyone until you turn it back on.`
      : `✅ Bot ${t.bot_username ? "@" + escapeHtml(t.bot_username) : "#" + tid} is now <b>ON</b>.`,
      kb([btn("⬅️ Back", `a:tb:${tid}`)]));
    return;
  }
  if ((m = data.match(/^a:vk:(\d+)(?::(\d+))?$/)) && own) {
    const pid = Number(m[1]);
    const p = await getProduct(db, bot.tenantId, pid);
    if (!p) return;
    const report = await keysReport(db, bot.tenantId, p, Number(m[2] ?? 0));
    await replyLines(reply, report.lines, keyPageButtons(report, `a:vk:${pid}`, `a:p:${pid}`));
    return;
  }
  if ((m = data.match(/^a:tbk:(\d+):(\d+)(?::(\d+))?$/)) && own && bot.isMain) {
    const tid = Number(m[1]), pid = Number(m[2]);
    const p = await getProduct(db, tid, pid);
    if (!p) return;
    const report = await keysReport(db, tid, p, Number(m[3] ?? 0));
    await replyLines(reply, report.lines, keyPageButtons(report, `a:tbk:${tid}:${pid}`, `a:tb:${tid}`));
    return;
  }

  // ── Customer callbacks
  if (data === "a:rmu" && own && bot.isMain) return ask(ctx, reply, { s: "rm_user" }, "🚫 <b>Remove user</b>\nSend the user's Telegram ID or @username.\nThey will start fresh on /start (like a brand-new user). Their old balance, orders and bot stay saved but are no longer linked.");
  if (data === "aff:menu" && bot.isMain) return affiliateMenu(ctx, reply);
  if (data.startsWith("a:aff") && own && bot.isMain) return affiliateAdmin(ctx, reply, data);
  if (data === "c:home") return own ? adminMenu(ctx, reply) : shopMenu(ctx, reply);
  const sm = data.match(/^c:shop:(\d+)$/);
  if (data === "c:shop" || sm) return own ? ownerShop(ctx, reply, sm ? Number(sm[1]) : 0) : shopCustomer(ctx, reply, sm ? Number(sm[1]) : 0);
  if ((m = data.match(/^c:cat:(\d+)(?::(\d+))?$/))) {
    const cid = Number(m[1]) || null;
    const requested = Number(m[2] ?? 0);
    const ps = await topProducts(db, bot.tenantId, cid);
    const { data: c } = cid ? await db.from("categories").select("name").eq("id", cid).eq("tenant_id", bot.tenantId).maybeSingle() : { data: { name: "Other" } };
    const { items, page, pages } = pageSlice(ps, requested);
    if (own) {
      await reply(`📋 Choose a product in category <b>${c?.name ?? ""}</b>:${pageLabel(page, pages)}`, kb(
        [btn("➕ Add position", `a:addc:${cid ?? 0}`), ...(cid ? [btn("🗑 Delete category", `a:cdel:${cid}`)] : [])],
        ...items.map((p) => [btn(`${p.name}${Number(p.nvars) ? "" : " – " + money(p.price)}`, `c:p:${p.id}`)]),
        ...pageNav(`c:cat:${cid ?? 0}`, page, pages),
        [btn("⬅️ Go back", "c:shop")]));
      return;
    }
    await reply(`${titlePrefix("📂", c?.name ?? "")}<b>${c?.name ?? ""}</b>\nChoose a product:${pageLabel(page, pages)}`, kb(...productButtons(items), ...pageNav(`c:cat:${cid ?? 0}`, page, pages), [btn("⬅️ Back", "c:shop")]));
    return;
  }
  if ((m = data.match(/^c:p:(\d+)(?::(\d+))?$/))) {
    const pid = Number(m[1]);
    const requested = Number(m[2] ?? 0);
    const p = await getProduct(db, bot.tenantId, pid);
    if (!p) return;
    const back = p.parent_id ? `c:p:${p.parent_id}` : p.category_id ? `c:cat:${p.category_id}` : "c:shop";
    if (own) {
      if (p.parent_id) return adminProduct(ctx, reply, pid);
      const vars = await variantsOf(db, bot.tenantId, pid);
      const { items, page, pages } = pageSlice(vars, requested);
      await reply(`📋 Choose a key type for <b>${p.name}</b>:${pageLabel(page, pages)}`, kb(
        [btn("➕ Add key type", `a:v:${pid}`), btn("🗑 Delete position", `a:del:${pid}`)],
        ...items.map((v) => [btn(`${v.name} – ${money(v.price)}`, `c:p:${v.id}`)]),
        ...pageNav(`c:p:${pid}`, page, pages),
        [btn("⬅️ Go back", back)]));
      return;
    }
    if (!p.parent_id && Number(p.nvars)) {
      const vars = await variantsOf(db, bot.tenantId, pid);
      const { items, page, pages } = pageSlice(vars, requested);
      await reply(`${p.name}\n${p.description ? "\n" + p.description + "\n" : ""}\n⏱ Choose a key type:${pageLabel(page, pages)}`, kb(
        ...items.map((v) => [btn(`${v.name} – ${pr(ctx, v)}${v.stock ? "" : " (out of stock)"}`, `c:p:${v.id}`)]),
        ...pageNav(`c:p:${pid}`, page, pages), [btn("⬅️ Back", back)]));
      return;
    }
    await reply(`${await fullName(db, bot.tenantId, p)}\n${p.description ? "\n" + p.description + "\n" : ""}\n💵 Price: <b>${pr(ctx, p)}</b>\n📦 In stock: ${p.stock}`,
      p.stock ? kb([btn("🛒 Buy one", `c:buy:${pid}`), btn("🛒 Buy multiple", `c:bm:${pid}`)], [btn("⬅️ Back", back)]) : kb([btn("⬅️ Back", back)]));
    return;
  }
  if ((m = data.match(/^c:buy:(\d+)$/))) return buy(ctx, reply, Number(m[1]), 1);
  if ((m = data.match(/^c:bm:(\d+)$/))) {
    ctx.session.step = { s: "buy_qty", pid: Number(m[1]) };
    await reply("🔢 How many keys? Send a number (e.g. 5).", kb([btn("✖️ Cancel", "x:cancel")], [btn("⬅️ Go back", `c:p:${m[1]}`)]));
    return;
  }
  if (data === "c:me") {
    const acc = await getAccount(ctx);
    await reply(`👤 <b>Your account:</b>\n- Username: <code>${escapeHtml(acc?.username ?? "")}</code>\n- Balance: <code>${money(acc?.balance ?? 0)}</code>`, kb(...(ctx.bot.isMain ? [[btn("💳 Add balance with Crypto", "pay:top")]] : []), [btn("📜 Purchase History", "c:orders")], [btn("⬅️ Go back", "c:home")]));
    return;
  }
  if ((m = data.match(/^c:orders(?::(\d+))?$/))) {
    const acc = await getAccount(ctx);
    if (!acc) return;
    return historyPage(ctx, reply, Number(m[1] ?? 0), "c:orders", acc.id);
  }
}

const productButtons = (ps: any[]) => ps.map((p) => [btn(p.name, `c:p:${p.id}`)]);

// ─── List pagination: 10 items per page with Previous/Next ───────────────────
const LIST_PER_PAGE = 10;
function pageSlice<T>(items: T[], requested: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / LIST_PER_PAGE));
  const page = Math.min(Math.max(0, requested || 0), pages - 1);
  return { items: items.slice(page * LIST_PER_PAGE, page * LIST_PER_PAGE + LIST_PER_PAGE), page, pages };
}
function pageNav(prefix: string, page: number, pages: number): any[][] {
  const nav: any[] = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `${prefix}:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `${prefix}:${page + 1}`));
  return nav.length ? [nav] : [];
}
const pageLabel = (page: number, pages: number) => (pages > 1 ? ` · Page ${page + 1}/${pages}` : "");

async function variantPrompt(ctx: Ctx, reply: (h: string, e?: any) => any, pid: number) {
  return ask(ctx, reply, { s: "add_vars", pid }, "⏱ Enter the duration (e.g. 1 Day, 7 Days):");
}

function keyPageButtons(report: { page: number; pages: number }, prefix: string, back: string) {
  const nav = [];
  if (report.page > 0) nav.push(btn("⬅️ Previous", `${prefix}:${report.page - 1}`));
  if (report.page + 1 < report.pages) nav.push(btn("Next ➡️", `${prefix}:${report.page + 1}`));
  return kb(...(nav.length ? [nav] : []), [btn("⬅️ Go back", back)]);
}
async function keysReport(db: any, tid: number, p: any, requested = 0) {
  const vars = Number(p.nvars) ? await variantsOf(db, tid, Number(p.id)) : [p];
  const ids = vars.map((v: any) => Number(v.id));
  const query = () => db.from("product_keys").select("id,product_id,key,sold", { count: "exact" }).in("product_id", ids);
  const counted = await query().limit(0);
  if (counted.error) throw counted.error;
  const pages = Math.max(1, Math.ceil((counted.count ?? 0) / 10));
  const page = Math.min(Math.max(0, requested), pages - 1);
  const { data: ks, error } = await query().order("id").range(page * 10, page * 10 + 9);
  if (error) throw error;
  const parent = p.parent_id ? await getProduct(db, tid, Number(p.parent_id)) : null;
  const lines = [
    `🔑 <b>Key inventory</b>`,
    `<b>${escapeHtml(plainLabel(parent?.name ?? p.name))}</b>${parent ? ` · ${escapeHtml(plainLabel(p.name))}` : ""}`,
    `${counted.count ?? 0} keys total · Page ${page + 1} of ${pages}`,
  ];
  for (const v of vars) {
    const variantKeys = (ks ?? []).filter((k: any) => Number(k.product_id) === Number(v.id));
    if (!variantKeys.length) continue;
    if (Number(p.nvars)) lines.push(`\n⏱ <b>${escapeHtml(plainLabel(v.name))}</b>`);
    const available = variantKeys.filter((k: any) => !k.sold);
    const sold = variantKeys.filter((k: any) => k.sold);
    if (available.length) {
      lines.push(`\n🟢 <b>Available</b> · ${available.length} on this page`);
      for (const k of available) lines.push(`<code>${escapeHtml(k.key)}</code>`);
    }
    if (sold.length) {
      lines.push(`\n✅ <b>Sold</b> · ${sold.length} on this page`);
      for (const k of sold) {
        const ownerName = parent?.name ?? p.name;
        const entryLabel = plainLabel(ownerName) === plainLabel(v.name)
          ? escapeHtml(plainLabel(v.name))
          : `${escapeHtml(plainLabel(ownerName))} — ${escapeHtml(plainLabel(v.name))}`;
        const order = await db.from("shop_orders").select("account_id,created_at,price").eq("tenant_id", tid).eq("product_id", k.product_id).eq("key", k.key).order("id", { ascending: false }).limit(1).maybeSingle();
        if (order.error) throw order.error;
        let detail = "\nSale details unavailable";
        if (order.data) {
          const account = await db.from("bot_accounts").select("username").eq("tenant_id", tid).eq("id", order.data.account_id).maybeSingle();
          if (account.error) throw account.error;
          detail = `\nBuyer: <b>${escapeHtml(account.data?.username ?? "Unavailable")}</b> · ${entryLabel} · Paid: <b>${money(order.data.price)}</b>\nDate: ${fmtDate(order.data.created_at)}`;
        }
        lines.push(`<code>${escapeHtml(k.key)}</code>${detail}\n`);
      }
    }
  }
  if (!ks?.length) lines.push("\nNo keys in this product yet.");
  return { lines, page, pages };
}

async function adminProduct(ctx: Ctx, reply: (h: string, e?: any) => any, pid: number) {
  ctx.session.step = null;
  const db = await getDb();
  const p = await getProduct(db, ctx.bot.tenantId, pid);
  if (!p) return;
  if (p.parent_id) {
    const parent = await getProduct(db, ctx.bot.tenantId, Number(p.parent_id));
    await reply(`${parent?.name ?? ""} — <b>${p.name}</b>\n\n💵 Price: <b>${money(p.price)}</b>\n🏷 Cost: <b>${money(p.cost)}</b>\n📦 Stock: ${p.stock}`, kb(
      [btn("🔑 Add keys", `a:k:${pid}`), btn("💵 Price", `a:sp:${pid}`), btn("🏷 Cost", `a:sc:${pid}`)],
      [btn("🗂 View keys", `a:vk:${pid}`)],
      [btn("✏️ Name", `a:sn:${pid}`), btn("🗑 Delete", `a:del:${pid}`)], [btn("⬅️ Go back", `c:p:${p.parent_id}`)]));
    return;
  }
  const { data: cat } = p.category_id ? await db.from("categories").select("name").eq("id", p.category_id).maybeSingle() : { data: null };
  const vars = await variantsOf(db, ctx.bot.tenantId, pid);
  const head = `${p.name}\n${titlePrefix("📂", cat ? cat.name : "No category")}${cat ? cat.name : "No category"}\n${p.description ? p.description + "\n" : ""}`;
  if (vars.length) {
    await reply(head + `\n⏱ ${vars.length} variant(s) · 📦 total stock ${p.stock}\nTap a variant to add keys / change price:`, kb(
      ...vars.map((v) => [btn(`${v.name} · ${money(v.price)} · stock ${v.stock}`, `a:p:${v.id}`)]),
      [btn("➕ Add variants", `a:v:${pid}`), btn("📂 Category", `a:pc:${pid}`)],
      [btn("🗂 View keys", `a:vk:${pid}`)],
      [btn("✏️ Name", `a:sn:${pid}`), btn("📝 Description", `a:sd:${pid}`)],
      [btn("🗑 Delete product", `a:del:${pid}`), btn("⬅️ Products", "a:list")]));
  } else {
    await reply(head + `\n💵 Price: <b>${money(p.price)}</b>\n🏷 Cost: <b>${money(p.cost)}</b>\n📦 Stock: ${p.stock}\n\nNo variants yet — add 1 Day / 7 Days / 30 Days… with ➕ Add variants.`, kb(
      [btn("➕ Add variants", `a:v:${pid}`)],
      [btn("🔑 Add keys", `a:k:${pid}`), btn("💵 Price", `a:sp:${pid}`), btn("🏷 Cost", `a:sc:${pid}`)],
      [btn("🗂 View keys", `a:vk:${pid}`)],
      [btn("✏️ Name", `a:sn:${pid}`), btn("📝 Description", `a:sd:${pid}`), btn("📂 Category", `a:pc:${pid}`)],
      [btn("🗑 Delete product", `a:del:${pid}`), btn("⬅️ Products", "a:list")]));
  }
}

async function stockSelectionLabel(db: any, tenantId: number, p: any): Promise<string> {
  const parent = p.parent_id ? await getProduct(db, tenantId, Number(p.parent_id)) : null;
  return `📝 Product: <b>${parent?.name ?? p.name}</b>${parent ? `\n⏱ Duration: <b>${p.name}</b>` : ""}`;
}

async function stockKeyPrompt(ctx: Ctx, reply: (h: string, e?: any) => any, pid: number) {
  const db = await getDb();
  const p = await getProduct(db, ctx.bot.tenantId, pid);
  if (!p || p.nvars) { ctx.session.step = null; return stockView(ctx, reply); }
  return ask(ctx, reply, { s: "stock_keys", pid },
    `➕ <b>Add stock</b>\n\n${await stockSelectionLabel(db, ctx.bot.tenantId, p)}\n📦 Available: <b>${p.stock}</b>\n\n📝 Send keys, one per line:\n\n<code>DEMO-KEY1</code>\n\n<code>DEMO-KEY2</code>`,
    kb([btn("⬅️ Back", p.parent_id ? `a:stockprod:${p.parent_id}` : "a:stockadd"), btn("✖️ Cancel", "a:stock")]));
}

async function stockView(ctx: Ctx, reply: (h: string, e?: any) => any, requested = 0) {
  ctx.session.step = null;
  const db = await getDb();
  const ps = await topProducts(db, ctx.bot.tenantId, "all");
  if (!ps.length) { await reply("📦 No products yet.", kb([btn("➕ Add product", "a:add")], [btn("⬅️ Back", "a:home")])); return; }
  const inStock = ps.filter((p) => Number(p.stock) > 0).length;
  const { items, page, pages } = pageSlice(ps, requested);
  let out = `📦 <b>Current stock [${inStock}/${ps.length}]:</b>${pageLabel(page, pages)}\n`;
  for (const p of items) {
    const vars = await variantsOf(db, ctx.bot.tenantId, Number(p.id));
    if (vars.length) {
      out += `\n${titlePrefix("🛒", p.name)}<b>${p.name}</b>\n` + vars.map((v) => `· ${v.name}: <b>${v.stock}</b>${Number(v.stock) ? "" : " ❌"}`).join("\n") + "\n";
    } else {
      out += `\n${titlePrefix("🛒", p.name)}<b>${p.name}</b>: <b>${p.stock}</b>${Number(p.stock) ? "" : " ❌"}\n`;
    }
  }
  await reply(out, kb([btn("➕ Add stock", "a:stockadd")], ...pageNav("a:stock", page, pages), [btn("⬅️ Back", "a:home")]));
}

const USERS_PER_PAGE = 10;
function fmtDay(v: any): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
/** Admin: every logged-in user (10 per page) with login date and bot subscription details. */
async function usersPage(ctx: Ctx, reply: (h: string, e?: any) => any, requested: number) {
  const db = await getDb();
  const tid = ctx.bot.tenantId;
  const { count } = await db.from("bot_accounts").select("id", { count: "exact", head: true }).eq("tenant_id", tid).not("tg_id", "is", null);
  const total = Number(count ?? 0);
  const pages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
  const page = Math.max(0, Math.min(requested, pages - 1));
  const back = [btn("⬅️ Go back", "a:home")];
  if (!total) { await reply("👥 <b>Logged-in users</b>\n\nNo users have logged in yet.", kb(back)); return; }
  const { data: rows } = await db.from("bot_accounts").select("*").eq("tenant_id", tid).not("tg_id", "is", null)
    .order("last_login_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false })
    .range(page * USERS_PER_PAGE, page * USERS_PER_PAGE + USERS_PER_PAGE - 1);
  const ids = (rows ?? []).map((r: any) => r.id);
  // Old accounts can be repaired without asking each customer to log in again.
  // Only the ten visible rows are queried, through their own shop's bot token.
  await Promise.all((rows ?? []).map(async (u: any) => {
    if (u.tg_name || !u.tg_id) return;
    try {
      const profile = await tgCall(ctx.bot.token, "getChat", { chat_id: Number(u.tg_id) });
      if (Number(profile?.id) !== Number(u.tg_id) || profile?.type !== "private") return;
      const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      if (!name) return;
      const fields = { tg_name: name, tg_username: profile.username || null };
      const { error } = await db.from("bot_accounts").update(fields).eq("id", u.id).eq("tenant_id", tid).eq("tg_id", u.tg_id);
      if (!error) Object.assign(u, fields);
    } catch { /* A blocked/unavailable chat must not hide the remaining users. */ }
  }));
  // Bot subscriptions only exist in the main bot (resellers buy them there).
  const subs = new Map<number, any>();
  const paid = new Map<number, string>();
  if (ctx.bot.isMain && ids.length) {
    const { data: tb } = await db.from("tenant_bots").select("id, owner_account_id, bot_username, expires_at, status, created_at").in("owner_account_id", ids);
    for (const t of tb ?? []) subs.set(Number(t.owner_account_id), t);
    const tids = (tb ?? []).map((t: any) => t.id);
    if (tids.length) {
      const { data: pays } = await db.from("tenant_bot_payments").select("tenant_id, created_at").in("tenant_id", tids).order("created_at", { ascending: false });
      for (const p of pays ?? []) if (!paid.has(Number(p.tenant_id))) paid.set(Number(p.tenant_id), p.created_at);
    }
  }
  const now = Date.now();
  const blocks = (rows ?? []).map((u: any, i: number) => {
    const n = page * USERS_PER_PAGE + i + 1;
    const lines = [
      `<b>${n}.</b> 👤 Username: <b>${escapeHtml(u.username)}</b>`,
      `   🏷 Name: ${escapeHtml(u.tg_name || "Unavailable")}`,
      `   👤 Telegram: ${u.tg_username ? `@${escapeHtml(String(u.tg_username).replace(/^@/, ""))}` : "No public username"}`,
      `   🔐 Login: ${fmtDay(u.last_login_at ?? u.created_at)}`,
    ];
    const t = subs.get(Number(u.id));
    if (t) {
      const exp = new Date(t.expires_at).getTime();
      const left = Math.ceil((exp - now) / 86400000);
      const state = t.status === "disabled" ? "🔴 Disabled" : exp <= now || t.status === "expired" ? "⛔️ Expired" : `🟢 Active · ${left} day${left === 1 ? "" : "s"} left`;
      lines.push(`   🤖 Subscription: ${t.bot_username ? `@${escapeHtml(t.bot_username)} · ` : ""}${state}`);
      lines.push(`   📅 Bought: ${fmtDay(paid.get(Number(t.id)) ?? t.created_at)} · Expires: ${fmtDay(t.expires_at)}`);
    } else if (ctx.bot.isMain) {
      lines.push("   🤖 Subscription: —");
    }
    return lines.join("\n");
  });
  const nav: any[] = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `a:users:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `a:users:${page + 1}`));
  await reply(`👥 <b>Logged-in users</b> · ${total}\n📄 Page ${page + 1}/${pages}\n\n${blocks.join("\n\n")}`,
    kb(...(nav.length ? [nav] : []), back));
}

async function balPicker(ctx: Ctx, reply: (h: string, e?: any) => any, page: number) {
  const db = await getDb();
  const per = 10;
  const { data: cs, count } = await db.from("bot_accounts").select("id, username, balance", { count: "exact" })
    .eq("tenant_id", ctx.bot.tenantId).order("id", { ascending: false }).range(page * per, page * per + per - 1);
  const total = count ?? cs?.length ?? 0;
  const back = [btn("⬅️ Go back", "a:home")];
  if (!cs?.length) { await reply("👥 No users yet.", kb(back)); return; }
  const pages = Math.max(1, Math.ceil(total / per));
  const rows = cs.map((c: any) => [btn(`${plainLabel(c.username)} · ${money(c.balance)}`, `a:mt:${c.id}`)]);
  const nav: any[] = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `a:bal:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `a:bal:${page + 1}`));
  await reply(`💰 <b>Add balance</b> · ${total} users\n📄 Page ${page + 1}/${pages}\n\nTap a user to top up:`,
    { ...kb(...rows, ...(nav.length ? [nav] : []), back), noButtonColors: true });
}

async function manageList(ctx: Ctx, reply: (h: string, e?: any) => any, requested = 0, custom = false) {
  const db = await getDb();
  const prefix = custom ? "a:cpu" : "a:accs";
  const query = () => db.from("bot_accounts").select("id,username,balance", { count: "exact" }).eq("tenant_id", ctx.bot.tenantId);
  const counted = await query().limit(0);
  if (counted.error) throw counted.error;
  const pages = Math.max(1, Math.ceil((counted.count ?? 0) / 10));
  const page = Math.min(Math.max(0, requested), pages - 1);
  const { data: cs, error } = await query().order("balance", { ascending: false }).order("id").range(page * 10, page * 10 + 9);
  if (error) throw error;
  if (!cs?.length) { await reply("👥 No accounts yet.", kb(...(ctx.bot.isMain ? [] : [[btn("👤 Add account", "a:acc")]]), [btn("⬅️ Back", "a:home")])); return; }
  const rows: any[][] = cs.map((c: any) => [btn(custom ? plainLabel(c.username) : `${plainLabel(c.username)} (${money(c.balance)})`, custom ? `a:cp:${c.id}` : `a:m:${c.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn("⬅️ Previous", `${prefix}:${page - 1}`));
  if (page + 1 < pages) nav.push(btn("Next ➡️", `${prefix}:${page + 1}`));
  await reply(`${custom ? "💲 <b>Custom prices</b>\nChoose an account to set special prices:" : "👤 <b>Choose account to manage:</b>"}\nPage ${page + 1}/${pages}`, { ...kb(...(ctx.bot.isMain || custom ? [] : [[btn("➕ Add account", "a:acc")]]), ...rows, ...(nav.length ? [nav] : []), [btn("⬅️ Go back", custom ? "a:home" : "a:manage")]), noButtonColors: true });
}

async function ownerShop(ctx: Ctx, reply: (h: string, e?: any) => any, requested = 0) {
  const db = await getDb();
  const cs = await categories(db, ctx.bot.tenantId);
  const loose = await topProducts(db, ctx.bot.tenantId, null);
  const entries: any[][] = [
    ...cs.map((c) => [btn(c.name, `c:cat:${c.id}`)]),
    ...(loose.length ? [[btn("📄 Other", "c:cat:0")]] : []),
  ];
  const { items, page, pages } = pageSlice(entries, requested);
  await reply(`📋 Choose a category:${pageLabel(page, pages)}`, kb([btn("➕ Add category", "a:catnew:list")],
    ...items, ...pageNav("c:shop", page, pages), [btn("⬅️ Go back", "a:home")]));
}

async function shopCustomer(ctx: Ctx, reply: (h: string, e?: any) => any, requested = 0) {
  if (!ctx.session.accountId) {
    ctx.session.step = { s: "login_user" };
    await reply("🔐 Please log in first.\nSend your <b>username</b>:", kb([btn("✖️ Cancel", "x:cancel")]));
    return;
  }
  const db = await getDb();
  const cs = (await categories(db, ctx.bot.tenantId)).filter((c) => Number(c.n) > 0);
  const loose = await topProducts(db, ctx.bot.tenantId, null);
  if (!cs.length && !loose.length) { await reply("🛍 No products yet.", kb([btn("⬅️ Back", "c:home")])); return; }
  if (!cs.length) {
    const { items, page, pages } = pageSlice(loose, requested);
    await reply(`🛍 <b>Choose a product</b>${pageLabel(page, pages)}`, kb(...productButtons(items), ...pageNav("c:shop", page, pages), [btn("⬅️ Back", "c:home")]));
    return;
  }
  const entries: any[][] = [
    ...cs.map((c) => [btn(c.name, `c:cat:${c.id}`)]),
    ...(loose.length ? [[btn("📄 Other", "c:cat:0")]] : []),
  ];
  const { items, page, pages } = pageSlice(entries, requested);
  await reply(`📂 <b>Choose a category</b>${pageLabel(page, pages)}`, kb(...items, ...pageNav("c:shop", page, pages), [btn("⬅️ Back", "c:home")]));
}

// ─── Purchase (atomic via Postgres function) ─────────────────────────────────

async function buy(ctx: Ctx, reply: (h: string, e?: any) => any, pid: number, qty: number) {
  const db = await getDb();
  const acc = await getAccount(ctx);
  if (!acc) {
    ctx.session.step = { s: "login_user" };
    await reply("🔐 Please log in first.\nSend your <b>username</b>:", kb([btn("✖️ Cancel", "x:cancel")]));
    return;
  }
  // A failed purchase returns to the bought product's duration list (its parent when a variant was bought).
  const { data: bought } = await db.from("products").select("parent_id").eq("id", pid).eq("tenant_id", ctx.bot.tenantId).maybeSingle();
  const backTo = bought?.parent_id ? `c:p:${bought.parent_id}` : `c:p:${pid}`;
  const { data, error } = await db.rpc("buy_keys_once", { p_tenant: ctx.bot.tenantId, p_account: acc.id, p_product: pid, p_qty: qty, p_request: ctx.requestId });
  if (error) {
    if (ctx.bot.durable && !/STOCK:/.test(error.message ?? "")) throw error;
    const stockMatch = /STOCK:(\d+)/.exec(error.message ?? "");
    const errTxt = stockMatch ? (Number(stockMatch[1]) ? `Only ${stockMatch[1]} in stock.` : "Out of stock.") : "Purchase failed. Please try again.";
    await reply("❌ " + errTxt, kb([btn("⬅️ Back", backTo)]));
    return;
  }
  if (!data) throw new Error("Missing purchase response");
  const res = data as any;
  if (res?.err) { await reply("❌ " + res.err, kb([btn("⬅️ Back", backTo)])); return; }
  const header = `✅ <b>Purchase completed</b>\n` +
    `🔑 You bought <b>${escapeHtml(plainLabel(res.label))}</b> · Quantity: <b>${qty}</b>\n\n`;
  const footer = `\n\n💬 New balance: <b>${money(res.balance)}</b>`;
  const keys = (res.keys as string[]).map((key) => `Key: <code>${escapeHtml(key)}</code>`);
  const receipts: string[] = [];
  let receipt = header;
  let entries = 0;
  // Preserve complete, individually copyable keys when a large purchase
  // needs multiple Telegram messages; ordinary purchases use one receipt.
  for (const key of keys) {
    const separator = entries ? "\n" : "";
    if (entries && receipt.length + separator.length + key.length + footer.length > 3800) {
      receipts.push(receipt);
      receipt = "";
      entries = 0;
    }
    receipt += (entries ? "\n" : "") + key;
    entries++;
  }
  receipts.push(receipt + footer);
  const navigation = kb(
    [btn("🧾 Order history", "c:orders"), btn("🏠 Menu", "c:home")]);
  for (let index = 0; index < receipts.length; index++) {
    const message = receipts[index];
    if (message === undefined) continue;
    await deliver(ctx.bot, ctx.chatId, translateHtml(themeHtml(message, ctx.emoji), ctx.lang), {}, `receipt:${ctx.bot.tenantId}:${ctx.requestId}:${index}`);
  }
  await deliver(ctx.bot, ctx.chatId, translateHtml(themeHtml("🧾 <b>Order history</b> · 🏠 <b>Menu</b>", ctx.emoji), ctx.lang), themeExtra(translateExtra(navigation, ctx.lang), ctx.emoji), `receipt-navigation:${ctx.bot.tenantId}:${ctx.requestId}`);
  const owner = ctx.bot.isMain ? ctx.bot.adminTgIds[0] : ctx.bot.ownerTgId;
  if (owner && owner !== ctx.tgId) await sendHtml(ctx.bot.token, owner, `🛒 New order: ${escapeHtml(res.label)} × ${qty} — ${money(res.total)} by ${escapeHtml(acc.username)}`).catch(() => {});
}

// ─── My Own Bot subscription (main bot) ──────────────────────────────────────

/** True when this account never had a bot and never used its free trial. */
async function trialAvailable(ctx: Ctx): Promise<boolean> {
  if (!ctx.bot.isMain || !ctx.session.accountId) return false;
  const db = await getDb();
  const [tr, cr] = await Promise.all([
    db.from("tenant_bots").select("id, status, expires_at").eq("owner_account_id", ctx.session.accountId).maybeSingle(),
    db.from("trial_claims_acc").select("account_id").eq("account_id", ctx.session.accountId).maybeSingle(),
  ]);
  if (tr.error || cr.error) return false; // fail closed
  const t = tr.data;
  const active = t && t.status === "active" && new Date(t.expires_at) > new Date();
  return !cr.data && !active;
}

/** Free-trial offer shown on /start; the 3 days start only when the bot token is connected. */
async function trialInvite(ctx: Ctx, reply: (h: string, e?: any) => any) {
  if (ctx.isBoss || !(await trialAvailable(ctx))) return;
  const custom = await getSetting(ctx.bot, "trial_text");
  const msg = custom
    ? custom.replaceAll("{days}", String(TRIAL_DAYS)).replaceAll("{date}", "")
    : `🎁 <b>${TRIAL_DAYS}-Day Free Trial — on us!</b>\n\nLaunch your own Telegram shop bot free for ${TRIAL_DAYS} days.\n\n✅ Full access to every feature\n⏳ Your ${TRIAL_DAYS} days start only when you connect your bot\n🚫 No payment needed to begin\n\nTap the button below, create a bot in @BotFather and send its token here.`;
  await reply(msg, kb([btn(`🎁 Start ${TRIAL_DAYS}-day free trial`, "tsub:trial")]));
}

async function showMyBot(ctx: Ctx, reply: (h: string, e?: any) => any) {
  const db = await getDb();
  if (!ctx.session.accountId) {
    ctx.session.step = { s: "login_user" };
    await reply("🔐 Please log in first, then tap " + MY_BOT_LABEL + " again.\nSend your <b>username</b>:", kb([btn("✖️ Cancel", "x:cancel")]));
    return;
  }
  const price = await getPrice(ctx.bot);
  const days = await getDays(ctx.bot);
  const { data: t } = await db.from("tenant_bots").select("*").eq("owner_account_id", ctx.session.accountId).maybeSingle();
  const active = t && t.status === "active" && new Date(t.expires_at) > new Date();
  if (!t) {
    await reply(
      `🤖 <b>Make your own bot</b>\n\nLaunch your own reseller bot in minutes — you are the admin:\n• Add products, set prices & costs\n• Load stock keys and sell instantly\n• Manage accounts & balances\n• Track orders & profit, broadcast to resellers\n• Premium emoji supported automatically\n\n💵 Price: <b>${money(price)}</b> / ${days} days (paid from your balance)`,
      kb(...((await trialAvailable(ctx)) ? [[btn(`🎁 Start ${TRIAL_DAYS}-day free trial`, "tsub:trial")]] : []), [btn(`🚀 Make my bot — ${money(price)}`, "tsub:buy")], [btn("⬅️ Go back", "c:home")]));
    return;
  }
  const { data: paid } = await db.from("tenant_bot_payments").select("id").eq("tenant_id", t.id).neq("note", "trial").limit(1);
  const trial = !(paid ?? []).length;
  const left = Math.max(0, Math.ceil((new Date(t.expires_at).getTime() - Date.now()) / 86400000));
  const rows: any[][] = [[btn(`🔄 Renew +${days} days — ${money(price)}`, "tsub:buy")]];
  if (active) rows.push([btn(t.token ? "🔑 Change bot token" : "🔑 Send bot token", "tsub:token")]);
  rows.push([btn("⬅️ Go back", "c:home")]);
  await reply(
    `🤖 <b>Your own bot</b>\n\nStatus: ${active ? (trial ? `🎁 Free trial — ${left} day${left === 1 ? "" : "s"} left` : "✅ Active") : (trial ? `⛔️ Free trial ended — renew for ${days} days to keep your bot running` : "⛔️ Expired")}\nBot: ${t.bot_username ? "@" + escapeHtml(t.bot_username) : "— (token not added yet)"}\nValid until: <b>${fmtDate(t.expires_at)}</b>`,
    kb(...rows));
}

async function handleSubscription(ctx: Ctx, reply: (h: string, e?: any) => any, data: string) {
  const db = await getDb();
  const price = await getPrice(ctx.bot);
  const days = await getDays(ctx.bot);
  if (data === "tsub:no") { await reply("Cancelled."); return; }
  if (data === "tsub:crypto" || data === "tsub:crypto:bep20" || data === "tsub:crypto:trc20") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    if (await showOpenPayment(ctx, reply)) return;
    return startCryptoPayment(ctx, reply, "sub", price, data.endsWith("trc20") ? "trc20" : "bep20");
  }
  if (data === "tsub:cancel") { ctx.session.step = null; return showMyBot(ctx, reply); }
  if (data === "tsub:token") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    const { data: cur } = await db.from("tenant_bots").select("token").eq("owner_account_id", ctx.session.accountId).maybeSingle();
    const freeLeft = cur?.token && !(await getSetting(ctx.bot, `free_token_change_${ctx.session.accountId}`));
    if (freeLeft) {
      // One free change: no warning and no 24h wait; later changes show the warning.
      ctx.session.step = { s: "await_token" };
      await reply(`🔑 <b>Change bot token</b>\nYou have <b>1 free change</b>. Your shop catalog will start fresh on the new bot.\n\n` + tokenHelp(), kb([btn("❌ Cancel", "tsub:cancel")]));
      return;
    }
    if (cur?.token) {
      await reply(`⚠️ <b>Change bot token?</b>\n\nIf you continue:\n• All categories, products, durations and keys in your shop will be <b>deleted</b>.\n• Your new bot starts with an empty shop.\n• Your accounts, settings, emoji and colors stay.\n• You can change the token only <b>once every 24 hours</b>.\n\nDo you want to continue?`,
        kb([btn("✅ Continue", "tsub:token_go")], [btn("❌ Cancel", "tsub:cancel")]));
      return;
    }
    data = "tsub:token_go";
  }
  if (data === "tsub:trial") {
    if (!(await trialAvailable(ctx))) { await reply("ℹ️ Your free trial was already used. You can subscribe below.", kb([btn(`🚀 Make my bot — ${money(price)}`, "tsub:buy")])); return; }
    const { data: cur } = await db.from("tenant_bots").select("token, bot_username").eq("owner_account_id", ctx.session.accountId!).maybeSingle();
    if (cur?.token) {
      // Bot already connected: the trial starts right now.
      const { data: tr } = await db.rpc("claim_trial", { p_account: ctx.session.accountId!, p_tg: ctx.tgId, p_days: TRIAL_DAYS });
      if (!tr?.ok) { await reply("ℹ️ Your free trial was already used.", kb([btn(`🚀 Make my bot — ${money(price)}`, "tsub:buy")])); return; }
      await reply(`🎁 <b>You got a ${TRIAL_DAYS}-day free trial subscription!</b>\n\nYour bot${cur.bot_username ? " @" + escapeHtml(cur.bot_username) : ""} is active again.\nTrial ends: <b>${fmtDate(tr.expires_at)}</b>`, kb([btn("⬅️ My Own Bot", "tsub:cancel")]));
      return;
    }
    ctx.session.trialPending = true;
    ctx.session.step = { s: "await_token" };
    await reply(`🎁 <b>Start your ${TRIAL_DAYS}-day free trial</b>\n\nYour trial begins the moment your bot is connected.\n\n` + tokenHelp(), kb([btn("❌ Cancel", "tsub:cancel")]));
    return;
  }
  if (data === "tsub:token_go") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    const wait = await tokenCooldown(db, ctx.session.accountId);
    if (wait > 0) { await reply(`⏳ You can change the bot token once every 24 hours.\nTry again in <b>${Math.ceil(wait / 3600000)}h</b>.`); return; }
    ctx.session.step = { s: "await_token" };
    await reply(tokenHelp(), kb([btn("❌ Cancel", "tsub:cancel")]));
    return;
  }
  if (data === "tsub:buy") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    const nets = await availableNetworks();
    const payRows = (nets.length ? nets : ["bep20"] as Network[]).map(n => [btn(`💳 Pay with USDT (${NETWORK_LABEL[n]})`, `tsub:crypto:${n}`)]);
    await reply(`Pay <b>${money(price)}</b> for ${days} days?`,
      kb([btn(`✅ Pay from balance — ${money(price)}`, "tsub:pay")], ...payRows, [btn("❌ Cancel", "tsub:no")]));
    return;
  }
  if (data === "tsub:pay") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    const { data: res, error } = await db.rpc("buy_subscription_once", { p_account: ctx.session.accountId, p_tg: ctx.tgId, p_price: price, p_days: days, p_request: ctx.requestId });
    if (error || !res) { if (ctx.bot.durable) throw error ?? new Error("Missing subscription response"); await reply("⚠️ Could not confirm payment. Please try again."); return; }
    if ((res as any).err) {
      await reply(`❌ Not enough balance. You have <b>${money((res as any).balance)}</b>, need <b>${money(price)}</b>. Please top up first.`);
      return;
    }
    const t = res as any;
    await reply(`✅ Paid <b>${money(price)}</b>. Subscription valid until <b>${fmtDate(t.expires_at)}</b>.\nNew balance: ${money(t.balance)}`);
    if (t.token) {
      await reply(`Your bot @${escapeHtml(t.bot_username ?? "")} is active again.`);
    } else {
      ctx.session.step = { s: "await_token" };
      await reply(tokenHelp());
    }
    await affiliateNotice(ctx.bot, t.affiliate, `wallet:${ctx.requestId}`);
    for (const adminId of ctx.bot.adminTgIds) {
      await sendHtml(ctx.bot.token, adminId, `💰 Bot subscription: <b>${escapeHtml(ctx.session.username ?? String(ctx.session.accountId))}</b> paid ${money(price)} (tenant #${t.id}).`).catch(() => {});
    }
    return;
  }
}

// ─── Crypto payments (BEP20 USDT, main bot only) ─────────────────────────────

// Order spam guard: cancelling 4 orders in one day blocks new orders for 12h.
const MAX_DAILY_CANCELS = 4;
const ORDER_BLOCK_MS = 12 * 3600 * 1000;

/** Minutes left on the account's order block (0 = not blocked). */
async function orderBlockMinutes(db: any, accountId: number): Promise<number> {
  const { data, error } = await db.from("bot_order_guards").select("blocked_until").eq("account_id", accountId).maybeSingle();
  if (error) throw error;
  if (!data?.blocked_until) return 0;
  const ms = new Date(data.blocked_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

function orderBlockText(waitMin: number): string {
  const h = Math.floor(waitMin / 60);
  const m = waitMin % 60;
  const left = h > 0 ? `${h}h ${m}min` : `${m}min`;
  return `⛔️ <b>Too many cancelled orders.</b>\n\nYou cancelled ${MAX_DAILY_CANCELS} orders today, so new orders are blocked for <b>${left}</b>. Please try again after that.`;
}

/** Stop payment entry before pending invoice reuse or network/amount prompts. */
async function showOrderBlock(ctx: Ctx, reply: (h: string, e?: any) => any): Promise<boolean> {
  if (!ctx.session.accountId) return false;
  const wait = await orderBlockMinutes(await getDb(), ctx.session.accountId);
  if (wait <= 0) return false;
  ctx.session.step = null;
  await reply(orderBlockText(wait), kb([btn("🏠 Menu", "c:home")]));
  return true;
}

/** Records one cancelled order. Returns the day's cancel count and whether
 *  this cancel just triggered the 12-hour block. */
async function registerOrderCancel(db: any, accountId: number): Promise<{ count: number; blocked: boolean }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("bot_order_guards").select("*").eq("account_id", accountId).maybeSingle();
  let count = data && data.cancel_day === today ? Number(data.cancel_count) + 1 : 1;
  let blockedUntil: string | null = data?.blocked_until ?? null;
  let blocked = false;
  if (count >= MAX_DAILY_CANCELS) {
    blockedUntil = new Date(Date.now() + ORDER_BLOCK_MS).toISOString();
    count = 0;
    blocked = true;
  }
  const { error } = await db.from("bot_order_guards").upsert({ account_id: accountId, cancel_day: today, cancel_count: count, blocked_until: blockedUntil }, { onConflict: "account_id" });
  if (error) throw error;
  return { count, blocked };
}

/** Remaining minutes for a pending payment (never below 1). */
function paymentMinutesLeft(createdAt: string): number {
  return Math.max(1, Math.ceil((new Date(createdAt).getTime() + PAYMENT_TTL_MS - Date.now()) / 60000));
}

function paymentKb(id: number, wallet?: string, amount?: number): any {
  const rows: any[][] = [[btn("✅ I've paid", `pay:check:${id}`)]];
  // Native Telegram copy buttons — one tap copies to the clipboard.
  if (wallet && wallet !== "—") {
    rows.push([
      ...(amount != null ? [copyBtn("📋 Copy amount", amount.toFixed(2))] : []),
      copyBtn("📋 Copy address", wallet),
    ]);
  }
  rows.push([btn("🔄 Refresh", `pay:refresh:${id}`), btn("❌ Cancel", `pay:cancel:${id}`)]);
  return kb(...rows);
}

/** If the account already has an open invoice, show it again instead of
 *  allowing a new one (anti-spam: one invoice per user for 20 minutes). */
async function showOpenPayment(ctx: Ctx, reply: (h: string, e?: any) => any): Promise<boolean> {
  if (!ctx.session.accountId) return false;
  if (await showOrderBlock(ctx, reply)) return true;
  const p = await openPayment(ctx.session.accountId);
  if (!p) return false;
  const net = ((p as any).network ?? "bep20") as Network;
  const wallet = await getWallet(net);
  const left = paymentMinutesLeft(p.created_at);
  ctx.session.step = null;
  await reply(`⏳ <b>You already have a pending payment.</b>\nPlease complete it first — a new order can be created after it is paid or expires in <b>${left} min</b>.\n\n` + paymentText(p, wallet ?? "—", net, left), paymentKb(p.id, wallet ?? "—", p.amount));
  return true;
}

async function startCryptoPayment(ctx: Ctx, reply: (h: string, e?: any) => any, kind: "topup" | "sub", baseAmount: number, net: Network = "bep20") {
  const accountId = ctx.session.accountId;
  if (!accountId) { ctx.session.step = null; await reply("🔐 Please log in first."); return; }
  if (await showOpenPayment(ctx, reply)) return;
  const wallet = await getWallet(net);
  if (!wallet) { await reply(`⚠️ USDT (${NETWORK_LABEL[net]}) payments are not available yet. Please ask the admin.`); return; }
  const p = await createPayment(accountId, ctx.tgId, kind, baseAmount, net);
  if (!p) {
    if (await showOrderBlock(ctx, reply)) return;
    await reply("⚠️ Could not create the payment. Please try again."); return;
  }
  await reply(paymentText(p, wallet, net, paymentMinutesLeft(p.created_at)), paymentKb(p.id, wallet, p.amount));
}

function paymentText(p: CryptoPayment, wallet: string, net: Network = "bep20", minutesLeft?: number): string {
  const L = NETWORK_LABEL[net];
  return `💳 <b>Pay with USDT (${L})</b>\n\n` +
    `Send <b>exactly</b> this amount:\n<code>${p.amount.toFixed(2)}</code> USDT\n\n` +
    `To this address (${NETWORK_CHAIN[net]}) — tap to copy:\n<code>${escapeHtml(wallet)}</code>\n\n` +
    `⚠️ Send only <b>USDT on ${L}</b> — any other network or token is lost forever.\n` +
    `The exact amount (with the cents) identifies your payment.\n\n` +
    `✅ Your payment is verified automatically within a minute — no need to send any proof.` +
    (minutesLeft ? `\n\n⏳ This order expires in <b>${minutesLeft} min</b>. You cannot create a new order until it is paid or expired.` : "");
}

async function handleCryptoPay(ctx: Ctx, reply: (h: string, e?: any) => any, data: string) {
  const db = await getDb();
  let m: RegExpMatchArray | null;
  if (data === "pay:top") {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    if (await showOpenPayment(ctx, reply)) return;
    const nets = await availableNetworks();
    if (!nets.length) { await reply("⚠️ Crypto payments are not available yet. Please ask the admin."); return; }
    if (nets.length === 1) return ask(ctx, reply, { s: "pay_amount", net: nets[0] }, `💳 How much do you want to add via USDT (${NETWORK_LABEL[nets[0]]})? Send the amount in $ (e.g. 50):`);
    await reply("💳 <b>Add balance</b>\n\nChoose the USDT network:", kb(...nets.map(n => [btn(`USDT (${NETWORK_LABEL[n]})`, `pay:top:${n}`)]), [btn("❌ Cancel", "x:cancel")]));
    return;
  }
  if ((m = data.match(/^pay:top:(bep20|trc20)$/))) {
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    if (await showOpenPayment(ctx, reply)) return;
    const net = m[1] as Network;
    if (!(await getWallet(net))) { await reply("⚠️ This network is not available yet. Please ask the admin."); return; }
    return ask(ctx, reply, { s: "pay_amount", net }, `💳 How much do you want to add via USDT (${NETWORK_LABEL[net]})? Send the amount in $ (e.g. 50):`);
  }
  if ((m = data.match(/^pay:cancel:(\d+)$/))) {
    // Anti-spam: the invoice stays open until paid or expired (20 min), so
    // cancelling cannot be used to create order after order. Cancelling 4
    // orders in one day blocks new orders for 12 hours.
    ctx.session.step = null;
    if (!ctx.session.accountId) { await reply("🔐 Please log in first."); return; }
    const guard = await registerOrderCancel(db, ctx.session.accountId);
    if (guard.blocked) { await reply(orderBlockText(ORDER_BLOCK_MS / 60000)); return; }
    await reply(
      `ℹ️ This order stays open for 20 minutes. If you send the exact amount it is still credited; otherwise it expires automatically and you can create a new one.\n\n⚠️ Cancelled orders today: <b>${guard.count}/${MAX_DAILY_CANCELS}</b> — after ${MAX_DAILY_CANCELS} cancels, new orders are blocked for 12 hours.`,
      kb([btn("🏠 Menu", "c:home")]));
    return;
  }
  if ((m = data.match(/^pay:refresh:(\d+)$/))) {
    const id = Number(m[1]);
    const { data: p } = await db.from("crypto_payments").select("*").eq("id", id).maybeSingle();
    if (!p || p.account_id !== ctx.session.accountId) { await reply("❌ Payment not found."); return; }
    if (await showOrderBlock(ctx, reply)) return;
    if (p.status !== "pending") { await reply(p.status === "paid" ? "✅ Payment confirmed!" : "⌛ This payment has expired. Please start a new one."); return; }
    const net = (p.network ?? "bep20") as Network;
    const wallet = await getWallet(net);
    await reply(paymentText(p, wallet ?? "—", net, paymentMinutesLeft(p.created_at)), paymentKb(p.id, wallet ?? "—", p.amount));
    return;
  }
  if ((m = data.match(/^pay:check:(\d+)$/))) {
    const id = Number(m[1]);
    const { data: p } = await db.from("crypto_payments").select("account_id").eq("id", id).maybeSingle();
    if (!p || p.account_id !== ctx.session.accountId) { await reply("❌ Payment not found."); return; }
    const status = await checkPayment(id);
    if (status === "paid") await reply("✅ Payment confirmed! Check your balance / subscription.");
    else if (status === "pending") await reply("⏳ Not received yet. If you just sent it, wait a minute and tap \"✅ I've paid\" again — it is also checked automatically.");
    else await reply("⌛ This payment has expired. Please start a new one.");
    return;
  }
}

function tokenHelp() {
  return `🔑 <b>Now create your bot</b>\n\n1. Open @BotFather\n2. Send /newbot, choose a name and a username\n3. BotFather gives you a token like <code>123456789:AAH...</code>\n4. Copy it and send it here.\n\nSend /cancel to stop.`;
}

// ─── Main-admin commands ─────────────────────────────────────────────────────

async function cmdTenantBots(ctx: Ctx, reply: (h: string, e?: any) => any) {
  const db = await getDb();
  const { data: rows } = await db.from("tenant_bots").select("*").order("id");
  const price = await getPrice(ctx.bot);
  const days = await getDays(ctx.bot);
  const ids = (rows ?? []).map((r: any) => r.owner_account_id);
  const { data: accs } = ids.length ? await db.from("bot_accounts").select("id, username").in("id", ids) : { data: [] };
  const nameOf = (id: number) => (accs ?? []).find((a: any) => a.id === id)?.username ?? "?";
  const lines = (rows ?? []).map((r: any) => `#${r.id} ${escapeHtml(nameOf(r.owner_account_id))} — ${r.bot_username ? "@" + escapeHtml(r.bot_username) : "no token"} — ${r.status} — until ${fmtDate(r.expires_at)}`);
  await reply(`🤖 <b>Subscriber bots</b> (price ${money(price)}/${days}d)\n\n${lines.join("\n") || "None yet."}\n\n/extendbot ID DAYS · /disablebot ID · /enablebot ID · /setbotprice AMOUNT`);
}

async function cmdExtendBot(ctx: Ctx, reply: (h: string, e?: any) => any, id: number, days: number) {
  if (!id || !days) { await reply("Usage: /extendbot ID DAYS"); return; }
  const db = await getDb();
  const { data: t } = await db.from("tenant_bots").select("*").eq("id", id).maybeSingle();
  if (!t) { await reply("Not found."); return; }
  const base = new Date(Math.max(new Date(t.expires_at).getTime(), Date.now()));
  const expires = new Date(base.getTime() + days * 86400000).toISOString();
  await db.from("tenant_bots").update({ expires_at: expires, status: "active", reminded: 0 }).eq("id", id);
  await reply(`✅ #${id} valid until ${fmtDate(expires)}`);
}

async function cmdSetBotStatus(ctx: Ctx, reply: (h: string, e?: any) => any, id: number, status: "active" | "disabled") {
  if (!id) { await reply(`Usage: /${status === "active" ? "enablebot" : "disablebot"} ID`); return; }
  const db = await getDb();
  const { data: t } = await db.from("tenant_bots").update({ status }).eq("id", id).select("id").maybeSingle();
  await reply(t ? (status === "active" ? `✅ #${id} enabled.` : `⛔️ #${id} disabled.`) : "Not found.");
}

// ─── Affiliates (main bot only) ──────────────────────────────────────────────
let mainBotUsername: string | null = null;
export async function affAmount(bot: BotInfo): Promise<number> {
  const n = Number((await getSetting(bot, "aff_amount")) ?? 5);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

async function affiliateMenu(ctx: Ctx, reply: (h: string, e?: any) => any) {
  if ((await getSetting(ctx.bot, "aff_enabled")) === "0") { await reply("ℹ️ The affiliate program is currently closed."); return; }
  if (!ctx.session.accountId) { await reply("🔐 Please send /start first."); return; }
  const db = await getDb();
  if (!mainBotUsername) { const me: any = await tgCall(ctx.bot.token, "getMe").catch(() => null); mainBotUsername = me?.username ?? null; }
  const code = await refCode(db, ctx.session.accountId);
  const link = `https://t.me/${mainBotUsername ?? "bot"}?start=${code}`;
  const { count: invited } = await db.from("bot_accounts").select("id", { count: "exact", head: true }).eq("tenant_id", 0).eq("referred_by", ctx.session.accountId);
  const { data: earn } = await db.from("affiliate_earnings").select("amount").eq("referrer_id", ctx.session.accountId);
  const total = (earn ?? []).reduce((a: number, r: any) => a + Number(r.amount), 0);
  const { data: me } = await db.from("bot_accounts").select("aff_amount").eq("id", ctx.session.accountId).maybeSingle();
  const amount = me?.aff_amount != null ? Number(me.aff_amount) : await affAmount(ctx.bot);
  await reply(
    `💰 <b>Start Earning By Affiliates</b>\n\n` +
    `Copy the Affiliates link and share with your friends, family, or anyone who might be interested in our services. ` +
    `You can earn commissions for every sale made through your referral link.\n\n` +
    `🎁 You get <b>${money(amount)}</b> balance every time someone you invite buys a bot subscription (e.g. 1 month).\n\n` +
    `🔗 Your link:\n<code>${escapeHtml(link)}</code>\n\n` +
    `👥 Invited: <b>${invited ?? 0}</b>\n🛒 Sales: <b>${(earn ?? []).length}</b>\n💵 Earned: <b>${money(total)}</b>`,
    kb([urlBtn("📤 Share link", `https://t.me/share/url?url=${encodeURIComponent(link)}`)], [btn("⬅️ Go back", "c:home")]),
  );
}

async function affiliateAdmin(ctx: Ctx, reply: (h: string, e?: any) => any, data: string) {
  const db = await getDb();
  if (data === "a:aff:cu") return ask(ctx, reply, { s: "aff_cu" }, "🎯 <b>Custom commission</b>\nSend your friend's Telegram ID or @username:");
  if (data === "a:aff:amt") return ask(ctx, reply, { s: "aff_amount" }, "💵 Send the commission in $ per subscription (e.g. 5):");
  if (data === "a:aff:tog") {
    const on = (await getSetting(ctx.bot, "aff_enabled")) !== "0";
    await setSetting(ctx.bot, "aff_enabled", on ? "0" : "1");
    data = "a:aff:0";
  }
  const page = Math.max(0, Number(data.split(":")[2]) || 0);
  const on = (await getSetting(ctx.bot, "aff_enabled")) !== "0";
  const { data: earn } = await db.from("affiliate_earnings").select("referrer_id,amount");
  const { data: refs } = await db.from("bot_accounts").select("referred_by").eq("tenant_id", 0).not("referred_by", "is", null);
  const stats = new Map<number, { inv: number; sales: number; total: number }>();
  const get = (id: number) => { let v = stats.get(id); if (!v) { v = { inv: 0, sales: 0, total: 0 }; stats.set(id, v); } return v; };
  for (const r of refs ?? []) get(Number(r.referred_by)).inv++;
  for (const e of earn ?? []) { const v = get(Number(e.referrer_id)); v.sales++; v.total += Number(e.amount); }
  const list = [...stats.entries()].sort((a, b) => b[1].total - a[1].total || b[1].inv - a[1].inv);
  const pages = Math.max(1, Math.ceil(list.length / 10));
  const p = Math.min(page, pages - 1);
  const slice = list.slice(p * 10, p * 10 + 10);
  const ids = slice.map(([id]) => id);
  const { data: accs } = ids.length ? await db.from("bot_accounts").select("id,username,tg_name").in("id", ids) : { data: [] as any[] };
  const name = (id: number) => { const a = (accs ?? []).find((x: any) => x.id === id); return a?.tg_name || `User #${id}`; };
  const lines = slice.map(([id, v], i) => `${p * 10 + i + 1}. ${escapeHtml(name(id))} — 👥 ${v.inv} · 🛒 ${v.sales} · 💵 ${money(v.total)}`);
  const { data: customs } = await db.from("bot_accounts").select("id,username,tg_name,aff_amount").eq("tenant_id", 0).not("aff_amount", "is", null).limit(30);
  const customTxt = (customs ?? []).length ? `\n\n🎯 <b>Custom commissions</b>\n${(customs ?? []).map((c: any) => `· ${escapeHtml(c.tg_name || c.username)} — ${money(Number(c.aff_amount))}`).join("\n")}` : "";
  const nav: any[] = [];
  if (p > 0) nav.push(btn("⬅️ Prev", `a:aff:${p - 1}`));
  if (p < pages - 1) nav.push(btn("Next ➡️", `a:aff:${p + 1}`));
  await reply(
    `💰 <b>Affiliates</b>\n\nStatus: <b>${on ? "🟢 On" : "🔴 Off"}</b>\nCommission: <b>${money(await affAmount(ctx.bot))}</b> per subscription\n\n` +
    (lines.length ? `<b>Top affiliates</b> · Page ${p + 1}/${pages}\n${lines.join("\n")}` : "No affiliates yet.") + customTxt,
    kb([btn("💵 Set commission", "a:aff:amt"), btn(on ? "🔴 Turn off" : "🟢 Turn on", "a:aff:tog")], [btn("🎯 Custom commission", "a:aff:cu")], ...(nav.length ? [nav] : []), [btn("⬅️ Menu", "a:home")]),
  );
}

/** Credits the referrer once per paid subscription (source is unique). */
export async function creditAffiliate(bot: BotInfo, buyerAccountId: number, source: string): Promise<void> {
  try {
    if ((await getSetting(bot, "aff_enabled")) === "0") return;
    const amount = await affAmount(bot);
    const db = await getDb();
    const { data: r } = await db.rpc("credit_affiliate", { p_buyer: buyerAccountId, p_amount: amount, p_source: source });
    if (r && (r as any).ok && (r as any).tg_id) {
      await sendHtml(bot.token, Number((r as any).tg_id), `🎉 You earned <b>${money(Number((r as any).amount ?? amount))}</b> commission from <b>${escapeHtml((r as any).buyer ?? "a referral")}</b>!\n💰 New balance: <b>${money((r as any).balance)}</b>`).catch(() => {});
    }
  } catch (e) { console.error("affiliate credit failed", e); }
}

// ─── Quick color editor: tap admin-panel buttons, then Save once ─────────────
const QC_GRID: [string, string][][] = [
  [["add_product", "➕ Add product"], ["products", "📦 Products"]],
  [["categories", "📂 Categories"], ["stock", "📦 Stock"]],
  [["manage", "🔧 Reseller"], ["view_shop", "🛍 View shop"]],
  [["add_account", "👤 Add account"], ["add_balance", "💰 Add balance"]],
  [["stats", "📊 Orders & profit"], ["broadcast", "📣 Broadcast"]],
  [["welcome", "👋 Welcome text"], ["hide", "🙈 Hide prices"]],
  [["support", "💬 Support username"], ["users", "👥 Logged-in users"]],
  [["emoji", "✨ Premium emoji"], ["colors", "🎨 Button colors"]],
  [["language", "🌐 Language"]],
  [["tenants", "🤖 Reseller bots"], ["affiliates", "💰 Affiliates"]],
  [["buy", "🔑 Buy keys"], ["custom_prices", "💲 Custom prices"]],
  [["remove_user", "🚫 Remove user"]],
];
function qcGrid(ctx: Ctx): [string, string][][] {
  return QC_GRID
    .map(row => row.filter(([id]) => ctx.bot.isMain ? !["add_account", "custom_prices"].includes(id) : !["tenants", "affiliates", "remove_user"].includes(id)))
    .filter(row => row.length);
}

async function quickColors(ctx: Ctx, reply: (h: string, e?: any) => any, data: string) {
  ctx.session.step = null;
  const saved = parseButtonColors(ctx.emoji.buttons);
  if (data === "a:qc" || !ctx.session.qc) ctx.session.qc = { brush: "primary", draft: { ...(saved.items ?? {}) } };
  const qc = ctx.session.qc;
  const ids = qcGrid(ctx).flat().map(([id]) => id);
  const b = data.match(/^a:qc:b:(default|primary|success|danger)$/);
  if (b && isButtonColor(b[1])) qc.brush = b[1];
  const t = data.match(/^a:qc:t:([a-z_]+)$/);
  if (t?.[1] && ids.includes(t[1])) qc.draft[t[1]] = qc.brush;
  if (data === "a:qc:all") for (const id of ids) qc.draft[id] = qc.brush;
  if (data === "a:qc:x") { ctx.session.qc = undefined; return colorsMenu(ctx, reply); }
  if (data === "a:qc:save") {
    const items: Record<string, any> = { ...(saved.items ?? {}) };
    for (const id of ids) if (qc.draft[id] && isButtonColor(qc.draft[id])) items[id] = qc.draft[id];
    saved.items = items;
    ctx.emojiOwn.buttons = saved;
    await saveEmojiTheme(ctx);
    ctx.session.qc = undefined;
    // Telegram cannot replace a persistent keyboard through editMessageText.
    await sendMenuKb(ctx, "✅ All button colors saved.");
    return adminMenu(ctx, reply);
  }
  const fallback = saved.inline;
  const styled = (label: string, cb: string, color?: string) => {
    const x: any = btn(label, cb);
    const c = color ?? fallback;
    if (c && c !== "default") x.style = c;
    return x;
  };
  const brushName = BUTTON_COLORS.find(c => c.value === qc.brush)?.label ?? "Default";
  const rows: any[][] = [
    BUTTON_COLORS.map(c => styled(`${qc.brush === c.value ? "✓ " : ""}${c.value === "default" ? "⚪ None" : c.label}`, `a:qc:b:${c.value}`, c.value)),
    ...qcGrid(ctx).map(row => row.map(([id, label]) => styled(label, `a:qc:t:${id}`, qc.draft[id]))),
    [styled(`🪣 Apply ${brushName} to all`, "a:qc:all", qc.brush)],
    [btn("💾 Save", "a:qc:save"), btn("✖️ Cancel", "a:qc:x")],
  ];
  await reply(`🖌 <b>Quick colors</b>\n\n1. Pick a color at the top (now: <b>${brushName}</b>).\n2. Tap any buttons below to paint them — one or many.\n3. Tap <b>💾 Save</b> to keep all changes.`, { ...kb(...rows), noButtonColors: true });
}

const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
/** Random 5–11 char referral code, unique per account, created once. */
async function refCode(db: any, accountId: number): Promise<string> {
  const { data: a } = await db.from("bot_accounts").select("ref_code").eq("id", accountId).maybeSingle();
  if (a?.ref_code) return a.ref_code;
  for (let i = 0; i < 10; i++) {
    const len = 5 + Math.floor(Math.random() * 7);
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    const code = Array.from(bytes, b => REF_CHARS[b % REF_CHARS.length]).join("");
    const { data: taken } = await db.from("bot_accounts").select("id").eq("ref_code", code).maybeSingle();
    if (taken) continue;
    const { error } = await db.from("bot_accounts").update({ ref_code: code }).eq("id", accountId).is("ref_code", null);
    if (!error) {
      const { data: b } = await db.from("bot_accounts").select("ref_code").eq("id", accountId).maybeSingle();
      if (b?.ref_code) return b.ref_code;
    }
  }
  return `ref_${accountId}`;
}
