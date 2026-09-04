---
name: ast-grep
description: Bulk code refactoring using AST patterns instead of manual read-edit-write cycles. Load this skill when renaming, changing signatures, or migrating API usage across many files.
---

# ast-grep

Use `ast-grep` (CLI: `sg`) for structural code search and rewriting. It matches and transforms code using Abstract Syntax Tree patterns rather than text, so it understands code structure and handles formatting, whitespace, and nesting correctly.

If you can describe the change as "rename X to Y" or "change all A-shaped code to B-shaped code," use ast-grep — even if you already know some of the locations. Knowing where the definitions are does not mean you know where all the access sites are.

Prefer ast-grep over manual read-edit-write cycles when:

- Renaming functions, methods, types, or variables across files
- Changing function signatures (adding/removing/reordering arguments)
- Migrating API calls from one shape to another
- Updating import paths or restructuring imports
- Applying the same structural transformation to many call sites
- Any change where the pattern is "find all X shaped like this, replace with Y"

Do not use ast-grep when:

- The change is truly isolated — a single site with no callers, no consumers, no matching pattern elsewhere in the codebase (e.g., fixing a typo in one string literal)
- The transformation depends on runtime semantics ast-grep cannot see (e.g., type resolution across modules)
- The target language is not supported

## Supported Languages

JavaScript, TypeScript, TSX, JSX, Python, Rust, Go, Java, C, C++, C#, Kotlin, Swift, Scala, Ruby, PHP, Lua, Bash, Dart, Elixir, Haskell, HTML, CSS, JSON, YAML.

Not supported: SCSS, Vue, Svelte, OCaml, SQL, Dockerfile, XML, TOML.

## Pattern Syntax

Patterns are code snippets in the target language with metavariable placeholders.

### Metavariables

| Syntax | Meaning |
|---|---|
| `$NAME` | Matches exactly one AST node, captured as `NAME` |
| `$_` | Matches one node, not captured |
| `$$$NAME` | Matches zero or more sibling nodes, captured as `NAME` |
| `$$$` | Matches zero or more siblings, not captured |

**Same-name constraint:** Two occurrences of the same metavariable in one pattern must match identical text. `foo($X, $X)` matches `foo(a, a)` but not `foo(a, b)`.

### Pattern Rules

1. A pattern must parse as a single AST node (or sibling sequence with `$$$`).
2. Multi-statement patterns are not supported. `x = 1; y = 2` will error. Use relational rules (`inside`, `has`, `follows`) for multi-node relationships.
3. Optional syntax (like `extends` on a class) must appear in the pattern to match nodes that have it. Use `$$$` to absorb optional parts: `class $NAME $$$REST { $$$BODY }` matches both `class Foo {}` and `class Foo extends Bar {}`.
4. Code inside comments is not matched by patterns (a commented-out `console.log(...)` will not match pattern `console.log($$$)`). However, comment nodes themselves can be targeted using `kind: comment` in YAML rules.
5. Whitespace and formatting differences are ignored — the match is structural, not textual.

## Inline Patterns with `sg run`

Use `sg run` for quick, one-off search and rewrite operations. This is the default approach — reach for YAML rules only when you need constraints, transforms, or relational matching.

### Search

```bash
sg run --pattern 'console.log($$$ARGS)' --lang js src/
```

### Search and rewrite (preview diff)

```bash
sg run --pattern 'console.log($$$ARGS)' --rewrite 'logger.info($$$ARGS)' --lang js src/
```

### Apply rewrites in place

```bash
sg run --pattern 'console.log($$$ARGS)' --rewrite 'logger.info($$$ARGS)' --lang js -U src/
```

The `-U` (`--update-all`) flag applies changes to files without prompting. Without it, ast-grep prints a diff preview.

### Key flags

| Flag | Purpose |
|---|---|
| `-p, --pattern` | AST pattern to match |
| `-r, --rewrite` | Replacement template using captured metavariables |
| `-l, --lang` | Target language |
| `-U, --update-all` | Apply rewrites in place |
| `--globs` | Filter files by glob (prefix `!` to exclude) |
| `--json` | Structured JSON output |
| `--debug-query=<mode>` | Show AST structure; modes: `pattern` (pattern parse tree), `ast` (named nodes), `cst` (full tree), `sexp` (S-expression). Requires `--lang`. |

### Common inline recipes

**Rename a function call site:**
```bash
sg run -p 'oldName($$$ARGS)' -r 'newName($$$ARGS)' -l js -U src/
```
This pattern only matches `identifier` nodes in call-expression position. It will not catch the name where it appears as a type annotation (`type_identifier`), an interface or object field (`property_identifier`), a destructured binding (`shorthand_property_identifier_pattern`), or an object literal shorthand (`shorthand_property_identifier`). For a name that appears in more than one syntactic position, use the multi-kind rename recipe below.

