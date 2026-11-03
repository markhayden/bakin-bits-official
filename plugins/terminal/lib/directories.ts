/**
 * The New terminal folder picker's listing (a Terminal browser route): one
 * folder's subfolders on this machine, never file names or contents. A
 * browser's own picker can only name files on the device it runs on, so the
 * Mac's folders are listed here. It runs asynchronously and within a budget,
 * so a huge or slow folder never stalls the server's terminals.
 */
import { opendir, realpath, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { TerminalError, type Session } from './contracts'

/** At most this many folders in one listing (`truncated` says when more matched). */
export const DIRECTORY_LIMIT = 500
/** At most this many entries read from one folder (`truncated` too): the scan's bound. */
export const SCAN_LIMIT = 20_000
/** Links are resolved this many at a time (plain folders need no stat). */
const LINK_STATS = 16

export interface DirectoryListing {
  /** The resolved folder (links followed). */
  path: string
  /** Its parent, unless it is the root. */
  parent?: string
  entries: Array<{ name: string; path: string }>
  /** `limit`: more folders matched than DIRECTORY_LIMIT (a filter narrows them); `scan`: the folder is bigger than SCAN_LIMIT entries and was not read to its end. */
  truncated?: 'limit' | 'scan'
}

const isFolder = async (path: string): Promise<boolean> => { try { return (await stat(path)).isDirectory() } catch { return false } }

export async function listDirectories(raw: string | undefined, options: { hidden?: boolean; home?: string; filter?: string; scanLimit?: number } = {}): Promise<DirectoryListing> {
  const requested = raw?.trim() || (options.home ?? homedir())
  if (!isAbsolute(requested)) throw new TerminalError('The folder must be absolute (start with /).', 400)
  let path: string
  try {
    path = await realpath(requested)
  } catch (error) {
    // Only a missing path is "does not exist"; anything else (permissions) is unreadable.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TerminalError(`${requested} does not exist.`, 404)
    throw new TerminalError(`${requested} cannot be read.`, 403)
  }
  if (!await isFolder(path)) throw new TerminalError(`${requested} is not a folder.`, 400)
  const filter = options.filter?.trim().toLowerCase() ?? ''
  const folders: string[] = []
  const links: string[] = []
  let scanned = 0
  let cut = false
  try {
    const dir = await opendir(path)
    for await (const entry of dir) {
      if (++scanned > (options.scanLimit ?? SCAN_LIMIT)) { cut = true; break }
      if (!options.hidden && entry.name.startsWith('.')) continue
      if (filter && !entry.name.toLowerCase().includes(filter)) continue
      if (entry.isDirectory()) folders.push(entry.name)
      else if (entry.isSymbolicLink()) links.push(entry.name)
    }
  } catch {
    throw new TerminalError(`${requested} cannot be read.`, 403)
  }
  // Only links need a stat (to see whether they lead to a folder), a few at a time.
  for (let at = 0; at < links.length; at += LINK_STATS) {
    const batch = links.slice(at, at + LINK_STATS)
    const leads = await Promise.all(batch.map((name) => isFolder(join(path, name))))
    batch.forEach((name, index) => { if (leads[index]) folders.push(name) })
  }
  folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const parent = dirname(path)
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    entries: folders.slice(0, DIRECTORY_LIMIT).map((name) => ({ name, path: join(path, name) })),
    ...(cut ? { truncated: 'scan' as const } : folders.length > DIRECTORY_LIMIT ? { truncated: 'limit' as const } : {}),
  }
}

/** The newest sessions' folders (once each, still existing, never a worktree): the picker's quick choices. */
export function recentDirectories(sessions: Session[], limit = 5): string[] {
  const seen: string[] = []
  for (const session of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    if (session.worktreePath || seen.includes(session.cwd)) continue
    try { if (!statSync(session.cwd).isDirectory()) continue } catch { continue }
    seen.push(session.cwd)
    if (seen.length === limit) break
  }
  return seen
}
