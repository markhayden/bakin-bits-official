# Security Policy

## Supported versions

This project distributes plugins and agent packages by git ref. Only the
current `main` branch is actively supported. Older tagged releases of
individual plugins (e.g. `messaging-v1.0.0`) receive fixes on a best-effort
basis when a vulnerability is reported.

| Branch / ref      | Supported          |
| ----------------- | ------------------ |
| `main`            | Yes                |
| Latest plugin tag | Best-effort        |
| Older tags        | No                 |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email **hi@markhayden.me** with:

- A description of the issue and the affected plugin or agent package
- The git ref or version where you observed it
- A minimal reproduction (commands, manifest, snippet)
- Any suggested mitigation, if you have one

We aim to acknowledge reports within **72 hours** and to have a fix or
mitigation plan within **14 days** for confirmed issues. We will credit
reporters in the relevant CHANGELOG entry unless you ask us not to.

## Scope

In scope:

- Code in this repository (`plugins/*`, `agents/*`, shared tooling)
- The install/upgrade flow as documented in the README

Out of scope:

- The Bakin core runtime — please report those at the Bakin core repo
- Issues that require already-compromised local machine access
- Vulnerabilities in third-party dependencies — report upstream first;
  we will track the relevant advisory
