import { describe, expect, it } from 'bun:test'
import { DRAFT_LIMIT_BYTES, readDraft, writeDraft } from '../components/compose-drafts'

function memory() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) }, items,
  } as unknown as Storage & { items: Map<string, string> }
}

describe('compose drafts', () => {
  it('keeps one draft per session; empty removes it', () => {
    const storage = memory()
    writeDraft('a', 'first', () => storage)
    writeDraft('b', 'second', () => storage)
    expect(readDraft('a', () => storage)).toBe('first')
    expect(readDraft('b', () => storage)).toBe('second')
    writeDraft('a', '', () => storage)
    expect(readDraft('a', () => storage)).toBe('')
    expect(storage.items.size).toBe(1)
  })
  it('says it could not keep a draft past the limit (in bytes), and drops the stale stored copy', () => {
    const storage = memory()
    expect(writeDraft('a', 'kept', () => storage)).toBe(true)
    // 22,000 CJK characters are 66,000 bytes: past the limit though shorter than it in characters.
    expect(writeDraft('a', '字'.repeat(22_000), () => storage)).toBe(false)
    expect(readDraft('a', () => storage)).toBe('')
    expect(writeDraft('a', 'x'.repeat(DRAFT_LIMIT_BYTES), () => storage)).toBe(true)
  })
  it('works without storage: nothing saved, nothing thrown', () => {
    const broken = () => { throw new Error('SecurityError') }
    expect(readDraft('a', broken)).toBe('')
    expect(writeDraft('a', 'text', broken)).toBe(false)
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: () => {} } as unknown as Storage
    expect(writeDraft('a', 'text', () => full)).toBe(false)
  })
})
