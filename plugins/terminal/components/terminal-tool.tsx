import type { ReactElement, ReactNode } from 'react'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@makinbakin/sdk/ui'

export function TerminalTool({ label, description, children, onClick, disabled, render }: {
  label: string; description: string; children: ReactNode; onClick?(): void; disabled?: boolean; render?: ReactElement
}) {
  return <Tooltip>
    <TooltipTrigger render={render ?? <Button aria-label={label} size="icon-sm" variant="ghost" disabled={disabled} focusableWhenDisabled onClick={onClick} />}>{children}</TooltipTrigger>
    <TooltipContent>{label}. {description}</TooltipContent>
  </Tooltip>
}
