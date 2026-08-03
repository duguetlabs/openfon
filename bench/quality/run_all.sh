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

# Overrideable like the arm lists. It was a bare assignment, which silently
# ignored the documented CONDITIONS= override and ran all eight conditions for
# the 2.1 extension — 800 ASR rows where the reports describe 600, at the
# service's expense, and unable to reproduce the committed asymmetric matrix.
CONDITIONS="${CONDITIONS:-clean,cafe_snr20,cafe_snr10,cafe_snr5,cafe_snr0,tel,tel_cafe_snr10,tel_loss3}"
# Scenario subset for Track B, passed to run_scenarios.py --only. Empty means
# every scenario in the fixture. The 2.1 arms ran the nine *scored* scenarios
# and skipped the two barge-in ones, which is why they have 27 runs against the
# incumbents' 33; without this the extension produces 99 runs, not 81.
ONLY="${ONLY:-}"
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
# directory, APPEND=1 to add arms to a run already there, or FORCE=1 if you
# really mean to replace what is there. FORCE=1 covers `results/` only —
# replacing raw logs is FORCE_LOGS=1, and the two are separate on purpose: a
# result can be rebuilt from its log, a log can be rebuilt only by paying again.
#
# APPEND exists because the committed matrix is a base pass plus an extension:
# without it, reproducing it means running each block to its own directory and
# concatenating the jsonl files by hand, which is exactly the kind of step that
# gets done wrong. Appending destroys nothing, so it does not need the guard.
# Validate the selections BEFORE anything is truncated. A malformed list is not
# an empty one: `CONDITIONS=','` bypassed the default, run_asr.py parsed zero
# conditions and exited 0, and this script had already emptied asr.jsonl and
# went on to report the full Track A matrix as successful — real data cleared by
# a run that then did nothing. Checking after the truncation would report the
# failure and still have destroyed the file.
nonempty() {  # nonempty <var-name> <value>
  case "$(printf '%s' "$2" | tr -d ' ,')" in
    "") echo "$1 is set to '$2', which names nothing. Unset it for the" >&2
        echo "  default, or give a comma-separated list." >&2
        exit 2 ;;
  esac
}
[ -n "${CONDITIONS:-}" ] && nonempty CONDITIONS "$CONDITIONS"
[ -n "${ONLY:-}" ]       && nonempty ONLY "$ONLY"
[ -n "${ASR_ARMS:-}" ]   && nonempty ASR_ARMS "$ASR_ARMS"
[ -n "${SC_ARMS:-}" ]    && nonempty SC_ARMS "$SC_ARMS"

# A repeated arm runs the same unit twice into the same raw log, so the run
# collides with itself and the preflight below cannot see it — the second pass
# finds the log populated and aborts after the first has been billed. Deduping
# quietly would hide a typo that costs money; naming it does not.
nodup() {  # nodup <var-name> <space-separated value>
  local d
  d="$(printf '%s\n' $2 | sort | uniq -d | tr '\n' ' ')"
  if [ -n "${d% }" ]; then
    echo "$1 names ${d% } more than once. Each arm writes its own raw logs," >&2
    echo "  so a repeat would overwrite the log the first pass paid for." >&2
    exit 2
  fi
}
nodup ASR_ARMS "$ASR_ARMS"
nodup SC_ARMS "$SC_ARMS"

APPEND="${APPEND:-0}"
# Only the files this invocation will actually truncate. The guard used to
# check both regardless of TRACK, so TRACK=a refused to start because
# scenarios.jsonl was populated — a file it never touches. A guard that blocks
# a run which would destroy nothing teaches people to reach for FORCE=1, which
# is the one habit this guard exists to prevent.
GUARDED=""
want_a() { [ "${TRACK:-both}" = "a" ] || [ "${TRACK:-both}" = "both" ]; }
want_b() { [ "${TRACK:-both}" = "b" ] || [ "${TRACK:-both}" = "both" ]; }
want_a && GUARDED="$OUT/results/asr.jsonl"
want_b && GUARDED="$GUARDED $OUT/results/scenarios.jsonl"
if [ "${FORCE:-0}" != "1" ] && [ "$APPEND" != "1" ]; then
  for f in $GUARDED; do
    if [ -s "$f" ]; then
      echo "refusing to truncate $f ($(wc -l < "$f" | tr -d ' ') rows)." >&2
      echo "  These are the committed results the reports quote. To run a new" >&2
      echo "  study:      OUT=/tmp/mybench DATA=\$DATA ./run_all.sh" >&2
      echo "  To add arms to that run:   APPEND=1 OUT=/tmp/mybench ..." >&2
      echo "  To deliberately replace them:   FORCE=1 ..." >&2
      exit 2
    fi
  done
fi

