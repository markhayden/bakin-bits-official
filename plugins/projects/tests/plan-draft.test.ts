import { expect, it } from 'bun:test'
import { acceptPlanDraft, createPlanDraft, editPlanDraft, planDraftDirty, preparePlanDraft, refreshPlanDraft, resolvePlanDraft } from '../lib/plan-draft'

it('an untouched draft follows the latest body', () => {
  const state = refreshPlanDraft(createPlanDraft('v1'), 'agent v2')
  expect(state.value).toBe('agent v2')
  expect(planDraftDirty(state)).toBe(false)
})

it('an overlapping agent edit needs a choice before saving, against the latest reviewed body', () => {
  let state = refreshPlanDraft(editPlanDraft(createPlanDraft('v1'), 'mine'), 'agent')
  expect(state.conflict).toEqual({ baseline: 'v1', latest: 'agent', local: 'mine' })
  expect(() => preparePlanDraft(state)).toThrow('overlapping')
  state = resolvePlanDraft(state, 'mine')
  expect(preparePlanDraft(state)).toEqual({ body: 'mine', expected: 'agent' })
  state = resolvePlanDraft(refreshPlanDraft(state, 'agent again'), 'latest')
  expect(state.value).toBe('agent again')
  expect(planDraftDirty(state)).toBe(false)
})

it('typing during a save stays dirty against the submitted snapshot', () => {
  let state = editPlanDraft(createPlanDraft('v1'), 'mine')
  const sent = preparePlanDraft(state)
  state = acceptPlanDraft(editPlanDraft(state, 'later'), sent)
  expect(state.value).toBe('later')
  expect(preparePlanDraft(state)).toEqual({ body: 'later', expected: 'mine' })
})
