import type { ReactNode } from 'react'
import { Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@makinbakin/sdk/ui'
import { Check, Ellipsis, Hand, Trash2 } from 'lucide-react'
import type { Session } from '../lib/contracts'
import { TerminalTool } from './terminal-tool'

export type SessionConfirmation = { id: string; operation: 'terminate' | 'delete-history' | 'delete' }

export function SessionActions({ session, busy, label = 'Session actions', onOperate, onConfirm, children, allowTake = false }: {
  session: Session
  busy: boolean
  label?: string
  onOperate(operation: string, id: string): void
  onConfirm(confirmation: SessionConfirmation): void
  children?: ReactNode
  allowTake?: boolean
}) {
  // The operator is not the browser tab: any human can act. Input ownership
  // (driving) only gates typing; ending or deleting a session does not.
  const running = session.state === 'running'
  const driving = session.owner.kind === 'human' && running
  return <DropdownMenu>
    <TerminalTool label={label} description="Drive, end, or delete this session." render={<DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} />} />}><Ellipsis size={16} /></TerminalTool>
    <DropdownMenuContent align="end" className="w-xs">
      {children}
      {allowTake && <DropdownMenuItem disabled={busy || driving || !running} onClick={() => onOperate('take', session.id)}><Hand size={16} />Drive</DropdownMenuItem>}
      {session.state === 'exited' && <DropdownMenuItem disabled={busy} onClick={() => onOperate('complete', session.id)}><Check size={16} />Mark ended</DropdownMenuItem>}
      <DropdownMenuItem variant="danger" disabled={busy || !running} onClick={() => onConfirm({ id: session.id, operation: 'terminate' })}><Trash2 size={16} />Terminate</DropdownMenuItem>
      <DropdownMenuItem variant="danger" disabled={busy || running} onClick={() => onConfirm({ id: session.id, operation: 'delete' })}><Trash2 size={16} />Delete session</DropdownMenuItem>
      <DropdownMenuItem variant="danger" disabled={busy || session.state !== 'completed' || session.historyDeleted} onClick={() => onConfirm({ id: session.id, operation: 'delete-history' })}><Trash2 size={16} />Delete output only</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