**Rename an identifier across all syntactic positions (TypeScript):**

In TypeScript the same bare name parses as a different AST node kind depending on where it sits — `identifier` in expressions, `type_identifier` in type annotations, `property_identifier` in interface or object fields, `shorthand_property_identifier_pattern` in destructured bindings, and `shorthand_property_identifier` in object literal shorthand. A bare inline rewrite (`sg run -p 'OldName' -r 'NewName'`) only matches `identifier` and silently misses the rest. Use a YAML rule that enumerates the node kinds:

```bash
sg scan --inline-rules '
id: rename-identifier
language: typescript
rule:
  any:
    - kind: identifier
      regex: "^OldName$"
    - kind: type_identifier
      regex: "^OldName$"
    - kind: property_identifier
      regex: "^OldName$"
    - kind: shorthand_property_identifier_pattern
      regex: "^OldName$"
    - kind: shorthand_property_identifier
      regex: "^OldName$"
fix: NewName
' -U src/
```

This is the default approach for renaming a type, class, interface, or any identifier that may surface in more than just call-site position. The inline `sg run -p` form is the shortcut for call-site-only renames.

**Change an import source:**
```bash
sg run -p 'import $$$ITEMS from "old-package"' -r 'import $$$ITEMS from "new-package"' -l ts -U src/
```
Use `$$$ITEMS` (not `$ITEMS`) because `import type` inserts an extra `type` node as a sibling before the import clause. `$ITEMS` expects exactly one node in that position and fails when two are present.

The symmetric export form does not work inline. `sg run -p 'export $$$ITEMS from "old-package"' -r '...'` fails with "Multiple AST nodes are detected" — the re-export does not parse as a single AST node. For re-export source rewrites, use a YAML rule keyed on `kind: export_statement` with a `has` constraint on the source string, or fall back to manual edits when the file count is small.

**Add an argument to a call:**
```bash
sg run -p 'client.get($URL)' -r 'client.get($URL, { timeout: 5000 })' -l ts -U src/
```

**Wrap a call with an additional outer call:**
```bash
sg run -p 'fetchData($$$ARGS)' -r 'withRetry(() => fetchData($$$ARGS))' -l ts -U src/
```

**Unwrap a wrapper (Rust):**
```bash
sg run -p '$EXPR.unwrap()' -r '$EXPR?' -l rust -U src/
```

**Remove a function call, keep the argument:**
```bash
sg run -p 'deprecated($VALUE)' -r '$VALUE' -l js -U src/
```

## YAML Rules

Use YAML rules when you need constraints, transforms, relational matching, or complex multi-part logic that inline patterns cannot express.

### Basic rule structure

```yaml
id: replace-console-log
language: javascript
rule:
  pattern: console.log($$$ARGS)
fix: logger.info($$$ARGS)
```

Run a single rule file:
```bash
sg scan --rule my-rule.yaml src/
sg scan --rule my-rule.yaml -U src/
```

### Inline YAML rules

For quick one-offs that need rule features but not a file:
```bash
sg scan --inline-rules '
id: example
language: javascript
rule:
  pattern: console.log($$$ARGS)
fix: logger.info($$$ARGS)
' src/
```

### Constraints

Filter metavariable matches by node kind or regex:

```yaml
id: ban-untyped-empty-objects
language: typescript
rule:
  pattern: "const $NAME: {} = $VALUE"
constraints:
  NAME:
    regex: "^[a-z]"
message: "Avoid empty object type {}; use Record<string, unknown> instead"
```

Constraints narrow which matches a rule reports or rewrites. Use `regex` to filter by the matched text content, or `kind` to filter by AST node type.

### Relational rules

Match based on the structural position of nodes relative to each other:

```yaml
rule:
  pattern: console.log($$$)
  inside:
    kind: function_declaration
    stopBy: end
```

**`stopBy: end` is critical.** Without it, `inside` only checks the immediate parent node. With `stopBy: end`, it traverses all ancestors up to the file root. This matters because even simple nesting has multiple intermediate AST nodes between a matched node and its logical container (e.g., `call_expression` → `expression_statement` → `statement_block` → `function_declaration`). Without `stopBy: end`, matching `console.log($$$)` inside a `function_declaration` fails even with trivial one-level nesting. Always add `stopBy: end` unless you specifically want immediate-parent-only matching.

Available relational rules:

| Rule | Meaning |
|---|---|
| `inside` | Node is a descendant of a matching ancestor |
| `has` | Node has a descendant matching this |
| `follows` | Node is preceded by a matching sibling |
| `precedes` | Node is followed by a matching sibling |

All accept `stopBy` with three valid forms: `neighbor` (only check adjacent — the default when omitted), `end` (traverse all the way to the root), or a rule object (e.g., `stopBy: { kind: function_declaration }` to stop at a specific node type).

