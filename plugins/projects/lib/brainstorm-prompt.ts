/**
 * The project brainstorm posture (D14) — ONE builder shared by the /ask
 * route, the kickoff turn and `bakin_exec_projects_ask`, so the stages can
 * never drift apart. The lead is a brainstorm buddy while the project takes
 * shape, a progress buddy once it is active, and a retrospective partner
 * after it closes.
 */
import type { Project, ProjectStatus, ProjectWaitingOn } from '../types'

/** `live`: the reply renders in the project chat, where question cards work. */
export interface BrainstormPromptOptions {
  live: boolean
  /** A check-in question this message answers (D25): the lead sees what it asked, and why. */
  pendingQuestion?: ProjectWaitingOn
}

function pendingQuestionLines(waiting: ProjectWaitingOn): string[] {
  return [
    '',
    `Pending question from your last check-in: ${waiting.question}`,
    ...(waiting.options?.length ? [`Options: ${waiting.options.join(' · ')}`] : []),
    ...(waiting.context ? [`Why you asked: ${waiting.context}`] : []),
    'The user\'s message below is their reply to it — act on it.',
  ]
}

const SHARED = [
  'Every plan edit is snapshotted with a visible diff and one-click restore, so direct edits are safe.',
  'You cannot start, complete or archive the project — those are the user\'s decisions.',
  'Invoke Bakin tools as described in your Tool access section — the exact call form depends on the active runtime.',
]

function askLine(live: boolean): string {
  return live
    ? 'Ask exactly ONE question per turn with bakin_exec_ask_user (2–5 options, mark the one you recommend), then end your turn and wait for the answer.'
    : 'Ask at most ONE question, in plain text, and mark the answer you recommend.'
}

const STAGES: Record<ProjectStatus, (live: boolean) => string[]> = {
  draft: live => [
    'Project shaping mode — you are the user\'s brainstorm buddy: help them refine the idea and poke holes in it, the way a sharp friend would. Keep it light; no formal process.',
    `Each turn: a brief reflection on what you heard, at most one challenge ("you said X — but what about Y?"), then the question. ${askLine(live)}`,
    'Ask only questions whose answers would materially change the plan.',
    'Name the project early: once you understand it, set a short title (six words or fewer) with bakin_exec_projects_update — unless the user already named it.',
    'Once the goal, the scope and what "done" means are answered (usually three to five questions), draft the plan body and its steps with bakin_exec_projects_apply_plan, say "Draft plan is ready in the Plan tab", label your assumptions, and keep refining.',
    'If the user says "just write it" or "draft with what we know", draft now and list your assumptions.',
  ],
  active: live => [
    'Project progress mode — you are the user\'s progress buddy: what is blocked, what is next, and whether the scope still holds.',
    'Do not interview the user unless they ask. Keep the plan and its steps current with bakin_exec_projects_apply_plan and the step tools, and say what you changed.',
    `Only when a real decision is needed: ${askLine(live)}`,
  ],
  completed: () => [
    'Project retrospective mode — the project is complete. Answer questions and reflect on what happened; change the plan only when the user asks.',
  ],
  archived: () => [
    'Project retrospective mode — the project is archived. Answer questions; change the plan only when the user asks.',
  ],
}

export function projectBrainstormInstructions(status: ProjectStatus, opts: BrainstormPromptOptions): string {
  return [...STAGES[status](opts.live), ...SHARED].join('\n')
}

const SPEC_CAP = 3000

/** The full turn context: project state, the stage's posture, the user's request. */
export function buildProjectBrainstormContext(project: Project, request: string, opts: BrainstormPromptOptions): string {
  const assetLines = project.assets.length > 0
    ? ['', 'Attached assets (summaries — use asset tools to read full content if needed):', ...project.assets.map(a => `- ${a.assetId}${a.label ? ` — ${a.label}` : ''}`)]
    : []
  const truncated = project.body.length > SPEC_CAP
  const done = project.tasks.filter(t => t.checked).length
  return [
    `You are being asked about project "${project.title}" (id: ${project.id}, status: ${project.status}).`,
    project.titleSource === 'user'
      ? 'The user named this project — keep their title.'
      : 'The title is provisional — rename it once you understand the project.',
    `Progress: ${done} of ${project.tasks.length} steps done (${project.progress}%)`,
    '',
    'Project plan:',
    project.body ? project.body.slice(0, SPEC_CAP) : '(empty — nothing drafted yet)',
    // Visible omission marker — an agent must never mistake a truncated view
    // for the whole plan.
    ...(truncated
      ? [`[... plan truncated: showing ${SPEC_CAP} of ${project.body.length} chars — read the full plan with bakin_exec_projects_get before any rewrite; prefer appendBody or single-step edits.]`]
      : []),
    '',
    'Steps:',
    ...project.tasks.map(t => `- [${t.checked ? 'x' : ' '}] ${t.title}${t.taskId ? ` (board task ${t.taskId} — completes from the board)` : ''}`),
    ...assetLines,
    '',
    projectBrainstormInstructions(project.status, opts),
    ...(opts.pendingQuestion ? pendingQuestionLines(opts.pendingQuestion) : []),
    '',
    'User request:',
    request,
    '',
    'Respond concisely.',
  ].join('\n')
}
