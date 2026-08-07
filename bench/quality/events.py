"""Pure functions over realtime-API events. No transport, no dependencies.

Split out of `run_scenarios.py` so the scoring tests can import it without
pulling in `websockets`: test collection died on a clean CI runner, and scoring
logic that cannot be imported without a websocket client is scoring logic
entangled with transport. Everything here is a plain dict in, plain value out.
"""
from __future__ import annotations


def redact(ev: dict) -> dict:
    """Drop base64 audio payloads before logging, keeping their length.

    A single scenario's raw log is ~2 MB of base64 otherwise, and 120 runs would
    be ~120 MB of unreviewable diff. Everything needed to re-score without
    re-spending — transcripts, timings, tool calls, errors — survives.
    """
    if not any(k in ev for k in ("delta", "audio")):
        return ev
    out = dict(ev)
    for k in ("delta", "audio"):
        v = out.get(k)
        if isinstance(v, str) and len(v) > 64:
            out[k] = f"<{len(v)} b64 chars redacted>"
    return out


def function_call(ev: dict) -> tuple[str, str] | None:
    """Return (call_id, name) if this event announces a tool call, else None.

    Several event types describe the same invocation; the caller deduplicates on
    call_id. Events that carry a call_id but no name (the argument deltas) are
    ignored, since the name is what we record.
    """
    t = ev.get("type", "")
    item = ev.get("item") or {}
    if t in ("response.function_call_arguments.done", "response.output_item.done",
             "response.output_item.added"):
        name = ev.get("name") or item.get("name")
        cid = ev.get("call_id") or item.get("call_id") or ev.get("item_id")
        if name and cid:
            return (cid, name)
    if t == "conversation.item.created" and item.get("type") == "function_call":
        if item.get("name") and (item.get("call_id") or item.get("id")):
            return (item.get("call_id") or item.get("id"), item["name"])
    return None


def response_cancelled(ev: dict) -> bool:
    """Did this event report a generation that was interrupted?

    An interrupted generation arrives as `response.done` carrying
    `response.status == "cancelled"`. Neither service emits a top-level
    `response.cancelled` event — zero appear in any committed log — so watching
    for one reads false for every real cancellation.
    """
    if ev.get("type") != "response.done":
        return False
    return ((ev.get("response") or {}).get("status")) in ("cancelled", "canceled")


def declared_axis(flag: str, raw: str) -> list[str]:
    """Parse one declared axis, refusing the two ways such a list lies.

    The scorers take their expected matrix from arguments like these rather than
    from the rows they are checking, so this parse is where the expectation
    enters — and a fix that reproduces the class inside itself is this harness's
    most repeated mistake.

    Empty is not "everything": `--expect-conditions ','` naming nothing makes
    the expected cross-product empty, so no cell can be missing and every cell
    in the file is a rogue. The same empty-is-absent confusion already found in
    `--only`, `--arms`, `--conditions` and `CONDITIONS`.

    A repeat is not a wider axis: the cross-product is nested loops over these
    lists, so a name given twice emits the same cell twice and inflates the
    declared matrix while covering nothing extra.

    Raises ValueError; callers turn it into their own exit.
    """
    vals = [v.strip() for v in raw.split(",") if v.strip()]
    if not vals:
        raise ValueError(f"{flag} {raw!r} names nothing. This is the declared "
                         "axis the results are checked against, and an empty "
                         "declaration expects nothing of them.")
    if dupes := sorted({v for v in vals if vals.count(v) > 1}):
        raise ValueError(
            f"{flag} {raw!r} names {', '.join(dupes)} more than once. The "
            "expected matrix is the cross-product of the declared axes, so a "
            "repeat duplicates cells rather than adding any.")
    return vals


def scenario_ids(scenarios: list[dict], source: str) -> list[str]:
    """The fixture's scenario ids, in order, refusing a repeat.

    Every consumer keys the fixture by id — the runner maps each id to one raw
    log path, `judge.py` to its candidate set, `summarize.py` to the expected
    scenario universe, `score_slots.py` to the spec it scores against — so two
    entries sharing an id are silently *one* entry to all of them.

    In the runner that is the `FORCE=1` data-loss shape again: both entries
    resolve to the same log path, `--preflight-logs` therefore sees one file and
    exits 0, and the real run bills the first scenario before `open_log` refuses
    the second — or, under `--force-logs`, truncates the log the first scenario
    just paid for. A preflight that passes because two things look like one has
    answered a different question from the one it was asked.

    Elsewhere it is quieter and not free either: the judge pays twice for the
    same scenario, and `summarize.py` counts it twice in the denominator every
    rate is computed over. The uniqueness was assumed at four sites and checked
    at none, so it is checked here, once, for all of them.

    Lives beside `scenario_filter` for the same reason: pure, and importable
    without the runner's transport.
    """
    ids = [sc["id"] for sc in scenarios]
    if dupes := sorted({i for i in ids if ids.count(i) > 1}):
        raise ValueError(
            f"{source} declares {len(dupes)} scenario id(s) more than once: "
            f"{', '.join(dupes)}. Every consumer keys this fixture by id, so a "
            "repeat is one scenario to the runner's log map, the judge and the "
            "scorer alike — the second entry is not run, not judged and not "
            "scored, while the counts derived from the file say it was.")
    return ids


def scenario_filter(only: str | None, known: set[str]) -> set[str] | None:
    """Parse and validate a `--only` list against the fixture's scenario ids.

    Raises ValueError naming every unknown id. An unknown id used to act as a
    filter that matches nothing: a typo in a list quietly dropped that scenario,
    and a wholly wrong list produced no runs at all while `run_all.sh` reported
    success on an empty matrix. The fixture is the declared scenario universe
    (`summarize.py` reads it for the same reason), so an id absent from it is a
    mistake, not a selection.

    Lives here rather than in `run_scenarios.py` so it can be tested without
    importing `websockets` — the runner's transport is not installed on the CI
    image, and a test that shells out to the runner to check a pure validation
    fails for a reason unrelated to what it is testing.
    """
    if only is None or only == "":
        return None
    want = {s.strip() for s in only.split(",") if s.strip()}
    if not want:
        # `--only ','` parsed to an empty set, and the caller tested `if want`,
        # so a malformed selection was indistinguishable from no selection and
        # every paid scenario ran. A malformed filter is not an absent one —
        # the same empty-is-absent confusion this harness keeps producing, here
        # inside the validation added to stop typos slipping through.
        raise ValueError(
            f"--only {only!r} names no scenario ids. Pass a comma-separated "
            "list, or omit --only entirely to run every scenario.")
    if unknown := sorted(want - known):
        raise ValueError(
            f"--only names {len(unknown)} scenario id(s) not in the fixture: "
            f"{', '.join(unknown)}. Known ids: {', '.join(sorted(known))}")
    return want
