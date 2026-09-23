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
import { PlanHistoryPanel as HistoryPanel } from '../../../plugins/projects/components/plan-history'

import type { ProjectHistory } from '../hooks/use-project-history'
import { useProjectHistory } from '../hooks/use-project-history'
import { RenderedPlan as Plan } from '../components/rendered-plan'
function PlanHistoryPanel(props: { projectId: string; currentBody: string; onRestored: () => void }) {
  const historyState = useProjectHistory(props.projectId, props.currentBody)
  return <HistoryPanel {...props} historyState={historyState} />
}
function RenderedPlan(props: { projectId: string; body: string; hintsEnabled?: boolean }) {
  const historyState = useProjectHistory(props.projectId, props.body)
  return <Plan {...props} historyState={historyState} />
}

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

describe('history failures', () => {
  it('shows an actionable failure instead of pretending history is empty', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'History unavailable' }, { status: 503 })) as typeof fetch
    render(<PlanHistoryPanel projectId="p1" currentBody="body" onRestored={() => {}} />)
    await waitFor(() => expect(screen.getByText('History unavailable')).toBeDefined())
    expect(screen.queryByText('No plan versions yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
  })
})

describe('block-level change hints (rendered view)', () => {
  it('splitBlocks separates on blank lines but keeps fenced code intact', async () => {
    const { splitBlocks } = await import('../../../plugins/projects/lib/block-diff')
    expect(splitBlocks('# A\n\npara one\n\n```js\ncode\n\nstill code\n```\n\npara two')).toEqual([
      '# A',
      'para one',
      '```js\ncode\n\nstill code\n```',
      'para two',
    ])
  })

  it('diffBlocks: edits are green-only, pure deletions become removal markers, identical is clean', async () => {
    const { diffBlocks } = await import('../../../plugins/projects/lib/block-diff')
    const previous = '# Title\n\nintro\n\nmiddle\n\noutro'

    // Edited middle block — a modification collapses to one changed block,
    // no removal marker.
    expect(diffBlocks(previous, '# Title\n\nintro\n\nmiddle EDITED\n\noutro')).toEqual([
      { type: 'block', text: '# Title', changed: false },
      { type: 'block', text: 'intro', changed: false },
      { type: 'block', text: 'middle EDITED', changed: true },
      { type: 'block', text: 'outro', changed: false },
    ])

    // Pure deletion: an explicit marker at the removal site.
    expect(diffBlocks(previous, '# Title\n\nintro\n\noutro')).toEqual([
      { type: 'block', text: '# Title', changed: false },
      { type: 'block', text: 'intro', changed: false },
      { type: 'removed' },
      { type: 'block', text: 'outro', changed: false },
    ])

    // Trailing deletion: marker at the end.
    expect(diffBlocks(previous, '# Title\n\nintro\n\nmiddle')).toEqual([
      { type: 'block', text: '# Title', changed: false },
      { type: 'block', text: 'intro', changed: false },
      { type: 'block', text: 'middle', changed: false },
      { type: 'removed' },
    ])

    // Pure addition: green block, no marker.
    expect(diffBlocks(previous, '# Title\n\nintro\n\nNEW\n\nmiddle\n\noutro')).toEqual([
      { type: 'block', text: '# Title', changed: false },
      { type: 'block', text: 'intro', changed: false },
      { type: 'block', text: 'NEW', changed: true },
      { type: 'block', text: 'middle', changed: false },
      { type: 'block', text: 'outro', changed: false },
    ])

    // Identical bodies: nothing marked.
    expect(diffBlocks(previous, previous).every((e) => e.type === 'block' && !e.changed)).toBe(true)
  })

  it('RenderedPlan draws a green edge bar on the edited block only', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/history')) {
        return {
          ok: true,
          json: async () => ({ history: [{ ts: '2026-07-20T10:00:00Z', author: 'agent', body: '# Plan\n\nold section\n\nending' }] }),
          text: async () => '',
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { container } = render(<RenderedPlan projectId="p1" body={'# Plan\n\nnew section\n\nending'} />)
    await waitFor(() => expect(container.querySelectorAll('[data-plan-changed-block]').length).toBe(1))
    const marked = container.querySelector('[data-plan-changed-block]')!
    expect(marked.textContent).toContain('new section')
    expect(marked.className).toContain('border-bakin-signal-success')
    expect(container.querySelectorAll('[data-plan-removed-marker]').length).toBe(0)
    expect(screen.getByText('# Plan')).toBeDefined()
  })

  it('RenderedPlan draws a red tick where content was removed', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/history')) {
        return {
          ok: true,
          json: async () => ({ history: [{ ts: '2026-07-20T10:00:00Z', author: 'user', body: '# Plan\n\ndoomed section\n\nending' }] }),
          text: async () => '',
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { container } = render(<RenderedPlan projectId="p1" body={'# Plan\n\nending'} />)
    await waitFor(() => expect(container.querySelectorAll('[data-plan-removed-marker]').length).toBe(1))
    expect(container.querySelector('[data-plan-removed-marker]')!.className).toContain('bg-bakin-signal-danger')
    expect(container.querySelectorAll('[data-plan-changed-block]').length).toBe(0)
  })

  it('RenderedPlan renders plain when there is no history baseline', async () => {
    globalThis.fetch = mock(async () => ({ ok: true, json: async () => ({ history: [] }), text: async () => '' }) as Response) as unknown as typeof fetch
    const { container } = render(<RenderedPlan projectId="p1" body="# Plan" />)
    await waitFor(() => expect(screen.getByText('# Plan')).toBeDefined())
    expect(container.querySelectorAll('[data-plan-changed-block]').length).toBe(0)
  })
})


