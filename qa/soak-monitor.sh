#!/bin/bash
# Expoline soak monitor — checks :4320 health every 5 min for 168 hours.
# Logs to /tmp/soak4320-monitor.log. Started 2026-09-26 ~06:55 PDT.
# Expected end: 2026-10-03 ~06:55 PDT.
END_EPOCH=$(($(date +%s) + 168*3600))
LOG=/tmp/soak4320-monitor.log
echo "[$(date -u +%FT%TZ)] soak monitor started, ends at $(date -u -d @$END_EPOCH +%FT%TZ)" >> $LOG
while [ $(date +%s) -lt $END_EPOCH ]; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:4320/api/health 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo "[$(date -u +%FT%TZ)] OK" >> $LOG
  else
    echo "[$(date -u +%FT%TZ)] FAIL code=$CODE" >> $LOG
  fi
  sleep 300
done
echo "[$(date -u +%FT%TZ)] soak monitor finished (168h elapsed)" >> $LOG
