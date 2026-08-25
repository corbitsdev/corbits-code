"""Pure Corbits settings + exec argv builders for the Harbor adapter.

No Harbor imports — unit-testable in isolation.
"""

from __future__ import annotations

from typing import Any


def build_settings(
    provider: str,
    model: str,
    api_key: str,
    *,
    base_url: str,
    shell_timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Build a Corbits ``settings.json`` dict for ``--config``.

    Shape matches product settings: ``providers.<provider>.{apiKey,models,baseURL}``
    plus optional ``shell.timeoutMs``. Credentials go into the file only — Corbits
    does not read API keys from the environment.

    ``base_url`` is required and always written as ``baseURL``. Callers must
    resolve it (agent kwargs / ``CORBITS_BASE_URL`` / Harbor model connection);
    this helper does not invent a default URL.
    """
    provider_entry: dict[str, Any] = {
        "apiKey": api_key,
        "models": [model],
        "baseURL": base_url,
    }

    settings: dict[str, Any] = {
        "providers": {
            provider: provider_entry,
        },
    }
    if shell_timeout_ms is not None:
        settings["shell"] = {"timeoutMs": shell_timeout_ms}
    return settings


def build_exec_argv(
    *,
    cwd: str,
    config_path: str,
    provider: str,
    model: str,
    prompt: str,
    binary: str = "corbits",
) -> list[str]:
    """Build the exact ``corbits exec`` argv for a Harbor trial.

    Always includes ``--dangerously-skip-permissions`` and ``--force`` so the
    headless process cannot block on operator approval.
    """
    return [
        binary,
        "exec",
        "--cwd",
        cwd,
        "--config",
        config_path,
        "--provider",
        provider,
        "--model",
        model,
        "--dangerously-skip-permissions",
        "--force",
        prompt,
    ]
