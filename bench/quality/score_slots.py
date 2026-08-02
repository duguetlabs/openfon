"""Programmatic Track B scoring — everything with an objectively right answer.

Deliberately kept away from the LLM judge. Whether the agent captured the phone
number `015228817386` is a string comparison, not a matter of opinion, and a
judge asked to rule on it will occasionally be charitable. The judge only gets
the soft dimensions (see judge.py).

Checks per scenario run
  slot_acc        fraction of expected slots present in the agent's own words
  slots_all       1 if every expected slot was captured
  tool_ok         expected tools called, and no forbidden behaviour
  grounded_hit    every `grounded_facts` string present
  forbidden_hit   any `forbidden` string present (a failure)
  lang_ok         final agent turn is in the expected language

  python score_slots.py --runs results/scenarios.jsonl --out results/slots.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prepare"))
from score_wer import NUM_LANG, normalize  # noqa: E402

from num2words import num2words  # noqa: E402

DIGITS = re.compile(r"\D+")

# Cheap, dependency-free language ID over closed-class words. Enough to tell
# German from English, which is all `codeswitch-01` needs.
DE_MARKERS = {"und", "die", "der", "das", "ist", "sie", "wir", "haben", "nicht",
              "einen", "gerne", "uhr", "bitte", "danke", "termin", "geschlossen"}
EN_MARKERS = {"and", "the", "is", "you", "we", "have", "not", "an", "please",
              "thanks", "appointment", "closed", "our", "can"}


def detect_lang(text: str) -> str | None:
    toks = set(re.findall(r"[a-zäöüß]+", text.lower()))
    de, en = len(toks & DE_MARKERS), len(toks & EN_MARKERS)
    if de == en:
        return None
    return "de" if de > en else "en"


MERIDIEM = r"(?:\s*(a\.?m\.?|p\.?m\.?))?"
CLOCK_MENTION = re.compile(
    rf"\b(\d{{1,2}})(?::(\d{{2}}))?\s*(uhr|o'?clock|h)?{MERIDIEM}", re.I)


def _word_hours(lang: str) -> dict[str, int]:
    """Spelled-out hour names for this language, 0–24, via the normaliser."""
    code = NUM_LANG.get(lang.split("_")[0].lower())
    out: dict[str, int] = {}
    if not code:
        return out
    for n in range(25):
        try:
            out[normalize(num2words(n, lang=code), lang)] = n
        except Exception:  # noqa: BLE001 - a missing word form is not fatal
            pass
    return out


def times_mentioned(text: str, lang: str) -> list[tuple[int | None, int | None]]:
    """Every clock time the text asserts, as (hour24 or None, minute or None).

    `None` for the hour means "a spoken hour with no meridiem", which is
    ambiguous between H and H+12 and is resolved by the caller. Parsing
    mentions and comparing them semantically replaces the old approach of
    building a regex per expected value: that pattern made the suffix optional
    and dropped the minutes, so expected `14:00` matched `2:30`, `2 AM` and a
    bare `2` alike — semantically wrong appointment times satisfying a strict
    check.
    """
    # Each entry carries the string it was found in and the offset within it, so
    # a caller can ask whether the mention sits inside a negation.
    found: list[tuple[int | None, int | None, str, int]] = []
    # Apostrophes become spaces so "can't" tokenises the way NEGATORS expects.
    # Same-length substitution, so the offsets recorded below stay valid.
    low = text.lower().replace("'", " ").replace("\u2019", " ")
    for m in CLOCK_MENTION.finditer(text):
        hour, minute, suffix, mer = (int(m.group(1)), m.group(2),
                                     (m.group(3) or "").lower(), (m.group(4) or "").lower())
        if hour > 24:
            continue
        mm = int(minute) if minute is not None else None
        at = m.start()
        if mer.startswith("p"):
            found.append(((hour % 12) + 12, mm, low, at))
        elif mer.startswith("a"):
            found.append((hour % 12, mm, low, at))
        elif hour > 12 or suffix in ("uhr", "h"):
            found.append((hour, mm, low, at))   # 24-hour reading is unambiguous
        else:
            found.append((None, mm, low, at))   # bare "2"/"2 o'clock": ambiguous
            found.append((hour, mm, low, at))
            found.append((hour + 12, mm, low, at))
    # Spelled-out hours, scanned over text with the DIGITS REMOVED FIRST.
    # `normalize` expands digits into words, so normalising "2:30" yields "two
    # thirty" and a naive word scan finds "two" — re-admitting exactly the wrong
    # times the digit pass just rejected ("2:30", "2 AM", "15:30" all matched an
    # expected 14:00/15:00 this way). Only genuinely spoken hours should reach here.
    words = _word_hours(lang)
    norm = normalize(re.sub(r"\d+", " ", text), lang)
    for w, n in words.items():
        if not w:
            continue
        wm = re.search(rf"\b{re.escape(w)}\b", norm)
        if wm:
            found.append((n, None, norm, wm.start()))
            if n <= 12:
                found.append((n + 12, None, norm, wm.start()))
    return found


def time_matches(text: str, value: str, lang: str, reject_negated: bool = False) -> bool:
    """Does `text` assert the clock time `value` (HH:MM)?

    A mention matches only if the hour agrees *and* the minutes do not
    disagree: an expected 14:00 is satisfied by "2 PM", "14 Uhr", "at two" or
    "14:00", but not by "2:30" (wrong minutes) or "2 AM" (wrong meridiem).
    """
    hh_s, _, mm_s = value.partition(":")
    try:
        want_h, want_m = int(hh_s), int(mm_s or 0)
    except ValueError:
        return normalize(value, lang) in normalize(text, lang)
    for hour, minute, ctx, at in times_mentioned(text, lang):
        if hour is None or hour != want_h:
            continue
        if minute is not None and minute != want_m:
            continue
        if reject_negated and negated_before(ctx, at):
            continue        # "not 10:00 — I meant 14:00" does not assert 10:00
        return True
    return False


def slot_present(agent_text: str, key: str, accepted: list[str], lang: str) -> bool:
    """Is any accepted value for this slot present in the text?

    Numeric slots are compared as digit strings so that "015228817386",
    "0152 288 17386" and "0152-288-17386" all count. Times go through
    `time_forms` so 12-hour and spoken forms count. Everything else goes through
    the same per-language normaliser as the WER path, so `Schröder` matches
    `Schroeder` rather than scoring as a miss.
    """
    if key in ("phone", "day_of_month"):
        hay = DIGITS.sub("", agent_text)
        for v in accepted:
            want = DIGITS.sub("", v)
            if not want:
                continue
            if want in hay:
                return True
            # National 0-prefixed forms and international ones are the same
            # number: "0152 288 17386" == "+49 152 28817386". Matching the
            # trunk-code-stripped tail catches both without hardcoding a
            # country code (the fixture business is in Vienna, callers are not).
            if key == "phone" and want.startswith("0") and want[1:] in hay:
                return True
        return False
    if key == "final_language":
        return detect_lang(agent_text) in accepted
    if key in ("time_after", "new_time"):
        return any(time_matches(agent_text, v, lang) for v in accepted)
    hay = normalize(agent_text, lang)
    return any(normalize(v, lang) in hay for v in accepted)


CLOCK_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")

# Negators as they appear AFTER normalisation. The normaliser replaces
# punctuation with a space, so "aren't" becomes "aren t" — two tokens, not
# "arent". The first version of this list assumed the latter and therefore
# matched only phrasings nobody uses: "We aren't open on Saturday" and "We
# don't close at 17:00" both sailed through as forbidden claims. Both the
# split stem and the joined form are listed, since which one appears depends
# on whether the source text used a typographic or ASCII apostrophe.
NEGATORS = {
    "not", "no", "never", "cannot", "unfortunately", "afraid", "without",
    # split stems left behind by apostrophe removal: aren't -> "aren" + "t"
    "aren", "arent", "isn", "isnt", "don", "dont", "doesn", "doesnt",
    "won", "wont", "can", "cant", "couldn", "couldnt", "wouldn", "wouldnt",
    "haven", "havent", "hasn", "hasnt", "didn", "didnt",
    "nicht", "kein", "keine", "keinen", "keiner", "keinem", "nie", "leider",
}
NEGATION_WINDOW = 6


def negated_before(norm_text: str, index: int) -> bool:
    """Is the phrase at `index` inside a negation?

    Substring matching cannot tell "We are open on Saturday" from "We are NOT
    open on Saturday", so a correct denial matched the forbidden claim it was
    denying — and any forbidden hit is a hard failure, so correct answers and
    self-corrections were scored as failures. Looks back a few tokens, which is
    crude but covers the constructions these scenarios actually produce.
    """
    before = norm_text[:index].split()
    return any(tok in NEGATORS for tok in before[-NEGATION_WINDOW:])


def time_in(text: str, value: str, lang: str) -> bool:
    """Does `text` *assert* the clock time `value`, negations excluded?"""
    return time_matches(text, value, lang, reject_negated=True)


def fact_present(utterances: list[str], fact: str, lang: str) -> bool:
    """Is `fact` asserted inside a *single* utterance?

    Two things this must not do.

    Match across turn boundaries: joining every agent turn into one string and
    substring-matching lets "…Monday, 17:00…" from one turn plus "On Fridays…
    14:00" from another synthesise the forbidden claim "17:00 on Friday" out of
    two correct answers. Facts are asserted in an utterance, so that is the unit.

    Compare clock times as text: `normalize("14:00")` is "vierzehn null", which
    never matches "vierzehn uhr" or "2 PM". Every time-valued grounded fact was
    therefore unsatisfiable, and a correct answer scored as ungrounded. Clock
    components are compared temporally via `time_forms`; the rest of the fact is
    still a normalised substring, and both must hold in the same utterance.
    """
    m = CLOCK_RE.search(fact)
    rest = (fact[:m.start()] + " " + fact[m.end():]).strip() if m else fact
    want_rest = normalize(rest, lang) if rest else ""
    for u in utterances:
        if m and not time_in(u, m.group(0), lang):
            continue
        norm_u = normalize(u, lang)
        if want_rest:
            at = norm_u.find(want_rest)
            if at < 0:
                continue
            if negated_before(norm_u, at):
                continue
        return True
    return False


def score_run(run: dict, spec: dict) -> dict:
    sc = next(s for s in spec["scenarios"] if s["id"] == run["scenario"])
    exp = sc["expected"]
    lang = "de" if sc["lang"].startswith("de") else "en"
    agent_text = " ".join(m["text"] for m in run.get("transcript", [])
                          if m["role"] == "agent")

    # Two different questions, deliberately kept apart.
    #
    #   heard  — the value appears in the engine's OWN caller transcript, i.e.
    #            its ASR got it right. This is the understanding metric, and it
    #            is what decides whether the business ends up with the correct
    #            phone number.
    #   echoed — the value appears in the agent's own words, i.e. it confirmed
    #            back to the caller. That is prompt/brain behaviour, not
    #            recognition: an agent that silently records the name correctly
    #            and moves on is not wrong, it just does not confirm.
    #
    # Scoring only `echoed` (the first version of this) marks a correct agent
    # down for being terse, which is why success is keyed on `heard`.
    caller_text = " ".join(m["text"] for m in run.get("transcript", [])
                           if m["role"] == "caller_asr")
    # `final_language` is not an ASR slot: it asks whether the *agent* switched
    # languages, so neither the caller transcript (which tests what the caller
    # said) nor the joined agent turns (where earlier German drowns out a correct
    # English reply) answers it. Both were wrong, in opposite directions. It is
    # scored from the agent's last turn, which is what "final" means.
    final_agent = next((m["text"] for m in reversed(run.get("transcript", []))
                        if m["role"] == "agent"), "")

    def source(key: str, default: str) -> str:
        return final_agent if key == "final_language" else default

    slots = exp.get("slots") or {}
    heard = {k: slot_present(source(k, caller_text), k, v, lang)
             for k, v in slots.items()}
    hits = {k: slot_present(source(k, agent_text), k, v, lang)
            for k, v in slots.items()}
    called = set(run.get("tool_calls") or [])
    want_tools = set(exp.get("tool_calls") or [])

    agent_utterances = [m["text"] for m in run.get("transcript", [])
                        if m["role"] == "agent"]
    grounded = [g for g in exp.get("grounded_facts") or []
                if fact_present(agent_utterances, g, lang)]
    forbidden = [f for f in exp.get("forbidden") or []
                 if fact_present(agent_utterances, f, lang)]

    turns = run.get("turns", [])
    ttfa = [t["ttfa_ms"] for t in turns if t.get("ttfa_ms")]
    barges = [t for t in turns if t.get("barge_in")]
    barge = [t["bargein_stop_ms"] for t in barges if t.get("bargein_stop_ms") is not None]
    inflight = [t for t in barges if t.get("response_inflight")]

    # Barge-in adoption is a property of what the agent said *after* being
    # interrupted, not of the caller transcript. Deriving it from `heard` (the
    # first version) scored an accurately transcribed correction as adopted even
    # when the agent carried on using the old value — i.e. it could not detect
    # the failure it exists to detect.
    bargein_correct = ""
    if barges:
        first = next(i for i, t in enumerate(turns) if t.get("barge_in"))
        post = [t.get("agent_text") or "" for t in turns[first:]]
        post_joined = " ".join(post)
        checks = [slot_present(post_joined, k, v, lang) for k, v in slots.items()]
        checks += [not fact_present(post, f, lang)
                   for f in exp.get("forbidden") or []]
        bargein_correct = int(all(checks)) if checks else ""

    return {
        "arm": run["arm"], "trial": run["trial"], "scenario": run["scenario"],
        "lang": sc["lang"], "intent": sc["intent"],
        # Scenarios opted out of scoring still get a row — the transcript is the
        # point — but summarize.py drops them before any aggregate.
        "scored": int(sc.get("scored", True)),
        "n_slots": len(slots),
        "slot_heard": round(sum(heard.values()) / len(slots), 3) if slots else "",
        "slots_all_heard": int(all(heard.values())) if slots else "",
        "missed_heard": ",".join(k for k, v in heard.items() if not v),
        "slot_echoed": round(sum(hits.values()) / len(slots), 3) if slots else "",
        "slots_all_echoed": int(all(hits.values())) if slots else "",
        "missed_echoed": ",".join(k for k, v in hits.items() if not v),
        "tools_called": ",".join(sorted(called)),
        "tool_ok": int(want_tools <= called),
        "grounded_n": len(exp.get("grounded_facts") or []),
        "grounded_hit": len(grounded),
        "grounded_ok": int(len(grounded) == len(exp.get("grounded_facts") or [])),
        "forbidden_hit": len(forbidden),
        "forbidden_terms": ",".join(forbidden),
        # Every caller turn's latency, not just this call's median. Collapsing
        # to a median here and taking a percentile of medians in summarize.py
        # discards the single slow response inside an otherwise normal call —
        # exactly the event a p95 exists to capture.
        # Turn attribution is unreliable once a response was cancelled: the
        # replacement used to be recorded against the *next* turn (see the
        # runner). Transcripts are unaffected — they are appended in arrival
        # order — so slots, grounding and success are sound either way; only
        # the per-turn latencies are suspect, and summarize.py drops them.
        "ttfa_trustworthy": int(not run.get("response_cancellations")),
        "ttfa_ms_all": ";".join(f"{v:.1f}" for v in ttfa),
        "ttfa_p50_ms": round(sorted(ttfa)[len(ttfa) // 2], 1) if ttfa else "",
        "bargein_attempts": len(barges),
        "bargein_inflight": len(inflight),
        "bargein_stop_ms": round(barge[0], 1) if barge else "",
        # Did the agent adopt the corrected value after being interrupted? This,
        # not the stop latency, is what a caller actually cares about.
        "bargein_correct": bargein_correct,
        "agent_turns": sum(1 for m in run.get("transcript", []) if m["role"] == "agent"),
        "n_turns_expected": len(sc["turns"]),
        "session_s": run.get("session_s", ""),
        "error": run.get("error") or "",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--scenarios", default="fixtures/scenarios.json")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    spec = json.loads(Path(a.scenarios).read_text())
    runs = [json.loads(l) for l in Path(a.runs).read_text().splitlines() if l.strip()]
    rows = [score_run(r, spec) for r in runs]

    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {a.out}")


if __name__ == "__main__":
    main()
