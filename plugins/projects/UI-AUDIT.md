# Projects UI audit — 2026-09-23

Scope: fix the large read-only markdown gaps; inventory text/selection controls;
identify useful Projects UI follow-ups. Other usability changes below are
findings, not implemented redesigns. No live project data or agents were used.

## Fixed: read-only markdown spacing

`components/rendered-plan.tsx` used `MarkdownEditor editing={false}` once per
blank-line block when Show changes was enabled. The SDK compatibility editor
selects the `document` height, whose preview reserves `min-h-80` (320px).
A heading and a sentence therefore each occupied a full editing canvas.

Nonempty plans and annotated blocks now use `MarkdownContent`. The empty-plan
placeholder and actual edit mode retain their existing editor behavior. Change
markers, history comparison, and the toggle are unchanged. The new fixture
covers changed content, hints hidden, and no history. Before/after browser
inspection confirmed the large gaps disappear at desktop and 320px width.
The change also removes repeated identically named editor-preview landmarks.

Selected existing public contract:
`storybook/public/content/markdown-content.stories.tsx` — `CanonicalUsage` and
`ReadingAndCode`, through `@makinbakin/sdk/content`. No new public API, visual
baseline, token, accessibility suppression, or design-system exception.

## Control inventory

No raw HTML input, textarea, or select was found in the Projects components.
Most controls already inherit the shared defaults; a blanket migration is
unnecessary. Preserve visible outlined fields for primary data entry.

| Surface | Current control | Recommendation |
| --- | --- | --- |
| New project title | Field + Input + Form/SubmitButton | Keep md/outlined. Existing busy/error handling is a good model for detail saves. |
| Edit project title | Input with `!h-auto`, custom padding and 20px text | Use the shared lg/outlined treatment if prominence is wanted. The page already displays the title, so the input need not imitate another heading. |
| Owner and brainstorm agent | AgentSelect with `h-bakin-8`; owner also overrides surface/type | Prefer an explicit compact pattern. **SDK gap:** AgentSelect currently exposes neither size nor variant, even though SelectTrigger does. Extending its Storybook/API requires approval; do not pass unsupported props or replace it with an unrelated control. |
| Add checklist task | InputGroup + input + trailing add action | Already the intended pattern. Keep md/outlined; prioritize submission/error behavior over restyling. |
| Checklist description | Textarea, two rows, manual resize, typography override | Give it a persistent/programmatic label. Shared sm/outlined and bounded auto-grow are reasonable for this nested editor; retain text-size accessibility. |
| Snapshot chooser | Field + SelectTrigger size=sm | Appropriate compact outlined choice; match its adjacent restore button height. |
| Project search | SearchInput in PageControls | Keep the established pattern and URL-backed query. |
| Status | DropdownMenu action trigger | Keep the existing action pattern; use checked/radio menu items to expose the current selection. It does not need a Combobox. |
| Plan editor and chat composer | MarkdownEditor / ConversationPanel | Keep their specialized semantics. Fix problems at the owning shared pattern, not by replacing them with basic inputs. |

Filled could be useful for compact owner/agent metadata once AgentSelect supports
it. Ghost is best reserved for unobtrusive secondary actions; there is no clear
need to make title, search, or task-entry boundaries disappear. Searchable agent
selection is useful only if roster size warrants it.

## Usability findings, in recommended order

1. **High — protect edits and failed saves.** `project-detail.tsx`'s `handleSave`
   and `saveField` ignore `res.ok` and have no busy/error state. A failed HTTP
   save still refetches and can replace the draft and exit edit mode. Cancel
   restores title/body but not owner/status. There is no dirty-navigation guard
   in the detail component or route wrappers. Use the existing Form submission
   workflow, field errors/Alert, and `/navigation`'s `useUnsavedChangesGuard`.
   References: `forms/form-composition.stories.tsx` — `SubmissionWorkflow`;
   `forms/unsaved-changes-dialog.stories.tsx` — `CanonicalUsage`.

2. **High — make checklist writes reliable.** `project-checklist.tsx` clears a
   new title immediately, closes description editing before the PUT completes,
   and ignores unsuccessful writes. The parent handlers similarly ignore HTTP
   failures. Preserve drafts, prevent duplicate submission, and show retryable
   errors before adding new visual treatments. Give repeated Remove/Create
   board task buttons task-specific accessible names and label the description
   textarea. Reuse InputGroup/Form recipes; avoid a custom submit mechanism.

