import { createServer } from "node:http";
import { setDefaultResultOrder } from "node:dns";
// Prefer IPv4: VPS IPv6 routes to Telegram are often slow and stall every request.
setDefaultResultOrder("ipv4first");
import { getDb } from "./bot/db";
import { enqueueUpdate, drainUpdates, drainOutbox } from "./bot/reliability";
import { sendHtml, tgCall, webhookSecret } from "./bot/tg";
import { scanPayments } from "./bot/crypto";

const PORT = Number(process.env["PORT"] ?? 3000);
const PUBLIC_URL = (process.env["PUBLIC_URL"] ?? "").replace(/\/+$/, "");
const ADMIN_BOT_TOKEN = process.env["ADMIN_BOT_TOKEN"] ?? "";
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

if (!ADMIN_BOT_TOKEN) throw new Error("ADMIN_BOT_TOKEN is not set");
if (!PUBLIC_URL.startsWith("https://")) throw new Error("PUBLIC_URL must be your https Railway domain");

let adminCache: { at: number; ids: number[] } | null = null;
async function adminIds(): Promise<number[]> {
  if (adminCache && Date.now() - adminCache.at < 60_000) return adminCache.ids;
  const parse = (v: string) => v.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const ids = new Set(parse(process.env["ADMIN_TG_IDS"] ?? ""));
  const db = await getDb();
  const { data: s, error } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "admin_tg_ids").maybeSingle();
  if (error) throw error;
  for (const n of parse(String(s?.value ?? ""))) ids.add(n);
  adminCache = { at: Date.now(), ids: [...ids] };
  return adminCache.ids;
}

const mainSecret = await webhookSecret(ADMIN_BOT_TOKEN);
// Token -> reseller bot id (status/expiry is still checked fresh per update).
const tenantCache = new Map<string, { at: number; id: number; owner_tg_id: number }>();
const secretCache = new Map<string, string>();
async function cachedSecret(token: string): Promise<string> {
  let s = secretCache.get(token);
  if (!s) { s = await webhookSecret(token); secretCache.set(token, s); }
  return s;
}

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

