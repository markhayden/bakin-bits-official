/** How a program's clipboard offer (OSC 52) is shown in the canvas corner (plan T36b). */

/** A program's clipboard offer, said plainly (it may be many lines, or begin with blank ones). */
export function offerCaption(text: string): string {
  const lines = text.split('\n').length
  return lines > 1 ? `Text to copy · ${lines} lines` : 'Text to copy'
}
/** Its first line that has anything on it (blank lines would show nothing). */
export function offerPreview(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '(blank)'
}
