// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { PlansSummary } from '../hooks/use-plans-summary'

// Controllable summary returned by the mocked data hook.
let mockSummary: PlansSummary | null = null
mock.module('../hooks/use-plans-summary', () => ({
  usePlansSummary: () => ({ summary: mockSummary, loading: false, error: null, refresh: async () => {} }),
}))

// Mock the shared useNavBadge hook — its wiring (value-keying, setNavBadge)
// is covered in the bakin SDK tests. Here we assert the provider derives +
// passes the right badge.
const useNavBadge = mock()
mock.module('@makinbakin/sdk/hooks', () => ({ useNavBadge }))

import { PlansBadgeProvider } from '../components/plans-badge-provider'

beforeEach(() => {
  mockSummary = null
  useNavBadge.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('PlansBadgeProvider', () => {
  it('renders nothing', () => {
    const { container } = render(<PlansBadgeProvider />)
    expect(container.firstChild).toBeNull()
  })

  it('passes an attention count badge when plans need review', () => {
    mockSummary = { needsReview: 3, total: 5 }
    render(<PlansBadgeProvider />)
    expect(useNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', { count: 3, tone: 'attention' })
  })

  it('passes null when nothing needs review', () => {
    mockSummary = { needsReview: 0, total: 5 }
    render(<PlansBadgeProvider />)
    expect(useNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', null)
  })

  it('passes null before the summary has loaded', () => {
    mockSummary = null
    render(<PlansBadgeProvider />)
    expect(useNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', null)
  })

  it('updates the badge as the count transitions 3 → 0', () => {
    mockSummary = { needsReview: 3, total: 5 }
    const { rerender } = render(<PlansBadgeProvider />)
    expect(useNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', { count: 3, tone: 'attention' })

    mockSummary = { needsReview: 0, total: 5 }
    rerender(<PlansBadgeProvider />)
    expect(useNavBadge).toHaveBeenLastCalledWith('messaging', 'messaging-plans', null)
  })
})
