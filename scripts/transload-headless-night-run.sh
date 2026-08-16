#!/bin/bash
# Transload headless retry pass — one-shot night run (scheduled 2026-08-15
# ~05:00 UTC / midnight CDT, off-peak per the heavy-batch rule).
# crawl (resumable, retried) -> merge -> rebuild -> deploy -> verify,
# then DM Jacob AFTER quiet hours end (13:05 UTC = 8:05am CDT).
set -uo pipefail
# Telegram creds live in ~/.bashrc (the run.sh fallback pattern). Source
# BEFORE redirecting output; never echo values.
source /home/ubuntu/.bashrc >/dev/null 2>&1 || true
LOG=/home/ubuntu/bots/assistant/logs/transload-headless-night.log
exec >> "$LOG" 2>&1
echo "==== headless night run started $(date -u +%FT%TZ) ===="

SITE=/home/ubuntu/projects/steel-wheel-site
ASSIST=/home/ubuntu/bots/assistant
DATA=$SITE/tools/transload-directory/data

# -- crawl: chromium can die mid-run; results file is resumable, so retry --
ok=0
for attempt in 1 2 3; do
  echo "-- crawl attempt $attempt --"
  if node "$SITE/scripts/transload-enrich-headless.mjs"; then ok=1; break; fi
  sleep 60
done
if [ "$ok" != 1 ]; then
  echo "FATAL: crawl failed 3x"
  SUMMARY="Headless transload pass FAILED (crawl died 3x) — see transload-headless-night.log"
else
  echo "-- merge --"
  MERGE_OUT=$(python3 "$SITE/scripts/transload-enrich-merge-headless.py") || MERGE_OUT="MERGE FAILED"
  echo "$MERGE_OUT"
  echo "-- rebuild --"
  cd "$SITE" && bun run scripts/build-transload-pages.js
  echo "-- deploy --"
  bash "$ASSIST/scripts/keyring.sh" run VT=vercel -- \
    bash -c 'cd /home/ubuntu/projects/steel-wheel-site && FORCE_COLOR=0 npx --yes vercel@latest deploy --prod --yes --token "$VT"' \
    && DEPLOY=ok || DEPLOY=FAILED
  echo "deploy: $DEPLOY"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://steelwheellogistics.com/transload/wisconsin?cb=$(date +%s)")
  echo "verify: /transload/wisconsin -> $CODE"
  NFAIL=$(python3 -c "import json;print(len(json.load(open('$DATA/transload-repeat-failures.json'))))" 2>/dev/null || echo "?")
  SUMMARY="🌙 Overnight transload headless pass done.
$MERGE_OUT
Deploy: $DEPLOY, live check $CODE.
Repeat-failures (dead in both passes): $NFAIL URLs -> transload-repeat-failures.json. Your call on verify-or-remove; nothing was deleted."
fi

# -- DM happens on a separate 13:05 UTC cron (quiet hours end 8am CDT); we
# just leave the summary where transload-headless-dm.sh will pick it up --
printf '%s\n' "$SUMMARY" > "$ASSIST/logs/transload-headless-summary.txt"
echo "==== headless night run finished $(date -u +%FT%TZ) ===="
