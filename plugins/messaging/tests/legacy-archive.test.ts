import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StorageAdapter } from '@makinbakin/sdk/types'
import { MarkdownStorageAdapter } from '../test-helpers'
import { archiveLegacyMessagingFile } from '../lib/legacy-archive'

function withStorage(test: (storage: MarkdownStorageAdapter) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bakin-messaging-legacy-'))
  try {
    test(new MarkdownStorageAdapter(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('archiveLegacyMessagingFile', () => {
  it('returns archived=false when no legacy file exists', () => {
    withStorage((storage) => {
      expect(archiveLegacyMessagingFile(storage, '2026-05-01T00:00:00Z')).toEqual({
        archived: false,
        from: 'messaging.json',
      })
    })
  })

  it('renames top-level messaging.json into the legacy archive directory', () => {
    withStorage((storage) => {
      storage.writeJson('messaging.json', [{ id: 'legacy-1' }])

      const result = archiveLegacyMessagingFile(storage, '2026-05-01T00:00:00Z')

      expect(result).toEqual({
        archived: true,
        from: 'messaging.json',
        to: 'messaging/legacy/messaging-2026-05-01T00-00-00Z.json',
      })
      expect(storage.exists('messaging.json')).toBe(false)
      expect(storage.readJson(result.to!)).toEqual([{ id: 'legacy-1' }])
    })
  })

  it('is idempotent after the first archive', () => {
    withStorage((storage) => {
      storage.writeJson('messaging.json', [{ id: 'legacy-1' }])
      expect(archiveLegacyMessagingFile(storage, '2026-05-01T00:00:00Z').archived).toBe(true)
      expect(archiveLegacyMessagingFile(storage, '2026-05-01T00:00:00Z').archived).toBe(false)
      expect(storage.list('messaging/legacy')).toEqual(['messaging-2026-05-01T00-00-00Z.json'])
    })
  })

  it('falls back to copy-remove when rename is unavailable', () => {
    const files: Record<string, string> = {
      'messaging.json': JSON.stringify([{ id: 'legacy-1' }]),
    }
    const storage = {
      read: (path: string) => files[path] ?? null,
      write: (path: string, content: string) => { files[path] = content },
      exists: (path: string) => files[path] !== undefined,
      remove: (path: string) => { delete files[path] },
    } as StorageAdapter

    const result = archiveLegacyMessagingFile(storage, '2026-05-01T00:00:00Z')

    expect(result.archived).toBe(true)
    expect(files['messaging.json']).toBeUndefined()
    expect(JSON.parse(files[result.to!]!)).toEqual([{ id: 'legacy-1' }])
  })
})
