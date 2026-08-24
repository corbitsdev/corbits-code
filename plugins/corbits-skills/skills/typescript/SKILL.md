---
name: typescript
user-invocable: false
description: TypeScript-specific coding conventions and type system patterns. Always load this skill when writing or reviewing TypeScript code.
---

# TypeScript

Guidance for TypeScript output quality. Prefer these patterns; they are not a substitute for reading the project's own `AGENTS.md`, tsconfig, or existing code. When project conventions disagree with this skill, follow the project.

Load alongside `style` and `philosophy` when writing or reviewing TS.

## Quick reference

**Prefer**

- `import type` for type-only imports
- `unknown` (then narrow) over `any`
- Runtime validation at every external boundary (fetch, fs, env, user input, third-party APIs)
- Factory functions (`create*`) that return plain objects over classes
- Letting the compiler infer obvious types
- `{ cause }` when re-throwing
- Named exports

**Avoid**

- Default exports
- Type assertions (`as T`) and non-null assertions (`x!`) — they are compile-time lies
- Hand-rolled `typeof` / shape guards for structured external data when a validator exists
- Explicit annotations the compiler already proves
- File extensions in imports unless the runtime or project requires them
- Inline `await import("./known-module")` for a static dependency

## Naming (TypeScript)

Language-general naming lives in `style`. TS-specific suffixes:

| Pattern | Use | Example |
| ------- | --- | ------- |
| `PascalCase` | Types, interfaces | `RequestConfig` |
| `*Args` / `*Opts` | Function arguments | `CreateHandlerOpts` |
| `*Response` | API / handler results | `SettleResponse` |
| `create*` | Factories | `createClient` |
| `is*` | Type predicates / booleans | `isValidationError` |

Acronyms keep their natural case in types and values (`JSONSchema`, `getURL`, `parseHTTPHeaders`). `ID` is an abbreviation → `userId`, `getId()`.

Files: lowercase with hyphens (`token-payment.ts`); tests co-located as `{name}.test.ts` or under the project's test tree.

## Type system

### Boundary validation

Validate external data with a schema library already in the project (arktype, zod, typebox, …). Prefer deriving the TypeScript type from the validator:

```typescript
import { type } from "arktype";

export const PaymentRequest = type({
  scheme: "string",
  network: "string",
  amount: "string.numeric",
  resource: "string.url",
});

export type PaymentRequest = typeof PaymentRequest.infer;
```

If the project has no validator yet and needs one, prefer arktype. Do not invent parallel hand-rolled parsers for the same shape.

### Narrowing

Use validators and predicates; avoid casting into a branded shape:

```typescript
export function isAddress(maybe: unknown): maybe is Address {
  return !isValidationError(Address(maybe));
}
```

### `type` vs `interface`

- **`type`** — data shapes, unions, intersections, validator-derived types
- **`interface`** — behavioral contracts (objects with methods), when declaration merging is intentional

```typescript
export type RequestContext = {
  request: RequestInfo | URL;
};

export interface PaymentHandler {
  handleSettle: (requirements, payment) => Promise<SettleResponse | null>;
}
```

### Exhaustive literals

```typescript
const PaymentMode = {
  Direct: "direct",
  Deferred: "deferred",
} as const;

type PaymentMode = (typeof PaymentMode)[keyof typeof PaymentMode];
```

Prefer `as const` objects over TypeScript `enum`.

### Inference vs annotation

Let TypeScript infer when the type is obvious. Annotate when:

- The symbol is a public API boundary and the type is documentation
- Inference would widen too far
- The compiler cannot infer correctly

Do not annotate loop variables, trivial locals, or callback params already constrained by context.

### Assertions and `any`

`as T` and `x!` change compile-time types only. Prefer validation or restructuring:

```typescript
// Prefer
const raw = await response.json();
const data = UserData(raw);
if (isValidationError(data)) {
  throw new Error(`Invalid response: ${data.summary}`);
}

// Prefer
const user = users.find((u) => u.id === id);
if (!user) {
  throw new Error(`User not found: ${id}`);
}
```

Reach for `unknown` at untrusted edges, then narrow. If you need `as` or `!`, treat that as a signal the types or control flow are wrong.

### Generics over index signatures

```typescript
// Prefer
export type BaseConfigArgs = { level: LogLevel };

export interface LoggingBackend<TConfig extends BaseConfigArgs = BaseConfigArgs> {
  configureApp(args: TConfig): Promise<void>;
}
```

## Modules

### Exports

Named exports only. Prefer `create*` factories returning objects with methods over classes.

```typescript
export function createMiddleware(args: CreateMiddlewareArgs) {
  return {
    handle: async (req: Request) => { /* ... */ },
  };
}
```

Barrels (`index.ts`) are fine for a package's public surface — namespaced (`export * as payments`) or flat — matching the package already in tree.

### Imports

Order: external libraries → internal packages → relative. Use `import type` / inline `type` for types.

```typescript
import { type } from "arktype";
import { isValidationError } from "@myorg/types";
import type { Handler } from "@myorg/types/handler";
import { logger } from "./logger";
```

Omit extensions unless the project or runtime requires them. Use dynamic `import()` only when the path is truly runtime-variable or the dependency is optional.

## Async and errors

- Prefer `async`/`await` over raw promise chains for sequential work
- `Promise.all` for independent parallel work; `Promise.race` / `AbortSignal` for timeouts when the project already uses that pattern
- Re-throw with `{ cause }`
- Handlers that participate in a chain may return `null` to mean "not mine" when that is the local convention

```typescript
try {
  transaction = parseTransaction(input);
} catch (cause) {
  throw new Error("Failed to parse transaction", { cause });
}
```

Prefer a logger over `console.log` when the project has one.

## Testing (TypeScript projects)

Match the project's runner. In Bun/TS repos that use `bun:test`:

```typescript
import { expect, test } from "bun:test";

test("rejects an empty id", () => {
  expect(parseId("")).toBeNull();
});
```

Cover domain logic, integration seams, and error paths. Do not test the typechecker or a well-maintained library's happy path. Prefer injecting clocks and I/O over sleeping or hitting the network.

Bug fixes start with a failing test that reproduces the bug when the project expects that discipline.

## Documentation

Public APIs may use short TSDoc when the signature alone is not enough. Do not narrate what the code already says — see `style` for comment rules.

## Sync / async API contracts

Preserve existing public sync/async shapes. Do not make a sync function `async` only to use Web Crypto or similar — prefer sync libraries (`node:crypto`, etc.) when the surface is sync. Match parameter order, optionality, and return types at call sites you own; update callers instead of leaving shims.
