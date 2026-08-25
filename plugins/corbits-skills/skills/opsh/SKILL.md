---
name: opsh
user-invocable: false
description: Write scripts using opsh and its built-in libraries. Tiny scripts: DIY with these rules. Substantial script work: copy the rules into an implement brief. Load when writing, reviewing, or debugging opsh scripts.
---

# opsh Scripting

How to write scripts with opsh and its libraries. Tiny / single-file scripts: DIY with write_file/edit_file using these rules. Substantial script work: spawn `task(agent="builder")` with these rules copied into the brief (workers do not mount `use_skill`). For a review, spawn `task(agent="critic")` (or `task(agent="neckbeard")` for hygiene-only) with the same rules copied in.

Shell for agent commands is `run_shell`. Bash-the-language in the examples below stays — opsh scripts are bash.

opsh is a scripting environment for operations use. It is a curated bash
environment with sensible defaults and a standard library. Scripts are
bash, but opsh sets strict runtime options and provides a library
ecosystem accessed via `lib::import`.

## Script Structure

Every opsh script starts with:

```bash
#!/usr/bin/env opsh

lib::import git semver   # import libraries you need

# your script here
```

opsh can also be sourced into an existing bash script:

```bash
#!/usr/bin/env bash
source opsh
lib::import git
```

## Runtime Defaults

opsh sets these options before your script runs. Do not disable them.

| Setting                    | Effect                                           |
| -------------------------- | ------------------------------------------------ |
| `set -e` (errexit)         | Non-zero return terminates unless caught         |
| `set -u` (nounset)         | Referencing an unset variable is fatal           |
| `set -o pipefail`          | A pipeline fails if any command in it fails      |
| `IFS=''`                   | Word splitting is disabled by default            |
| `shopt -s inherit_errexit` | Command substitutions inherit errexit            |
| `set -o errtrace`          | ERR traps propagate into functions and subshells |

**The `IFS=''` default is important.** Unquoted `$var` where
`var="a b c"` stays as a single string, not three words. Use
`array::split` when you actually need to split a string.

## Global Variables

These are set by opsh before your script runs:

| Variable       | Description                                 |
| -------------- | ------------------------------------------- |
| `$SCRIPTFILE`  | Absolute path to your script                |
| `$SCRIPTDIR`   | Directory containing your script            |
| `$TMPDIR`      | Managed temp directory, cleaned up on exit  |
| `$OPSHROOTDIR` | Root of the opsh installation               |
| `$DEBUG`       | Set this (any value) to enable `log::debug` |

Color variables `$CRED`, `$CGRN`, `$CYEL`, `$CBLU`, `$CNONE` are
available and are automatically empty when output is not a terminal.

## Import System

```bash
lib::import <name> [name2 ...]
```

- Imports are idempotent; importing the same library twice is safe.
- Libraries can declare their own dependencies (e.g. `ssh` imports
  `path`, `cloud-init` imports `command`).
- If a library is not found, the script dies via `log::fatal`.
- Multiple libraries can be imported in a single call.

## Naming Convention

All opsh functions use `module::function` naming with `::` as the
namespace separator. Follow this convention in your own scripts:

```bash
deploy::prepare() { ... }
deploy::execute() { ... }
deploy::cleanup() { ... }
```

## Core Functions (Always Available)

### Logging

All log output goes to stderr. Messages are colorized when stderr is a
terminal.

| Function     | Behavior                               |
| ------------ | -------------------------------------- |
| `log::debug` | Blue output, only when `$DEBUG` is set |
| `log::info`  | Green output                           |
| `log::warn`  | Yellow output                          |
| `log::error` | Red output                             |
| `log::fatal` | Red output, then `exit 1`              |

```bash
log::info "deploying version $VERSION..."
log::fatal "config file not found"
```

### Exit Triggers

Register cleanup functions that run on exit in LIFO (last-in,
first-out) order:

```bash
exit::trigger <function_or_command> [args...]
```

```bash
start-service() { ... }
stop-service() { ... }

start-service
exit::trigger stop-service    # guaranteed to run on exit
```

Multiple triggers are supported. They run in reverse registration order.

### Temporary Files

`$TMPDIR` is a managed directory that is automatically removed on exit.
Create files and directories inside it:

```bash
temp::file [mktemp_args...]   # create a temp file in $TMPDIR
temp::dir  [mktemp_args...]   # create a temp directory in $TMPDIR
```

