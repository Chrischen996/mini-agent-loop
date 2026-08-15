# Git repair triage (after A)

## Baseline
- HEAD / main / origin/main: d6668bb (feat: subagent runtime ref...)
- Note: earlier notes saying origin/main=f1a76f6 were stale; real tip is d6668bb

## 建议提交 (intentional WIP)
### New (untracked)
- src/kimi-k3-models.ts
- src/tokenrouter-models.ts
- docs/superpowers/plans/2026-08-08-kimi-k3-adapter-plan.md
- docs/superpowers/plans/2026-08-10-tokenrouter-kimi-k3-free-adapter-plan.md
- docs/superpowers/specs/2026-08-10-tokenrouter-kimi-k3-free-adapter-design.md
  (design for kimi-k3 may already exist at docs/superpowers/specs/2026-08-08-kimi-k3-adapter-design.md on HEAD)

### Modified (tracked)
- src/models.ts — register KIMI_K3 + TOKENROUTER models / provider / env key
- src/tui/image-attachments.ts — Windows + Linux clipboard image export
- test/models.test.ts — model registry tests
- test/tui-image-attachments.test.ts — clipboard command tests
- README.md — docs for new providers / features

## 建议暂不提交
- .git-repair-backup/ (local safety dump only)
- Any mass reverts of origin/main features (now restored)

## 疑似误删 / 已从 HEAD 恢复
These were missing or heavily reverted in the dirty worktree vs d6668bb; restored via :
- src/validation.ts, src/tools/validation.ts, test/validation.test.ts
- src/git/*, src/tools/git.ts, test/git-workflow.test.ts
- src/thinking-policy.ts, test/thinking-policy.test.ts
- src/tui/message-viewport.ts, layout.ts, legacy-render.ts, terminal-width.ts
- test/message-viewport.test.ts, tui-render.test.ts, cache-tracker.test.ts
- Large reverts in loop.ts, llm/*, subagent/*, server.ts, TUI App, etc.

## Recommended next (C)
Stage only intentional WIP paths, split commits:
1) feat(models): Kimi K3 + TokenRouter adapters
2) feat(tui): Windows/Linux clipboard image paste
(or single commit if preferred)
