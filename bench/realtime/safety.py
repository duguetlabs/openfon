"""Credential scrubbing, at the boundary rather than at each call site.

The gateway takes its key in the WebSocket query string, and websocket
libraries routinely put the request URI into exception messages. So any string
derived from an exception is a potential disclosure.

This was first fixed per-call-site in `bench.py`, and a later script
(`verify_live.py`) reintroduced the leak simply by printing an exception —
which is the argument for putting the scrub where text *leaves the process*
instead of asking every author to remember. Two exits are covered:

  `safe_print`   — everything printed to a terminal or CI log
  `scrub_record` — everything written to a results file

Use `safe_print` instead of `print` in anything under bench/realtime/. A script
that forgets still cannot leak through the results writer, and a field that
escapes `redact()` upstream is still scrubbed on the way out.
"""
from __future__ import annotations

import re

# `?token=`, `?api-key=`, `?api_key=`, `?apikey=` and friends, up to the next
# separator. Case-insensitive; stops at &, whitespace, quotes.
_SECRET_IN_URL = re.compile(r"([?&](?:token|api[-_]?key)=)[^&\s\"']+", re.I)

# Bare Kataleptic keys (dg_ prefix) that reached a string without their query
# parameter — e.g. an error message quoting the key alone.
_BARE_KEY = re.compile(r"\bdg_[A-Za-z0-9]{16,}")


def redact(s) -> str:
    """Strip credentials out of anything about to be shown or persisted."""
    out = _SECRET_IN_URL.sub(r"\1<redacted>", str(s))
    return _BARE_KEY.sub("dg_<redacted>", out)


def safe_print(*args, **kwargs) -> None:
    """`print`, with every argument scrubbed first."""
    print(*(redact(a) for a in args), **kwargs)


def scrub_record(obj):
    """Recursively redact a JSON-serialisable record before it is written.

    Defence in depth: the per-field redaction upstream is the first line, this
    is the one that cannot be bypassed by adding a new field.
    """
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, dict):
        return {k: scrub_record(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub_record(v) for v in obj]
    return obj
