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
  # Safe kill by exact verified PID (never pkill -f: it can self-match the
  # checking command or hit a wrapper shell). Only processes whose command
  # line is actually "node .../qa/soak/soak.js" get killed.
  for pid in $(harness_pids); do
    echo "[$(date -u +%FT%TZ)] killing stale harness pid=$pid" >> $LOG
    kill "$pid" 2>/dev/null
  done
  sleep 2
  # setsid so the new harness survives this worker run ending (plain
  # nohup ... & children get SIGTERM'd when a short-lived run exits).
  SOAK_CHAOS_DB=/home/hatch/workspace/goals/expo-line-pos-beat-toast-spoton-pilot-at-bali-hai/soak-20260926.db \
    setsid nohup node qa/soak/soak.js >> qa/soak/soak_stdout.log 2>&1 < /dev/null &
  sleep 3
  NEWPID=$(harness_pids | head -n 1)
  echo "[$(date -u +%FT%TZ)] harness restarted pid=${NEWPID:-unknown}" >> $LOG
}

# Prints PIDs verified to be the node soak harness: full command line must be
# "node .../qa/soak/soak.js" (wrapper shells excluded, our own PID excluded).
harness_pids() {
  pgrep -f "$HARNESS_PATTERN" 2>/dev/null | while read -r pid; do
    [ -z "$pid" ] && continue
    [ "$pid" = "$$" ] && continue
    ARGS=$(ps -p "$pid" -o args= 2>/dev/null) || continue
    case "$ARGS" in
      "node "*"qa/soak/soak.js"*)
        echo "$pid" ;;
    esac
  done
}

# Disk-space guard (2026-09-27): /tmp exhaustion silently killed a soak run.
# df-based; on low space, rotate runaway logs (truncate to last 2000 lines —
# append-mode writers keep working) and log a warning. Never kills anything.
disk_guard() {
  for d in /tmp "$BUILD"; do
    FREE_KB=$(df -k --output=avail "$d" 2>/dev/null | tail -n 1 | tr -d ' ')
    case "$FREE_KB" in ''|*[!0-9]*) continue ;; esac
    if [ "$FREE_KB" -lt 512000 ]; then
      echo "[$(date -u +%FT%TZ)] DISK WARN: only $((FREE_KB / 1024))MB free on $d — rotating logs" >> $LOG
      for f in "$LOG" "$BUILD/qa/soak/soak.log" "$BUILD/qa/soak/soak_stdout.log"; do
        if [ -f "$f" ]; then
          tail -n 2000 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
        fi
      done
    fi
  done
}

while [ $(date +%s) -lt $END_EPOCH ]; do
  TS=$(date -u +%FT%TZ)
  # 1. Server health
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:4320/api/health 2>/dev/null)
  # 2. Harness liveness (verified node-harness process must exist)
  if [ -n "$(harness_pids)" ]; then
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
  # 3. Disk-space guard (log rotation only; never kills the harness)
  disk_guard
  sleep 300
done
echo "[$(date -u +%FT%TZ)] soak monitor v2 finished (168h elapsed)" >> $LOG
