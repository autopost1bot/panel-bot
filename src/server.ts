import { createServer } from "node:http";
import { getDb } from "./bot/db";
import { handleUpdate } from "./bot/engine";
import { sendHtml, tgCall, webhookSecret } from "./bot/tg";

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
  const { data: s } = await db.from("bot_settings").select("value").eq("tenant_id", 0).eq("key", "admin_tg_ids").maybeSingle();
  for (const n of parse(String(s?.value ?? ""))) ids.add(n);
  adminCache = { at: Date.now(), ids: [...ids] };
  return adminCache.ids;
}

const mainSecret = await webhookSecret(ADMIN_BOT_TOKEN);

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
      ok(); // answer Telegram immediately, process after
      if (update) handleUpdate({ token: "main", tenantId: 0, ownerTgId: 0, isMain: true, adminTgIds: await adminIds() }, update)
        .catch((e) => console.error("main bot update failed", e));
      return;
    }

    const m = url.pathname.match(/^\/tenant\/(.+)$/);
    if (m) {
      const token = decodeURIComponent(m[1]!);
      if (!TOKEN_RE.test(token) || secret !== (await webhookSecret(token))) { res.writeHead(401); res.end(); return; }
      const update = await readJson(req);
      ok();
      if (!update) return;
      const db = await getDb();
      const { data: t } = await db.from("tenant_bots").select("id, owner_tg_id").eq("token", token).maybeSingle();
      if (t) handleUpdate({ token, tenantId: t.id, ownerTgId: Number(t.owner_tg_id), isMain: false, adminTgIds: [] }, update)
        .catch((e) => console.error("reseller bot update failed", e));
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

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
        await sendHtml("main", owner, "⛔️ <b>Your bot subscription has expired.</b>\nRenew it from the main reseller bot → 🤖 My Own Bot");
      } else if (left <= 1 && r.reminded < 2) {
        await db.from("tenant_bots").update({ reminded: 2 }).eq("id", r.id);
        await sendHtml("main", owner, "⏰ Your bot subscription ends in <b>less than 1 day</b>. Renew from the main bot.");
      } else if (left <= 3 && r.reminded < 1) {
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
  void expiryCheck();
  setInterval(expiryCheck, 60 * 60 * 1000);
});
