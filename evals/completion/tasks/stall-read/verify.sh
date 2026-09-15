#!/bin/sh
# Grader for stall-read: passes only when report.txt names the seed.
# The stall-profile responder re-reads instead of writing, so the reactor
# doom-loop guard is expected to break the run first.
set -eu
grep -q "7" report.txt
