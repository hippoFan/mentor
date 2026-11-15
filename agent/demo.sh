#!/usr/bin/env bash
# Keeps Mentor and the Chert connector alive for a demo: restarts either one if it exits.
#   ./demo.sh                      (Gemini brain; for judges/anyone)
#   ODY_BRAIN=claude-code ODY_OWNER_TESTING=1 ./demo.sh   (owner testing only)
# Logs: ../logs/agent.log, ../logs/chert-dev.log, ../logs/record.log (+ ../logs/sessions/). Ctrl+C stops all.
set -u
cd "$(dirname "$0")"
LOGS=../logs; mkdir -p "$LOGS"
AGENT_NAME=$(node --env-file=../.env -e 'process.stdout.write(process.env.AGENT_NAME||"mentor-hackuta")')
# Judges always get Gemini unless told otherwise (an ANTHROPIC_API_KEY in .env would otherwise pick the Claude API).
export ODY_BRAIN="${ODY_BRAIN:-${MENTOR_BRAIN:-gemini}}"
export ODY_TASK="${ODY_TASK:-Help the caller with whatever hands-on project or object they show you}"
trap 'kill 0; exit 0' INT TERM
keep() {   # keep <name> <log> <cmd...>
  local name=$1 log=$2; shift 2
  while true; do
    echo "[demo] $(date +%T) starting $name" | tee -a "$log"
    "$@" >>"$log" 2>&1
    echo "[demo] $(date +%T) $name exited ($?); restarting in 3 s" | tee -a "$log"
    sleep 3
  done
}
: > "$LOGS/agent.log"; : > "$LOGS/chert-dev.log"; : > "$LOGS/hub.log"
keep hub "$LOGS/hub.log" node --env-file=../.env hub.mjs &      # the laptop page, always on (http://localhost:8790 and /twin)
sleep 2
keep record "$LOGS/record.log" node record.mjs &   # every call -> ../logs/sessions/<time>.jsonl (replay.mjs plays it back)
keep agent "$LOGS/agent.log" node --env-file=../.env agent.mjs start &
sleep 6
keep chert "$LOGS/chert-dev.log" chert dev --agent "$AGENT_NAME" --takeover &
echo "[demo] running. Laptop screen: http://localhost:8790   3D twin: http://localhost:8790/twin   Ctrl+C to stop."
echo "[demo] presenting? in another pane: npm run watchdog -- --arm 60   (no call in 60 s -> backup demo; b = backup now, s = stop)"
wait