describe('show-changes preference', () => {
  it('RenderedPlan renders plain (no hints, no history fetch dependence) when hints are disabled', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/history')) {
        return {
          ok: true,
          json: async () => ({ history: [{ ts: '2026-07-20T10:00:00Z', author: 'agent', body: 'old body' }] }),
          text: async () => '',
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { container } = render(<RenderedPlan projectId="p1" body="new body" hintsEnabled={false} />)
    await waitFor(() => expect(screen.getByText('new body')).toBeDefined())
    expect(container.querySelectorAll('[data-plan-changed-block]').length).toBe(0)
    expect(container.querySelectorAll('[data-plan-removed-marker]').length).toBe(0)
  })
})


describe('restore intent', () => {
  const old = { ts: '2026-09-01T00:00:00Z', author: 'agent' as const, body: 'Old body' }
  const state = (history = [old]): ProjectHistory => ({ identity: 'p1', history, loading: false, error: null, refresh: async () => {} })
  it('pins the confirmed snapshot when the history list shifts', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (_url, init) => { requests.push(String(init?.body)); return Response.json({ ok: true }) }) as typeof fetch
    const view = render(<HistoryPanel projectId="p1" currentBody="Current" onRestored={() => {}} historyState={state()} />)
    fireEvent.click(screen.getByTestId('plan-history-restore'))
    view.rerender(<HistoryPanel projectId="p1" currentBody="Current" onRestored={() => {}} historyState={state([{ ...old, ts: '2026-09-02T00:00:00Z' }])} />)
    fireEvent.click(screen.getByTestId('plan-history-restore-confirm'))
    await waitFor(() => expect(requests).toEqual([JSON.stringify({ expectedTs: old.ts })]))
  })
  it('keeps the confirmation open after failure and retries the same intent', async () => {
    let fail = true
    globalThis.fetch = (async () => { if (fail) throw new Error('offline'); return Response.json({ ok: true }) }) as typeof fetch
    const restored = mock()
    render(<HistoryPanel projectId="p1" currentBody="Current" onRestored={restored} historyState={state()} />)
    fireEvent.click(screen.getByTestId('plan-history-restore'))
    fireEvent.click(screen.getByTestId('plan-history-restore-confirm'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not reach'))
    expect(restored).not.toHaveBeenCalled()
    fail = false
    fireEvent.click(screen.getByTestId('plan-history-restore-confirm'))
    await waitFor(() => expect(restored).toHaveBeenCalledTimes(1))
  })
  it('never calls an over-budget diff unchanged', () => {
    render(<HistoryPanel projectId="p1" currentBody={'line\n'.repeat(5001)} onRestored={() => {}} historyState={state()} />)
    expect(screen.getByText('Comparison unavailable')).toBeDefined()
    expect(screen.queryByText('No changes')).toBeNull()
    expect(screen.getByRole('region', { name: 'Plan line comparison' }).tabIndex).toBe(0)
  })
})
