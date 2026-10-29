// Restore a bot backup file into the VPS database.
//   node restore.mjs backup-YYYY-MM-DD.json.gz > /tmp/restore.sql
//   sudo -u postgres psql -v ON_ERROR_STOP=1 -d panelbot -f /tmp/restore.sql
// Everything runs in ONE transaction: on any error nothing changes.
// WARNING: this replaces ALL current bot data with the backup's data.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const ORDER = ["bot_settings", "bot_accounts", "tenant_bots", "tenant_bot_payments", "categories", "products", "product_keys",
  "account_prices", "shop_orders", "crypto_payments", "bot_payment_transfers", "affiliate_earnings", "trial_claims",
  "trial_claims_acc", "polls", "poll_votes", "poll_tg_votes", "poll_deliveries", "coupons", "coupon_uses", "bot_sessions"];

const files = process.argv.slice(2);
if (!files.length) { console.error("Usage: node restore.mjs backup.json.gz [part2 ...]"); process.exit(1); }
const raw = Buffer.concat(files.map(f => readFileSync(f)));
const backup = JSON.parse(gunzipSync(raw).toString("utf8"));
if (backup.version !== 1 || !backup.tables) { console.error("Not a bot backup file"); process.exit(1); }

const out = ["BEGIN;", "SET session_replication_role = replica;"];
const present = ORDER.filter(t => Array.isArray(backup.tables[t]));
out.push(`TRUNCATE ${present.map(t => `public.${t}`).join(", ")} RESTART IDENTITY CASCADE;`);
for (const t of present) {
  const rows = backup.tables[t];
  if (!rows.length) continue;
  const tag = "$r" + randomBytes(6).toString("hex") + "$";
  out.push(`INSERT INTO public.${t} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::public.${t}, ${tag}${JSON.stringify(rows)}${tag}::jsonb);`);
  if (Object.prototype.hasOwnProperty.call(rows[0], "id")) {
    out.push(`SELECT setval(pg_get_serial_sequence('public.${t}', 'id'), GREATEST(COALESCE((SELECT max(id) FROM public.${t}), 1), 1));`);
  }
}
out.push("SET session_replication_role = origin;", "COMMIT;");
process.stdout.write(out.join("\n") + "\n");
console.error(`Restore SQL ready (backup from ${backup.created_at}).`);
