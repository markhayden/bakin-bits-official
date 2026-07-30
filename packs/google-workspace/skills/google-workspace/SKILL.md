---
name: google-workspace
description: 'Work with Gmail, Google Calendar, Drive, Contacts, Sheets, and Docs through the `gog` CLI. Use whenever a task involves the operator’s email, calendar, Drive files, contacts, or a Google Sheet or Doc.'
---

# Google Workspace (gog)

## Agent Directive

Use `gog` via the bash tool for anything in the operator's Google account.
It covers Gmail, Calendar, Drive, Contacts, Sheets, and Docs behind one
command.

Two flags matter on every call you make:

- `--json` — structured output you can parse instead of scraping a table.
- `--no-input` — never block on a prompt. You are not at a terminal, and a
  command that stops to ask a question will simply hang.

Discover the exact surface with `gog --help` and `gog <group> --help` rather
than guessing a flag. The groups are `gmail`, `calendar`, `drive`,
`contacts`, `sheets`, `docs`, and `auth`.

## Setup is the operator's job, not yours

`gog` authenticates with OAuth against the operator's own Google Cloud
credentials. That is a one-time interactive setup they run themselves:

```bash
gog auth credentials /path/to/client_secret.json
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,sheets,docs
```

Check the state with `gog auth list`. If that comes back empty, or a command
fails with an auth error, **report it and stop** — say that `gog` needs
`gog auth add` run once by a human. Do not attempt the OAuth flow, do not
look for credential files, and do not try alternate accounts.

Once more than one account is configured, `GOG_ACCOUNT=you@gmail.com` picks
the default; otherwise pass `--account`.

## Typical use

```bash
gog gmail search 'newer_than:7d from:stripe.com' --max 10 --json
gog calendar events primary --from 2026-08-01T00:00:00Z --to 2026-08-08T00:00:00Z --json
gog drive search "quarterly report" --max 10 --json
gog contacts list --max 20 --json
gog sheets get <sheetId> "Tab!A1:D10" --json
gog docs cat <docId>
```

Gmail search takes ordinary Gmail query syntax (`from:`, `subject:`,
`has:attachment`, `newer_than:7d`, `label:`), so express the filter in the
query rather than fetching broadly and filtering yourself.

## Writing

```bash
gog gmail send --to a@b.com --subject "..." --body "..."
gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED
gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS
gog sheets clear <sheetId> "Tab!A2:Z"
gog docs export <docId> --format txt --out /tmp/doc.txt
```

Rules for writes:

- **Always confirm before sending mail, creating or changing a calendar
  event, or writing to a shared Sheet.** These reach other people, they
  arrive under the operator's name, and none of them can be recalled.
- `sheets update` **overwrites** the range you name. When the intent is to
  add rows, use `append`. Read the range first if you are not certain what is
  there.
- Pass cell data through `--values-json` rather than building inline rows —
  it is the only form that survives commas, quotes, and newlines intact.
- `--input USER_ENTERED` makes Sheets interpret values the way typing would
  (dates, formulas, numbers). Use `RAW` when a value must be stored
  literally.
- `docs` can export, read, and copy. It cannot edit a document in place — if
  a task needs in-document edits, say so rather than working around it.

## Honest failure

- Quote the error `gog` printed. Auth failures, revoked scopes, and Google
  API quota errors all look different and lead to different fixes.
- An empty result is a real answer. No matching mail, no events in the
  window, no file by that name — report it; never invent a plausible one.
- Never guess a message id, event id, sheet id, or document id. Find it with
  a search first.
