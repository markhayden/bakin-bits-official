import type { ReactNode } from 'react'
import { Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@makinbakin/sdk/ui'
import { Check, Ellipsis, Hand, Trash2 } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { clientId } from './api'
import { TerminalTool } from './terminal-tool'

export type SessionConfirmation = { id: string; operation: 'terminate' | 'delete-history' }

export function SessionActions({ session, busy, label = 'Session actions', onOperate, onConfirm, children, allowTake = false }: {
  session: Session
  busy: boolean
  label?: string
  onOperate(operation: string, id: string): void
  onConfirm(confirmation: SessionConfirmation): void
  children?: ReactNode
  allowTake?: boolean
}) {
  const owned = session.owner.kind === 'human' && session.owner.id === clientId()
  return <DropdownMenu>
    <TerminalTool label={label} description="Manage control, completion, and retained output." render={<DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} />} />}><Ellipsis size={16} /></TerminalTool>
    <DropdownMenuContent align="end" className="w-xs">
      {children}
      {allowTake && <DropdownMenuItem disabled={busy || owned || session.state === 'completed'} onClick={() => onOperate('take', session.id)}><Hand size={16} />Take control</DropdownMenuItem>}
      <DropdownMenuItem disabled={busy || !owned || session.state !== 'exited'} onClick={() => onOperate('complete', session.id)}><Check size={16} />Complete session</DropdownMenuItem>
      <DropdownMenuItem variant="danger" disabled={busy || !owned || session.state === 'completed'} onClick={() => onConfirm({ id: session.id, operation: 'terminate' })}><Trash2 size={16} />Terminate and complete</DropdownMenuItem>
      <DropdownMenuItem variant="danger" disabled={busy || session.state !== 'completed' || session.historyDeleted} onClick={() => onConfirm({ id: session.id, operation: 'delete-history' })}><Trash2 size={16} />Delete completed output</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
