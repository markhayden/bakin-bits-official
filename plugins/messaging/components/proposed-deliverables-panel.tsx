'use client'

import { useMemo } from 'react'
import { Badge } from "@bakin/sdk/ui"
import { Button } from "@bakin/sdk/ui"
import { Check, Pencil, X } from 'lucide-react'
import type { Deliverable } from '../types'

interface ProposedDeliverablesPanelProps {
  deliverables: Deliverable[]
  onApprove?: (deliverable: Deliverable) => void
  onReject?: (deliverable: Deliverable) => void
  onEdit?: (deliverable: Deliverable) => void
}

function formatPublishAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ProposedDeliverablesPanel({
  deliverables,
  onApprove,
  onReject,
  onEdit,
}: ProposedDeliverablesPanelProps) {
  const proposedDeliverables = useMemo(
    () => deliverables.filter((deliverable) => deliverable.status === 'proposed'),
    [deliverables],
  )

  return (
    <section className="flex flex-col gap-3" aria-labelledby="proposed-deliverables-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="proposed-deliverables-heading" className="text-sm font-semibold">
          Content Piece Suggestions
        </h3>
        <Badge variant="outline" className="text-[11px]">
          {proposedDeliverables.length} to review
        </Badge>
      </div>

      {proposedDeliverables.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No content pieces to review
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {proposedDeliverables.map((deliverable) => (
            <article
              key={deliverable.id}
              className="rounded-md border border-border bg-card p-3"
              data-testid={`proposed-deliverable-${deliverable.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h4 className="truncate text-sm font-medium">{deliverable.title}</h4>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {deliverable.channel}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      {deliverable.contentType}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {deliverable.tone}
                    </Badge>
                    <time dateTime={deliverable.publishAt}>
                      {formatPublishAt(deliverable.publishAt)}
                    </time>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {deliverable.brief}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {onApprove && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-emerald-500 hover:text-emerald-400"
                      aria-label={`Accept ${deliverable.title}`}
                      title="Accept"
                      onClick={() => onApprove(deliverable)}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                  {onReject && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-red-500 hover:text-red-400"
                      aria-label={`Decline ${deliverable.title}`}
                      title="Decline"
                      onClick={() => onReject(deliverable)}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                  {onEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Edit ${deliverable.title}`}
                      title="Edit"
                      onClick={() => onEdit(deliverable)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
