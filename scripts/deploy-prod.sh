#!/usr/bin/env bash
# Deploy steelwheellogistics.com to Vercel production.
# Token comes from the S3 keyring (label "Vercel"); nothing is printed.
# Usage: scripts/deploy-prod.sh            (from anywhere)
set -uo pipefail
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYRING=/home/ubuntu/bots/assistant/scripts/keyring.sh
cd "$SITE"
echo "deploying $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l) uncommitted paths)"
OUT=$("$KEYRING" run VERCEL_TOKEN=Vercel -- bash -c 'vercel deploy --prod --yes --token "$VERCEL_TOKEN" 2>&1')
RC=$?
URL=$(printf '%s\n' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | tail -1)
if [ $RC -ne 0 ] || [ -z "$URL" ]; then
  printf '%s\n' "$OUT" | tail -15
  echo "DEPLOY FAILED (rc=$RC)"; exit 1
fi
echo "deployed: $URL"
sleep 8
printf 'live check: %s\n' "$(curl -s -o /dev/null -w '%{http_code}' https://steelwheellogistics.com/)"
