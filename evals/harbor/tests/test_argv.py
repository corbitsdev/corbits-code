"""Unit tests for Harbor adapter argv/settings helpers (no Harbor package)."""

from __future__ import annotations

import unittest

from evals.harbor.argv import api_key_env_names, build_exec_argv, build_settings


class BuildSettingsTests(unittest.TestCase):
    def test_requires_base_url_and_always_emits_base_url(self) -> None:
        settings = build_settings(
            "xai",
            "grok-4.5",
            "sk-test",
            base_url="https://api.x.ai/v1",
        )
        self.assertEqual(
            settings,
            {
                "providers": {
                    "xai": {
                        "apiKey": "sk-test",
                        "models": ["grok-4.5"],
                        "baseURL": "https://api.x.ai/v1",
                    }
                }
            },
        )

    def test_base_url_and_shell_timeout(self) -> None:
        settings = build_settings(
            "openai",
            "gpt-5",
            "sk-openai",
            base_url="https://example.com/v1",
            shell_timeout_ms=120_000,
        )
        self.assertEqual(
            settings["providers"]["openai"],
            {
                "apiKey": "sk-openai",
                "models": ["gpt-5"],
                "baseURL": "https://example.com/v1",
            },
        )
        self.assertEqual(settings["shell"], {"timeoutMs": 120_000})

    def test_omits_shell_when_unset(self) -> None:
        settings = build_settings(
            "codex",
            "gpt-5.3-codex",
            "sk",
            base_url="https://api.openai.com/v1",
        )
        self.assertEqual(
            settings["providers"]["codex"]["baseURL"],
            "https://api.openai.com/v1",
        )
        self.assertNotIn("shell", settings)


class BuildExecArgvTests(unittest.TestCase):
    def test_exact_order_includes_skip_permissions(self) -> None:
        argv = build_exec_argv(
            cwd="/app",
            config_path="/tmp/corbits-settings.json",
            provider="xai",
            model="grok-4.5",
            prompt="Write hello.txt",
        )
        self.assertEqual(
            argv,
            [
                "corbits",
                "exec",
                "--cwd",
                "/app",
                "--config",
                "/tmp/corbits-settings.json",
                "--provider",
                "xai",
                "--model",
                "grok-4.5",
                "--dangerously-skip-permissions",
                "Write hello.txt",
            ],
        )

    def test_custom_binary(self) -> None:
        argv = build_exec_argv(
            cwd="/work",
            config_path="/cfg.json",
            provider="xai",
            model="grok-4.5",
            prompt="hi",
            binary="/usr/local/bin/corbits",
        )
        self.assertEqual(argv[0], "/usr/local/bin/corbits")
        self.assertEqual(argv[-2:], ["--dangerously-skip-permissions", "hi"])
        self.assertNotIn("--force", argv)


class ApiKeyEnvNamesTests(unittest.TestCase):
    def test_only_generic_and_selected_provider(self) -> None:
        self.assertEqual(
            api_key_env_names("openai"), ("CORBITS_API_KEY", "OPENAI_API_KEY")
        )

    def test_no_cross_provider_fallback(self) -> None:
        names = api_key_env_names("xai")
        self.assertNotIn("OPENAI_API_KEY", names)
        self.assertNotIn("ANTHROPIC_API_KEY", names)


if __name__ == "__main__":
    unittest.main()
