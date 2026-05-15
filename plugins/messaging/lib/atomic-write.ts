import type { StorageAdapter } from '@makinbakin/sdk/types'
import { generateId } from './ids'

function tmpPathFor(path: string): string {
  return `${path}.tmp-${Date.now()}-${generateId()}`
}

export function atomicWriteJson(storage: StorageAdapter, path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2)

  if (!storage.rename) {
    storage.write(path, content)
    return
  }

  const tmpPath = tmpPathFor(path)
  storage.write(tmpPath, content)
  try {
    storage.rename(tmpPath, path)
  } catch (err) {
    storage.remove?.(tmpPath)
    throw err
  }
}
