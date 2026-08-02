"""LLM judge for the soft half of Track B, run blind.

Scope is deliberately narrow. Slot capture, tool calls and language adherence
are scored programmatically in score_slots.py because they have objectively
right answers. The judge only rules on things a string comparison cannot see:
whether the agent's business claims are supported by the knowledge base, whether
it actually resolved the call, and whether it sounds like a receptionist.

Blinding
  * arm identity is stripped; each candidate gets an opaque id
  * candidates for one scenario are judged together (so the judge calibrates
    against a common reference) but in an order shuffled per scenario
  * the shuffle is seeded, so a rerun reproduces the same presentation
  * `--seed` changing the order is how reliability is measured: run twice with
    different seeds and compare. An unvalidated judge is a vibe, not a metric.

  python judge.py --runs results/scenarios.jsonl --out results/judge.csv --seed 1
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

MODEL = os.environ.get("JUDGE_MODEL", "gpt-5.5")
BASE = os.environ.get("JUDGE_BASE_URL", "https://api.kataleptic.com/v1")

RUBRIC = """You are grading transcripts of a phone call between a caller and an AI
receptionist for a business. You will see the business knowledge base, the caller's
scripted turns, and several anonymous candidate transcripts of how different systems
handled the same call.

Grade EACH candidate independently on these dimensions. Do not rank them against each
other, and do not let one candidate's answer change how you grade another.

groundedness (0 or 1)
  1 = every factual claim the agent makes about the business is supported by the
      KNOWLEDGE BASE below. 0 = the agent asserted any business fact that is absent
      from or contradicts the knowledge base (a wrong closing time, an invented
      price, a made-up parking arrangement, an opening day that is listed CLOSED).
  Generic conversational filler is not a factual claim. Judge only business facts.

resolution (0, 1 or 2)
  2 = the agent did what the call needed: answered the question asked, or collected
      the details the business would need to act (name, number, preferred time), or
      correctly redirected an out-of-scope request.
  1 = partially: it engaged with the request but left something important unresolved.
  0 = it did not address what the caller asked.

tone (0, 1 or 2)
  2 = natural, warm, concise — plausible as a human receptionist. Short spoken
      sentences, one question at a time.
  1 = understandable but stilted, repetitive, or over-long for speech.
  0 = robotic, confusing, or clearly unsuitable to be read aloud on a phone call.

For groundedness you MUST quote the knowledge-base line that supports your verdict,
or name the unsupported claim.

Return ONLY a JSON array, one object per candidate, no markdown fence:
[{"id":"<candidate id>","groundedness":0|1,"groundedness_evidence":"<one sentence>",
  "resolution":0|1|2,"tone":0|1|2,"note":"<one short sentence>"}]"""


def chat(messages: list[dict], api_key: str) -> str:
    body = json.dumps({"model": MODEL, "messages": messages,
                       "temperature": 0, "max_tokens": 4000}).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions", data=body,
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json",
                 # Cloudflare fronts the gateway and 403s the default
                 # `Python-urllib/3.x` agent before the request reaches the API.
                 "User-Agent": "openfon-bench/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


class JudgeParseError(ValueError):
    """The judge returned something that is not a usable set of verdicts."""


def _require_score(cid: str, dim: str, value, allowed: tuple[int, ...]) -> None:
    """Reject anything that is not literally one of the allowed integers.

    `bool` is a subclass of `int` in Python, so a reply containing `true` passes
    a bare `value in (0, 1)` membership test, lands `True` in the CSV, and is
    then coerced to 0.0 by `float()` downstream — turning a *positive* verdict
    into a failure with no parse error raised anywhere.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value not in allowed:
        raise JudgeParseError(
            f"{cid}: {dim} must be one of {allowed} as a JSON number, "
            f"got {value!r} ({type(value).__name__})")


def parse_verdicts(raw: str, expected_ids: set[str]) -> list[dict]:
    """Parse the judge's reply into verdicts, or raise.

    Deliberately raises instead of returning defaults. If a malformed reply
    silently produced zeros, a systematic judge outage would read as "every arm
    scores badly on groundedness" — a plausible-looking result that is actually
    no measurement at all, and nothing downstream could tell the two apart.
    Callers count the failures and refuse to write a summary that hides them.
    """
    txt = re.sub(r"^```(?:json)?|```$", "", (raw or "").strip(), flags=re.M).strip()
    if not txt:
        raise JudgeParseError("empty reply")
    try:
        data = json.loads(txt)
    except json.JSONDecodeError as e:
        raise JudgeParseError(f"not JSON: {e}") from e
    if not isinstance(data, list) or not data:
        raise JudgeParseError(f"expected a non-empty array, got {type(data).__name__}")

    out = []
    for v in data:
        if not isinstance(v, dict):
            raise JudgeParseError(f"array element is {type(v).__name__}, not an object")
        cid = v.get("id")
        if cid not in expected_ids:
            raise JudgeParseError(f"unknown candidate id {cid!r}")
        _require_score(cid, "groundedness", v.get("groundedness"), (0, 1))
        _require_score(cid, "resolution", v.get("resolution"), (0, 1, 2))
        _require_score(cid, "tone", v.get("tone"), (0, 1, 2))
        out.append(v)

    seen = [v["id"] for v in out]
    if len(set(seen)) != len(seen):
        raise JudgeParseError("duplicate candidate ids")
    if missing := expected_ids - set(seen):
        raise JudgeParseError(f"missing verdicts for {sorted(missing)}")
    return out


