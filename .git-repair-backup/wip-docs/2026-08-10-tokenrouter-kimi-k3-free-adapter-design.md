# TokenRouter Kimi K3 Free Adapter Design

## Goal

Expose the fixed `tokenrouter/kimi-k3-free` route through the existing model
picker and send requests through TokenRouter's OpenAI-compatible Chat
Completions endpoint.

## Findings

TokenRouter documents `https://api.tokenrouter.io/v1` as its OpenAI-compatible
base URL, Bearer authentication with `TOKENROUTER_API_KEY`, and
`POST /v1/chat/completions`. The compatibility page documents streaming,
tools, and `max_tokens`. It does not document per-model context limits,
vision support, or a portable reasoning parameter for `kimi-k3-free`.

## Design

- Add one project-owned typed fallback model with provider `tokenrouter` and
  id `kimi-k3-free`.
- Keep the existing pi-ai provider catalogs unchanged and merge the fallback
  after the upstream catalog using the existing provider/id de-duplication.
- Reuse the vendored OpenAI Completions transport with explicit compatibility
  overrides: `max_tokens`, no reasoning effort, no developer role, and no
  strict tool schema field.
- Declare text input and tool calling, with conservative generic limits of a
  128K context window and 16K output tokens because TokenRouter does not
  publish this route's limits in the public compatibility docs.
- Use zero cost metadata because the route is named `free`; this is catalog
  metadata only and does not bypass TokenRouter account quotas.

## Verification

- Model catalog/search tests prove the qualified reference and API metadata.
- Wire tests prove the TokenRouter URL, Bearer header, `kimi-k3-free` model id,
  `max_tokens`, and absence of K3-direct reasoning fields.
- TypeScript compilation and focused model/LLM tests must pass.
