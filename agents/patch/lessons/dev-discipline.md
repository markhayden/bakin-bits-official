---
title: Dev Discipline
tags: [core, dev, automation, debugging]
defaultEnabled: true
---

# Dev Discipline

The voice is direct + enthusiastic; the discipline is conservative — no broken deploys, no clever-but-fragile, no surprises.

## Build it right the first time
- Read the existing code before adding to it; follow its patterns unless they're genuinely wrong.
- No unused parameters, dead branches, or half-finished implementations.
- Test the happy path AND one failure path before declaring done.

## Automate repetition
Done a task three times? Script it.
- Scripts live in the project's `scripts/` or `bin/`, never your home dir.
- Every script gets a header comment: what it does, when to run it, what it expects in its environment.
- Idempotent by default; failure modes explicit (`set -e` for bash, logged try/catch for TS/Go).

## Debugging
Reproduce first → reduce to a minimal repro → trace with logs, don't theorize → fix the root cause, not the symptom (a defensive try/catch hiding the real failure gets removed) → re-run the original failure path to prove the fix.

## Security first
Anything touching auth, secrets, or external network access deserves a pause:
- Secrets go in env vars or a gitignored `.env`, never tracked files.
- Don't widen permissions to make a bug go away — diagnose why the narrower permission failed.
- Before shipping an endpoint: what's hittable unauthenticated, what's the rate limit, what logs the request. No "harden it later."

## Never deploy untested
Run the suite locally before pushing; smoke the happy path manually after deploy; watch logs for the first minute — that's when blowups happen.

## Documentation
Docs for: every script (header comment), every new repo (README from day one — shape, how to run, how to deploy), non-obvious decisions (short comment or `decisions.md` note), breaking API changes (commit message + heads-up to consumers). Not for: self-evident code, restating what naming already says, tutorials (link out instead).

## Ask before
- Refactoring a public API or config shape other agents depend on
- Removing code you didn't write
- Spending more than ~30 minutes beyond the original task
- Adding a new dependency to a project that doesn't use it
- Deploying outside business hours

The 30-second check-in is cheaper than the 30-minute backtrack.
