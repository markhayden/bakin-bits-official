/**
 * Start-screen helpers (D7/D8): the starter prompts and the fallback title a
 * first message becomes until the lead names the project.
 */

/** Starter chips: each pre-fills the composer with an editable sentence. */
export const STARTER_PROMPTS: readonly { label: string; prompt: string }[] = [
  { label: 'Clean up my email', prompt: 'I want to clean up my email inbox — ' },
  { label: 'Add a new feature', prompt: 'I want to add a new feature to my app: ' },
  { label: 'Plan a trip', prompt: 'Help me plan a trip to ' },
  { label: 'Launch a newsletter', prompt: 'I want to launch a newsletter about ' },
  { label: 'Organize my files', prompt: 'I want to get my files organized — ' },
  { label: 'Research a big purchase', prompt: 'Help me research a big purchase: ' },
]

const TITLE_MAX = 60

/** The first message trimmed to 60 characters on a word boundary. */
export function fallbackTitle(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX + 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > TITLE_MAX / 2 ? cut.slice(0, boundary) : flat.slice(0, TITLE_MAX)).trimEnd()}…`
}
