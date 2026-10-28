import { useState } from 'react'
import { Inline } from '@makinbakin/sdk/layout'
import { Button, Text, Textarea } from '@makinbakin/sdk/ui'

// The actions keep focus in the textarea (the keyboard stays up) until the page moves it.
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/** What became of a send: it went (the draft clears once the server accepts it), or why it did not. */
export type PasteOutcome = 'sent' | 'too-long' | 'unavailable'

const OUTCOMES: Record<Exclude<PasteOutcome, 'sent'>, string> = {
  'too-long': 'Too long to send in one go (64 KB at most). Send it in parts.',
  unavailable: 'Not sent: typing is not available right now. Your text is kept.',
}

/**
 * The compose sheet (spec D9 item 2): a native textarea for dictation, IME
 * and paste, sent to the terminal as one paste — Paste, or Paste + Enter.
 * The page owns each session's draft (it outlives this sheet) and clears it
 * only when the server accepted the paste. It sits in the key accessory, so
 * focus inside it is still the terminal's typing session.
 */
export function ComposeSheet({ draft, kept, disabled, textarea, onDraft, onSend }: {
  draft: string
  /** False when the draft is too long for this browser to keep after the page is left. */
  kept: boolean
  /** Sending is not possible now (not this viewer's to type, disconnected); the draft stays editable. */
  disabled: boolean
  textarea: React.RefObject<HTMLTextAreaElement | null>
  onDraft(text: string): void
  onSend(text: string, enter: boolean): PasteOutcome
}) {
  // The page's draft is the text (it clears it once a paste is accepted).
  const text = draft
  const [outcome, setOutcome] = useState<PasteOutcome | undefined>()
  const change = (next: string) => {
    setOutcome(undefined)
    onDraft(next)
  }
  const send = (enter: boolean) => { if (text) setOutcome(onSend(text, enter)) }
  const message = outcome && outcome !== 'sent' ? OUTCOMES[outcome] : !kept ? 'This draft is too long to keep after you leave this page.' : undefined
  return <div role="region" aria-label="Compose" className="terminal-compose">
    <Textarea ref={textarea} aria-label="Text to send" value={text} autoSize minRows={3} maxRows={6}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => change(event.target.value)} />
    {message && <Text role="status" size="meta" tone="muted">{message}</Text>}
    <Inline gap="dense" justify="end" role="group" aria-label="Send">
      <Button variant="secondary" disabled={disabled || !text} onMouseDown={keepFocus} onClick={() => send(false)}>Paste</Button>
      <Button disabled={disabled || !text} onMouseDown={keepFocus} onClick={() => send(true)}>Paste + Enter</Button>
    </Inline>
  </div>
}
