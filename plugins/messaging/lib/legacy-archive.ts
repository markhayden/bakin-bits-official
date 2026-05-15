import type { StorageAdapter } from '@makinbakin/sdk/types'
import { generateId } from './ids'

export const LEGACY_MESSAGING_FILE = 'messaging.json'
export const LEGACY_ARCHIVE_DIR = 'messaging/legacy'

export interface LegacyArchiveResult {
  archived: boolean
  from: string
  to?: string
}

function archivePath(timestamp = new Date().toISOString()): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  return `${LEGACY_ARCHIVE_DIR}/messaging-${safeTimestamp}.json`
}

export function archiveLegacyMessagingFile(
  storage: StorageAdapter,
  timestamp?: string,
): LegacyArchiveResult {
  if (!storage.exists(LEGACY_MESSAGING_FILE)) {
    return { archived: false, from: LEGACY_MESSAGING_FILE }
  }

  let to = archivePath(timestamp)
  if (storage.exists(to)) {
    to = `${to.replace(/\.json$/, '')}-${generateId()}.json`
  }

  if (storage.rename) {
    storage.rename(LEGACY_MESSAGING_FILE, to)
  } else {
    const raw = storage.read(LEGACY_MESSAGING_FILE)
    storage.write(to, raw ?? '[]')
    storage.remove?.(LEGACY_MESSAGING_FILE)
  }

  return { archived: true, from: LEGACY_MESSAGING_FILE, to }
}
