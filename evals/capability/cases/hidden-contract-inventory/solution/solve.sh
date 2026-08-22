#!/usr/bin/env bash
# Oracle reference patch for hidden-contract-inventory. Run with a workdir
# (a copy of the fixture) as cwd to apply the reference implementation, e.g.:
#   (cd /path/to/workdir && bash /path/to/solution/solve.sh)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

cp "$here/services/reservations.ts" src/services/reservations.ts
cp "$here/routes/reservations.ts" src/routes/reservations.ts

echo "applied oracle reservations implementation"
