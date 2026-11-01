"""Synthetic source-schema fixtures: no real conversations or personal paths."""

import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
from metrics import snapshot


BASE = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
COUNTS = {
    "input_tokens": 10, "output_tokens": 20,
    "cache_read_tokens": 30, "cache_creation_tokens": 40,
    "total_time_ms": 1000, "ttft_ms": 200, "tokens_per_sec": 25,
}


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "sessions #1.db"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT,working_directory TEXT,
              model TEXT,last_activity_at INTEGER,main_chain_id INTEGER,hidden INTEGER);
            CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,
              created_at INTEGER);
            INSERT INTO sessions VALUES ('s','Synthetic session','/workspace/demo',
              'model-a',1767225613,7,0);
        """)
        self.node(1, None, "user", 0, user=True)
        self.node(2, 1, "assistant", 1, request="a", calls=1)
        self.node(100, None, "system", 0)
        self.node(101, 100, "assistant", 2, request="worker", model="model-b")
        self.node(3, 2, "tool", 3, delegated=101)
        self.node(4, 3, "assistant", 4, request="b")
        self.node(5, 4, "user", 5, user=True)
        self.node(6, 5, "assistant", 6, request="c", calls=1)
        self.node(7, 6, "tool", 7)
        self.node(99, 1, "assistant", 1, request="a", calls=1)
        self.db.commit()

    def node(self, node_id, parent, role, second, request=None, calls=0,
             user=False, delegated=None, model="model-a", metrics=None, client=None):
        metadata = {
            "created_at": datetime.fromtimestamp((BASE / 1000) + second, timezone.utc).isoformat(),
            "is_user_input": True if user else None,
            "extensions": {},
        }
        if client:
            metadata["extensions"]["chisel/client-message-id"] = client
        if delegated is not None:
            metadata["extensions"]["subagent/chain_node_id"] = delegated
        if request:
            metadata.update({
                "request_id": request, "generation_model": model,
                "metrics": dict(COUNTS if metrics is None else metrics),
            })
        message = {
            "role": role, "message_id": "message-" + (request or str(node_id)),
            "metadata": metadata, "tool_calls": [{}] * calls,
            "content": "SECRET SYNTHETIC TEXT MUST NOT BE EXPORTED",
        }
        self.db.execute(
            "INSERT INTO message_nodes VALUES (NULL,?,?,?,?,?)",
            ("s", node_id, parent, json.dumps(message), int(BASE / 1000) + second),
        )

    def read(self, **kwargs):
        self.db.commit()
        return snapshot(str(self.path), now_ms=BASE + 13000, **kwargs)

    def test_dedup_main_chain_cache_writes_and_prompt_timing(self):
        data = self.read()
        self.assertEqual(data["source"]["state"], "ready")
        session = data["session"]
        self.assertEqual(session["totals"]["requests"], 4)
        self.assertEqual(session["totals"]["tokens"], {
            "input": 40, "output": 80, "cacheRead": 120,
            "cacheWrite": 160, "total": 400, "unknown": [],
        })
        recent, previous = session["turns"]
        self.assertEqual((recent["state"], recent["elapsedMs"]), ("open", 8000))
        self.assertEqual((previous["state"], previous["elapsedMs"]), ("complete", 4000))
        self.assertEqual(previous["lead"]["requests"], 2)
        self.assertEqual(previous["delegated"]["requests"], 1)
        self.assertEqual(recent["lastRequest"]["tps"], 25)
        self.assertEqual(session["unassignedRequests"], 0)
        self.assertNotIn("SECRET", json.dumps(data))

    def test_persistent_worker_history_is_not_billed_again_on_next_handoff(self):
        self.node(102, 101, "assistant", 8, request="worker-2", model="model-b")
        self.node(8, 7, "tool", 9, delegated=102)
        self.node(9, 8, "assistant", 10, request="d")
        self.db.execute("UPDATE sessions SET main_chain_id=9")
        latest, previous = self.read()["session"]["turns"]
        self.assertEqual(latest["delegated"]["requests"], 1)
        self.assertEqual(previous["delegated"]["requests"], 1)
        self.assertEqual(latest["delegated"]["tokens"]["total"], 100)

    def test_old_sibling_branch_counts_in_session_but_not_current_prompt(self):
        self.node(88, 1, "assistant", 2, request="discarded-branch")
        session = self.read()["session"]
        self.assertEqual(session["totals"]["requests"], 5)
        self.assertEqual(session["unassignedRequests"], 1)
        self.assertEqual(session["turns"][-1]["lead"]["requests"], 2)

    def test_exact_prices_and_unknown_cost(self):
        rates = {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4}
        absent = self.read(prices={"model": rates})["session"]
        self.assertIsNone(absent["totals"]["costUsd"])
        partial = self.read(prices={"model-a": rates})["session"]
        self.assertEqual(partial["totals"]["pricedRequests"], 3)
        self.assertIsNone(partial["totals"]["costUsd"])
        full = self.read(prices={"model-a": rates, "model-b": rates})["session"]
        self.assertAlmostEqual(full["totals"]["costUsd"], 0.0012)
        self.assertAlmostEqual(full["turns"][-1]["delegated"]["costUsd"], 0.0003)
        zero = dict.fromkeys(rates, 0)
        self.assertEqual(self.read(prices={"model-a": zero, "model-b": zero})["session"]["totals"]["costUsd"], 0)

    def test_missing_and_invalid_counters_are_lower_bounds_not_complete_zero(self):
        changed = dict(COUNTS, cache_read_tokens=None, cache_creation_tokens=-10)
        self.node(8, 7, "assistant", 9, request="partial", metrics=changed)
        self.db.execute("UPDATE sessions SET main_chain_id=8")
        req = self.read()["session"]["turns"][0]["lastRequest"]
        self.assertEqual(req["tokens"]["total"], 30)
        self.assertEqual(req["tokens"]["unknown"], ["cacheRead", "cacheWrite"])
        self.assertIsNone(req["costUsd"])

    def test_zero_and_fallback_tps_have_explicit_meanings(self):
        self.node(8, 7, "assistant", 9, request="zero",
                  metrics=dict(COUNTS, total_time_ms=0, ttft_ms=0, tokens_per_sec=0))
        self.db.execute("UPDATE sessions SET main_chain_id=8")
        req = self.read()["session"]["turns"][0]["lastRequest"]
        self.assertEqual((req["durationMs"], req["ttftMs"], req["tps"]), (0, 0, 0))
        self.node(9, 8, "assistant", 10, request="fallback",
                  metrics=dict(COUNTS, tokens_per_sec=None))
        self.db.execute("UPDATE sessions SET main_chain_id=9")
        req = self.read()["session"]["turns"][0]["lastRequest"]
        self.assertEqual((req["tps"], req["tpsKind"]), (20, "request"))

    def test_next_prompt_does_not_invent_finish_time_for_interrupted_turn(self):
        self.node(8, 7, "user", 10, user=True)
        self.db.execute("UPDATE sessions SET main_chain_id=8")
        turns = self.read()["session"]["turns"]
        self.assertEqual(turns[1]["state"], "superseded")
        self.assertIsNone(turns[1]["elapsedMs"])
        self.assertIsNone(turns[1]["endedAt"])

    def test_matching_workspace_and_explicit_session(self):
        self.assertIsNone(self.read(workspace_paths=["/workspace/different"])["session"])
        self.assertEqual(self.read(workspace_paths=["/workspace"])["selectedSessionId"], "s")
        self.assertIsNotNone(self.read(session_id="s", workspace_paths=["/different"])["session"])
        self.assertIsNone(self.read(session_id="does-not-exist")["session"])

    def test_missing_database_is_not_created(self):
        nonexistent = Path(self.temp.name) / "absent.db"
        data = snapshot(str(nonexistent))
        self.assertEqual(data["source"]["state"], "missing")
        self.assertFalse(nonexistent.exists())

    def test_read_only_does_not_change_source(self):
        before = self.path.read_bytes()
        self.read()
        self.assertEqual(self.path.read_bytes(), before)

    def test_duplicate_client_message_does_not_split_prompt(self):
        self.node(8, 7, "user", 9, user=True, client="same-submission")
        self.node(9, 8, "user", 9, user=True, client="same-submission")
        self.db.execute("UPDATE sessions SET main_chain_id=9")
        self.assertEqual(len(self.read()["session"]["turns"]), 3)

    def test_broken_chain_warns_instead_of_following_a_random_leaf(self):
        self.db.execute("UPDATE sessions SET main_chain_id=999")
        data = self.read()["session"]
        self.assertEqual(data["turns"], [])
        self.assertTrue(data["warnings"])
        self.assertEqual(data["unassignedRequests"], 4)


if __name__ == "__main__":
    unittest.main()
