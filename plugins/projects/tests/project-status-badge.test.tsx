import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectStatusBadge } from '../components/project-status-badge'
import type { ProjectStatus } from '../types'

afterEach(cleanup)

describe('ProjectStatusBadge', () => {
  const states: Array<{ status: ProjectStatus; label: string; tone: string }> = [
    { status: 'draft', label: 'Draft', tone: 'neutral' },
    { status: 'active', label: 'Active', tone: 'accent' },
    { status: 'completed', label: 'Completed', tone: 'success' },
    { status: 'archived', label: 'Archived', tone: 'neutral' },
  ]

  for (const { status, label, tone } of states) {
    it(`uses a compact solid ${tone} chip for ${status}`, () => {
      const badge = ProjectStatusBadge({ status })
      expect(badge.props.variant).toBe('solid')
      expect(badge.props.size).toBe('xs')
      render(badge)
      expect(screen.getByText(label).getAttribute('data-tone')).toBe(tone)
    })
  }

  it('preserves the optional click handler', () => {
    const onClick = mock(() => {})
    render(<ProjectStatusBadge status="draft" onClick={onClick} />)
    fireEvent.click(screen.getByText('Draft'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
