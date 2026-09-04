"""Harbor ``BaseInstalledAgent`` bridge that runs headless ``corbits exec``.

Thin adapter: install a Linux Corbits binary + git, write a temporary
settings.json from Harbor kwargs/env, then exec with
``--dangerously-skip-permissions``. No second agent loop.

Requires the Harbor package at import time (normal for Harbor plugins).
Unit tests import ``evals.harbor.argv`` only.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    with_prompt_template,
)
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from evals.harbor.argv import (
    api_key_env_names,
    build_exec_argv,
    build_settings,
    resolve_base_url,
)

_REMOTE_BIN_DIR = PurePosixPath("/usr/local/bin")
_REMOTE_CORBITS = _REMOTE_BIN_DIR / "corbits"
_REMOTE_SETTINGS = PurePosixPath("/tmp/corbits-settings.json")
_OUTPUT_FILENAME = "corbits.txt"
_DEFAULT_PROVIDER = "xai"
_DEFAULT_MODEL = "grok-4.5"
_DEFAULT_TASK_CWD = "/app"


class Corbits(BaseInstalledAgent):
    """Installed-agent adapter: Harbor → ``corbits exec`` (yolo for that process)."""

    # No default_provider: ``-m xai/grok-4.5`` and ``-m openai/…`` both work.
    # CORBITS_* is tried before Harbor's per-provider catalog env names.
    MODEL_CONNECTION = ModelConnectionSpec(
        api_key_envs=("CORBITS_API_KEY",),
        base_url_envs=("CORBITS_BASE_URL",),
    )

    def __init__(
        self,
        *args: Any,
        provider: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        shell_timeout_ms: int | None = None,
        corbits_binary_url: str | None = None,
        corbits_tarball_url: str | None = None,
        corbits_binary_path: str | None = None,
        task_cwd: str = _DEFAULT_TASK_CWD,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._provider_override = provider
        self._model_override = model
        self._api_key_override = api_key
        self._base_url = base_url
        self._shell_timeout_ms = shell_timeout_ms
        self._corbits_binary_url = corbits_binary_url
        self._corbits_tarball_url = corbits_tarball_url
        self._corbits_binary_path = corbits_binary_path
        self._task_cwd = task_cwd
        self._last_exit_code: int | None = None

    @staticmethod
    @override
    def name() -> str:
        # Custom import path agent — do not require AgentName enum membership.
        return "corbits"

    @override
    def get_version_command(self) -> str | None:
        # The CLI has no --version flag; record the help banner as a best-effort
        # identity string. Harbor ignores failures here.
        return "corbits --help | head -n 1"

    def _resolve_provider_model(self) -> tuple[str, str]:
        if self._provider_override and self._model_override:
            return self._provider_override, self._model_override

        if self.model_name and "/" in self.model_name:
            provider, model = self.model_name.split("/", 1)
            return (
                self._provider_override or provider,
                self._model_override or model,
            )

        if self.model_name:
            return (
                self._provider_override or _DEFAULT_PROVIDER,
                self._model_override or self.model_name,
            )

        return (
            self._provider_override or _DEFAULT_PROVIDER,
            self._model_override or _DEFAULT_MODEL,
        )

    def _resolve_api_key(self, provider: str) -> str:
        if self._api_key_override:
            return self._api_key_override

        # Adapter-only translation: Harbor env/kwargs → settings.json.
        # Product Corbits still sees credentials only via --config.
        for name in api_key_env_names(provider):
            value = self._get_env(name)
            if value:
                return value

        access = self.model_connection
        if getattr(access, "api_key", None):
            return str(access.api_key)

        raise ValueError(
            "No API key for Corbits Harbor adapter. Pass api_key=… in agent "
            "kwargs, set CORBITS_API_KEY or {PROVIDER}_API_KEY, "
            "or configure Harbor model credentials. Keys are written into a "
            "temporary settings.json for --config only."
        )

    def _resolve_base_url(self) -> str:
        access = self.model_connection
        return resolve_base_url(
            override=self._base_url,
            configured=getattr(access, "configured_base_url", None),
            env_url=self._get_env("CORBITS_BASE_URL"),
            inferred=getattr(access, "base_url", None),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Corbits storage requires git in the environment (no git-less fallback).
        await self.ensure_system_dependencies(
            environment, ("git", "curl", "ca_certificates", "tar")
        )

        check = await environment.exec(command="command -v corbits >/dev/null 2>&1")
        if check.return_code == 0:
            self.logger.debug("corbits already on PATH")
            return

        if self._corbits_binary_path:
            await self._install_from_host_path(environment, self._corbits_binary_path)
            return

        url = self._corbits_binary_url or self._corbits_tarball_url
        if url:
            await self._install_from_url(environment, url)
            return

        raise RuntimeError(
            "Corbits Harbor adapter needs a Linux ELF binary. Pass one of "
            "corbits_binary_path (host file uploaded into the env), "
            "corbits_binary_url, or corbits_tarball_url in agent kwargs. "
            "Build with `bun run build:bin` on Linux, or use a release tarball. "
            "See evals/harbor/README.md."
        )

    async def _install_from_host_path(
        self, environment: BaseEnvironment, host_path: str
    ) -> None:
        source = Path(host_path).expanduser()
        if not source.is_file():
            raise FileNotFoundError(f"corbits_binary_path not found: {source}")
        remote = _REMOTE_CORBITS.as_posix()
        await environment.upload_file(source, remote)
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {shlex.quote(remote)} && corbits --help >/dev/null",
        )

    async def _install_from_url(self, environment: BaseEnvironment, url: str) -> None:
        quoted_url = shlex.quote(url)
        remote = _REMOTE_CORBITS.as_posix()
        # Detect archive by URL suffix — do not use file(1) (absent in trivial images).
        path_part = url.lower().split("?", 1)[0]
        is_archive = path_part.endswith((".tar.gz", ".tgz", ".tar"))
        if is_archive:
            command = (
                "set -euo pipefail; "
                f"tmp=$(mktemp -d); "
                f"curl -fsSL {quoted_url} -o \"$tmp/artifact\"; "
                "tar -xaf \"$tmp/artifact\" -C \"$tmp\"; "
                "bin=$(find \"$tmp\" -type f -name corbits | head -n 1); "
                "if [ -z \"$bin\" ]; then "
                "  echo 'tarball did not contain a corbits binary' >&2; exit 1; "
                "fi; "
                f"install -m 755 \"$bin\" {shlex.quote(remote)}; "
                "corbits --help >/dev/null"
            )
        else:
            command = (
                "set -euo pipefail; "
                f"curl -fsSL {quoted_url} -o {shlex.quote(remote)}; "
                f"chmod 755 {shlex.quote(remote)}; "
                "corbits --help >/dev/null"
            )
        await self.exec_as_root(environment, command=command)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        meta = dict(context.metadata or {})
        if self._last_exit_code is not None:
            meta["exit_code"] = self._last_exit_code
        meta["agent"] = self.name()
        context.metadata = meta

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model = self._resolve_provider_model()
        api_key = self._resolve_api_key(provider)
        settings = build_settings(
            provider,
            model,
            api_key,
            base_url=self._resolve_base_url(),
            shell_timeout_ms=self._shell_timeout_ms,
        )

        remote_config = _REMOTE_SETTINGS.as_posix()
        await self._upload_config_text(
            environment,
            content=json.dumps(settings, indent=2) + "\n",
            remote_path=remote_config,
            filename="settings.json",
        )

        # Persist a redacted copy under agent logs for debugging.
        redacted = json.loads(json.dumps(settings))
        redacted["providers"][provider]["apiKey"] = "***"
        (self.logs_dir / "settings.redacted.json").write_text(
            json.dumps(redacted, indent=2) + "\n"
        )

        argv = build_exec_argv(
            cwd=self._task_cwd,
            config_path=remote_config,
            provider=provider,
            model=model,
            prompt=instruction,
            binary="corbits",
        )
        command = (
            "set -euo pipefail; "
            + " ".join(shlex.quote(part) for part in argv)
            + f" 2>&1 | tee {shlex.quote((EnvironmentPaths.agent_dir / _OUTPUT_FILENAME).as_posix())}; "
            "exit ${PIPESTATUS[0]}"
        )

        (self.logs_dir / "command.txt").write_text(command + "\n")

        # Bypass Harbor's _exec so the real exit code survives a failure; it
        # raises NonZeroAgentExitCodeError without exposing the code.
        result = await environment.exec(command=command)
        self._last_exit_code = result.return_code
        if result.return_code != 0:
            raise self._classify_exec_error(command, result)
