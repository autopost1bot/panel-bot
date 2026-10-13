#!/bin/bash
# One-time install: makes the VPS check GitHub every minute by itself.
# Run: curl -fsSL https://raw.githubusercontent.com/autopost1bot/panel-bot/main/install-autoupdate.sh | bash
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
APP_DIR="/root/panel-bot"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "panel-bot not found in $APP_DIR - run setup.sh first."
  exit 1
fi

cd "$APP_DIR" || exit 1
git pull -q origin main || true
chmod +x "$APP_DIR/autoupdate.sh" "$APP_DIR/stop-autoupdate.sh" 2>/dev/null

CRON_LINE="* * * * * /bin/bash $APP_DIR/autoupdate.sh >> $APP_DIR/autoupdate.log 2>&1"
( crontab -l 2>/dev/null | grep -v "panel-bot/autoupdate.sh"; echo "$CRON_LINE" ) | crontab -

systemctl enable cron >/dev/null 2>&1 || systemctl enable crond >/dev/null 2>&1 || true
systemctl restart cron >/dev/null 2>&1 || systemctl restart crond >/dev/null 2>&1 || true

"$APP_DIR/autoupdate.sh" || true

echo ""
echo "AUTO-UPDATE IS ON: the VPS now checks GitHub every minute and restarts"
echo "the bot by itself whenever new code is pushed. Nothing to type later."
echo "Turn it off any time with: bash $APP_DIR/stop-autoupdate.sh"
echo ""
exit 0
