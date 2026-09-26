#!/bin/bash
# Expoline soak monitor v2 — checks BOTH server health AND harness liveness.
# v1 only checked :4320/health and missed the harness dying (2026-09-26).
# v2 (2026-09-26): also verifies the soak harness process is alive; restarts
# it if dead. Restart is safe: the server holds the persistent DB
# (soak-20260926.db); the harness is stateless and just hits the API.
#
# Logs to /tmp/soak4320-monitor.log. Runs until END_EPOCH (168h window).

END_EPOCH=$(($(date +%s) + 168*3600))
LOG=/tmp/soak4320-monitor.log
BUILD=/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/build/expoline
HARNESS_PATTERN="qa/soak/soak.js"

echo "[$(date -u +%FT%TZ)] soak monitor v2 started (server+harness), ends at $(date -u -d @$END_EPOCH +%FT%TZ)" >> $LOG

restart_harness() {
  echo "[$(date -u +%FT%TZ)] HARNESS DEAD — restarting (server DB untouched)" >> $LOG
  cd "$BUILD" || return 1
  # Never use pkill -f server.js (could kill the wrong thing). Harness only.
  pkill -f "$HARNESS_PATTERN" 2>/dev/null
  sleep 2
  nohup node qa/soak/soak.js >> qa/soak/soak_stdout.log 2>&1 &
  echo "[$(date -u +%FT%TZ)] harness restarted pid=$!" >> $LOG
}

while [ $(date +%s) -lt $END_EPOCH ]; do
  TS=$(date -u +%FT%TZ)
  # 1. Server health
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:4320/api/health 2>/dev/null)
  # 2. Harness liveness (process must exist)
  if pgrep -f "$HARNESS_PATTERN" > /dev/null 2>&1; then
    HARNESS="alive"
  else
    HARNESS="DEAD"
  fi

  if [ "$CODE" = "200" ] && [ "$HARNESS" = "alive" ]; then
    echo "[$TS] OK server=200 harness=alive" >> $LOG
  else
    echo "[$TS] FAIL server=$CODE harness=$HARNESS" >> $LOG
    if [ "$HARNESS" = "DEAD" ] && [ "$CODE" = "200" ]; then
      restart_harness
    fi
    # If server is down too, don't restart harness — server needs attention.
  fi
  sleep 300
done
echo "[$(date -u +%FT%TZ)] soak monitor v2 finished (168h elapsed)" >> $LOG
