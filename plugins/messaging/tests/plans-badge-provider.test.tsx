// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { PlansSummary } from '../hooks/use-plans-summary'

// Controllable summary returned by the mocked hook.
let mockSummary: PlansSummary | null = null
mock.module('../hooks/use-plans-summary', () => ({
  usePlansSummary: () => ({ summary: mockSummary, loading: false, error: null, refresh: async () => {} }),
}))

const setNavBadge = mock()
mock.module('@makinbakin/sdk', () => ({ setNavBadge }))

import { PlansBadgeProvider } from '../components/plans-badge-provider'

beforeEach(() => {
  mockSummary = null
  setNavBadge.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('PlansBadgeProvider', () => {
  it('renders nothing', () => {
    const { container } = render(<PlansBadgeProvider />)
    expect(container.firstChild).toBeNull()
  })

  it('sets an attention count badge when plans need review', () => {
    mockSummary = { needsReview: 3, total: 5 }
    render(<PlansBadgeProvider />)
    expect(setNavBadge).toHaveBeenCalledWith('messaging', 'messaging-plans', { count: 3, tone: 'attention' })
  })

  it('clears the badge (null) when nothing needs review', () => {
    mockSummary = { needsReview: 0, total: 5 }
    render(<PlansBadgeProvider />)
    expect(setNavBadge).toHaveBeenCalledWith('messaging', 'messaging-plans', null)
  })

  it('does not call setNavBadge before the summary has loaded', () => {
    mockSummary = null
    render(<PlansBadgeProvider />)
    expect(setNavBadge).not.toHaveBeenCalled()
  })

  it('updates the badge as the count transitions 3 → 0', () => {
    mockSummary = { needsReview: 3, total: 5 }
    const { rerender } = render(<PlansBadgeProvider />)
    expect(setNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', { count: 3, tone: 'attention' })

    mockSummary = { needsReview: 0, total: 5 }
    rerender(<PlansBadgeProvider />)
    expect(setNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', null)
  })
})