# Raw logs are guarded separately from results, and replacing them is a separate
# decision: they are the only artifact a result can be re-scored from without
# paying for the call again, so FORCE=1 deliberately does NOT imply this.
LOG_REPLACE=""
[ "${FORCE_LOGS:-0}" = "1" ] && LOG_REPLACE="--force-logs"
PREFLIGHT=""   # set to --preflight-logs for the collision pass below

FAILURES=()
run() {  # run <label> <cmd...>
  local label="$1"; shift
  if ! "$@"; then
    echo "FAILED: $label" >&2
    FAILURES+=("$label")
  fi
}

# engines.LOG_COLLISION_EXIT. A preflight that fails for any *other* reason —
# no interpreter, a bad argument, an import error — is not a log collision, and
# saying it is sends the next person to the wrong problem. Both stop the run
# before anything is truncated; they are reported as what they are.
LOG_COLLISION_EXIT=97
COLLISIONS=0
BROKEN=0
pre() {  # pre <label> <cmd...> — same invocation, --preflight-logs appended
  local label="$1" rc; shift
  "$@"; rc=$?
  case "$rc" in
    0) ;;
    "$LOG_COLLISION_EXIT")
      echo "  ^ $label would replace raw logs it must not" >&2
      COLLISIONS=$((COLLISIONS + 1)) ;;
    *)
      echo "  ^ $label: preflight exited $rc — see its message above. This is" >&2
      echo "    NOT a log collision; the logs may be fine." >&2
      BROKEN=$((BROKEN + 1)) ;;
  esac
}

# The matrix, defined once and walked twice: once to check the raw logs, once to
# run. Duplicating the loops would let the two drift, and a preflight that
# checks a different set of files from the one the run writes is no preflight.
track_a() {  # track_a <run|pre>
  for arm in $ASR_ARMS; do
    for lang in en_us de_de; do
      [ -n "$PREFLIGHT" ] || echo "=== ASR $arm $lang"
      "$1" "asr/$arm/$lang" "$PY" run_asr.py --arm "$arm" --lang "$lang" \
        --conditions "$CONDITIONS" --data "$DATA/conditions" --n "$N" \
        --out $OUT/results/asr.jsonl --logdir "$OUT/logs" \
        $LOG_REPLACE $PREFLIGHT
    done
  done
}

track_b() {  # track_b <run|pre>
  for trial in $(seq 1 "$TRIALS"); do
    for arm in $SC_ARMS; do
      [ -n "$PREFLIGHT" ] || echo "=== SCENARIOS $arm trial $trial"
      "$1" "scenarios/$arm/t$trial" "$PY" run_scenarios.py --arm "$arm" \
        --trial "$trial" --audio "$DATA/scenarios" \
        ${ONLY:+--only "$ONLY"} \
        --out $OUT/results/scenarios.jsonl --logdir "$OUT/logs" \
        $LOG_REPLACE $PREFLIGHT
    done
  done
}

# Preflight the raw logs BEFORE the truncation below. FORCE=1 emptied
# $OUT/results/*.jsonl and then never forwarded a log-replacement option, so
# every existing log made the first runner abort in engines.open_log: the
# results were erased and the forced replacement could not be produced.
# Destroy-then-recreate is safe only when the recreate cannot fail, and that one
# failed by construction. Each runner reports its own collisions and exits
# non-zero, doing no work and touching nothing.
PREFLIGHT="--preflight-logs"
want_a && track_a pre
want_b && track_b pre
PREFLIGHT=""
if [ "$COLLISIONS" -gt 0 ]; then
  echo >&2
  echo "$COLLISIONS runner invocation(s) refused their raw logs (above)." >&2
  echo "  Nothing has been truncated. Send this run somewhere new:" >&2
  echo "      OUT=/tmp/mybench DATA=\$DATA ./run_all.sh" >&2
  echo "  or, if you really mean to overwrite those logs:  FORCE_LOGS=1 ..." >&2
  exit 2
fi
if [ "$BROKEN" -gt 0 ]; then
  echo >&2
  echo "$BROKEN preflight(s) refused for a reason other than a log collision" >&2
  echo "  (above) — an unknown arm, a missing data root, a broken interpreter." >&2
  echo "  This run is not certified safe to start. Nothing has been truncated." >&2
  exit 2
fi

if want_a; then
  [ "$APPEND" = "1" ] || : > $OUT/results/asr.jsonl
  track_a run
fi

if want_b; then
  [ "$APPEND" = "1" ] || : > $OUT/results/scenarios.jsonl
  track_b run
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo >&2
  echo "${#FAILURES[@]} runner invocation(s) failed:" >&2
  printf '  %s\n' "${FAILURES[@]}" >&2
  echo "The result files are INCOMPLETE — do not score them as a finished run." >&2
  exit 1
fi

echo "done — all runner invocations succeeded"
