'use client'

/**
 * The docked project conversation (D10): the trailing collapsible rail
 * beside Plan, Steps and Files — the public `PageAside` conversation-width,
 * end-edge rail (Components/Pages/Collapsible aside — ConversationDock).
 * Collapsed, the kit strip shows the lead's avatar and a working/unread
 * marker. The page decides whether the panel is mounted here at all.
 */
import type { ReactNode } from 'react'
import { PanelRightClose } from 'lucide-react'
import { Button, Text } from '@makinbakin/sdk/ui'
import { AgentAvatar, PageAside, StatusMarker } from '@makinbakin/sdk/patterns'
import type { ConversationAgent } from '@makinbakin/sdk/conversation'

export function ChatDock({
  agent,
  collapsed,
  onCollapsedChange,
  working,
  unread,
  children,
}: {
  agent: ConversationAgent
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  working: boolean
  unread: boolean
  children: ReactNode
}) {
  return (
    <PageAside
      label="Project conversation"
      width="conversation"
      side="end"
      collapsible={{
        collapsed,
        onCollapsedChange,
        expandLabel: 'Expand project conversation',
        strip: (
          <div className="flex flex-col items-center gap-bakin-2 py-bakin-2">
            <AgentAvatar agent={{ id: agent.id ?? agent.name, name: agent.name, imageSrc: agent.avatarUrl ?? null }} size="sm" />
            {working
              ? <StatusMarker tone="accent" label={`${agent.name} is working`} />
              : unread ? <StatusMarker tone="attention" label="Unread reply" /> : null}
          </div>
        ),
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-bakin-2 border-b border-bakin-border-subtle px-bakin-3 py-bakin-2">
          <Text size="meta" weight="medium" className="truncate">{agent.name}</Text>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse project conversation"
            aria-expanded
            onClick={() => onCollapsedChange(true)}
            className="text-bakin-text-muted"
          >
            <PanelRightClose aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </PageAside>
  )
}
