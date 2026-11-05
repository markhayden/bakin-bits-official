// @vitest-environment jsdom
/**
 * Start screen (D7/D8): a chip pre-fills without creating, the first send
 * creates idempotently and navigates, and a failed create keeps the text and
 * retries with the SAME request identity.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { composerDrafts } from '@makinbakin/sdk/conversation'
import { StartScreen } from '../components/start-screen'
import { STARTER_PROMPTS, fallbackTitle } from '../lib/start'

const push = mock((_to: string) => {})
let responses: Array<() => Response> = []
const fetchMock = mock(async (_url: string, _init?: RequestInit) => (responses.shift() ?? (() => Response.json({ ok: true, id: 'p1', created: true })))())

beforeEach(() => {
  sessionStorage.clear()
  push.mockClear()
  fetchMock.mockClear()
  responses = []
  ;(globalThis as unknown as { __bakinTestSdkHooks?: Record<string, unknown> }).__bakinTestSdkHooks = {
    useRouter: () => ({ push, replace: mock(), back: mock() }),
    useMainAgentId: () => 'main',
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  delete (globalThis as unknown as { __bakinTestSdkHooks?: unknown }).__bakinTestSdkHooks
  cleanup()
})

const input = () => screen.getByRole('textbox', { name: 'Describe your project' }) as HTMLTextAreaElement
const send = async (text: string) => {
  await act(async () => { fireEvent.change(input(), { target: { value: text } }) })
  await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
}
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))

describe('StartScreen', () => {
  it('asks what is on your mind; a chip pre-fills the composer and creates nothing', async () => {
    render(<StartScreen />)
    expect(screen.getByRole('heading', { name: 'What kind of project is on your mind?' })).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clean up my email' })) })
    // A complete prompt: Enter works as-is; the lead's interview draws out the specifics.
    expect(input().value).toBe('Help me clean up my email inbox.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('every starter is a complete sentence', () => {
    for (const starter of STARTER_PROMPTS) expect(starter.prompt).toMatch(/^[A-Z].*\.$/)
  })

  it('the first send creates the project with the lead and a fallback title, then opens it', async () => {
    render(<StartScreen />)
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Lead agent' }), { target: { value: 'scout' } }) })
    await send('Help me plan a garden for next spring')
    expect(bodies()).toEqual([{
      requestId: expect.any(String),
      title: 'Help me plan a garden for next spring',
      owner: 'scout',
      firstMessage: 'Help me plan a garden for next spring',
    }])
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('a failed create restores the text, shows the error, and the retry reuses the request id', async () => {
    responses = [() => Response.json({ error: 'Projects is restarting.' }, { status: 503 })]
    render(<StartScreen />)
    await send('Organize the garage')
    expect(input().value).toBe('Organize the garage')
    expect(screen.getByText('Projects is restarting.')).toBeDefined()
    expect(push).not.toHaveBeenCalled()

    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const [first, retry] = bodies()
    expect(retry.requestId).toBe(first.requestId)
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

describe('StartScreen when Projects never answers', () => {
  it('times out honestly: the error shows, the text is kept, and the retry reuses the request id', async () => {
    // A real fetch rejects with the signal's reason once the timeout aborts it.
    const hanging = mock((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = hanging as unknown as typeof fetch
    render(<StartScreen createTimeoutMs={20} />)
    await send('Plan a trip.')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(screen.getByText('Projects did not answer. Retry — your text is kept.')).toBeDefined()
    expect(input().value).toBe('Plan a trip.')
    expect(input().disabled).toBe(false)
    expect(push).not.toHaveBeenCalled()

    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const first = JSON.parse(String(hanging.mock.calls[0]?.[1]?.body)) as { requestId: string }
    const [retry] = bodies()
    expect(retry.requestId).toBe(first.requestId)
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

describe('StartScreen while creating', () => {
  it('locks the composer and the chips until the create settles', async () => {
    let finish!: () => void
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => new Promise<Response>(resolve => {
      finish = () => resolve(Response.json({ ok: true, id: 'p1', created: true }))
    })) as unknown as typeof fetch
    render(<StartScreen />)
    await send('First idea')
    expect(input().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Clean up my email' })).toBeNull()
    await act(async () => { finish() })
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('an unconfirmed create survives a reload and its retry reuses the identity', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    const first = render(<StartScreen />)
    await send('Reload me')
    first.unmount()
    render(<StartScreen />)
    await send('Reload me')
    const [original, retry] = bodies()
    expect(retry.requestId).toBe(original.requestId)
    expect(sessionStorage.getItem('projects:new:pending')).toBeNull()
  })
})

describe('StartScreen retry after an edit', () => {
  it('re-sends the original payload unchanged and keeps the edit as the project\'s draft', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    render(<StartScreen />)
    await send('Original idea')
    await send('Original idea, with more detail')
    const [first, retry] = bodies()
    expect(retry).toEqual(first)
    expect(retry.firstMessage).toBe('Original idea')
    expect((composerDrafts as Map<string, string>).get('project:p1')).toBe('Original idea, with more detail')
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

describe('fallbackTitle', () => {
  it('keeps short messages and trims long ones on a word boundary', () => {
    expect(fallbackTitle('  Plan   a trip  ')).toBe('Plan a trip')
    const long = 'I want to reorganize every shared drive folder we have before the audit next quarter'
    const title = fallbackTitle(long)
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title.endsWith('…')).toBe(true)
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
  })
})
