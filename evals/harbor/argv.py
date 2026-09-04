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


def api_key_env_names(provider: str) -> tuple[str, str]:
    """Env vars consulted for the API key, in priority order.

    Deliberately no cross-provider fallback: a key for another provider is
    never silently written into ``providers.<provider>.apiKey``.
    """
    return ("CORBITS_API_KEY", f"{provider.upper()}_API_KEY")


def resolve_base_url(
    *,
    override: str | None,
    configured: str | None,
    env_url: str | None,
    inferred: str | None,
) -> str:
    """Pick the Corbits ``providers.<p>.baseURL`` from adapter sources.

    Precedence: explicit kwarg, Harbor ``configured_base_url`` (env such as
    ``XAI_BASE_URL`` / ``CORBITS_BASE_URL``), adapter env, then Harbor's
    inferred catalog default (e.g. xAI → ``https://api.x.ai/v1`` when an API
    key is present). Does not invent the grok-cli OAuth proxy URL.
    """
    for value in (override, configured, env_url, inferred):
        if value:
            return value
    raise ValueError(
        "No base URL for Corbits Harbor adapter. Pass base_url=… in agent "
        "kwargs, set CORBITS_BASE_URL, or configure Harbor model connection "
        "base URL. Corbits settings require providers.<provider>.baseURL."
    )


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

    Always includes ``--dangerously-skip-permissions`` so the headless process
    cannot block on operator approval.
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
        prompt,
    ]
