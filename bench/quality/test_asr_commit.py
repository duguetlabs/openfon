"""Exercise the actual batch coroutine with a fake transport, without credentials."""
import ast
import asyncio
import base64
import io
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


class TestCommitBinding(unittest.IsolatedAsyncioTestCase):
    async def test_pre_ack_failures_close_session_before_next_clip(self):
        # Load the production coroutine without importing credential-aware engine
        # configuration or adding transport dependencies to scoring-only CI.
        path = Path(__file__).with_name("run_asr.py")
        tree = ast.parse(path.read_text())
        body = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.AsyncFunctionDef))
                and n.name in ("CommitDesync", "transcribe_batch")]
        for failure in ({"type": "error", "error": {"message": "rejected"}},
                        {"type": "input_audio_buffer.committed"},
                        {"type": "input_audio_buffer.committed", "item_id": ""}):
            with self.subTest(failure=failure):
                sent = []
                events = iter([
                    {"type": "session.updated", "session": {"instructions": "marker"}},
                    failure,
                    {"type": "input_audio_buffer.committed", "item_id": "late-first"},
                ])
                class Socket:
                    closed = False
                    async def __aenter__(self):
                        return self
                    async def __aexit__(self, *args):
                        self.closed = True
                    async def send(self, text):
                        sent.append(json.loads(text))
                    async def recv(self):
                        return json.dumps(next(events))
                socket = Socket()
                arm = SimpleNamespace(url="fake", session_asr=lambda *a: {},
                                      caller_transcript=lambda ev: None)
                env = dict(asyncio=asyncio, base64=base64, json=json, sys=sys,
                           time=time, Path=Path, ARMS={"fake": arm},
                           LANG_CODE={}, MARKER="marker", FRAME_MS=200,
                           connect_kwargs=lambda arm: {}, pcm24k=lambda p: b"00",
                           websockets=SimpleNamespace(connect=lambda *a, **kw: socket))
                exec(compile(ast.Module(body=body, type_ignores=[]), str(path), "exec"), env)
                clips = [{"id": name, "path": "unused"} for name in ("first", "second")]
                with self.assertRaises(env["CommitDesync"]):
                    await env["transcribe_batch"]("fake", "en", clips, io.StringIO())
                self.assertTrue(socket.closed)
                self.assertEqual(sum(e["type"] == "input_audio_buffer.commit" for e in sent), 1)
                self.assertEqual(next(events)["item_id"], "late-first")
