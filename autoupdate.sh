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

# Apply schema.sql whenever its contents changed since the last successful
# apply (also catches databases that missed an earlier update), then make the
# database API reload so new tables are visible to the bot immediately.
apply_schema() {
  [ -f "$APP_DIR/schema.sql" ] || return 0
  local HASH_FILE="$APP_DIR/.schema.applied"
  local NEW_HASH; NEW_HASH="$(sha256sum "$APP_DIR/schema.sql" | cut -d' ' -f1)"
  [ "$(cat "$HASH_FILE" 2>/dev/null)" = "$NEW_HASH" ] && return 0
  echo "[$(date -u '+%F %T UTC')] applying schema.sql" >> "$LOG"
  local PSQL="psql"
  if command -v runuser >/dev/null 2>&1; then PSQL="runuser -u postgres -- psql"
  elif command -v sudo >/dev/null 2>&1; then PSQL="sudo -u postgres psql"; fi
  # The postgres user cannot open files under /root, so root reads the file
  # and feeds it on stdin; run from /tmp so psql can change directory.
  if (cd /tmp && $PSQL -v ON_ERROR_STOP=1 -d panelbot -f - < "$APP_DIR/schema.sql") >> "$LOG" 2>&1; then
    echo "$NEW_HASH" > "$HASH_FILE"
    (cd /tmp && $PSQL -d panelbot -c "NOTIFY pgrst, 'reload schema';") >> "$LOG" 2>&1
    systemctl restart postgrest >> "$LOG" 2>&1 || true
    sleep 2
    echo "[$(date -u '+%F %T UTC')] schema applied, database API reloaded" >> "$LOG"
    return 1   # signal: restart the bot too
  fi
  echo "[$(date -u '+%F %T UTC')] schema.sql FAILED (see above)" >> "$LOG"
  return 0
}

if [ "$LOCAL" = "$REMOTE" ]; then
  if ! apply_schema; then "$PM2" restart "$APP_NAME" --update-env >> "$LOG" 2>&1; fi
  exit 0                # nothing new, do not touch the running bot
fi

echo "[$(date -u '+%F %T UTC')] new code $LOCAL -> $REMOTE" >> "$LOG"
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1   # discard local edits, take remote exactly

# Install dependencies only when the dependency list changed.
if ! git diff -q "$LOCAL" "$REMOTE" -- package.json package-lock.json >/dev/null 2>&1; then
  echo "[$(date -u '+%F %T UTC')] installing dependencies" >> "$LOG"
  npm install --silent >> "$LOG" 2>&1
fi

# Apply schema changes that came with the new code.
apply_schema || true

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
