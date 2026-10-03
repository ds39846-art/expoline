#!/usr/bin/env bash
# Runs the :4317 sequence family in its designed order against ONE scratch
# server with a fresh DB: test1_flow -> test2_roles -> test3_finance.
#
# Why a sequence: test3's assertions audit the exact finance state that
# test1 (group checks, seat splits, the move-target payment) and test2
# (refunded-then-cash-settled soda) create on the same server. That coupling
# is intentional (see test3's comments); test3 now fails fast with a
# PRECONDITION MISSING diagnostic when run standalone. test1 and test2 each
# also pass standalone; test2 builds its own fixtures.
set -u
cd "$(dirname "$0")/.."
PORT="${SEQ_PORT:-4317}"
DB="$(mktemp -u /tmp/expoline-seq-XXXXXX.db)"  # -u: name only — the server seeds only when the file is ABSENT
LOG="$(mktemp /tmp/expoline-seq-XXXXXX.log)"
EXPOLINE_DB="$DB" EXPOLINE_PORT="$PORT" setsid nohup node server.js >"$LOG" 2>&1 < /dev/null &
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"; }
trap cleanup EXIT
for i in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
PID="$(lsof -ti:"$PORT" | head -1)"
if [ -z "$PID" ]; then echo "server did not start on :$PORT — see $LOG"; exit 1; fi
export EXPOLINE_BASE="http://localhost:$PORT"
fail=0
for t in test1_flow test2_roles test3_finance; do
  echo "=== $t ==="
  python3 "qa/$t.py" || fail=1
done
exit $fail
