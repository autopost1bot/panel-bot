#!/bin/bash
# Turns the auto-update check off again (bot keeps running, nothing else changes).
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
( crontab -l 2>/dev/null | grep -v "panel-bot/autoupdate.sh" ) | crontab -
echo "Auto-update turned off."
exit 0