3. **High — finish detail-page keyboard and accessibility coverage.** The real
   detail page in a synthetic browser fixture reported six findings across two
   widths: heading-order on the Details h3 on both; composer focus visibility on
   desktop; an unfocusable mobile scroll region; and incomplete tab traversal on
   both. The keyboard scanner findings need a manual trace before assigning
   ownership: some concern ConversationPanel/composer, others nested scrolling.
   Do not treat the passing index fixture as detail-page coverage. Use semantic
   section headings and the existing ConversationPanel and scroll patterns.

4. **Medium — make the narrow layout easier to use.** At 320px, Details,
   Show changes, and Rendered/Diff crowd one line and the view control clips.
   Let the toolbar wrap onto distinct rows using supported layout primitives.
   The empty brainstorm panel occupies most of the mobile page before tasks;
   offer a compact explanation/intentional expand control and preserve the
   current conversation's draft and scroll position. The pinned plan/chat split
   needs keyboard/200%-text checks before adjusting heights.

5. **Medium — distinguish unavailable data from empty content.** Detail load
   failure becomes “Project not found”; history non-OK becomes “No plan versions
   yet”; rejected history fetches are uncaught. Use explicit loading, empty,
   not-found, and retryable error states. The index already has better fetch
   validation and stale-request protection. Extend that discipline to detail
   and history; prevent old project/history responses from replacing new state.

6. **Low — improve labels and orientation.** Rename the second sidebar Details
   section to “Project info”; call the progress bar “Checklist progress” so
   Draft + 100% is understandable. Keep project lifecycle independent of task
   completion. The assets empty state says “Create the first item” although the
   available action is Attach; use contextual attachment guidance. Consider
   collapsing completed tasks with an explicit completed count for long plans.

7. **Markdown fidelity follow-up.** `lib/block-diff.ts` splits on blank lines,
   keeping fences together but not all Markdown structures. Reference links,
   loose/nested lists, and other cross-block constructs can lose context when
   rendered separately. Use semantic Markdown block boundaries if expanding
   change annotations. Literal emphasis markers in the supplied screenshot
   cannot be diagnosed without its source; no blanket source rewriting was
   applied as part of the spacing fix.

Existing raw-size/class allowances are recorded in Bakin's
`design-system/migrations.json` for Projects. This audit does not turn that debt
into a new exception or silently expand the AgentSelect contract.

## Verification and rollout

- Browser geometry guards reject a restored 320px minimum height in all three
  read-only modes, independently, on both desktop and mobile. Changed blocks
  report a 292px inter-block gap; hidden-hints/no-history plans report 97px
  trailing space. The corrected renderer passes all three. Component-name
  assertions were removed; coverage measures rendered layout instead.
- All 213 Projects tests passed; complete official Bits suite: 602 passed,
  8 skipped, zero failed. Typecheck and lint passed.
- Full official-plugin installed-SDK conformance passed against the exact
  pinned SDK commit: eight fixtures across the template, Terminal, Messaging,
  and Projects, desktop and mobile, zero findings.
- Real installed-SDK browser conformance: plan and index fixtures passed with
  zero findings, desktop and mobile. Their HTML/JSON reports and screenshots
  were inspected. The diagnostic detail fixture intentionally documents the
  separate findings above; the full detail page is **not** certified conformant.
- Bakin quick UI conformance passed (228 architecture tests and TypeScript).
- SDK package regression: browser-bundling the packed `/content` entry failed
  before the companion fix, then all six SDK package tests passed.

The browser fixture exposed a pre-existing SDK packaging issue: packaging every
entry for Bun selected vfile's Node-only process/URL implementations inside the
content bundle. The companion Bakin change builds only `/content` for the
browser. The host vendor build was already a browser build; the Projects runtime
fix does not depend on changing the host markdown editor.

**Review fixes:** Bits CI now pins the published SDK prerequisite commit
`949da83f539ecb5c1eb4f0d71d88d159644d9254`, replacing the older collection-rollout
revision. The companion change is [Bakin PR #916](https://github.com/markhayden/bakin/pull/916).
The pin is fetchable before that PR merges, so both reviews can run CI against
the same immutable SDK. Prefer merging the SDK prerequisite first. Verification
uses an SDK assembled from that exact commit. No baseline was replaced and no
plugin or host release was deployed.

Local evidence (ignored build artifacts):
- `test-results/projects-ui-audit/plan-before/index.html`
- `test-results/projects-ui-audit/plan-after/index.html`
- `test-results/projects-ui-audit/list/index.html`
- `test-results/projects-ui-audit/detail-audit/index.html`
- `test-results/plugin-ui-conformance/projects/plan/index.html` (final pinned SDK)

Branches: Bits `codex/projects-markdown-spacing`; published SDK prerequisite
`fix/projects-markdown-sdk-packaging` (isolated worktree on current main). The
active Bakin workspace retains its original development changes, including the
unrelated embedded-assets manifest, untouched.
