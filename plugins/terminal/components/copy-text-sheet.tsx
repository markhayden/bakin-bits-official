import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { CodeBlock } from '@makinbakin/sdk/content'
import { CopyButton } from '@makinbakin/sdk/patterns'
import { shownText, type Snapshot } from '../lib/copy-text'
import { Button, Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Text } from '@makinbakin/sdk/ui'

/**
 * Copy text (for a phone, where the canvas has no touch selection): the
 * terminal's text as it was when opened, in a kit CodeBlock — ordinary page
 * text, so the system's own long-press selection and handles work — with a
 * 44 px Copy all (overlays/sheet.stories.tsx — CanonicalUsage).
 */
export function CopyTextSheet({ open, read, onOpenChange }: { open: boolean; read(): Snapshot | undefined; onOpenChange(open: boolean): void }) {
  // A snapshot (stable to select in), taken on opening and on Refresh; none while the terminal is still connecting.
  const [snapshot, setSnapshot] = useState<{ value?: Snapshot; at: number }>({ at: 0 })
  useEffect(() => { if (open) setSnapshot((last) => ({ value: read(), at: last.at + 1 })) }, [open, read])
  const all = snapshot.value?.text ?? ''
  const { text: shown, cut } = useMemo(() => shownText(all), [all])
  // The text scrolls in its own region (the kit Sheet does not scroll its body), opened at its newest lines.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => { const element = body.current; if (element) element.scrollTop = element.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [open, shown, snapshot.at])
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Copy text</SheetTitle>
        <SheetDescription>The terminal's text as of opening (Refresh takes it again). Long-press to select part of it, or copy it all.</SheetDescription>
      </SheetHeader>
      <div ref={body} className="terminal-copy-text-body" role="region" aria-label="Terminal text" tabIndex={0}>
        {all
          ? <>
            {cut && <Text size="meta" tone="muted">Showing the newest part of {snapshot.value!.lines.toLocaleString()} lines; Copy all copies everything.</Text>}
            <CodeBlock code={shown} wrap />
          </>
          : <Text size="meta" tone="muted">{snapshot.value ? 'There is no text in this terminal yet.' : 'The terminal is still connecting; refresh once it shows its output.'}</Text>}
      </div>
      <SheetFooter>
        {all && <span className="inline-flex items-center justify-between gap-bakin-2"><Text size="meta" weight="semibold">Copy all</Text><CopyButton size="touch" text={all} label="Copy all terminal text" /></span>}
        <Button variant="outline" onClick={() => setSnapshot((last) => ({ value: read(), at: last.at + 1 }))}><RotateCw size={16} />Refresh</Button>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
}
