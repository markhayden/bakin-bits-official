import { useState } from 'react'
import { Inline } from '@makinbakin/sdk/layout'
import { Button, Textarea } from '@makinbakin/sdk/ui'
import { readDraft, writeDraft } from './compose-drafts'

// The actions keep focus in the textarea (the keyboard stays up) until the page moves it.
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/**
 * The compose sheet (spec D9 item 2): a native textarea for dictation, IME
 * and paste, sent to the terminal as one paste — Paste, or Paste + Enter.
 * Each session keeps its own draft until it is sent. It sits in the key
 * accessory, so focus inside it is still the terminal's typing session.
 */
export function ComposeSheet({ sessionId, disabled, textarea, onSend }: {
  sessionId: string
  /** Sending is not possible now (not this viewer's to type, disconnected); the draft stays editable. */
  disabled: boolean
  textarea: React.RefObject<HTMLTextAreaElement | null>
  /** Send the text; true once it went, which clears the draft. */
  onSend(text: string, enter: boolean): boolean
}) {
  const [text, setText] = useState(() => readDraft(sessionId))
  const change = (next: string) => {
    setText(next)
    writeDraft(sessionId, next)
  }
  const send = (enter: boolean) => { if (text && onSend(text, enter)) change('') }
  return <div role="region" aria-label="Compose" className="terminal-compose">
    <Textarea ref={textarea} aria-label="Text to send" value={text} autoSize minRows={3} maxRows={6}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => change(event.target.value)} />
    <Inline gap="dense" justify="end" role="group" aria-label="Send">
      <Button variant="secondary" disabled={disabled || !text} onMouseDown={keepFocus} onClick={() => send(false)}>Paste</Button>
      <Button disabled={disabled || !text} onMouseDown={keepFocus} onClick={() => send(true)}>Paste + Enter</Button>
    </Inline>
  </div>
}