```bash
scratch=$(temp::file)
echo "data" > "$scratch"
# no cleanup needed; $TMPDIR is removed on exit
```

### Array Utilities

```bash
array::join <delimiter> <element1> [element2 ...]
array::split <nameref> <delimiter> <string>
```

```bash
parts=(one two three)
array::join , "${parts[@]}"       # stdout: one,two,three

array::split result ":" "$PATH"   # result is now an array
```

### Version Management

```bash
opsh::version                     # print the opsh version
opsh::version::require <min>      # fatal if opsh is too old
```

```bash
opsh::version::require 0.9.0
```

## Libraries

### command

```bash
lib::import command
```

| Function          | Description                        |
| ----------------- | ---------------------------------- |
| `command::exists` | Returns 0 if command is in `$PATH` |

```bash
command::exists docker || log::fatal "docker is required"
```

### path

```bash
lib::import path
```

| Function            | Description                     |
| ------------------- | ------------------------------- |
| `path::env::add`    | Prepend directories to `$PATH`  |
| `path::env::remove` | Remove a directory from `$PATH` |

```bash
path::env::add /opt/mytools/bin
path::env::remove /usr/local/old/bin
```

### git

```bash
lib::import git
```

| Function                    | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `git::repo::version`        | Version from `git describe --tags --dirty` or short SHA |
| `git::repo::current-branch` | Current branch name                                     |
| `git::repo::is-clean`       | Returns 0 if working tree is clean                      |
| `git::tag::exists`          | Returns 0 if a local tag exists                         |
| `git::tag::lookup::remote`  | Lookup a tag on a remote; prints commit hash            |

`git::tag::lookup::remote` returns 1 if the tag is not found, 2 if
ambiguous.

```bash
VERSION=$(git::repo::version)
git::repo::is-clean || log::fatal "working tree is dirty"
```

### semver

```bash
lib::import semver
```

| Function        | Description                                             |
| --------------- | ------------------------------------------------------- |
| `semver::parse` | Parse into `$OPSH_SEMVER` array `[major, minor, patch]` |
| `semver::test`  | Compare two versions: `-eq`, `-gt`, `-lt`, `-ge`, `-le` |
| `semver::bump`  | Bump `major`, `minor`, or `patch`; prints new version   |

`semver::parse` populates the global `$OPSH_SEMVER` array. If the
version has a suffix (e.g. `-rc1`, `+build`), it appears as a fourth
element.

```bash
semver::parse v2.1.0 || log::fatal "bad version"
echo "major: ${OPSH_SEMVER[0]}"  # 2

semver::test "$current" -ge "$minimum" || log::fatal "version too old"

new=$(semver::bump minor v1.2.3)  # v1.3.0
```

### ssh

```bash
lib::import ssh
```

| Function                 | Description                                   |
| ------------------------ | --------------------------------------------- |
| `ssh::begin`             | Start SSH context: agent, proxied ssh, config |
| `ssh::end`               | Tear down SSH context                         |
| `ssh::config`            | Append SSH config from stdin                  |
| `ssh::key::add`          | Add keys from files or stdin to the agent     |
| `ssh::background::run`   | Launch SSH port forwarding in background      |
| `ssh::background::close` | Close background port forwarding              |

`ssh::begin` creates an isolated SSH agent, a proxied `ssh` binary
that uses a managed config file, and registers `ssh::end` as an exit
trigger. Everything between `ssh::begin` and `ssh::end` uses this
isolated context.

```bash
ssh::begin
ssh::config <<'EOF'
Host bastion
    User deploy
    HostName bastion.example.com
EOF
ssh::key::add ~/.ssh/deploy_key
ssh bastion "uptime"
ssh::end
```

### cloud-init

```bash
lib::import cloud-init
```

| Function                      | Description                        |
| ----------------------------- | ---------------------------------- |
| `cloud-init::is-enabled`      | Returns 0 if cloud-init is present |
| `cloud-init::wait-for-finish` | Blocks until cloud-init completes  |

```bash
if cloud-init::is-enabled; then
    log::info "waiting for cloud-init..."
    cloud-init::wait-for-finish
fi
```

### step-runner

```bash
lib::import step-runner
```

| Function     | Description                                         |
| ------------ | --------------------------------------------------- |
| `steps::run` | Run all `prefix::*` functions in alphabetical order |

