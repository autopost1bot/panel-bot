#!/bin/bash
# Panel Bot auto-update: checks GitHub once a minute and restarts the bot
# only when new code has been pushed. Safe to run from cron.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="${HOME:-/root}"

APP_DIR="/root/panel-bot"
LOG="$APP_DIR/autoupdate.log"
LOCK="/tmp/panelbot-autoupdate.lock"
BRANCH="main"
APP_NAME="panelbot"

exec 9>"$LOCK"
flock -n 9 || exit 0   # a previous check is still running

cd "$APP_DIR" || exit 0

# Make sure pm2 is reachable even when cron gives a tiny PATH.
PM2="$(command -v pm2 || echo /usr/local/bin/pm2)"

git fetch -q origin "$BRANCH" || exit 0
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0                # nothing new, do not touch the running bot
fi

echo "[$(date -u '+%F %T UTC')] new code $LOCAL -> $REMOTE" >> "$LOG"
git pull -q origin "$BRANCH" >> "$LOG" 2>&1

# Install dependencies only when the dependency list changed.
if ! git diff -q "$LOCAL" "$REMOTE" -- package.json package-lock.json >/dev/null 2>&1; then
  echo "[$(date -u '+%F %T UTC')] installing dependencies" >> "$LOG"
  npm install --silent >> "$LOG" 2>&1
fi

"$PM2" restart "$APP_NAME" --update-env >> "$LOG" 2>&1
sleep 8

STATUS="$("$PM2" jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const p=(l||[]).find(x=>x.name==="'"$APP_NAME"'");console.log(p?p.pm2_env.status:"none")}catch(e){console.log("none")}})' 2>/dev/null)"

if [ "$STATUS" != "online" ]; then
  echo "[$(date -u '+%F %T UTC')] bot did not come online -> rolling back to $LOCAL" >> "$LOG"
  git reset --hard "$LOCAL" >> "$LOG" 2>&1
  "$PM2" restart "$APP_NAME" --update-env >> "$LOG" 2>&1
else
  echo "[$(date -u '+%F %T UTC')] restarted ok" >> "$LOG"
fi

exit 0
