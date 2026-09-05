"""Unit tests for Harbor adapter session harvest (no Harbor package)."""

from __future__ import annotations

import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from evals.harbor.session import usage_from_logs_dir, usage_from_unpacked_home


def _write_session(
    root: Path,
    *,
    token_usage: dict[str, int],
    pricing: dict[str, object] | None = None,
    session_id: str = "sess-1",
) -> Path:
    session_dir = root / ".corbits" / "projects" / "demo" / session_id
    session_dir.mkdir(parents=True)
    (session_dir / "metadata.json").write_text(
        json.dumps({"tokenUsage": token_usage, "pendingOperations": []}) + "\n"
    )
    (session_dir / "turns-0001.jsonl").write_text(
        json.dumps({"role": "assistant", "content": [], "timestamp": 1}) + "\n"
    )
    if pricing is not None:
        cache_dir = root / ".corbits" / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / "models-pricing.json").write_text(json.dumps(pricing) + "\n")
    return session_dir


class UsageFromUnpackedHomeTests(unittest.TestCase):
    def test_maps_cumulative_usage_and_known_pricing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_session(
                root,
                token_usage={
                    "input": 100,
                    "output": 20,
                    "cacheRead": 50,
                    "cacheWrite": 10,
                    "thinking": 5,
                },
                pricing={
                    "timestamp": 1,
                    "models": {
                        "xai/grok-4.5": {
                            "inputPricePerToken": 0.000003,
                            "outputPricePerToken": 0.000015,
                            "cacheReadPricePerToken": 0.00000075,
                        }
                    },
                },
            )
            usage = usage_from_unpacked_home(
                root, model_ids=("xai/grok-4.5", "grok-4.5")
            )
            self.assertEqual(usage.n_input_tokens, 160)
            self.assertEqual(usage.n_cache_tokens, 60)
            self.assertEqual(usage.n_output_tokens, 25)
            self.assertEqual(usage.pricing_model, "xai/grok-4.5")
            self.assertAlmostEqual(usage.cost_usd or 0.0, 0.0006375)
            self.assertIsNotNone(usage.session_relpath)
            self.assertTrue(
                (root / usage.session_relpath / "turns-0001.jsonl").is_file()
            )

    def test_cost_stays_none_when_model_missing_from_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_session(
                root,
                token_usage={
                    "input": 10,
                    "output": 2,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "thinking": 0,
                },
                pricing={"timestamp": 1, "models": {}},
            )
            usage = usage_from_unpacked_home(root, model_ids=("opencode-go/mimo-v2.5",))
            self.assertEqual(usage.n_input_tokens, 10)
            self.assertEqual(usage.n_output_tokens, 2)
            self.assertIsNone(usage.cost_usd)
            self.assertIsNone(usage.pricing_model)

    def test_missing_session_returns_empty_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            usage = usage_from_unpacked_home(Path(tmp), model_ids=("xai/grok-4.5",))
            self.assertIsNone(usage.n_input_tokens)
            self.assertIsNone(usage.cost_usd)
            self.assertIsNone(usage.session_relpath)

    def test_picks_newest_metadata_when_multiple_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_session(
                root,
                token_usage={
                    "input": 1,
                    "output": 1,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "thinking": 0,
                },
                session_id="old",
            )
            newer = _write_session(
                root,
                token_usage={
                    "input": 9,
                    "output": 3,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "thinking": 0,
                },
                session_id="new",
            )
            newer_meta = newer / "metadata.json"
            newer_stat = newer_meta.stat()
            os.utime(
                newer_meta,
                (newer_stat.st_atime + 10, newer_stat.st_mtime + 10),
            )
            usage = usage_from_unpacked_home(root, model_ids=())
            self.assertEqual(usage.n_input_tokens, 9)
            self.assertIn("new", usage.session_relpath or "")


class UsageFromLogsDirTests(unittest.TestCase):
    def test_unpacks_tar_then_reads_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / "staging"
            staging.mkdir()
            _write_session(
                staging,
                token_usage={
                    "input": 4,
                    "output": 1,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "thinking": 0,
                },
            )
            logs_dir = Path(tmp) / "logs"
            logs_dir.mkdir()
            tar_path = logs_dir / "corbits-home.tar.gz"
            with tarfile.open(tar_path, "w:gz") as archive:
                archive.add(staging / ".corbits", arcname=".corbits")
            usage = usage_from_logs_dir(logs_dir, model_ids=())
            self.assertEqual(usage.n_input_tokens, 4)
            self.assertEqual(usage.n_output_tokens, 1)
            unpacked = logs_dir / "corbits-home" / ".corbits"
            self.assertTrue(unpacked.is_dir())
