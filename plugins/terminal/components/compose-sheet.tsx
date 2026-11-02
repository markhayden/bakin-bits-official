import { useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { ComposerAttachmentTray } from '@makinbakin/sdk/conversation'
import { Inline } from '@makinbakin/sdk/layout'
import { CopyButton } from '@makinbakin/sdk/patterns'
import { Button, Input, Text, Textarea } from '@makinbakin/sdk/ui'
import { carriesImages, IMAGE_TYPES, imageFiles, type DraftImage } from './compose-images'

// The actions keep focus in the textarea (the keyboard stays up) until the page moves it.
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/** What became of a send: it went (the draft clears once the server accepts it), or why it did not. */
export type PasteOutcome = 'sent' | 'too-long' | 'unavailable'

const OUTCOMES: Record<Exclude<PasteOutcome, 'sent'>, string> = {
  'too-long': 'Too long to send in one go (64 KB at most). Send it in parts.',
  unavailable: 'Not sent: typing is not available right now. Your text is kept.',
}

/**
 * The compose sheet (spec D9 item 2, item 8): a native textarea for
 * dictation, IME and paste, plus images — from the picker, a paste, or a
 * drop — sent to the terminal through Paste or Paste + Enter. The page owns
 * each session's draft (it outlives this sheet) and clears it only when the
 * server accepted the paste. On a touch device it sits in the key accessory
 * (focus inside it is still the terminal's typing session); on a desktop the
 * page opens it for an image or from its menu, and Escape closes it, keeping
 * the draft.
 */
export function ComposeSheet({ draft, kept, disabled, textarea, images, onDraft, onSend, onAddImages, onRemoveImage, onClose }: {
  draft: string
  /** False when the draft is too long for this browser to keep after the page is left. */
  kept: boolean
  /** Sending is not possible now (not this viewer's to type, disconnected); the draft stays editable. */
  disabled: boolean
  textarea: React.RefObject<HTMLTextAreaElement | null>
  images: readonly DraftImage[]
  onDraft(text: string): void
  onSend(text: string, enter: boolean): PasteOutcome
  onAddImages(files: File[]): void
  onRemoveImage(id: string): void
  /** Desktop: Escape closes the sheet (the draft stays). */
  onClose?(): void
}) {
  // The page's draft is the text (it clears it once a paste is accepted).
  const text = draft
  const [outcome, setOutcome] = useState<PasteOutcome | undefined>()
  const picker = useRef<HTMLInputElement | null>(null)
  const change = (next: string) => {
    setOutcome(undefined)
    onDraft(next)
  }
  const ready = images.filter((image) => image.status === 'ready')
  // Nothing goes while an image is still on its way (its path is not known yet).
  const uploading = images.some((image) => image.status === 'uploading')
  const empty = !text && ready.length === 0
  const send = (enter: boolean) => { if (!empty && !uploading) setOutcome(onSend(text, enter)) }
  const add = (files: File[]) => { if (files.length) { setOutcome(undefined); onAddImages(files) } }
  const message = outcome && outcome !== 'sent' ? OUTCOMES[outcome] : uploading ? 'Adding the image…' : !kept ? 'This draft is too long to keep after you leave this page.' : undefined
  return <div role="region" aria-label="Compose" className="terminal-compose"
    onDragOver={(event) => { if (carriesImages(event.dataTransfer)) event.preventDefault() }}
    onDrop={(event) => { if (!carriesImages(event.dataTransfer)) return; event.preventDefault(); add(imageFiles(event.dataTransfer.files)) }}
    // Not while an input method is composing (its own Escape), nor one something else took.
    onKeyDown={(event) => { if (event.key === 'Escape' && onClose && !event.nativeEvent.isComposing && !event.defaultPrevented) { event.preventDefault(); onClose() } }}>
    {images.length > 0 && <ComposerAttachmentTray disabled={disabled} className="terminal-compose-images"
      items={images.map((image) => ({ id: image.id, name: image.label, previewUrl: image.preview, status: image.status === 'failed' ? 'error' : image.status, errorMessage: image.error }))}
      onRemove={onRemoveImage}
      itemAction={(item) => {
        const path = images.find((image) => image.id === item.id)?.upload?.path
        return path ? <CopyButton text={path} label={`Copy the path of ${item.name}`} /> : null
      }} />}
    <Textarea ref={textarea} aria-label="Text to send" value={text} autoSize minRows={3} maxRows={6}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => change(event.target.value)}
      // An image pasted here joins the draft (text pastes stay text).
      onPaste={(event: React.ClipboardEvent<HTMLTextAreaElement>) => { if (!carriesImages(event.clipboardData)) return; event.preventDefault(); add(imageFiles(event.clipboardData.files)) }} />
    {message && <Text role="status" size="meta" tone="muted">{message}</Text>}
    <Inline gap="dense" justify="between" role="group" aria-label="Send">
      <Input ref={picker} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => { add(imageFiles(event.target.files)); event.target.value = '' }} />
      <Button variant="ghost" onMouseDown={keepFocus} onClick={() => picker.current?.click()}><ImagePlus size={16} />Add image</Button>
      <Inline gap="dense">
        <Button variant="secondary" disabled={disabled || empty || uploading} onMouseDown={keepFocus} onClick={() => send(false)}>Paste</Button>
        <Button disabled={disabled || empty || uploading} onMouseDown={keepFocus} onClick={() => send(true)}>Paste + Enter</Button>
      </Inline>
    </Inline>
  </div>
}
