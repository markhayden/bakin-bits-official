import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ConversationPanel } from '@makinbakin/sdk/conversation'
import type { ComposerHandle, ConversationPanelProps } from '@makinbakin/sdk/conversation'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Text } from '@makinbakin/sdk/ui'

export function ProjectBrainstorm({ hasHistory = false, ...props }: ConversationPanelProps & { hasHistory?: boolean }) {
  const composer = useRef<ComposerHandle | null>(null)
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 1023px)').matches)
  const [hasDraft, setHasDraft] = useState(true)
  const [choice, setChoice] = useState<boolean | null>(null)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia('(max-width: 1023px)')
    const change = () => setNarrow(query.matches)
    change(); query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  // The mounted composer's public handle reads its hydrated draft before paint.
  // No private storage keys and no second draft store.
  useLayoutEffect(() => { if (composer.current) setHasDraft(!composer.current.isEmpty()) }, [props.storageKey])
  const meaningful = hasHistory || props.messages.length > 0 || props.streaming || hasDraft
  const open = !narrow || (choice ?? meaningful)
  return <Collapsible open={Boolean(open)} onOpenChange={value => setChoice(value)}>
    <h2 className="lg:hidden"><CollapsibleTrigger>Brainstorm <Text size="meta" tone="muted">{props.streaming ? 'Agent working' : open ? 'Collapse' : 'Ask an agent'}</Text></CollapsibleTrigger></h2>
    <CollapsibleContent keepMounted>
      <ConversationPanel {...props} composerHandleRef={composer} title="Project brainstorm" />
    </CollapsibleContent>
  </Collapsible>
}
