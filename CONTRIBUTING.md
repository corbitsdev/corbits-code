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

Automated CLA enforcement is not yet enabled; the acceptance mechanism is being finalized. Until then, contributors accept the CLA by opening a pull request, and maintainers confirm acceptance during review.

## Architecture docs

- `docs/ARCHITECTURE.md` — reactor loop, events, directors, permissions
- `docs/IMPLEMENTATION.md` — runtime, config, CLI, state
- `docs/PRODUCT.md` — product goals

## Questions

Open a GitHub issue for design discussion or bugs that are not security-sensitive. For security reports, see `SECURITY.md`.
