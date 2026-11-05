/**
 * The brief (projects-grill-start D3/D5/D6): the plan body IS the brief the
 * lead fills in during the shaping interview. The create seeds this
 * skeleton as revision zero; the lead keeps every heading. ONE tolerant
 * parser answers the Start dialog's only question — does the brief still
 * list open questions? — and answers "unknown" (null) rather than
 * "resolved" whenever it cannot read the section.
 */

export const BRIEF_SKELETON = `# Brief

## Goal
_Not yet discussed._

## What success looks like
_Not yet discussed._

## Scope
### In
_Not yet discussed._
### Out
_Not yet discussed._

## Constraints and assumptions
_Not yet discussed._

## Open questions
- Goals, scope and constraints still need clarification.

## Plan
_Drafted once the open questions are settled._
`

/** The headings the lead must keep (the prompt names them, the parser reads one). */
export const BRIEF_HEADINGS = ['Goal', 'What success looks like', 'Scope', 'Constraints and assumptions', 'Open questions', 'Plan'] as const

const OPEN_QUESTIONS_HEADING = /^##\s+open questions\s*$/i
const LEVEL_TWO_HEADING = /^##\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/

/**
 * Whether the brief still lists open questions.
 *   true  — the section holds only list items (the seeded placeholder counts:
 *           it is unresolved until the lead rewrites it)
 *   false — the section is blank
 *   null  — unknown: no heading, or content the parser does not recognise
 *           (prose, a sub-heading, a list mixed with prose)
 */
export function briefOpenQuestions(body: string): boolean | null {
  const lines = body.split('\n')
  const start = lines.findIndex(line => OPEN_QUESTIONS_HEADING.test(line))
  if (start === -1) return null
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (LEVEL_TWO_HEADING.test(line)) break
    section.push(line)
  }
  const content = section.filter(line => line.trim() !== '')
  if (content.length === 0) return false
  return content.every(line => LIST_ITEM.test(line)) ? true : null
}
