/**
 * The brief (projects-grill-start D5/D6): the seeded skeleton and the ONE
 * tolerant parser behind the Start dialog's advisory line. Doubt never
 * reads as "resolved".
 */
import { describe, expect, it } from 'bun:test'

import { BRIEF_SKELETON, briefOpenQuestions } from '../lib/brief'

const withOpenQuestions = (section: string) => `# Brief\n\n## Goal\nShip it.\n\n## Open questions\n${section}\n\n## Plan\n_Drafted once the open questions are settled._\n`

describe('BRIEF_SKELETON', () => {
  it('carries every heading the lead must keep, and its open question says nothing is settled', () => {
    const lines = BRIEF_SKELETON.split('\n')
    for (const heading of ['# Brief', '## Goal', '## What success looks like', '## Scope', '### In', '### Out', '## Constraints and assumptions', '## Open questions', '## Plan']) {
      expect(lines).toContain(heading)
    }
    expect(BRIEF_SKELETON).toContain('- Goals, scope and constraints still need clarification.')
    expect(briefOpenQuestions(BRIEF_SKELETON)).toBe(true)
  })
})

describe('briefOpenQuestions', () => {
  it('null when the body has no Open questions heading', () => {
    expect(briefOpenQuestions('')).toBeNull()
    expect(briefOpenQuestions('# Plan\n\nJust do it.')).toBeNull()
    expect(briefOpenQuestions('## Open questions?\n- one')).toBeNull()
  })

  it('false when the section is blank', () => {
    expect(briefOpenQuestions(withOpenQuestions(''))).toBe(false)
    expect(briefOpenQuestions(withOpenQuestions('   \n\n'))).toBe(false)
    expect(briefOpenQuestions('# Brief\n\n## Open questions\n')).toBe(false)
  })

  it('true when every line is a list item, whatever the marker', () => {
    expect(briefOpenQuestions(withOpenQuestions('- Which inbox?'))).toBe(true)
    expect(briefOpenQuestions(withOpenQuestions('* Which inbox?\n+ Which account?'))).toBe(true)
    expect(briefOpenQuestions(withOpenQuestions('1. Which inbox?\n2) Which account?'))).toBe(true)
    expect(briefOpenQuestions(withOpenQuestions('  - indented still counts'))).toBe(true)
  })

  it('null for prose, a sub-heading, or a list mixed with prose — unknown, never resolved', () => {
    expect(briefOpenQuestions(withOpenQuestions('We still need to decide the inbox.'))).toBeNull()
    expect(briefOpenQuestions(withOpenQuestions('### Later\n- one'))).toBeNull()
    expect(briefOpenQuestions(withOpenQuestions('- one\nand also this'))).toBeNull()
  })

  it('reads only up to the next level-two heading and tolerates trailing spaces and casing', () => {
    expect(briefOpenQuestions('## Open Questions  \n\n## Plan\n- a step')).toBe(false)
    expect(briefOpenQuestions('## open questions\n- one\n## Plan\nprose')).toBe(true)
  })
})
