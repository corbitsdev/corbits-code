# @interchange/plugin-exa

An Exa-backed web provider for Intercode. It implements the core `WebProvider`
contract (`search` + `fetch`) and is loaded dynamically via the generic
`webProvider` settings hook — core has no knowledge of Exa.

## Enabling

Add the following to your global settings file (`~/.intercode/settings.json`):

```json
{
  "webProvider": "./plugins/exa/src/index.ts",
  "webProviderOptions": {
    "apiKey": "your-exa-api-key"
  }
}
```

`webProvider` is any module specifier resolvable at runtime — a relative path as
above, or the package name `@interchange/plugin-exa` if it is installed as a
workspace/dependency.

The module's default export (`createWebProvider`) is called with
`webProviderOptions`. The options are validated at load time; a missing or empty
`apiKey` throws a clear error. If the provider fails to load, Intercode logs the
failure to stderr and falls back to the built-in local provider rather than
crashing the run.

## Behavior

- `search` calls the Exa `/search` API and maps results to the core
  `WebResult` shape (`title`, `url`, `snippet`, plus `extra` metadata such as
  `publishedDate`, `author`, and `score`).
- `fetch` performs a plain HTTP fetch of the requested URL (Exa has no generic
  fetch-arbitrary-URL endpoint), returning the response body.

## Development

```bash
bun test plugins/exa
```
