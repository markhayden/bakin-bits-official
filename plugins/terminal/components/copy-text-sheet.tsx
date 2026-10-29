import { useEffect, useRef } from 'react'
import { CodeBlock } from '@makinbakin/sdk/content'
import { CopyButton } from '@makinbakin/sdk/patterns'
import { Button, Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Text } from '@makinbakin/sdk/ui'

/** At most this many lines are shown (Copy all still copies every line). */
export const COPY_TEXT_SHOWN = 2_000

/**
 * Copy text (for a phone, where the canvas has no touch selection): the
 * terminal's text as it was when opened, in a kit CodeBlock — ordinary page
 * text, so the system's own long-press selection and handles work — with a
 * 44 px Copy all (overlays/sheet.stories.tsx — CanonicalUsage).
 */
export function CopyTextSheet({ open, text, onOpenChange }: { open: boolean; text?: { text: string; lines: number }; onOpenChange(open: boolean): void }) {
  const all = text?.text ?? ''
  const lines = all ? all.split('\n') : []
  const shown = lines.length > COPY_TEXT_SHOWN ? lines.slice(-COPY_TEXT_SHOWN).join('\n') : all
  // The text scrolls in its own region (the kit Sheet does not scroll its body), opened at its newest lines.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => { const element = body.current; if (element) element.scrollTop = element.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [open, shown])
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Copy text</SheetTitle>
        <SheetDescription>The terminal's text when you opened this. Long-press to select part of it, or copy it all.</SheetDescription>
      </SheetHeader>
      <div ref={body} className="terminal-copy-text-body" role="region" aria-label="Terminal text" tabIndex={0}>
        {all
          ? <>
            {lines.length > COPY_TEXT_SHOWN && <Text size="meta" tone="muted">Showing the last {COPY_TEXT_SHOWN.toLocaleString()} of {lines.length.toLocaleString()} lines; Copy all copies every line.</Text>}
            <CodeBlock code={shown} wrap />
          </>
          : <Text size="meta" tone="muted">There is no text in this terminal yet.</Text>}
      </div>
      <SheetFooter>
        {all && <span className="inline-flex items-center justify-between gap-bakin-2"><Text size="meta" weight="semibold">Copy all</Text><CopyButton size="touch" text={all} label="Copy all terminal text" /></span>}
        <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
}
