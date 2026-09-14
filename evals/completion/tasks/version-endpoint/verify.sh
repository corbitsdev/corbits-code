#!/bin/sh
# Grader for version-endpoint: asserts runtime behavior, not file text.
set -eu
version="$(bun -e 'import {handleRequest} from "./service.ts"; const r = handleRequest("GET","/version"); if (r.status !== 200) throw new Error("bad status"); console.log(r.body.version)')"
test "$version" = "1.0.0"
health="$(bun -e 'import {handleRequest} from "./service.ts"; console.log(handleRequest("GET","/health").status)')"
test "$health" = "200"
