# Contributing to Intercode

Thanks for contributing. This document covers setup, workflow, and legal requirements. Coding conventions live in `AGENTS.md` — read that before writing code.

## Prerequisites

- [Bun](https://bun.sh) v1.2 or newer (`package.json` engines)
- Git with submodule support

Clone with submodules (the `interchange` submodule is required):

```bash
git clone --recurse-submodules https://github.com/corbitsdev/intercode.git
cd intercode
bun install
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
bun install
```

Before your first commit, point Git at the project hooks and verify the environment:

```bash
git config core.hooksPath .githooks
./bin/check-env
```

## Development loop

```bash
bun run typecheck
bun run build
bun test ./src ./tests
```

These match the CI workflow in `.github/workflows/ci.yml`. Run the full suite before opening a PR.

## Pull requests

1. Keep changes focused — one concern per PR. See scope discipline in `AGENTS.md`.
2. Include or update tests for behavior changes. Bug fixes start with a failing test.
3. Use plain-English commit messages (no `feat:` / `fix:` prefixes). Details are in `AGENTS.md`.
4. Do not commit secrets, credentials, or generated noise.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`.

## Contributor License Agreement

All contributions require acceptance of the Contributor License Agreement in `CLA.md`. The CLA grants ABK Labs, Inc. rights needed to distribute contributions under the project license and alternative terms.

CLA acceptance is enforced on pull requests via the CLA Assistant workflow (`.github/workflows/cla.yml`). On your first contribution, the bot will ask you to comment:

```text
I have read the CLA Document and I hereby sign the CLA
```

Signatures are stored under `signatures/version1/cla.json`.

### Maintainer setup (one-time)

1. Ensure the CLA workflow file is on the default branch.
2. Confirm `path-to-document` in `.github/workflows/cla.yml` points at the published `CLA.md` URL.
3. The signature storage branch (`main` by default) must allow the action to commit signature updates. If you store signatures remotely, add a `PERSONAL_ACCESS_TOKEN` repository secret with repo write access and uncomment that env var in the workflow.
4. Optionally install the [CLA Assistant GitHub App](https://github.com/apps/cla-assistant) if you prefer the hosted app in addition to (or instead of) the action — the workflow as checked in uses `contributor-assistant/github-action` and does not require the App.

## Architecture docs

- `docs/ARCHITECTURE.md` — reactor loop, events, directors, permissions
- `docs/IMPLEMENTATION.md` — runtime, config, CLI, state
- `docs/PRODUCT.md` — product goals

## Questions

Open a GitHub issue for design discussion or bugs that are not security-sensitive. For security reports, see `SECURITY.md`.