### Matching by node kind

Use `kind` to match all AST nodes of a given type regardless of content:

```yaml
id: find-arrow-functions
language: typescript
rule:
  kind: arrow_function
```

This matches every arrow function in the codebase. Combine with `has`, `inside`, or `constraints` to narrow further. Use `--debug-query=ast` on a representative code snippet to discover the node kind names for your target language.

### Combinators

Compose rules with boolean logic:

```yaml
rule:
  all:
    - pattern: $FUNC($$$ARGS)
    - not:
        pattern: logger.$_($$$)
```

| Combinator | Meaning |
|---|---|
| `all` | All sub-rules must match (AND) |
| `any` | Any sub-rule must match (OR) |
| `not` | Sub-rule must not match (NOT) |

### Disambiguating same-named identifiers

When the same identifier appears in multiple semantic contexts and you only want to match some of them, use these techniques:

**By sibling content.** Match only when a sibling property has a specific value (e.g., only match `message` inside objects that also contain `type: "inference.done"`):

```yaml
rule:
  kind: pair
  has:
    field: key
    kind: property_identifier
    regex: "^message$"
  inside:
    kind: object
    has:
      kind: pair
      has:
        field: value
        regex: "inference\\.done"
    stopBy: neighbor
```

**By descendant access chain.** Exclude matches that are part of a longer property chain (e.g., match `$X.data.message` but not `$X.data.message.headers`):

```yaml
rule:
  pattern: $X.data.message
  not:
    inside:
      pattern: $X.data.message.headers
      stopBy: end
fix: $X.data.turn
```

**By node kind.** Distinguish type-level vs value-level occurrences. Use `kind: property_signature` for interface/type definitions and `kind: pair` for object literal expressions — they share the same surface syntax but are different AST nodes.

### Transforms

Derive new metavariables for use in `fix`:

```yaml
id: snake-to-camel
language: typescript
rule:
  pattern: $FUNC($$$ARGS)
transform:
  CAMEL_NAME:
    convert:
      source: $FUNC
      toCase: camelCase
fix: $CAMEL_NAME($$$ARGS)
```

Available transforms:

| Transform | Purpose |
|---|---|
| `convert` | Change case (`upperCase`, `lowerCase`, `camelCase`, `snakeCase`, `pascalCase`, `kebabCase`) |
| `substring` | Extract a substring by char index |
| `replace` | String find-and-replace within a metavar |
| `rewrite` | Apply sub-rewriters to a metavar (for nested transformations) |

## Debugging Non-Matching Patterns

When a pattern does not match what you expect:

1. **Inspect your pattern's AST.** Use `--debug-query=pattern` to see how ast-grep parses your pattern:
   ```bash
   sg run --pattern 'your_pattern($X)' --lang js --debug-query=pattern
   ```

2. **Inspect the source code's AST.** Use the target code itself as the pattern to see its tree structure:
   ```bash
   sg run --pattern 'myFunc(arg1, arg2)' --lang js --debug-query=ast
   ```
   This shows you the node kinds in the source, which tells you what your real pattern needs to match against. Compare the AST of your pattern (step 1) with the AST of the source to find the mismatch.

3. **Common causes of non-matches:**
   - **Ambiguous parse:** The pattern is valid syntax but parsed as something you did not intend. ast-grep picks the first valid AST interpretation, which may not be what you meant. The most common case: `key: value` patterns (e.g., `message: AssistantTurn`) parse as a **labeled statement** (`message:` label + `AssistantTurn` expression), not a property signature or object pair. The pattern silently matches nothing (exit 1, no error). Use `--debug-query=pattern` — if the output shows `labeled_statement`, you have hit this. Fix by wrapping in braces for object context (`{ message: $VAL }`) or using a YAML rule with `kind: property_signature` or `kind: pair` to match the intended node type.
   - Optional syntax missing from pattern (add `$$$` to absorb it)
   - Multi-statement pattern (not supported — use relational rules)
   - Wrong node granularity (pattern matches expression but code is in a statement context, or vice versa)
   - Language alias mismatch (`ts` vs `typescript` vs `tsx` — use the right one for the file type)

## Exit Codes

`sg run`: exit `0` means matches were found, exit `1` means no matches — but this is not reliable when the pattern contains an ERROR node, which also exits 0 with zero matches and a warning on stderr. Always check stderr for warnings. Other exit codes indicate errors (e.g., 3 when `--stdin` is used without `--lang`, 2 when `--debug-query` is used without `--lang`, 8 for patterns that fail to parse such as multi-statement patterns). Do not treat all non-zero exits as "no matches."

`sg scan`: exit `0` means no error-severity findings, exit `1` means at least one `severity: error` finding. All other severities (`warning`, `info`, `hint`) exit `0`.

