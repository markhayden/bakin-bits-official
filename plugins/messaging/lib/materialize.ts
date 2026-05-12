import type { BrainstormSession } from '../types'
import type { MessagingContentStorage } from './content-storage'

export interface MaterializeResult {
  planIds: string[]
}

export function materializeApprovedProposals(
  session: BrainstormSession,
  contentStore: MessagingContentStorage,
): MaterializeResult {
  const planIds: string[] = []
  session.createdAtPlanIds ??= []

  for (const proposal of session.proposals) {
    if (proposal.status !== 'approved' || proposal.planId) continue

    const plan = contentStore.createPlan({
      title: proposal.title,
      brief: proposal.brief,
      targetDate: proposal.targetDate,
      agent: proposal.agentId,
      status: 'needs_review',
      sourceSessionId: session.id,
      suggestedChannels: proposal.suggestedChannels,
    })
    proposal.planId = plan.id
    planIds.push(plan.id)
    if (!session.createdAtPlanIds.includes(plan.id)) session.createdAtPlanIds.push(plan.id)
  }

  return { planIds }
}
