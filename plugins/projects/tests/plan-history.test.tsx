// @vitest-environment jsdom
/**
 * Plan history UI (bakin#703): the line-diff util and the PlanHistoryPanel
 * (snapshot picker, added/removed rendering, restore behind a confirm
 * modal that keeps the whole flow in the dialog).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

import { diffLines } from '../../../plugins/projects/lib/line-diff'
import { PlanHistoryPanel } from '../../../plugins/projects/components/plan-history'

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { fetch?: unknown }).fetch
})

describe('diffLines', () => {
  it('classifies unchanged, added, and removed lines', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'same', text: 'c' },
    ])
  })

  it('handles pure additions, pure removals, and identical bodies', () => {
    expect(diffLines('a', 'a\nb')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'added', text: 'b' },
    ])
    expect(diffLines('a\nb', 'b')).toEqual([
      { type: 'removed', text: 'a' },
      { type: 'same', text: 'b' },
    ])
    expect(diffLines('a\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true)
  })

  it('keeps common context across a moved block (LCS, not naive pairing)', () => {
    const diff = diffLines('intro\nold section\noutro', 'intro\nnew section\nextra\noutro')
    expect(diff.filter((l) => l.type === 'same').map((l) => l.text)).toEqual(['intro', 'outro'])
    expect(diff.filter((l) => l.type === 'removed').map((l) => l.text)).toEqual(['old section'])
    expect(diff.filter((l) => l.type === 'added').map((l) => l.text)).toEqual(['new section', 'extra'])
  })
})

describe('PlanHistoryPanel', () => {
  const HISTORY = [
    { ts: '2026-07-18T10:00:00.000Z', author: 'agent', body: 'first version' },
    { ts: '2026-07-19T10:00:00.000Z', author: 'user', body: 'second version' },
  ]

  function stubFetch(restoreStatus = 200) {
    const calls: Array<{ url: string; method?: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith('/history') && !init?.method) {
        return { ok: true, json: async () => ({ history: HISTORY }), text: async () => '' } as Response
      }
      if (url.includes('/history/') && url.endsWith('/restore')) {
        return { ok: restoreStatus === 200, status: restoreStatus, json: async () => ({ ok: true }), text: async () => '' } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch
    return calls
  }

  it('defaults to the previous version and renders added/removed lines against the current body', async () => {
    stubFetch()
    render(<PlanHistoryPanel projectId="p1" currentBody={'second version\nnew line'} onRestored={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('plan-history-diff')).toBeDefined())
    const picker = screen.getByTestId('plan-history-picker') as HTMLSelectElement
    expect(picker.value).toBe('1') // newest snapshot = previous version
    const rows = screen.getByTestId('plan-history-diff').querySelectorAll('[data-diff-type]')
    const types = [...rows].map((r) => r.getAttribute('data-diff-type'))
    expect(types).toEqual(['same', 'added'])
  })

  it('restore flows entirely through the confirm modal and reports back', async () => {
    const calls = stubFetch()
    const restored: string[] = []
    render(<PlanHistoryPanel projectId="p1" currentBody="second version" onRestored={() => restored.push('yes')} />)
    await waitFor(() => expect(screen.getByTestId('plan-history-restore')).toBeDefined())

    fireEvent.click(screen.getByTestId('plan-history-restore'))
    // Nothing posted yet — the whole action lives in the modal.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('plan-history-restore-confirm'))
    await waitFor(() => expect(restored).toEqual(['yes']))
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toContain('/history/1/restore')
  })

  it('empty history renders the explainer, never a broken diff', async () => {
    globalThis.fetch = mock(async () => ({ ok: true, json: async () => ({ history: [] }), text: async () => '' }) as Response) as unknown as typeof fetch
    render(<PlanHistoryPanel projectId="p1" currentBody="x" onRestored={() => {}} />)
    await waitFor(() => expect(screen.getByText(/No plan versions yet/)).toBeDefined())
  })
})