Define functions with a shared prefix, then run them:

```bash
deploy::01-build() { ... }
deploy::02-test()  { ... }
deploy::03-push()  { ... }

steps::run deploy           # runs all three in order
steps::run deploy 02-test   # starts from 02-test
```

`steps::run` logs each step as it executes. Use numbered prefixes to
control ordering.

### test-harness

```bash
lib::import test-harness
```

| Function            | Description                                 |
| ------------------- | ------------------------------------------- |
| `testing::register` | Register a test function with a description |
| `testing::run`      | Execute all tests, output TAP v13           |
| `testing::fail`     | Fail the current test with a message        |

See the "Writing Tests" section below.

## Common Idioms

### Fatal preconditions

Use `|| log::fatal` for conditions that must be true:

```bash
[[ -f $CONFIG ]] || log::fatal "config not found: $CONFIG"
command::exists kubectl || log::fatal "kubectl is required"
```

### Recoverable errors

Capture the return code when you need to handle failure:

```bash
local ret=0
some-command || ret=$?
if [[ $ret -ne 0 ]]; then
    log::warn "command failed with $ret, retrying..."
fi
```

### Cleanup with exit triggers

Register cleanup in the order you acquire resources. They run in
reverse:

```bash
start-database
exit::trigger stop-database

start-server
exit::trigger stop-server
# on exit: stop-server runs first, then stop-database
```

### Default values

Use the `${var:=default}` pattern (standard bash parameter expansion).
The `:` builtin discards the result while still triggering assignment:

```bash
: "${DEPLOY_ENV:=staging}"
: "${RETRIES:=3}"
```

## Writing Tests

Test files use the `test-harness` library and output TAP v13 format.
They are typically run with `prove`:

```bash
#!/usr/bin/env opsh

lib::import test-harness

check-something() {
    local result
    result=$(my-function)
    [[ $result = "expected" ]] || testing::fail "got: $result"
}

testing::register check-something "verify my-function output"

check-another-thing() {
    my-precondition || testing::fail
    my-action || testing::fail "action failed"
}

testing::register check-another-thing "verify action succeeds"

testing::run
```

**Key patterns:**

- Use `|| testing::fail` as an assertion. Optionally pass a message.
- Each test function runs in a subshell, so variable changes do not
  leak between tests.
- Register all tests before calling `testing::run`.
- Use `$SCRIPTDIR` to locate fixture files and shared utilities
  relative to the test file.
- Source shared test helpers with `source "$SCRIPTDIR/utils.opsh"`.

### Checking command output

A common pattern uses `diff -u` against a heredoc to verify output:

```bash
check-output() {
    local outfile
    outfile=$(temp::file)

    my-command > "$outfile"

    diff -u - "$outfile" <<EOF || testing::fail
expected output here
EOF
}
```

### Checking return codes

```bash
check-failure() {
    local ret=0
    bad-command || ret=$?
    [[ $ret -eq 1 ]] || testing::fail "expected exit 1, got $ret"
}
```

## Formatting and Linting

When available:

- Format with: `shfmt`
- Lint with: `shellcheck -s bash -x`

## Quick Reference

```
lib::import <lib>             # import a library
log::{debug,info,warn,error}  # log to stderr
log::fatal                    # log and exit 1
exit::trigger <func>          # register cleanup (LIFO)
temp::file / temp::dir        # create managed temp files
array::join <delim> <args>    # join to stdout
array::split <ref> <delim> <s># split into named array
command::exists <cmd>         # check PATH for a command
path::env::add <dir>          # prepend to $PATH
path::env::remove <dir>       # remove from $PATH
git::repo::version            # repo version string
git::repo::current-branch     # current branch name
git::repo::is-clean           # clean working tree?
git::tag::exists <tag>        # local tag exists?
semver::parse <ver>           # parse into $OPSH_SEMVER
semver::test <a> <op> <b>     # compare versions
semver::bump <pos> <ver>      # bump major/minor/patch
ssh::begin / ssh::end         # SSH context lifecycle
ssh::config <<EOF             # append SSH config
ssh::key::add [files]         # add keys to agent
steps::run <prefix> [start]   # run prefixed functions
testing::register <fn> [desc] # register a test
testing::run                  # execute all tests (TAP v13)
testing::fail [msg]           # fail current test
```
