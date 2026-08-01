---
name: notion
description: 'Read and write Notion through its REST API — search pages and databases, read a page as text, append blocks, create pages, and query a database with filters. Use whenever a task mentions Notion, a notion.so URL, or a Notion page or database.'
---

# Notion

## Agent Directive

Call the Notion REST API with `curl`. There is nothing to install. Every
request needs three headers:

```bash
curl -s https://api.notion.com/v1/search \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query":"roadmap","page_size":10}'
```

`NOTION_TOKEN` is already in the environment — Bakin injects it. Never print
it, echo it, or write it into a file.

`Notion-Version` is required and pins the response shape. Use
`2022-06-28` unless a call fails specifically on the version, in which case
check the API docs rather than guessing a newer date.

## The access model — read this before debugging a 404

A Notion integration starts with access to **nothing**. A page or database
becomes reachable only after a human shares it with the integration (open the
page → ⋯ → Connections → add the integration). Parent access cascades to
children, so sharing a top-level page covers its subtree.

This means a `404 object_not_found` almost never means the page is missing.
It means the integration was not given access. Say that plainly instead of
retrying or hunting for a different id — the fix is a human sharing the page.

## Finding things

```bash
# Search pages and databases by title (NOT full text)
POST /v1/search   {"query":"...","page_size":25}

# Restrict to one kind
POST /v1/search   {"query":"...","filter":{"property":"object","value":"database"}}
```

Search only matches titles of things already shared with the integration. An
empty result is a real answer — report it rather than assuming a bug.

A page id can also be read straight off a notion.so URL: it is the 32 hex
characters at the end, which the API accepts with or without dashes.

## Reading a page

A page is metadata; its text lives in its block children, which nest.

```bash
GET  /v1/pages/{page_id}                      # properties, title, parent
GET  /v1/blocks/{block_id}/children?page_size=100
```

Walk into any block whose `has_children` is `true` to get the full document.
Paginate with `start_cursor` while `has_more` is `true`. Text lives at
`<type>.rich_text[].plain_text` — read `plain_text` and ignore the styling
unless the task is about formatting.

## Databases

```bash
POST /v1/databases/{database_id}/query
     {"filter":{"property":"Status","status":{"equals":"In progress"}},
      "sorts":[{"property":"Due","direction":"ascending"}],
      "page_size":50}
GET  /v1/databases/{database_id}              # property schema
```

Read the schema first when you are unsure of a property's name or type — a
filter keyed on the wrong type returns a `validation_error`, and the schema
tells you exactly which of `status`, `select`, `multi_select`, `date`,
`people`, `relation`, or `rich_text` to use.

## Writing

```bash
# Append blocks to a page
PATCH /v1/blocks/{page_id}/children
      {"children":[{"object":"block","type":"paragraph",
        "paragraph":{"rich_text":[{"type":"text","text":{"content":"..."}}]}}]}

# Create a page inside a database
POST  /v1/pages
      {"parent":{"database_id":"..."},
       "properties":{"Name":{"title":[{"text":{"content":"..."}}]}}}
```

Rules for writes:

- **Ask before creating or modifying anything in a shared workspace.**
  Appending to a scratch page the operator pointed you at is fine; creating
  pages, editing existing content, or writing into a team database is not
  something to do unprompted.
- **Append rather than overwrite.** `PATCH /v1/blocks/{id}` replaces a
  block's content — reach for it only when the task is explicitly an edit.
- Notion caps a single `children` array at 100 blocks. Split larger writes.
- There is no undo through the API. Notion's page history is the only
  recovery, so treat every write as permanent.

## Honest failure

| Response | What it actually means |
|---|---|
| `401 unauthorized` | The token is missing or wrong — the operator fixes it in Bakin's Settings → Integrations & Keys. |
| `404 object_not_found` | Almost always: the page was never shared with the integration. |
| `400 validation_error` | The body shape is wrong — read the message, it names the offending property. |
| `429 rate_limited` | Roughly 3 requests/second average. Respect `Retry-After`; do not spin. |

Never fabricate page content, ids, or database rows. If a call fails, quote
what Notion returned and stop.
