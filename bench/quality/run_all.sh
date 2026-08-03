#!/usr/bin/env bash
# Drive the full matrix. Arms and conditions run strictly serially — parallel
# session opens inflated connect time to 3.6 s in earlier recon, and the point
# of this run is to compare engines, not to measure our own concurrency.
#
# A partial run must not look like a complete one. Every runner invocation is
# checked, failures are collected, and the script exits non-zero listing them.
# The previous version had neither: a Python runner exiting non-zero did not
# stop or record anything, and the trailing `echo` made the script exit 0
# regardless, so a half-finished matrix was scored as though it were whole.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PY:-$HERE/../../../venv/bin/python}"
DATA="${DATA:?set DATA to the conditions/scenarios data root}"
N="${N:-25}"
TRIALS="${TRIALS:-3}"

CONDITIONS="clean,cafe_snr20,cafe_snr10,cafe_snr5,cafe_snr0,tel,tel_cafe_snr10,tel_loss3"
# Track A arms only. vl-native-brain is excluded on purpose: Voice Live rejects
# manual-commit transcription on the gpt-realtime-2 brain ("turn_detection must
# be of type AzureSemanticVAD"), so it cannot be put on the same footing as the
# others. Voice Live's STT is azure-speech regardless of brain, so vl-gpt41mini
# carries the Voice Live STT result; the Track B caller transcripts re-check that.
ASR_ARMS="${ASR_ARMS:-vl-gpt41mini vl-gpt41mini-dns native-gpt-realtime-2}"
# All five Track B arms. vl-gpt41mini-semvad is the VAD control that keeps the
# brain comparison VAD-neutral, and the report depends on it: omitting it yields
# 132 calls where the report describes 165.
SC_ARMS="${SC_ARMS:-vl-gpt41mini vl-gpt41mini-dns vl-gpt41mini-semvad vl-native-brain native-gpt-realtime-2}"

# Where results and logs go. Overridable so a test — or a second run — cannot
# truncate a finished run's output: the destructive `: >` below writes here.
OUT="${OUT:-$HERE}"
cd "$HERE"
mkdir -p "$OUT/results" "$OUT/logs"

# Refuse to truncate committed results. The `: >` below empties asr.jsonl and
# scenarios.jsonl, and OUT defaults to the repository's own results directory —
# so running this in a clean checkout destroys the data both published reports
# are derived from, and replaces it with a smaller study under a different arm
# set. That is the same in-place overwrite that made the merged report's figures
# unreproducible, except reached by following the documented procedure.
#
# A re-run is fine; it just has to say where it is going. Set OUT to a new
# directory, or FORCE=1 if you really mean to replace what is there.
if [ "${FORCE:-0}" != "1" ]; then
  for f in "$OUT/results/asr.jsonl" "$OUT/results/scenarios.jsonl"; do
    if [ -s "$f" ]; then
      echo "refusing to truncate $f ($(wc -l < "$f" | tr -d ' ') rows)." >&2
      echo "  These are the committed results the reports quote. To run a new" >&2
      echo "  study:   OUT=/tmp/mybench DATA=\$DATA ./run_all.sh" >&2
      echo "  To deliberately replace them:   FORCE=1 ..." >&2
      exit 2
    fi
  done
fi

FAILURES=()
run() {  # run <label> <cmd...>
  local label="$1"; shift
  if ! "$@"; then
    echo "FAILED: $label" >&2
    FAILURES+=("$label")
  fi
}

if [ "${TRACK:-both}" = "a" ] || [ "${TRACK:-both}" = "both" ]; then
  : > $OUT/results/asr.jsonl
  for arm in $ASR_ARMS; do
    for lang in en_us de_de; do
      echo "=== ASR $arm $lang"
      run "asr/$arm/$lang" "$PY" run_asr.py --arm "$arm" --lang "$lang" \
        --conditions "$CONDITIONS" --data "$DATA/conditions" --n "$N" \
        --out $OUT/results/asr.jsonl --logdir "$OUT/logs"
    done
  done
fi

if [ "${TRACK:-both}" = "b" ] || [ "${TRACK:-both}" = "both" ]; then
  : > $OUT/results/scenarios.jsonl
  for trial in $(seq 1 "$TRIALS"); do
    for arm in $SC_ARMS; do
      echo "=== SCENARIOS $arm trial $trial"
      run "scenarios/$arm/t$trial" "$PY" run_scenarios.py --arm "$arm" \
        --trial "$trial" --audio "$DATA/scenarios" \
        --out $OUT/results/scenarios.jsonl --logdir "$OUT/logs"
    done
  done
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo >&2
  echo "${#FAILURES[@]} runner invocation(s) failed:" >&2
  printf '  %s\n' "${FAILURES[@]}" >&2
  echo "The result files are INCOMPLETE — do not score them as a finished run." >&2
  exit 1
fi

echo "done — all runner invocations succeeded"
