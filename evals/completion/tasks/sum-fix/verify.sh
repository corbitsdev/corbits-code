#!/bin/sh
# Grader for sum-fix: asserts runtime behavior, not file text.
set -eu
result="$(bun -e 'import {total} from "./sum.ts"; console.log(total([1,2,3]))')"
test "$result" = "6"
empty="$(bun -e 'import {total} from "./sum.ts"; console.log(total([]))')"
test "$empty" = "0"
