#!/usr/bin/env bash
# One-command VPS installer: asks only for the bot token and admin Telegram ID.
# Installs Node.js, PostgreSQL (local database), PostgREST, Caddy (free https), PM2.
set -e
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

exec 3</dev/tty
echo "=============================="
echo "   Panel Bot - auto setup"
echo "=============================="
read -u 3 -p "Bot token (BotFather): " BOT_TOKEN
read -u 3 -p "Admin Telegram ID (number): " ADMIN_ID
BOT_TOKEN="$(echo "$BOT_TOKEN" | tr -d '[:space:]')"
ADMIN_ID="$(echo "$ADMIN_ID" | tr -d '[:space:]')"
if ! [[ "$BOT_TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]]; then echo "Token is not valid. Run again."; exit 1; fi
if ! [[ "$ADMIN_ID" =~ ^[0-9]{4,15}$ ]]; then echo "Telegram ID must be numbers only. Run again."; exit 1; fi

IP="$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
echo ">> Address: https://$DOMAIN"

echo ">> [1/6] Installing system packages..."
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https xz-utils postgresql
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo ">> [2/6] Downloading bot..."
cd /root
if [ -d panel-bot/.git ]; then git -C panel-bot pull --ff-only || true; else rm -rf panel-bot; git clone https://github.com/autopost1bot/panel-bot; fi
cd /root/panel-bot
npm install --no-audit --no-fund

echo ">> [3/6] Creating database..."
systemctl enable --now postgresql
DBPASS="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END \$\$;
ALTER ROLE authenticator PASSWORD '$DBPASS';
GRANT service_role TO authenticator;
GRANT anon TO authenticator;
SELECT 'CREATE DATABASE panelbot' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='panelbot')\gexec
SQL
sudo -u postgres psql -v ON_ERROR_STOP=1 -d panelbot -f /root/panel-bot/schema.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -d panelbot <<SQL
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
SQL

echo ">> [4/6] Installing database API..."
if [ ! -x /usr/local/bin/postgrest ]; then
  curl -fsSL -o /tmp/postgrest.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
  tar -xJf /tmp/postgrest.tar.xz -C /usr/local/bin
  chmod +x /usr/local/bin/postgrest
fi
mkdir -p /etc/postgrest
cat > /etc/postgrest/panelbot.conf <<CONF
db-uri = "postgres://authenticator:$DBPASS@127.0.0.1:5432/panelbot"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = 3001
CONF
cat > /etc/systemd/system/postgrest.service <<UNIT
[Unit]
Description=PostgREST
After=postgresql.service
[Service]
ExecStart=/usr/local/bin/postgrest /etc/postgrest/panelbot.conf
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable postgrest
systemctl restart postgrest

SERVICE_KEY="$(JWT_SECRET="$JWT_SECRET" node -e '
const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iat:Math.floor(Date.now()/1000)});
const s=c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url");
process.stdout.write(h+"."+p+"."+s);')"

echo ">> [5/6] Setting up https..."
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy localhost:3000
}
:8081 {
  bind 127.0.0.1
  handle_path /rest/v1/* {
    reverse_proxy 127.0.0.1:3001
  }
}
CADDY
systemctl enable caddy
systemctl restart caddy

cat > /root/panel-bot/.env <<ENV
ADMIN_BOT_TOKEN=$BOT_TOKEN
ADMIN_TG_IDS=$ADMIN_ID
PUBLIC_URL=https://$DOMAIN
PORT=3000
SUPABASE_URL=http://127.0.0.1:8081
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
ENV
chmod 600 /root/panel-bot/.env

echo ">> [6/6] Starting bot..."
npm i -g pm2 >/dev/null
pm2 delete panelbot >/dev/null 2>&1 || true
cd /root/panel-bot
pm2 start node_modules/tsx/dist/cli.mjs --name panelbot --node-args="--env-file=/root/panel-bot/.env" -- src/server.ts
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
sleep 6
pm2 status
echo ""
echo "=============================="
echo " DONE! Send /start to your bot on Telegram."
echo " Logs: pm2 logs panelbot"
echo "=============================="
