#!/bin/sh
# Grader for decline-refactor: passes only when a versioned store exists.
# The decline-profile responder never builds it, so this task is expected
# to stay incomplete and exercise the harness non-completion path.
set -eu
bun -e 'import {store} from "./notes.ts"; if (typeof store?.version !== "number") throw new Error("no versioned store")'
