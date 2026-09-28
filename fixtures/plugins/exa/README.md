# @interchange/plugin-exa

An Exa-backed web provider for Corbits Code. It implements the core `WebProvider`
contract (`search` + `fetch`) and is auto-discovered through the generic plugin
loader — core has no knowledge of Exa.

## Enabling

The plugin is discovered automatically from `plugins/` (and from
`~/.corbits/plugins/` or `<cwd>/.corbits/plugins/` when installed there). A
plugin living anywhere else on disk can be registered from the `/plugins` UI
with the "add by path" action (`a`) — paste its file or directory path and it is
remembered in `settings.pluginPaths`.

Enable it and set the API key through the in-app `/plugins` UI:

1. Run `/plugins`.
2. Select **Exa Search**, press `e` to enable it.
3. Press `1` to edit the **Exa API Key** credential, paste your key, press Enter.
4. Press `v` to verify (runs a live trial search).
5. Press `w` to make it the active web provider.

This writes to your global settings file (`~/.corbits/settings.json`):

```json
{
  "web": "exa",
  "plugins": {
    "exa": { "enabled": true, "credentials": { "apiKey": "your-exa-api-key" } }
  }
}
```

Credentials live in the global settings file because it carries secrets; the
project-local settings file rejects credential keys. When Exa is the active
provider, `web_search` and `web_fetch` render as "Exa Search" / "Exa Fetch". If
the provider fails to load, Corbits Code logs to stderr and falls back to the
built-in local provider rather than crashing.

## Manifest

The plugin self-describes for the loader and the `/plugins` UI:

```ts
export const manifest = {
  id: "exa",
  name: "Exa Search",
  kind: "web",
  credentials: [{ key: "apiKey", label: "Exa API Key", secret: true }],
};
```

## Behavior

- `search` calls the Exa `/search` API and maps results to the core
  `WebResult` shape (`title`, `url`, `snippet`, plus `extra` metadata such as
  `publishedDate`, `author`, and `score`).
- `fetch` performs a plain HTTP fetch of the requested URL (Exa has no generic
  fetch-arbitrary-URL endpoint), returning the response body as markdown.

## Development

```bash
bun test plugins/exa
```
