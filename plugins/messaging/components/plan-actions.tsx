'use client'

import { useRef } from 'react'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@makinbakin/sdk/ui'
import type { Plan } from '../types'

export function PlanActions({ plan, onDelete }: { plan: Plan; onDelete: (plan: Plan, trigger: HTMLButtonElement | null) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  return <DropdownMenu>
    <DropdownMenuTrigger ref={trigger} render={<Button size="icon-xs" variant="ghost" />} aria-label={`More actions for ${plan.title || 'Untitled plan'}`}>
      <MoreHorizontal aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem variant="danger" onClick={() => onDelete(plan, trigger.current)}>
        <Trash2 aria-hidden="true" />Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