## Language Detection

When running on file paths, ast-grep auto-detects the language from file extensions. The `--lang` flag is required when using `--stdin` (no file extension to infer from) or when using `--debug-query` (always requires explicit language). You can omit `--lang` for normal search and rewrite operations targeting directories or specific files.

## Workflow Guidance

### Before writing any pattern

These steps are mandatory, not advisory. Skipping them is the single most common cause of wasted work with ast-grep.

1. **Check known pitfalls.** Review the "Common causes of non-matches" list in the Debugging section before writing your pattern. The labeled statement trap (`key: value` parsing as a label, not a property) catches people repeatedly even after they know about it.
2. **Inspect your pattern's parse.** Run `--debug-query=pattern` on every new pattern before using it. If the output shows an unexpected node type (e.g., `labeled_statement` when you expected `pair`), fix the pattern before proceeding.
3. **Inspect the source code's AST.** Run `--debug-query=ast` on a representative snippet of the code you want to match. Identifiers parse as different node kinds depending on context — `property_identifier`, `shorthand_property_identifier`, `type_identifier`, etc. — and a pattern written for the wrong kind will silently match nothing. Discover the actual node kinds before writing the pattern.

### Before applying rewrites

**Never apply blind.** Do not pass `-U` on the first run. A blind rewrite overwrites file content in place with no recovery path short of `git checkout` — and if the fix template was wrong, the revert may not restore the original code (e.g., a hardcoded replacement loses the distinct values that were at each site). Follow these steps in order:

1. **Preview first.** Run without `-U` to see the diff.
2. **Check match count.** Pipe through `--json | jq length` or review the diff output. If the count is higher than expected, inspect the extra matches before applying. If it is lower, you are missing sites.
3. **Scan the whole repo.** The pattern itself provides selectivity — do not manually restrict to specific directories, as this leads to missed rename sites that only surface as build failures. Use `--globs` only to exclude known false positives (e.g., `--globs '!**/vendor/**'` or `--globs '!**/generated/**'`). Always use `**/` in exclusion patterns to match at any depth.
4. **Apply.** Only after previewing and confirming the match set, run with `-U`.

### After applying rewrites

5. **Format.** ast-grep rewrites can collapse multi-line formatting to single lines. Run the project's formatter (prettier, rustfmt, gofmt, etc.) after applying rewrites.
6. **Check for stragglers.** Grep for the old name across all file types — including comments, strings, docs, and test fixtures. ast-grep only matches code structure; occurrences in prose, JSDoc, string literals, and non-code files will be missed.
7. **Run the type checker.** ast-grep matches on syntax, not semantics — it cannot guarantee that every reference to a name has been caught across every syntactic context, and it cannot see scope. In typed languages, run the type checker before the test suite. It is the safety net that surfaces both kinds of miss: occurrences of the old name that the pattern did not anticipate (e.g., type annotations missed by a call-site-only rename), and scope collisions where the new name shadows an existing binding. Without a type checker, these gaps are silent and only show up at runtime.
8. **Run the full build.** Run the project's build and test suite to catch anything ast-grep's structural matching could not anticipate.

### Terminology migrations

When a rename is a terminology migration (not just a code rename), the code rewrite is only part of the job. After ast-grep handles the structural code changes, do a deliberate manual pass over:

- Comments and JSDoc that reference the old terminology
- Documentation files (README, guides, API docs)
- String literals (error messages, log messages, descriptions)
- Schema names and persisted keys that should reflect the new terminology

ast-grep handles code; prose requires separate attention. Skipping this pass leaves the codebase in an inconsistent state where code says one thing and documentation says another.

### Choosing inline vs YAML

| Situation | Use |
|---|---|
| Call-site-only rename or argument change | `sg run -p ... -r ...` |
| Renaming an identifier that may appear in type annotations, fields, or destructuring | YAML rule with `any:` over the relevant node kinds (see "Rename an identifier across all syntactic positions" above) |
| Need to exclude certain matches | YAML rule with `not` or `constraints` |
| Need positional context (inside a function, after an import) | YAML rule with `inside`/`follows`/`precedes` |
| Need case conversion or string manipulation in the replacement | YAML rule with `transform` |
| Applying multiple related transformations | Multiple `sg run` commands in sequence, or multiple YAML rules |

### Combining with manual edits

ast-grep handles the bulk structural transformation. Use manual edits for:

- New code that has no existing pattern to transform from
- Changes that require understanding type relationships across files
- One-off fixups after a bulk rewrite (e.g., adjusting a special case that the pattern caught incorrectly)

The ideal workflow for a large refactor: ast-grep for the mechanical bulk, manual edits for the exceptions, build verification to confirm everything holds together.

## Acknowledgment

After reviewing this skill, state: "I have reviewed the ast-grep skill."
