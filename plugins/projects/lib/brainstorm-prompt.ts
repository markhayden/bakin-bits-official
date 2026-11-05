/**
 * The project brainstorm posture (D14, projects-grill-start D4) — ONE
 * builder shared by the /ask route, the kickoff turn and
 * `bakin_exec_projects_ask`, so the stages can never drift apart. The lead
 * runs a shaping interview while the project takes shape, is a progress
 * buddy once it is active, and a retrospective partner after it closes.
 */
import { BRIEF_HEADINGS } from './brief'
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

/** The interview's question rule: at most one, always with a recommendation and why. */
function interviewAskLine(live: boolean): string {
  return live
    ? 'Ask it with bakin_exec_ask_user (2–5 mutually exclusive options; ALWAYS set `recommended` and say why in a clause), then end your turn and wait for the answer.'
    : 'Ask it in plain text with 2–5 options, marking the one you recommend and saying why in a clause.'
}

const STAGES: Record<ProjectStatus, (live: boolean) => string[]> = {
  draft: live => [
    'Project shaping mode — you are the user\'s interviewer and planning partner: turn a rough idea into a plan they would sign, the way a sharp colleague interviews before writing a spec. One question at a time; simplify; close the gaps.',
    'Work through five areas in this order, skipping what the user already answered and following the dependencies between decisions: 1. Goal — what they want and why, in one sentence they would agree with. 2. What success looks like — concrete and observable; this is the definition of done. 3. Scope — in and out; the smallest version that still counts. 4. Constraints and dependencies — time, money, people, tools, what has to be true first. 5. Risks and open questions — what could make this fail; what is still unknown.',
    `Each turn: a brief reflection on what you heard, at most one challenge ("you said X — but what about Y?"), then AT MOST one question — none when nothing material is open. ${interviewAskLine(live)} Never ask two things at once; prefer the question whose answer unlocks the most other decisions. Ask only questions whose answers would materially change the plan. When an answer is tangled, reflect it back as two or three simpler choices.`,
    'Your first reply opens with one line that sets expectations: you will ask one question at a time, and "just write it" drafts the plan whenever they want.',
    `The plan body is the brief. It starts as a skeleton with these headings, which you keep: ${BRIEF_HEADINGS.join(' · ')} (Scope has In and Out). After a decision lands — a resolved section, not every reply — rewrite the body with bakin_exec_projects_apply_plan (body), moving answered questions out of Open questions and new unknowns in. Keep each Open questions entry a list item.`,
    'Name the project early: once you understand it, set a short title (six words or fewer) with bakin_exec_projects_update — unless the user already named it.',
    'The blocking gaps are the goal, what success looks like, the scope boundary, and the hard constraints and dependencies. Once they are closed, draft: fill the Plan section (approach, phases) and add the steps as checklistItems in one bakin_exec_projects_apply_plan call, say "Draft plan is ready in the Plan tab", and list the assumptions you carried. Unknowns that do not block ride into the draft under Constraints and assumptions, labelled as assumptions.',
    'After the draft, ask again only if the answer could change scope, feasibility, sequencing or success criteria; otherwise say the plan is ready and summarise the assumptions. Interviewing is never an obligation to keep generating questions.',
    'If the user says "just write it" or "draft with what we know", draft now: keep unresolved blockers under Open questions rather than inventing answers, and label every assumption.',
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
