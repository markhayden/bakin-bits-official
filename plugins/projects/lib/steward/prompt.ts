/**
 * The steward task's description (D22): what changed (the digest), the plan
 * (excerpt), the recent conversation, and the standing instructions. It is
 * frozen into the reservation, so a recovered create is byte-identical.
 * Byte-capped with visible omission markers — never silently truncated.
 */
import type { Project, ProjectBrainstormMessage } from '../../types'
import type { StewardDigest, StewardSignal } from './digest'

export const STEWARD_PLAN_EXCERPT_BYTES = 4_000
export const STEWARD_ROW_BYTES = 400
export const STEWARD_RECENT_ROWS = 10
export const STEWARD_SIGNALS_BYTES = 3_000
export const STEWARD_DESCRIPTION_MAX_BYTES = 12_000

const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).length

/** Cut to at most `max` bytes on a character boundary, with a marker naming what was left out. */
export function capBytes(text: string, max: number, what: string): string {
  const total = byteLength(text)
  if (total <= max) return text
  let cut = text.slice(0, max)
  while (byteLength(cut) > max) cut = cut.slice(0, -1)
  return `${cut}\n[… ${what} truncated — ${total - byteLength(cut)} more bytes]`
}

const SIGNAL_LINES: Record<StewardSignal['kind'], (refs: string) => string> = {
  'blocked': refs => `Blocked board tasks: ${refs}`,
  'idle-review': refs => `Reviews waiting with no movement: ${refs}`,
  'unpromoted': refs => `Steps not yet on the board, with nothing in flight: ${refs}`,
  'work-done': refs => `Finished since your last check-in: ${refs}`,
  'all-done': () => 'Every step is done.',
  'stalled': refs => `Nothing has moved for a while; unfinished steps: ${refs}`,
}

function describeTask(digest: StewardDigest, id: string): string {
  const task = digest.workTasks.find(t => t.id === id)
  if (!task) return id
  return `"${task.title}" (${id}${task.agent ? `, ${task.agent}` : ''}${task.blockedReason ? ` — blocked: ${task.blockedReason}` : ''})`
}

function describeStep(project: Project, id: string): string {
  const step = project.tasks.find(s => s.id === id)
  return step ? `${id} "${step.title}"` : id
}

function renderRow(row: ProjectBrainstormMessage): string | null {
  const clip = (text: string) => capBytes(text.trim(), STEWARD_ROW_BYTES, 'message')
  switch (row.kind) {
    case 'user': return `User: ${clip(row.content)}`
    case 'assistant': return `${row.agentId ?? 'Agent'}: ${clip(row.content)}`
    case 'tool': return row.summary ? `(${row.toolName}: ${clip(row.summary)})` : null
    case 'error': return `(error: ${clip(row.message)})`
    default: return null
  }
}

export interface StewardPromptInput {
  project: Project
  digest: StewardDigest
  taskId: string
  recentRows: ProjectBrainstormMessage[]
  /** Start's hand-off: the first check-in of an Active project. */
  kickoff?: boolean
}

export function buildStewardDescription({ project, digest, taskId, recentRows, kickoff }: StewardPromptInput): string {
  const signals = digest.signals.map(signal => {
    const refs = signal.kind === 'unpromoted' || signal.kind === 'stalled' || signal.kind === 'all-done'
      ? signal.refs.map(id => describeStep(project, id)).join(', ')
      : signal.refs.map(id => describeTask(digest, id)).join(', ')
    return `- ${SIGNAL_LINES[signal.kind](refs)}`
  })
  const why = kickoff
    ? project.tasks.length === 0
      ? 'The user just started this project and it has no steps yet: break the agreed plan into steps first.'
      : 'The user just started this project: get the first steps moving.'
    : 'Something changed on this project since your last check-in:'

  const steps = project.tasks.map(step => `- ${step.id} ${step.taskId ? '[on board]' : '[not on board]'} ${step.title}`)
  const rows = recentRows.slice(-STEWARD_RECENT_ROWS).map(renderRow).filter((line): line is string => line !== null)

  const instructions = [
    '## What you may do on your own',
    '- Send existing steps to the board (bakin_exec_projects_promote_item), keeping a step yourself or assigning the agent best suited to it.',
    '- Add steps or board tasks that follow from the agreed plan; make small plan edits (bakin_exec_projects_apply_plan).',
    '- Re-describe or reassign a blocked task; nudge a review that is going nowhere.',
    '',
    '## What needs the user',
    '- Changing scope, dropping or deleting steps, or spending beyond what the plan agreed: ask with bakin_exec_projects_request_input.',
    '- Signing off a deliverable, or completing the project when every step is done: bakin_exec_projects_request_signoff.',
    '- You cannot change the project\'s status or delete steps.',
    '',
    '## Finish',
    `End by calling bakin_exec_projects_checkin with projectId "${project.id}", taskId "${taskId}", a one-line summary and the actions you took — the user reads it in the project conversation. Then complete this task.`,
  ].join('\n')

  // Instructions ride before the long sections: if the cap ever bites, it
  // trims the conversation tail, never the rules.
  const sections = [
    `You are the lead on the project "${project.title}" (project id ${project.id}). This is a check-in task (task id ${taskId}).`,
    capBytes([why, ...signals].join('\n'), STEWARD_SIGNALS_BYTES, 'signal list'),
    instructions,
    `## Steps\n${steps.length ? steps.join('\n') : '(none yet)'}`,
    `## Plan (excerpt)\n${project.body ? capBytes(project.body, STEWARD_PLAN_EXCERPT_BYTES, 'plan') : '(empty)'}\nRead the full project with bakin_exec_projects_get.`,
    `## Recent conversation\n${rows.length ? rows.join('\n') : '(no messages yet)'}`,
  ]
  return capBytes(sections.join('\n\n'), STEWARD_DESCRIPTION_MAX_BYTES, 'check-in brief')
}
