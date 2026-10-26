/**
 * The plan-body draft (D12): one field, edited in place on the Plan tab.
 * Agents edit the plan mid-session, so an untouched draft follows the
 * latest body, and an edited one that the latest overlaps needs a choice
 * (Use latest / Keep mine) before it can save. Title, lead and status are
 * not drafted — the header writes them directly.
 */
export interface PlanConflict { baseline: string; latest: string; local: string }
export interface PlanDraft {
  baseline: string
  value: string
  latest: string
  conflict: PlanConflict | null
}
export interface PlanSubmission { body: string; expected: string }

export function createPlanDraft(body: string): PlanDraft {
  return { baseline: body, value: body, latest: body, conflict: null }
}

export function planDraftDirty(state: PlanDraft): boolean {
  return state.value !== state.baseline
}

export function refreshPlanDraft(state: PlanDraft, latest: string): PlanDraft {
  const { baseline, value } = state
  if (value === baseline || value === latest) return { baseline: latest, value: latest, latest, conflict: null }
  if (latest === baseline) return { ...state, latest, conflict: null }
  return { ...state, latest, conflict: { baseline, local: value, latest } }
}

export function editPlanDraft(state: PlanDraft, value: string): PlanDraft {
  return refreshPlanDraft({ ...state, value }, state.latest)
}

export function resolvePlanDraft(state: PlanDraft, choice: 'mine' | 'latest'): PlanDraft {
  return refreshPlanDraft({
    ...state,
    baseline: state.latest,
    value: choice === 'latest' ? state.latest : state.value,
  }, state.latest)
}

export function preparePlanDraft(state: PlanDraft): PlanSubmission {
  if (state.conflict) throw new Error('Review the overlapping plan change before saving.')
  return { body: state.value, expected: state.baseline }
}

/** Only the submitted snapshot becomes clean; typing during a save stays dirty. */
export function acceptPlanDraft(state: PlanDraft, submitted: PlanSubmission): PlanDraft {
  return {
    baseline: submitted.body,
    latest: submitted.body,
    value: state.value === submitted.body ? submitted.body : state.value,
    conflict: null,
  }
}
