import { Database } from 'bun:sqlite'
import { assembleBundle, bundleHeader, bundleParts, type Bundle, type BundlePart } from './bundle'
import type { Session } from './contracts'

/** Sliced store work holds the event loop at most about this long between yields. */
const SLICE_MS = 4
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export class Store {
  private db: Database
  /** `bundleLimit`: the bytes every saved bundle may hold together (whole bundles go, oldest first). */
  constructor(path: string, private sessionLimit = 10 * 1024 * 1024, private globalLimit = 250 * 1024 * 1024, private bundleLimit = 250 * 1024 * 1024) {
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (session TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS output (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, cursor INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS output_session ON output(session, cursor);
      CREATE TABLE IF NOT EXISTS sizes (session TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles (session TEXT PRIMARY KEY, generation INTEGER NOT NULL, header TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bundle_parts (session TEXT NOT NULL, generation INTEGER NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, meta TEXT, data BLOB, PRIMARY KEY (session, generation, idx));`)
    this.db.transaction(() => {
      // A version that knows no bundles (a rollback to B5) deletes sessions and histories without
      // them: a bundle whose session is gone, or whose history was deleted, goes on the next open.
      this.db.exec(`DELETE FROM bundles WHERE session NOT IN (SELECT id FROM sessions)
        OR session IN (SELECT id FROM sessions WHERE json_extract(value, '$.historyDeleted') = 1)`)
      // Parts no committed bundle names: a write interrupted before its commit, or a replaced one.
      this.db.exec('DELETE FROM bundle_parts WHERE NOT EXISTS (SELECT 1 FROM bundles WHERE bundles.session = bundle_parts.session AND bundles.generation = bundle_parts.generation)')
      // A crash between a bundle's commit and its session's record: the committed bundle is the truth.
      this.db.exec(`UPDATE sessions SET value = json_set(value, '$.outputSaved', json('true'))
        WHERE id IN (SELECT session FROM bundles) AND json_extract(value, '$.outputSaved') = 0`)
    })()
    // Retained bytes are kept as running totals (summing the output on every
    // append made a busy session at its limit scan everything it retained);
    // they are rebuilt from the output once per open.
    this.db.transaction(() => {
      this.db.exec('DELETE FROM sizes')
      this.db.exec('INSERT INTO sizes SELECT session, SUM(length(data)) FROM output GROUP BY session')
    })()
  }
  sessions(): Session[] {
    // Rows written before explicit sizing carry no epoch or revision yet.
    return (this.db.query('SELECT value FROM sessions').all() as { value: string }[]).map((row) => ({ sizeEpoch: 0, sizeRevision: 0, ...JSON.parse(row.value) }))
  }
  save(session: Session): void {
    const previous = this.db.query('SELECT value FROM sessions WHERE id=?').get(session.id) as { value: string } | null
    session.revision = (previous ? JSON.parse(previous.value).revision ?? 0 : 0) + 1
    this.db.query('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(session.id, JSON.stringify(session))
  }
  append(session: string, data: Uint8Array): void {
    this.db.transaction(() => {
      this.db.query('INSERT INTO cursors VALUES (?, 1) ON CONFLICT(session) DO UPDATE SET value=value+1').run(session)
      const cursor = (this.db.query('SELECT value FROM cursors WHERE session=?').get(session) as { value: number }).value
      const kept = data.slice(-this.sessionLimit)
      this.db.query('INSERT INTO output(session,cursor,data) VALUES (?,?,?)').run(session, cursor, kept)
      this.db.query('INSERT INTO sizes VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET bytes=bytes+excluded.bytes').run(session, kept.length)
      this.trim(this.bytes(session) - this.sessionLimit, session)
      this.trim(this.bytes() - this.globalLimit)
    })()
  }
  /** Delete the oldest output rows (of `session`, or of any session) until at least `excess` bytes are gone. */
  private trim(excess: number, session?: string): void {
    while (excess > 0) {
      const rows = (session
        ? this.db.query('SELECT id, session, length(data) AS size FROM output WHERE session=? ORDER BY cursor LIMIT 256').all(session)
        : this.db.query('SELECT id, session, length(data) AS size FROM output ORDER BY id LIMIT 256').all()) as { id: number; session: string; size: number }[]
      if (!rows.length) return
      const freed = new Map<string, number>()
      const gone: number[] = []
      for (const row of rows) {
        if (excess <= 0) break
        gone.push(row.id)
        freed.set(row.session, (freed.get(row.session) ?? 0) + row.size)
        excess -= row.size
      }
      this.db.query(`DELETE FROM output WHERE id IN (${gone.map(() => '?').join(',')})`).run(...gone)
      for (const [owner, size] of freed) this.db.query('UPDATE sizes SET bytes=bytes-? WHERE session=?').run(size, owner)
    }
  }
  output(session: string, cursor = 0, limit = 256 * 1024): { cursor: number; data: Buffer; truncated: boolean } {
    const rows = this.db.query('SELECT cursor, data FROM output WHERE session=? AND cursor>? ORDER BY cursor LIMIT 256').all(session, cursor) as { cursor: number; data: Uint8Array }[]
    const selected: typeof rows = []
    let size = 0
    for (const row of rows) {
      if (selected.length && size + row.data.length > limit) break
      selected.push(row)
      size += row.data.length
    }
    const latest = (this.db.query('SELECT value FROM cursors WHERE session=?').get(session) as { value: number } | null)?.value ?? 0
    return {
      cursor: selected.at(-1)?.cursor ?? latest,
      data: Buffer.concat(selected.map((row) => Buffer.from(row.data))),
      truncated: selected.length ? selected[0].cursor > cursor + 1 : latest > cursor,
    }
  }
  bytes(session?: string): number {
    const row = (session
      ? this.db.query('SELECT COALESCE(SUM(bytes),0) AS size FROM sizes WHERE session=?').get(session)
      : this.db.query('SELECT COALESCE(SUM(bytes),0) AS size FROM sizes').get()) as { size: number }
    return row.size
  }
  /**
   * Save an ended session's final output (lib/bundle.ts): its parts written
   * across turns under a new generation, then committed in one transaction
   * that replaces any earlier bundle whole — a crash before the commit leaves
   * the earlier one (or none). Then whole bundles go, oldest first, until all
   * fit `bundleLimit`; one that cannot fit alone is not kept. Answers whether
   * it was kept, and the sessions whose bundles were removed for room.
   */
  async saveBundle(session: string, bundle: Bundle): Promise<{ saved: boolean; evicted: string[] }> {
    const generation = Date.now() * 1000 + Math.floor(Math.random() * 1000)
    const insert = this.db.query('INSERT INTO bundle_parts VALUES (?, ?, ?, ?, ?, ?)')
    const header = bundleHeader(bundle)
    let bytes = header.length
    let idx = 0
    let started = performance.now()
    try {
      for (const part of bundleParts(bundle)) {
        if (part.kind === 'piece') { insert.run(session, generation, idx++, 'piece', null, part.text); bytes += part.text.length * 2 }
        else { insert.run(session, generation, idx++, 'event', JSON.stringify(part.event), part.bytes ?? null); bytes += (part.bytes?.length ?? 0) + 64 }
        if (performance.now() - started >= SLICE_MS) { await nextTurn(); started = performance.now() }
      }
    } catch (error) {
      this.dropGeneration(session, generation)
      throw error
    }
    if (bytes > this.bundleLimit) { this.dropGeneration(session, generation); return { saved: false, evicted: [] } }
    const evicted: string[] = []
    this.db.transaction(() => {
      this.db.query('DELETE FROM bundle_parts WHERE session=? AND generation<>?').run(session, generation)
      this.db.query('INSERT OR REPLACE INTO bundles VALUES (?, ?, ?, ?, ?)').run(session, generation, header, bytes, bundle.savedAt)
      let total = (this.db.query('SELECT COALESCE(SUM(bytes),0) AS size FROM bundles').get() as { size: number }).size
      while (total > this.bundleLimit) {
        const oldest = this.db.query('SELECT session, bytes FROM bundles WHERE session<>? ORDER BY saved_at LIMIT 1').get(session) as { session: string; bytes: number } | null
        if (!oldest) break
        this.deleteBundleUnlocked(oldest.session)
        evicted.push(oldest.session)
        total -= oldest.bytes
      }
    })()
    return { saved: true, evicted }
  }
  /** The saved bundle, read across turns; undefined when there is none or it cannot be read as this version's. */
  async bundle(session: string): Promise<Bundle | undefined> {
    const row = this.db.query('SELECT generation, header FROM bundles WHERE session=?').get(session) as { generation: number; header: string } | null
    if (!row) return undefined
    const select = this.db.query('SELECT kind, meta, data FROM bundle_parts WHERE session=? AND generation=? AND idx>=? ORDER BY idx LIMIT 256')
    const parts: BundlePart[] = []
    for (;;) {
      const rows = select.all(session, row.generation, parts.length) as { kind: string; meta: string | null; data: string | Uint8Array | null }[]
      for (const part of rows) {
        parts.push(part.kind === 'piece'
          ? { kind: 'piece', text: String(part.data) }
          : { kind: 'event', event: JSON.parse(part.meta!), ...(part.data ? { bytes: new Uint8Array(part.data as Uint8Array) } : {}) })
      }
      if (rows.length < 256) break
      await nextTurn()
    }
    return assembleBundle(row.header, parts)
  }
  bundleBytes(): number {
    return (this.db.query('SELECT COALESCE(SUM(bytes),0) AS size FROM bundles').get() as { size: number }).size
  }
  private dropGeneration(session: string, generation: number): void {
    this.db.query('DELETE FROM bundle_parts WHERE session=? AND generation=?').run(session, generation)
  }
  private deleteBundleUnlocked(session: string): void {
    this.db.query('DELETE FROM bundle_parts WHERE session=?').run(session)
    this.db.query('DELETE FROM bundles WHERE session=?').run(session)
  }
  deleteOutput(session: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM output WHERE session=?').run(session)
      this.db.query('DELETE FROM sizes WHERE session=?').run(session)
      this.deleteBundleUnlocked(session)
    })()
  }
  deleteSession(session: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM output WHERE session=?').run(session)
      this.db.query('DELETE FROM sizes WHERE session=?').run(session)
      this.db.query('DELETE FROM cursors WHERE session=?').run(session)
      this.deleteBundleUnlocked(session)
      this.db.query('DELETE FROM sessions WHERE id=?').run(session)
    })()
  }
  close(): void { this.db.close() }
}