const server = createServer(async (req, res) => {
  const ok = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); };
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET") { res.writeHead(200); res.end("Panel bot is running"); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const secret = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");

    if (url.pathname === "/webhook") {
      if (secret !== mainSecret) { res.writeHead(401); res.end(); return; }
      const update = await readJson(req);
      if (update) await enqueueUpdate(0, update);
      ok(); // acknowledged only after durable persistence
      void drainUpdates(resolveBot).catch(() => console.error("Update worker failed"));
      return;
    }

    const m = url.pathname.match(/^\/tenant\/(.+)$/);
    if (m) {
      const encoded = m[1];
      if (!encoded) { res.writeHead(400); res.end(); return; }
      const token = decodeURIComponent(encoded);
      if (!TOKEN_RE.test(token) || secret !== (await cachedSecret(token))) { res.writeHead(401); res.end(); return; }
      const update = await readJson(req);
      if (!update) { ok(); return; }
      let t = tenantCache.get(token);
      if (!t || Date.now() - t.at > 60_000) {
        const db = await getDb();
        const { data, error } = await db.from("tenant_bots").select("id, owner_tg_id").eq("token", token).maybeSingle();
        if (error) throw error;
        t = data ? { at: Date.now(), id: data.id, owner_tg_id: data.owner_tg_id } : undefined;
        if (t) tenantCache.set(token, t); else tenantCache.delete(token);
      }
      if (t) await enqueueUpdate(t.id, update);
      ok();
      void drainUpdates(resolveBot).catch(() => console.error("Update worker failed"));
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

async function resolveBot(tenantId: number) {
  if (tenantId === 0) return { token: "main", tenantId: 0, ownerTgId: 0, isMain: true, adminTgIds: await adminIds() };
  const db = await getDb();
  const { data, error } = await db.from("tenant_bots").select("token,owner_tg_id").eq("id", tenantId).maybeSingle();
  if (error) throw error;
  if (!data?.token) return null;
  return { token: data.token, tenantId, ownerTgId: Number(data.owner_tg_id), isMain: false, adminTgIds: [] };
}

async function isTrial(tenantId: number): Promise<boolean> {
  const db = await getDb();
  const { data } = await db.from("tenant_bot_payments").select("note").eq("tenant_id", tenantId);
  const rows = data ?? [];
  return rows.some((p: any) => p.note === "trial") && !rows.some((p: any) => p.note !== "trial");
}

// Hourly: remind owners about expiring subscriptions and mark expired ones.
async function expiryCheck() {
  try {
    const db = await getDb();
    const { data: rows } = await db.from("tenant_bots").select("id, owner_tg_id, expires_at, reminded, status").eq("status", "active");
    for (const r of rows ?? []) {
      const left = (new Date(r.expires_at).getTime() - Date.now()) / 86400000;
      const owner = Number(r.owner_tg_id);
      if (left <= 0) {
        await db.from("tenant_bots").update({ status: "expired" }).eq("id", r.id);
        const { data: paid } = await db.from("tenant_bot_payments").select("id").eq("tenant_id", r.id).neq("note", "trial").limit(1);
        await sendHtml("main", owner, (paid ?? []).length
          ? "⛔️ <b>Your bot subscription has expired.</b>\nRenew it from the main reseller bot → 🤖 My Own Bot"
          : "⛔️ <b>Your 3-day free trial has ended.</b>\nRenew for 30 days to keep your bot running → 🤖 Make My own Bot");
      } else if (left <= 0.5 && r.reminded < 3) {
        await db.from("tenant_bots").update({ reminded: 3 }).eq("id", r.id);
        await sendHtml("main", owner, "⏰ <b>Your subscription expires in 12 hours.</b>\nRenew now to keep your bot running without interruption.",
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew subscription", callback_data: "tsub:cancel", style: "primary" }]] } });
      } else if (left <= 1 && r.reminded < 2 && !(await isTrial(r.id))) {
        await db.from("tenant_bots").update({ reminded: 2 }).eq("id", r.id);
        await sendHtml("main", owner, "⏰ Your bot subscription ends in <b>less than 1 day</b>. Renew from the main bot.");
      } else if (left <= 3 && r.reminded < 1 && !(await isTrial(r.id))) {
        await db.from("tenant_bots").update({ reminded: 1 }).eq("id", r.id);
        await sendHtml("main", owner, "⏰ Your bot subscription ends in <b>3 days</b>. Renew from the main bot.");
      }
    }
  } catch (e) { console.error("expiry check failed", e); }
}

server.listen(PORT, async () => {
  console.log(`Panel bot listening on ${PORT}`);
  try {
    await tgCall("main", "setWebhook", {
      url: `${PUBLIC_URL}/webhook`,
      secret_token: mainSecret,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    console.log("Admin bot webhook connected");
    // Re-point every reseller bot to this server.
    const db = await getDb();
    const { data: ts } = await db.from("tenant_bots").select("token").not("token", "is", null);
    for (const t of ts ?? []) {
      await tgCall(t.token, "setWebhook", {
        url: `${PUBLIC_URL}/tenant/${t.token}`,
        secret_token: await webhookSecret(t.token),
        allowed_updates: ["message", "edited_message", "callback_query"],
      }).catch((e: unknown) => console.error("reseller webhook failed", e));
    }
  } catch (e) { console.error("webhook setup failed", e); }
  const recover = () => drainUpdates(resolveBot).catch(() => console.error("Update recovery failed"));
  const deliverPending = () => drainOutbox(resolveBot).catch(() => console.error("Delivery recovery failed"));
  void recover();
  setInterval(recover, 1000);
  setInterval(deliverPending, 30_000);
  void expiryCheck();
  setInterval(expiryCheck, 60 * 60 * 1000);
  // Every minute: verify incoming BEP20 USDT payments automatically.
  const cryptoScan = () => scanPayments("main").catch((e) => console.error("crypto scan failed", e));
  void cryptoScan();
  setInterval(cryptoScan, 60 * 1000);
});
