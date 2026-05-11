/**
 * Prompt builder for planning sessions.
 *
 * Builds a system prompt with agent persona, planning instructions,
 * and current plan state. Returns a proper messages array (not a
 * flattened string). Durable conversation continuity is owned by the
 * runtime adapter via threadId; stored messages are for UI hydration.
 *
 * Pure module — agent identity, persona markdown, and the content-type
 * taxonomy are all resolved by the caller (who has plugin context +
 * roster validation + user settings) and passed in via options. No
 * filesystem access here.
 */
import type { PlanningSession, ContentTypeOption } from '../types'

export interface PromptBuilderOptions {
  /** Display name for the agent. Falls back to agentId when omitted (orphaned reference). */
  agentName?: string
  /** User-configured content types — surfaces valid ids in the prompt instruction. */
  contentTypes: ContentTypeOption[]
  /** Pre-loaded agent persona markdown, or empty string. The caller is responsible
   *  for validating the agentId against the live roster before loading. */
  persona: string
}

/**
 * Build a summary of the current plan state (proposals with statuses).
 */
function buildPlanState(session: PlanningSession): string {
  if (session.proposals.length === 0) return ''

  const lines = ['## Current Session State\n']
  for (const p of session.proposals) {
    const statusTag = p.status.toUpperCase()
    const targetDate = p.targetDate ?? p.scheduledAt.slice(0, 10)
    const channels = p.suggestedChannels ?? p.channels ?? []
    let line = `- [${statusTag}] (${p.id}) "${p.title}" — ${targetDate}`
    if (channels.length > 0) line += `; suggestedChannels: ${channels.join(', ')}`
    if (p.rejectionNote) {
      line += `\n  Rejection note: ${p.rejectionNote}`
    }
    lines.push(line)
  }

  const approved = session.proposals.filter(p => p.status === 'approved').length
  const rejected = session.proposals.filter(p => p.status === 'rejected').length
  const proposed = session.proposals.filter(p => p.status === 'proposed').length
  lines.push(`\nSummary: ${approved} approved, ${rejected} rejected, ${proposed} pending`)

  return lines.join('\n')
}

/**
 * Build the system prompt for a planning session.
 */
export function buildSystemPrompt(
  agentId: string,
  session: PlanningSession,
  options: PromptBuilderOptions,
): string {
  const agentName = options.agentName || agentId
  const persona = options.persona
  void options.contentTypes

  const sections: string[] = []

  // Identity
  sections.push(`You are ${agentName}.`)

  // Persona
  if (persona) {
    sections.push(`## Your Persona\n\n${persona}`)
  }

  // Planning instructions
  sections.push(`## Brainstorming Instructions

You are in a brainstorm session with Mark. The session scope is: ${session.scope || 'open'}.

Your job is to propose **content topics** as Plan proposals. One Plan = one topic
or one day's focus (e.g., "Taco Tuesday"). A single brainstorm session can produce
multiple Plans — Mark will materialize the ones he likes into the content calendar.

HARD RULE: If Mark requests ANY concrete content topic — even a single one ("a
post about tacos") — you MUST emit it as a \`\`\`json proposal block. Do not reply
in prose when a concrete content request is made. If Mark is ambiguous, clarify
briefly first, then emit a proposal.

HARD RULE: Emit each Plan as its OWN fenced JSON block — one object per block,
NOT an array. Brief intro sentence before each block so items appear incrementally.

Example block format:

\`\`\`json
{
  "title": "Taco Tuesday",
  "targetDate": "2026-05-19",
  "brief": "Tuesday focus on tacos — celebrate weeknight family recipes, easy assembly, fun toppings.",
  "suggestedChannels": ["blog", "x", "youtube"]
}
\`\`\`

Fields:
- title: punchy topic title in your authentic voice
- targetDate: ISO date (timezone: America/Denver, MDT)
- brief: 2–3 sentence focus describing the topic and angle
- suggestedChannels: optional hint; Mark will finalize channels per-Plan later

Few-shot examples:

[example 1 — single quote request]
User: "Generate an inspirational quote for today."
Agent: "One inspirational pulse for today:"
\`\`\`json
{
  "title": "Monday motivation",
  "targetDate": "2026-05-17",
  "brief": "An inspirational quote about persistence through slow progress; tied to a personal anecdote.",
  "suggestedChannels": ["x", "instagram"]
}
\`\`\`

[example 2 — multi-day plan]
User: "Plan three topics for next week."
Agent: "Three topics, one per day:"
\`\`\`json
{ "title": "Taco Tuesday", "targetDate": "2026-05-19", "brief": "Tuesday focus on tacos.", "suggestedChannels": ["blog"] }
\`\`\`
"Wednesday leans educational:"
\`\`\`json
{ "title": "Spice blending fundamentals", "targetDate": "2026-05-20", "brief": "Teach beginner spice blending.", "suggestedChannels": ["blog"] }
\`\`\`
"Friday wraps with something lighter:"
\`\`\`json
{ "title": "Weekend pairings", "targetDate": "2026-05-22", "brief": "Easy pairings for relaxed weekend cooking.", "suggestedChannels": ["x"] }
\`\`\`

[example 3 — revision with id]
User: "Make Wednesday's brief more SEO-focused."
Agent: "Refining Wednesday:"
\`\`\`json
{
  "id": "{existing-proposal-id}",
  "title": "Spice blending fundamentals",
  "targetDate": "2026-05-20",
  "brief": "SEO-tuned brief mentioning how to blend spices at home and beginner spice blends.",
  "suggestedChannels": ["blog"]
}
\`\`\`

## Revising Existing Proposals

When Mark asks you to edit, revise, or update an existing proposal, include the proposal's "id" field so the system updates it in place instead of creating a duplicate:

\`\`\`json
{ "id": "existing-proposal-id", "title": "Updated title", "targetDate": "2026-05-20", "brief": "...", "suggestedChannels": ["blog"] }
\`\`\`

Rules for revisions:
- Only modify the items Mark asked about — do NOT regenerate the entire plan
- Keep approved items unchanged unless explicitly asked to modify them
- If a rejection note is provided, address the feedback specifically
- Always include the "id" field from the Current Plan State when revising an existing item
- If you cannot find the ID, match by title — but "id" is strongly preferred`)

  // Plan state
  const planState = buildPlanState(session)
  if (planState) {
    sections.push(planState)
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Build a proper messages array for the current turn.
 * Returns an array suitable for the OpenAI-compatible chat completions API.
 */
export function buildMessages(
  session: PlanningSession,
  newMessage: string,
  options: PromptBuilderOptions,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

  // System prompt
  messages.push({
    role: 'system',
    content: buildSystemPrompt(session.agentId, session, options),
  })

  // New user message
  messages.push({
    role: 'user',
    content: newMessage,
  })

  return messages
}
