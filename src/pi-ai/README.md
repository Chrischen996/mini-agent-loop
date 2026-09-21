# `src/pi-ai` — vendored provider layer

## What this is

`src/pi-ai` is a **complete vendored copy** of the `pi-ai` provider layer, not a
thin patch on top of the published `@earendil-works/pi-ai` package. It owns:

- `api/` — one streaming implementation per wire protocol (OpenAI completions
  and responses, Codex responses, Anthropic messages, Bedrock converse-stream,
  Google Generative AI / Vertex, Mistral conversations, Azure responses).
- `providers/` — a provider factory per vendor plus its model catalog.
- `auth/`, `utils/oauth/` — credential resolution and OAuth device flows.
- `types.ts`, `models.ts` — the `Model` / `Provider` / `Api` contracts everything
  else in the repository codes against.

## Dependency boundary

The repository **does not import `@earendil-works/pi-ai` at runtime**. That
package, along with `@earendil-works/pi-agent-core` and
`@earendil-works/pi-coding-agent`, was previously declared as a dependency while
never being imported; those three declarations have been removed. The only
`@earendil-works` package actually imported is `@earendil-works/pi-tui`, used by
`src/tui/pi-tui-frame.ts` and `src/tui/pi-tui-runtime.ts` for alternate-screen
rendering.

The `overrides` block in `package.json` still pins the `@earendil-works/*`
versions, because `pi-web-access` pulls `pi-tui` transitively and the pin keeps
a single deduped copy.

Practical consequence: **upgrading the upstream npm package does nothing to this
directory.** Changes here are local edits to vendored source and must be
reconciled by hand against upstream.

## Compatibility shims

Two files exist purely to preserve the upstream module layout and should not
grow new callers:

- `compat.ts` — re-exports the old flat `pi-ai` global API (`stream()`,
  `complete()`, catalog reads, image generation). Upstream marks it as deleted
  after the coding-agent `ModelManager` migration.
- `legacy-api-aliases.ts` — `@deprecated` aliases for the per-API `stream` /
  `streamSimple` functions.

New code should use `createModels()` and the provider factories in
`providers/`.

## Model catalogs are generated

`providers/*.models.ts` and `models.generated.ts` are **generated artifacts**.
The source of truth is the JSON in `providers/data/*.models.json`.

```bash
npm run generate-models        # regenerate the TypeScript from the JSON
npm run generate-models:check  # CI drift check
```

Edit the JSON, never the `.models.ts` files. CI fails if the checked-in
TypeScript does not match the data.

## Excluded from coverage

`.c8rc.json` excludes `src/pi-ai/**` from coverage reporting, since it is
vendored third-party code rather than project logic.
