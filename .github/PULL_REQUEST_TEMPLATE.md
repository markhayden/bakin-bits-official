<!--
Thanks for contributing to bakin-bits-official.
Fill in each section below. Reviews focus on the four areas listed at the
bottom; calling them out explicitly speeds things up.
-->

## What

<!-- One sentence: what this PR adds, fixes, or changes. -->

## Why

<!-- Brief context: the problem this solves or the use case it enables. -->

## Test plan

<!--
How a reviewer can verify this locally. Include exact commands.
For UI changes, include a screenshot or short clip.
-->

- [ ] `bun typecheck`
- [ ] `bun test --isolate`
- [ ] `bun lint`
- [ ] Smoke-tested against a local Bakin runtime (`bakin plugins link ...`)

## Review checklist

- [ ] **Hot-reload compliance** — side effects live in `activate(ctx)`,
      torn down in `onShutdown(ctx)`
- [ ] **Permissions accuracy** — manifest declares every capability used
- [ ] **Error handling** — failures surface clearly, no silent catches
- [ ] **SDK boundary discipline** — no imports from outside `@bakin/sdk/*`

## Notes

<!-- Anything else reviewers should know: follow-ups, known limitations, etc. -->
