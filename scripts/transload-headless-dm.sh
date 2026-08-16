#!/bin/bash
# Deliver the overnight transload headless-pass summary after quiet hours end.
# Runs via cron-wrapper (which sources ~/.bashrc for Telegram creds).
set -euo pipefail
SUMMARY_FILE=/home/ubuntu/bots/assistant/logs/transload-headless-summary.txt
if [ ! -s "$SUMMARY_FILE" ]; then
  echo "no summary file — night run may have died before writing it"
  exit 1
fi
bash /home/ubuntu/bots/assistant/send-telegram.sh "$TELEGRAM_USER_ID" "$(cat "$SUMMARY_FILE")"
mv "$SUMMARY_FILE" "$SUMMARY_FILE.sent"
echo "summary DMed"
