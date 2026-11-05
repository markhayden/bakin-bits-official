/**
 * Start-screen helpers (D7/D8): the starter prompts and the fallback title a
 * first message becomes until the lead names the project.
 */

/**
 * Starter chips: each pre-fills the composer with a COMPLETE editable
 * prompt — Enter works as-is, and the lead's interview draws out the
 * specifics (projects-grill-start D2).
 */
export const STARTER_PROMPTS: readonly { label: string; prompt: string }[] = [
  { label: 'Clean up my email', prompt: 'Help me clean up my email inbox.' },
  { label: 'Add a new feature', prompt: 'Help me plan and ship a new feature for my app.' },
  { label: 'Plan a trip', prompt: 'Help me plan a trip.' },
  { label: 'Launch a newsletter', prompt: 'Help me launch a newsletter.' },
  { label: 'Organize my files', prompt: 'Help me get my files organized.' },
  { label: 'Research a big purchase', prompt: 'Help me research a big purchase.' },
]

/** How long the start screen waits for the create before it says so (D1a). */
export const CREATE_TIMEOUT_MS = 10_000

const TITLE_MAX = 60

/** The first message trimmed to 60 characters on a word boundary. */
export function fallbackTitle(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX + 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > TITLE_MAX / 2 ? cut.slice(0, boundary) : flat.slice(0, TITLE_MAX)).trimEnd()}…`
}
