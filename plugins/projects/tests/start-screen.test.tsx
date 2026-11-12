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
  ;(composerDrafts as Map<string, string>).clear()
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

  it('an interrupted reload shows the pending message and lead, and Enter retries them unchanged', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    const first = render(<StartScreen />)
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Lead agent' }), { target: { value: 'scout' } }) })
    await send('Reload me')
    first.unmount()
    render(<StartScreen />)
    // The text and the lead are visible again — nothing hidden retries behind the user's back.
    expect(input().value).toBe('Reload me')
    expect((screen.getByRole('combobox', { name: 'Lead agent' }) as HTMLSelectElement).value).toBe('scout')
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const [original, retry] = bodies()
    expect(retry).toEqual(original)
    expect(retry.owner).toBe('scout')
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('a retry after a reload keeps the original lead even when the picker now shows another', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    const first = render(<StartScreen />)
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Lead agent' }), { target: { value: 'scout' } }) })
    await send('Reload me')
    first.unmount()
    render(<StartScreen />)
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Lead agent' }), { target: { value: 'main' } }) })
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const [original, retry] = bodies()
    expect(retry).toEqual(original)
  })

  it('a reload during an edited retry keeps the edit, says a send is unconfirmed, and retries the original', async () => {
    responses = [
      () => Response.json({ error: 'Lost response' }, { status: 503 }),
      () => new Promise<never>(() => {}) as unknown as Response, // the retry never answers before the reload
    ]
    const first = render(<StartScreen />)
    await send('Original idea')
    await send('Original idea, with more detail')
    first.unmount()
    render(<StartScreen />)
    expect(input().value).toBe('Original idea, with more detail')
    expect(screen.getByText(/hasn't been confirmed yet/)).toBeDefined()
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const sent = bodies()
    expect(sent).toHaveLength(3)
    expect(sent[2]).toEqual(sent[0])
    expect((composerDrafts as Map<string, string>).get('project:p1')).toBe('Original idea, with more detail')
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('a saved composer draft after a reload does not hide the unconfirmed send', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    const first = render(<StartScreen />)
    await send('Original idea')
    first.unmount()
    // The real composer restores its own saved draft on mount.
    ;(composerDrafts as Map<string, string>).set('projects:new', 'A different idea')
    render(<StartScreen />)
    expect(input().value).toBe('A different idea')
    expect(screen.getByText(/hasn't been confirmed yet/)).toBeDefined()
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const [original, retry] = bodies()
    expect(retry).toEqual(original)
    expect((composerDrafts as Map<string, string>).get('project:p1')).toBe('A different idea')
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('a failed retry after a reload keeps the notice beside the error until the create succeeds', async () => {
    responses = [
      () => Response.json({ error: 'Lost response' }, { status: 503 }),
      () => Response.json({ error: 'Still down' }, { status: 503 }),
    ]
    const first = render(<StartScreen />)
    await send('Original idea')
    first.unmount()
    ;(composerDrafts as Map<string, string>).set('projects:new', 'A different idea')
    render(<StartScreen />)
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    expect(screen.getByText('Still down')).toBeDefined()
    expect(screen.getByText(/hasn't been confirmed yet/)).toBeDefined()
    expect(input().value).toBe('A different idea')
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    const sent = bodies()
    expect(sent).toHaveLength(3)
    expect(sent[2]).toEqual(sent[0])
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })

  it('a failed first send says the send is unconfirmed in the same visit, so an edited retry is never silent', async () => {
    responses = [() => Response.json({ error: 'Lost response' }, { status: 503 })]
    render(<StartScreen />)
    await send('Original idea')
    expect(screen.getByText('Lost response')).toBeDefined()
    expect(screen.getByText(/hasn't been confirmed yet/)).toBeDefined()
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

describe('StartScreen on a plain-http origin', () => {
  // Over Tailscale the page is http://<host>:3737 — not a secure context — and
  // crypto.randomUUID does not exist there. The create must still go out.
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  let saved: Crypto['randomUUID']
  beforeEach(() => {
    saved = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true })
  })
  afterEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: saved, configurable: true, writable: true })
  })

  it('still mints a v4 request id and opens the project', async () => {
    render(<StartScreen />)
    await send('Help me plan a trip.')
    expect(bodies()[0]?.requestId).toMatch(v4)
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

describe('StartScreen when minting the request id throws', () => {
  // Whatever fails before the request leaves must read as an error with the
  // text kept and the composer unlocked — never "Sending…" forever.
  let saved: Crypto['randomUUID']
  beforeEach(() => {
    saved = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: () => { throw new Error('no entropy today') }, configurable: true, writable: true })
  })
  afterEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: saved, configurable: true, writable: true })
  })

  it('shows the error, keeps the text, sends nothing, records nothing, and the retry works', async () => {
    render(<StartScreen />)
    await send('Help me plan a trip.')
    expect(screen.getByText('no entropy today')).toBeDefined()
    expect(input().value).toBe('Help me plan a trip.')
    expect(input().disabled).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(0)
    expect(push).not.toHaveBeenCalled()

    Object.defineProperty(crypto, 'randomUUID', { value: saved, configurable: true, writable: true })
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    expect(bodies()).toHaveLength(1)
    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

describe('StartScreen when building the request throws', () => {
  // Nothing has left the browser yet, so the text comes back and nothing is sent.
  let saved: typeof AbortSignal.timeout
  beforeEach(() => {
    saved = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: () => { throw new Error('no timers here') }, configurable: true, writable: true })
  })
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'timeout', { value: saved, configurable: true, writable: true })
  })

  it('shows the error, keeps the text, and sends nothing', async () => {
    render(<StartScreen />)
    await send('Help me plan a trip.')
    expect(screen.getByText('no timers here')).toBeDefined()
    expect(input().value).toBe('Help me plan a trip.')
    expect(input().disabled).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
