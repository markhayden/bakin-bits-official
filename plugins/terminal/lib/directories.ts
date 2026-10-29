/**
 * The New terminal folder picker's listing (a human-only route): one
 * folder's subfolders on this machine, never file names or contents. A
 * browser's own picker can only name files on the device it runs on, so the
 * Mac's folders are listed here.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { TerminalError, type Session } from './contracts'

/** At most this many folders in one listing (`truncated` says when more were left out). */
export const DIRECTORY_LIMIT = 500

export interface DirectoryListing {
  /** The resolved folder (links followed). */
  path: string
  /** Its parent, unless it is the root. */
  parent?: string
  entries: Array<{ name: string; path: string }>
  truncated?: true
}

const isFolder = (path: string): boolean => { try { return statSync(path).isDirectory() } catch { return false } }

export function listDirectories(raw: string | undefined, options: { hidden?: boolean; home?: string } = {}): DirectoryListing {
  const requested = raw?.trim() || (options.home ?? homedir())
  if (!isAbsolute(requested)) throw new TerminalError('The folder must be absolute (start with /).', 400)
  let path: string
  try {
    path = realpathSync(requested)
  } catch (error) {
    // Only a missing path is "does not exist"; anything else (permissions) is unreadable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new TerminalError(`${requested} does not exist.`, 404)
    throw new TerminalError(`${requested} cannot be read.`, 403)
  }
  if (!isFolder(path)) throw new TerminalError(`${requested} is not a folder.`, 400)
  let names: string[]
  try { names = readdirSync(path) } catch { throw new TerminalError(`${requested} cannot be read.`, 403) }
  const folders = names
    .filter((name) => options.hidden || !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .filter((name) => isFolder(join(path, name)))
  const parent = dirname(path)
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    entries: folders.slice(0, DIRECTORY_LIMIT).map((name) => ({ name, path: join(path, name) })),
    ...(folders.length > DIRECTORY_LIMIT ? { truncated: true as const } : {}),
  }
}

/** The newest sessions' folders (once each, still existing, never a worktree): the picker's quick choices. */
export function recentDirectories(sessions: Session[], limit = 5): string[] {
  const seen: string[] = []
  for (const session of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    if (session.worktreePath || seen.includes(session.cwd) || !isFolder(session.cwd)) continue
    seen.push(session.cwd)
    if (seen.length === limit) break
  }
  return seen
}
