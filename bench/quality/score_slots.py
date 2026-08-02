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


TIME_SUFFIX = r"(?:\s*(?::00|\.00|h|uhr|o'?clock|am|pm|a\.m\.|p\.m\.))?"


def time_forms(value: str, lang: str) -> list[str]:
    """Surface forms a speaker might use for a 24-hour `HH:MM` time.

    A caller who wants 14:00 says "at two", and the agent confirms "2 PM".
    Matching only the literal "14" scores every one of those as a miss — which
    is what the first version of this did, silently marking `new_time` wrong on
    all 15 reschedule runs where every arm had in fact got it right. A slot
    matcher that fails closed moves every number in the report without failing
    anything, so it is pinned by tests.
    """
    hh_s, _, mm_s = value.partition(":")
    try:
        hh = int(hh_s)
    except ValueError:
        return [re.escape(value.lower())]
    hh12 = hh % 12 or 12
    mm = mm_s or "00"

    forms = {re.escape(f"{hh:02d}:{mm}"), re.escape(f"{hh}:{mm}")}
    code = NUM_LANG.get(lang.split("_")[0].lower())
    for n in {hh, hh12}:
        forms.add(rf"\b{n}\b{TIME_SUFFIX}")
        if code:
            try:
                # Through the normaliser, so num2words' "fünfzehn" also matches a
                # transcript (or a scenario script) spelled "fuenfzehn".
                word = normalize(num2words(n, lang=code), lang)
                forms.add(rf"\b{re.escape(word)}\b{TIME_SUFFIX}")
            except Exception:  # noqa: BLE001 - a missing word form is not fatal
                pass
    return sorted(forms)


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
        # Two haystacks: the raw text keeps digits ("2 PM", "14:00"), the
        # normalised text spells them out ("two", "fuenfzehn"). A pattern only
        # matches the one it belongs to, so searching both costs nothing.
        hays = (agent_text.lower(), normalize(agent_text, lang))
        return any(re.search(f, h)
                   for v in accepted for f in time_forms(v, lang) for h in hays)
    hay = normalize(agent_text, lang)
    return any(normalize(v, lang) in hay for v in accepted)


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
    slots = exp.get("slots") or {}
    heard = {k: slot_present(caller_text, k, v, lang) for k, v in slots.items()}
    hits = {k: slot_present(agent_text, k, v, lang) for k, v in slots.items()}
    called = set(run.get("tool_calls") or [])
    want_tools = set(exp.get("tool_calls") or [])

    grounded = [g for g in exp.get("grounded_facts") or []
                if normalize(g, lang) in normalize(agent_text, lang)]
    forbidden = [f for f in exp.get("forbidden") or []
                 if normalize(f, lang) in normalize(agent_text, lang)]

    ttfa = [t["ttfa_ms"] for t in run.get("turns", []) if t.get("ttfa_ms")]
    barges = [t for t in run.get("turns", []) if t.get("barge_in")]
    barge = [t["bargein_stop_ms"] for t in barges if t.get("bargein_stop_ms") is not None]
    inflight = [t for t in barges if t.get("response_inflight")]

    return {
        "arm": run["arm"], "trial": run["trial"], "scenario": run["scenario"],
        "lang": sc["lang"], "intent": sc["intent"],
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
        "ttfa_p50_ms": round(sorted(ttfa)[len(ttfa) // 2], 1) if ttfa else "",
        "bargein_attempts": len(barges),
        "bargein_inflight": len(inflight),
        "bargein_stop_ms": round(barge[0], 1) if barge else "",
        # Did the agent adopt the corrected value after being interrupted? This,
        # not the stop latency, is what a caller actually cares about.
        "bargein_correct": (int(all(heard.values())) if barges and slots else ""),
        "agent_turns": sum(1 for m in run.get("transcript", []) if m["role"] == "agent"),
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
