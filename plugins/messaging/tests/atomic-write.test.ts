import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StorageAdapter } from '@bakin/sdk/types'
import { MarkdownStorageAdapter } from '../test-helpers'
import { atomicWriteJson } from '../lib/atomic-write'

function withTempStorage(test: (storage: MarkdownStorageAdapter) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-atomic-'))
  try {
    test(new MarkdownStorageAdapter(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('atomicWriteJson', () => {
  it('writes JSON via temp file then rename', () => {
    withTempStorage((storage) => {
      atomicWriteJson(storage, 'messaging/plans/plan-1.json', { id: 'plan-1', title: 'Taco Tuesday' })

      expect(storage.readJson('messaging/plans/plan-1.json')).toEqual({ id: 'plan-1', title: 'Taco Tuesday' })
      expect(storage.list('messaging/plans').some(file => file.includes('.tmp-'))).toBe(false)
    })
  })

  it('leaves no temp artifacts after repeated writes to the same path', () => {
    withTempStorage((storage) => {
      atomicWriteJson(storage, 'messaging/deliverables/deliv-1.json', { id: 'deliv-1', revision: 1 })
      atomicWriteJson(storage, 'messaging/deliverables/deliv-1.json', { id: 'deliv-1', revision: 2 })

      expect(storage.readJson('messaging/deliverables/deliv-1.json')).toEqual({ id: 'deliv-1', revision: 2 })
      expect(storage.list('messaging/deliverables').filter(file => file.includes('.tmp-'))).toEqual([])
    })
  })

  it('falls back to direct write when rename is unavailable', () => {
    const writes: Record<string, string> = {}
    const storage = {
      write(path: string, content: string) {
        writes[path] = content
      },
    } as StorageAdapter

    atomicWriteJson(storage, 'messaging/plans/plan-1.json', { ok: true })

    expect(JSON.parse(writes['messaging/plans/plan-1.json'])).toEqual({ ok: true })
    expect(Object.keys(writes).some(path => path.includes('.tmp-'))).toBe(false)
  })
})
