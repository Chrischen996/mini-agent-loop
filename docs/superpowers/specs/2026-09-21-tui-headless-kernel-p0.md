## Why

The headless-kernel direction (option B of the 2026-09-21 design review:
platform-agnostic kernel, `pi-tui` as canonical renderer, Ink as a
one-release transition adapter) is being implemented in phases P0..P4.
P0 is the hygiene step: remove EOL churn from the working tree, wire the
CRLF renormalizer back into the repo, and leave the `tui:legacy` client
as a documented rollback channel for P1+ work.

## Changes

### 1. EOL normalization (44 files CRLF -> LF)

`.gitattributes` already declares `* text=lf` for the whole repo, and the
commit history for a few TUI files (MessageFeed.tsx, PromptInput.tsx)
documents a past CRLF incident. 44 tracked files still carried CRLF
terminators from earlier Windows-side edits; their diffs were whole-file
churn on every touch.

`scripts/renormalize-crlf.mjs` is a reusable, in-process `git ls-files` +
`readFileSync/writeFileSync` tool that rewrites only files whose text
contains a `\r`. It is idempotent, and it is scoped to `src`, `test`,
`scripts` by default (CLI args override the scope).

Verified: 44 files in src/test were CRLF in HEAD and are now pure LF. No
content change, no `tsc --noEmit` impact, no test-suite impact.

### 2. P0 scope decision recorded

The `tui:legacy` client (`src/tui/main.ts` + `src/tui/legacy-render.ts` +
its `test/tui-render.test.ts`) is **kept** as the P4 rollback channel. It
is not deleted here because P1..P3 all run on top of `pi-tui` +
`terminal-main.ts`; deleting the legacy entry now would leave the release
with no working client if P1/P3 regressed. P4 (drop-ink + drop-legacy)
removes it in one commit.

## Not touched

- `src/tui/main.ts`, `src/tui/legacy-render.ts`, `test/tui-render.test.ts`,
  the `tui:legacy` script — see the scope note above.
- `package.json` / `tsconfig.json` / `pnpm-lock.yaml` — untouched.
- `plans/` — already an empty directory in HEAD (no tracked files); not a
  P0 concern.

## Verification

- `git diff --stat` shows 48 files, 11806 insertions, 11673 deletions
  (nearly symmetric — the delta is the EOL fix).
- `node scripts/renormalize-crlf.mjs` re-run: `0 CRLF -> LF`.
- `npx tsc --noEmit` runs clean on the post-fix tree.
- `tsx --test test/loop.test.ts` passes (a CRLF file that no longer churns).

