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
