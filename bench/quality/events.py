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
