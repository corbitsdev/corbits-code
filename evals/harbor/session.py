"""Parse harvested Corbits session usage for Harbor AgentContext.

No Harbor imports — unit-testable in isolation. Does not invent a dollar
figure when models.dev pricing is missing (unlike product faremeter's
fallback rate).
"""

from __future__ import annotations

import json
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_HOME_TAR = "corbits-home.tar.gz"
_UNPACKED_DIR = "corbits-home"


@dataclass(frozen=True)
class SessionUsage:
    n_input_tokens: int | None
    n_cache_tokens: int | None
    n_output_tokens: int | None
    cost_usd: float | None
    session_relpath: str | None
    pricing_model: str | None


def unpack_home_tar(logs_dir: Path) -> Path | None:
    """Extract ``corbits-home.tar.gz`` under ``logs_dir`` if present."""
    tar_path = logs_dir / _HOME_TAR
    if not tar_path.is_file():
        unpacked = logs_dir / _UNPACKED_DIR
        return unpacked if unpacked.is_dir() else None

    dest = logs_dir / _UNPACKED_DIR
    dest.mkdir(parents=True, exist_ok=True)
    kwargs: dict[str, Any] = {}
    if sys.version_info >= (3, 12):
        kwargs["filter"] = "data"
    with tarfile.open(tar_path, "r:gz") as archive:
        archive.extractall(dest, **kwargs)
    return dest


def usage_from_unpacked_home(
    unpacked: Path,
    *,
    model_ids: tuple[str, ...],
) -> SessionUsage:
    """Read the newest session ``metadata.json`` and optional pricing cache."""
    metadata_path = _newest_metadata(unpacked)
    if metadata_path is None:
        return SessionUsage(None, None, None, None, None, None)

    token_usage = _token_usage_from_metadata(metadata_path)
    if token_usage is None:
        return SessionUsage(
            None,
            None,
            None,
            None,
            _relpath(unpacked, metadata_path.parent),
            None,
        )

    input_tokens = token_usage["input"]
    output_tokens = token_usage["output"]
    cache_read = token_usage["cacheRead"]
    cache_write = token_usage["cacheWrite"]
    thinking = token_usage["thinking"]

    n_input = input_tokens + cache_read + cache_write
    n_cache = cache_read + cache_write
    n_output = output_tokens + thinking

    pricing_model, prices = _lookup_pricing(unpacked, model_ids)
    cost_usd = None
    if prices is not None:
        cost_usd = (
            input_tokens * prices["inputPricePerToken"]
            + output_tokens * prices["outputPricePerToken"]
            + cache_read * prices["cacheReadPricePerToken"]
        )

    return SessionUsage(
        n_input,
        n_cache,
        n_output,
        cost_usd,
        _relpath(unpacked, metadata_path.parent),
        pricing_model,
    )


def usage_from_logs_dir(logs_dir: Path, *, model_ids: tuple[str, ...]) -> SessionUsage:
    unpacked = unpack_home_tar(logs_dir)
    if unpacked is None:
        return SessionUsage(None, None, None, None, None, None)
    return usage_from_unpacked_home(unpacked, model_ids=model_ids)


def _newest_metadata(root: Path) -> Path | None:
    found = [path for path in root.rglob("metadata.json") if path.is_file()]
    if not found:
        return None
    found.sort(key=lambda path: (path.stat().st_mtime, str(path)))
    return found[-1]


def _token_usage_from_metadata(path: Path) -> dict[str, int] | None:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    raw = payload.get("tokenUsage")
    if not isinstance(raw, dict):
        return None
    try:
        return {
            "input": _as_int(raw.get("input")),
            "output": _as_int(raw.get("output")),
            "cacheRead": _as_int(raw.get("cacheRead")),
            "cacheWrite": _as_int(raw.get("cacheWrite")),
            "thinking": _as_int(raw.get("thinking")),
        }
    except TypeError:
        return None


def _as_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError
    return int(value)


def _lookup_pricing(
    unpacked: Path,
    model_ids: tuple[str, ...],
) -> tuple[str | None, dict[str, float] | None]:
    cache_path = unpacked / ".corbits" / "cache" / "models-pricing.json"
    if not cache_path.is_file():
        nested = list(unpacked.rglob("models-pricing.json"))
        cache_path = nested[0] if nested else cache_path
    if not cache_path.is_file():
        return None, None
    try:
        payload = json.loads(cache_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    models = payload.get("models")
    if not isinstance(models, dict):
        return None, None
    for model_id in model_ids:
        entry = models.get(model_id)
        prices = _parse_prices(entry)
        if prices is not None:
            return model_id, prices
    return None, None


def _parse_prices(entry: object) -> dict[str, float] | None:
    if not isinstance(entry, dict):
        return None
    try:
        return {
            "inputPricePerToken": float(entry["inputPricePerToken"]),
            "outputPricePerToken": float(entry["outputPricePerToken"]),
            "cacheReadPricePerToken": float(entry["cacheReadPricePerToken"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _relpath(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)
