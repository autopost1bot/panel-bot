# Panel Bot — Railway deploy

## 1. Database
Create a free Supabase project (supabase.com). Open **SQL Editor**, paste all of `schema.sql`, click **Run**.
From **Project Settings → API** copy the **Project URL** and the **service_role** key.

## 2. GitHub
Upload all files of this folder to a new GitHub repository.

## 3. Railway
1. railway.com → New Project → Deploy from GitHub repo → choose the repo.
2. Settings → Networking → **Generate Domain** (gives `https://xxxx.up.railway.app`).
3. Variables tab — add:

| Variable | Value |
|---|---|
| `ADMIN_BOT_TOKEN` | Admin bot token from @BotFather |
| `ADMIN_TG_IDS` | Your Telegram numeric ID(s), comma separated |
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from step 1 |
| `PUBLIC_URL` | The Railway domain from step 2 (with https://) |

4. Railway redeploys automatically. Logs should show `Admin bot webhook connected`.
5. Open your bot in Telegram and send `/start`.

Start command: `npm start` (Railway detects it automatically).
Reseller bots added from the admin bot are connected to the same server automatically.

## Backups & restore
- Admin Panel → **💾 Backup**: send a backup now, or turn the daily backup (after 03:00 Dhaka time, sent to all admins) on/off.
- The `.json.gz` file contains keys, password hashes and bot tokens — keep it private.
- Restore on the VPS (this REPLACES all current bot data with the backup; it runs in one transaction):
  ```bash
  cd /path/to/panel-bot
  node restore.mjs backup-YYYY-MM-DD.json.gz > /tmp/restore.sql      # multi-part: list all parts in order
  sudo systemctl stop panel-bot 2>/dev/null || true                  # stop the bot while restoring
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d panelbot -f /tmp/restore.sql
  sudo systemctl start panel-bot 2>/dev/null || true
  ```
