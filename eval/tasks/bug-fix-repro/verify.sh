#!/usr/bin/env bash
# Objective grader: the task's own test suite. Exit 0 = success.
set -e
cd "$(dirname "$0")/repo"
bun test