def render(run: dict) -> str:
    lines = []
    for m in run.get("transcript", []):
        who = "CALLER(as heard)" if m["role"] == "caller_asr" else "AGENT"
        lines.append(f"{who}: {m['text']}")
    if run.get("tool_calls"):
        lines.append(f"[tools invoked: {', '.join(run['tool_calls'])}]")
    return "\n".join(lines) or "(no transcript — the system produced nothing)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--scenarios", default="fixtures/scenarios.json")
    ap.add_argument("--prompt", default="fixtures/riverside-prompt.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    api_key = os.environ.get("KATALEPTIC_KEY", "").strip()
    if not api_key:
        sys.exit("set KATALEPTIC_KEY")

    spec = json.loads(Path(a.scenarios).read_text())
    kb = json.loads(Path(a.prompt).read_text())["system_prompt"]
    runs = [json.loads(l) for l in Path(a.runs).read_text().splitlines() if l.strip()]

    by_scenario: dict[str, list[dict]] = defaultdict(list)
    for r in runs:
        by_scenario[r["scenario"]].append(r)

    rows: list[dict] = []
    failures: list[str] = []
    for sc in spec["scenarios"]:
        cands = by_scenario.get(sc["id"]) or []
        if not cands:
            # Not silently skipped: a scenario with no runs is a hole in the
            # data, and summarize.py's completeness check must see it.
            print(f"  {sc['id']}: no runs to judge", file=sys.stderr)
            failures.append(sc["id"])
            continue
        rng = random.Random(f"{a.seed}:{sc['id']}")
        order = list(range(len(cands)))
        rng.shuffle(order)

        # Opaque ids: nothing in what the judge sees identifies the arm.
        labels = {}
        blocks = []
        for pos, i in enumerate(order):
            cid = f"cand{pos + 1}"
            labels[cid] = cands[i]
            blocks.append(f"### CANDIDATE {cid}\n{render(cands[i])}")

        caller = "\n".join(f"CALLER turn {i}: {t['text']}"
                           for i, t in enumerate(sc["turns"]))
        user = (f"KNOWLEDGE BASE (the agent's only permitted source of truth):\n"
                f"{kb}\n\n"
                f"SCENARIO: {sc['description']}\n\n"
                f"WHAT THE CALLER ACTUALLY SAID (scripted, ground truth):\n{caller}\n\n"
                f"CANDIDATES:\n\n" + "\n\n".join(blocks))

        try:
            raw = chat([{"role": "system", "content": RUBRIC},
                        {"role": "user", "content": user}], api_key)
            verdicts = parse_verdicts(raw, set(labels))
        except Exception as e:  # noqa: BLE001
            print(f"  {sc['id']}: judge failed ({type(e).__name__}: {e})", file=sys.stderr)
            failures.append(sc["id"])
            continue

        for v in verdicts:
            run = labels.get(v.get("id"))
            if not run:
                continue
            rows.append({
                "scenario": sc["id"], "arm": run["arm"], "trial": run["trial"],
                "lang": sc["lang"], "seed": a.seed,
                "groundedness": v.get("groundedness"),
                "resolution": v.get("resolution"),
                "tone": v.get("tone"),
                "groundedness_evidence": (v.get("groundedness_evidence") or "")[:300],
                "note": (v.get("note") or "")[:300],
            })
        print(f"  {sc['id']}: judged {len(verdicts)} candidates", file=sys.stderr)

    if not rows:
        sys.exit("judge produced no verdicts at all — refusing to write an empty scoring file")
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {a.out}")
    if failures:
        # Loud and non-zero. A partial judge pass silently becomes "these runs
        # had no groundedness verdict", which summarize.py treats as "no
        # objection" — i.e. a judge outage would quietly raise success rates.
        sys.exit(f"judge failed on {len(failures)} scenario(s): {', '.join(failures)}")


if __name__ == "__main__":
    main()
