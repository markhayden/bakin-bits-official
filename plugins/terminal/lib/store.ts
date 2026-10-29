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
      CREATE TABLE IF NOT EXISTS bundles (session TEXT PRIMARY KEY, generation INTEGER NOT NULL, header TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at INTEGER NOT NULL, parts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bundle_parts (session TEXT NOT NULL, generation INTEGER NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, meta TEXT, data BLOB, PRIMARY KEY (session, generation, idx));
      CREATE TABLE IF NOT EXISTS bundle_generations (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS session_marks (session TEXT PRIMARY KEY, revision INTEGER NOT NULL);`)
    // The generation counter starts above every generation already stored (rows written before it existed).
    const highest = (this.db.query('SELECT MAX(g) AS g FROM (SELECT MAX(generation) AS g FROM bundles UNION ALL SELECT MAX(generation) FROM bundle_parts UNION ALL SELECT MAX(id) FROM bundle_generations)').get() as { g: number | null }).g
    if (highest) this.db.query('INSERT OR IGNORE INTO bundle_generations(id) VALUES (?)').run(highest)
    this.db.transaction(() => {
      // A version that knows no bundles (a rollback to B5) deletes sessions and histories without
      // them: a bundle whose session is gone, or whose history was deleted, goes on the next open.
      this.db.exec(`DELETE FROM bundles WHERE session NOT IN (SELECT id FROM sessions)
        OR session IN (SELECT id FROM sessions WHERE json_extract(value, '$.historyDeleted') = 1)`)
      // Parts no committed bundle names: a write interrupted before its commit, or a replaced one.
      this.db.exec('DELETE FROM bundle_parts WHERE NOT EXISTS (SELECT 1 FROM bundles WHERE bundles.session = bundle_parts.session AND bundles.generation = bundle_parts.generation)')
      // A session another version wrote since this one last did (its revision moved without this
      // version's mark: a rollback that continued, ended or completed it) has its final output from that
      // version — the legacy output — so its bundle and output flags are dropped. Every session is then
      // marked at its revision now.
      const touched = `SELECT id FROM sessions LEFT JOIN session_marks ON session_marks.session = sessions.id
        WHERE session_marks.revision IS NULL OR session_marks.revision <> COALESCE(json_extract(value, '$.revision'), 0)`
      this.db.exec(`DELETE FROM bundle_parts WHERE session IN (${touched})`)
      this.db.exec(`DELETE FROM bundles WHERE session IN (${touched})`)
      this.db.exec(`UPDATE sessions SET value = json_remove(value, '$.outputSaved', '$.outputEvicted') WHERE id IN (${touched})`)
      this.db.exec('DELETE FROM session_marks')
      this.db.exec(`INSERT INTO session_marks SELECT id, COALESCE(json_extract(value, '$.revision'), 0) FROM sessions`)
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
  /**
   * Write a session record. The final-output fields belong to the store once
   * the row exists (set with its bundle, `markOutput`): a record read before
   * a commit never writes them back.
   */
  save(session: Session): void {
    const previous = this.db.query('SELECT value FROM sessions WHERE id=?').get(session.id) as { value: string } | null
    const stored = previous ? JSON.parse(previous.value) as Session : undefined
    session.revision = (stored?.revision ?? 0) + 1
    if (stored) {
      if (stored.outputSaved === undefined) delete session.outputSaved; else session.outputSaved = stored.outputSaved
      if (stored.outputEvicted === undefined) delete session.outputEvicted; else session.outputEvicted = stored.outputEvicted
    }
    this.db.transaction(() => {
      this.db.query('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(session.id, JSON.stringify(session))
      this.mark(session.id)
    })()
  }
  /** This version wrote the session at its current revision (see the open-time rule). */
  private mark(session: string): void {
    this.db.query(`INSERT OR REPLACE INTO session_marks SELECT id, COALESCE(json_extract(value, '$.revision'), 0) FROM sessions WHERE id=?`).run(session)
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
  saveBundle(session: string, bundle: Bundle): Promise<{ saved: boolean; evicted: string[] }> {
    // One writer per session at a time (a second waits): staged parts are never another write's.
    const previous = this.writing.get(session) ?? Promise.resolve()
    const next = previous.then(() => this.writeBundle(session, bundle), () => this.writeBundle(session, bundle))
    const settled = next.then(() => undefined, () => undefined)
    this.writing.set(session, settled)
    void settled.then(() => { if (this.writing.get(session) === settled) this.writing.delete(session) })
    return next
  }
  private writing = new Map<string, Promise<void>>()
  private async writeBundle(session: string, bundle: Bundle): Promise<{ saved: boolean; evicted: string[] }> {
    // A generation never used before, by any write (AUTOINCREMENT never reuses one, even after deletions):
    // a reader that sees the same generation sees the same bundle.
    const generation = Number(this.db.query('INSERT INTO bundle_generations DEFAULT VALUES').run().lastInsertRowid)
    this.db.query('DELETE FROM bundle_generations WHERE id<?').run(generation)
    const insert = this.db.query('INSERT INTO bundle_parts VALUES (?, ?, ?, ?, ?, ?)')
    const header = bundleHeader(bundle)
    // What SQLite holds: UTF-8 text and the bytes themselves (meta included).
    let bytes = Buffer.byteLength(header)
    let idx = 0
    let started = performance.now()
    try {
      for (const part of bundleParts(bundle)) {
        if (part.kind === 'piece') { insert.run(session, generation, idx++, 'piece', null, part.text); bytes += Buffer.byteLength(part.text) }
        else {
          const meta = JSON.stringify(part.event)
          insert.run(session, generation, idx++, 'event', meta, part.bytes ?? null)
          bytes += Buffer.byteLength(meta) + (part.bytes?.length ?? 0)
        }
        if (performance.now() - started >= SLICE_MS) { await nextTurn(); started = performance.now() }
      }
    } catch (error) {
      this.dropGeneration(session, generation)
      throw error
    }
    if (bytes > this.bundleLimit) { this.dropGeneration(session, generation); this.markOutput(session, false); return { saved: false, evicted: [] } }
    const evicted: string[] = []
    let kept = true
    // The bundle, its session's flag, and every eviction with its session's flags: one commit.
    this.db.transaction(() => {
      // The session was deleted, or its history, while the parts were written: nothing to keep.
      const owner = this.session(session)
      if (!owner || owner.historyDeleted) { kept = false; this.dropGeneration(session, generation); return }
      this.db.query('DELETE FROM bundle_parts WHERE session=? AND generation<>?').run(session, generation)
      this.db.query('INSERT OR REPLACE INTO bundles VALUES (?, ?, ?, ?, ?, ?)').run(session, generation, header, bytes, bundle.savedAt, idx)
      this.setOutputFlags(session, true, false)
      let total = (this.db.query('SELECT COALESCE(SUM(bytes),0) AS size FROM bundles').get() as { size: number }).size
      while (total > this.bundleLimit) {
        const oldest = this.db.query('SELECT session, bytes FROM bundles WHERE session<>? ORDER BY saved_at LIMIT 1').get(session) as { session: string; bytes: number } | null
        if (!oldest) break
        this.deleteBundleUnlocked(oldest.session)
        this.setOutputFlags(oldest.session, false, true)
        evicted.push(oldest.session)
        total -= oldest.bytes
      }
    })()
    return { saved: kept, evicted }
  }
  /** Record that a session's final output was not saved (or, `true`, is: with its bundle only). */
  markOutput(session: string, saved: false): void {
    this.setOutputFlags(session, saved, false)
  }
  /** The flags, with the record's revision moved (viewers drop a record no newer than one they have). */
  private setOutputFlags(session: string, saved: boolean, evicted: boolean): void {
    this.db.query(`UPDATE sessions SET value = json_set(json_remove(value, '$.outputEvicted'), '$.outputSaved', json(?), '$.revision', COALESCE(json_extract(value, '$.revision'), 0) + 1${evicted ? `, '$.outputEvicted', json('true')` : ''}) WHERE id=?`).run(String(saved), session)
    this.mark(session)
  }
  hasBundle(session: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM bundles WHERE session=?').get(session))
  }
  /** A running session's bundle was provisional (saved, then a crash before the kill): it goes, and the output is saved again at the end. */
  discardProvisionalBundle(session: string): void {
    this.db.transaction(() => {
      this.deleteBundleUnlocked(session)
      this.setOutputFlags(session, false, false)
    })()
  }
  /** The saved bundle, read across turns; undefined when there is none or it cannot be read as this version's. */
  async bundle(session: string): Promise<Bundle | undefined> {
    // A replacement, eviction or deletion between read slices makes the read incomplete: read again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.db.query('SELECT generation, header, parts FROM bundles WHERE session=?').get(session) as { generation: number; header: string; parts: number } | null
      if (!row) return undefined
      const parts = await this.readParts(session, row.generation)
      const still = this.db.query('SELECT generation FROM bundles WHERE session=?').get(session) as { generation: number } | null
      if (parts && parts.length === row.parts && still?.generation === row.generation) return assembleBundle(row.header, parts)
    }
    return undefined
  }
  private async readParts(session: string, generation: number): Promise<BundlePart[] | undefined> {
    const select = this.db.query('SELECT kind, meta, data FROM bundle_parts WHERE session=? AND generation=? AND idx>=? ORDER BY idx LIMIT 256')
    const parts: BundlePart[] = []
    try {
      for (;;) {
        const rows = select.all(session, generation, parts.length) as { kind: string; meta: string | null; data: string | Uint8Array | null }[]
        for (const part of rows) {
          parts.push(part.kind === 'piece'
            ? { kind: 'piece', text: String(part.data) }
            : { kind: 'event', event: JSON.parse(part.meta!), ...(part.data ? { bytes: new Uint8Array(part.data as Uint8Array) } : {}) })
        }
        if (rows.length < 256) return parts
        await nextTurn()
      }
    } catch {
      // A malformed part reads as no bundle (the session shows its output as unavailable).
      return undefined
    }
  }
  session(id: string): Session | undefined {
    const row = this.db.query('SELECT value FROM sessions WHERE id=?').get(id) as { value: string } | null
    return row ? { sizeEpoch: 0, sizeRevision: 0, ...JSON.parse(row.value) } : undefined
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
      this.db.query('DELETE FROM session_marks WHERE session=?').run(session)
      this.db.query('DELETE FROM sessions WHERE id=?').run(session)
    })()
  }
  close(): void { this.db.close() }
}
