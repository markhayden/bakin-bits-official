---
name: browser-tools
description: Drive a real Chrome browser via CDP — open pages, read rendered content, run JavaScript, screenshot, extract readable article text. Use when a task needs what a page ACTUALLY renders (JS-heavy sites), a screenshot, or in-page interaction.
---

# Browser Tools

Chrome DevTools Protocol tools driving the Chrome installed on this Mac
(remote debugging on `:9222`). Everything is already installed — do NOT
run npm install. All scripts live in ONE directory:

```
~/.bakin/npm/browser-tools/scripts/
```

Run them with node, e.g. `node ~/.bakin/npm/browser-tools/scripts/browser-start.js`.

## Start Chrome (once per session)

```bash
node ~/.bakin/npm/browser-tools/scripts/browser-start.js              # fresh profile
node ~/.bakin/npm/browser-tools/scripts/browser-start.js --profile    # copy the user's profile (logins)
```

`--profile` carries the user's cookies/logins — only use it when the task
explicitly needs a logged-in session.

## Navigate / Evaluate / Screenshot

```bash
node ~/.bakin/npm/browser-tools/scripts/browser-nav.js https://example.com [--new]
node ~/.bakin/npm/browser-tools/scripts/browser-eval.js 'document.title'
node ~/.bakin/npm/browser-tools/scripts/browser-screenshot.js   # prints a temp PNG path
```

Screenshots that matter to the task should be saved as assets
(`bakin_exec_assets_save`), not left in /tmp.

## Extract Readable Content

```bash
node ~/.bakin/npm/browser-tools/scripts/browser-content.js https://example.com
```

Renders the page in Chrome and prints the readable article content as
markdown (Readability). Prefer this over eval-scraping for articles/docs.

## Pick Elements (human present only)

```bash
node ~/.bakin/npm/browser-tools/scripts/browser-pick.js "Click the submit button"
```

Launches an interactive picker in the visible browser — the HUMAN clicks
elements and you receive CSS selectors. Only useful when the user is at
the machine; never rely on it for autonomous tasks.

## Cookies

```bash
node ~/.bakin/npm/browser-tools/scripts/browser-cookies.js
```

## Honest failure

- Chrome must be installed at /Applications/Google Chrome.app; if the
  start script can't find it, say so with the install link.
- The browser is VISIBLE on the machine's display — that's by design
  (collaborative use). Don't fight it with headless expectations.
