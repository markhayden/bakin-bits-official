import { Database } from 'bun:sqlite'
import { assembleBundle, bundleHeader, bundleParts, type Bundle, type BundlePart } from './bundle'
import type { Session } from './contracts'

/** Sliced store work holds the event loop at most about this long between yields. */
const SLICE_MS = 4
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export class Store {
  private db: Database
  /** `bundleLimit`: the bytes every saved bundle may hold together (whole bundles go, oldest first). */
  constructor(path: string, private bundleLimit = 250 * 1024 * 1024) {
    this.db = new Database(path, { create: true })
    // The bridge viewer's retained output and the rollback marks (plan T38b) are dropped where they remain.
    this.db.exec(`PRAGMA journal_mode=WAL;
      DROP TABLE IF EXISTS output;
      DROP TABLE IF EXISTS cursors;
      DROP TABLE IF EXISTS sizes;
      DROP TABLE IF EXISTS session_marks;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles (session TEXT PRIMARY KEY, generation INTEGER NOT NULL, header TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at INTEGER NOT NULL, parts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bundle_parts (session TEXT NOT NULL, generation INTEGER NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, meta TEXT, data BLOB, PRIMARY KEY (session, generation, idx));
      CREATE TABLE IF NOT EXISTS bundle_generations (id INTEGER PRIMARY KEY AUTOINCREMENT);`)
    // The generation counter starts above every generation already stored (rows written before it existed).
    const highest = (this.db.query('SELECT MAX(g) AS g FROM (SELECT MAX(generation) AS g FROM bundles UNION ALL SELECT MAX(generation) FROM bundle_parts UNION ALL SELECT MAX(id) FROM bundle_generations)').get() as { g: number | null }).g
    if (highest) this.db.query('INSERT OR IGNORE INTO bundle_generations(id) VALUES (?)').run(highest)
    // Parts no committed bundle names: a write interrupted before its commit, or a replaced one.
    this.db.exec('DELETE FROM bundle_parts WHERE NOT EXISTS (SELECT 1 FROM bundles WHERE bundles.session = bundle_parts.session AND bundles.generation = bundle_parts.generation)')
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
    this.db.query('INSERT OR REPLACE INTO sessions VALUES (?, ?)').run(session.id, JSON.stringify(session))
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
  /** Its saved final picture goes (its history was deleted). */
  deleteBundle(session: string): void {
    this.db.transaction(() => this.deleteBundleUnlocked(session))()
  }
  deleteSession(session: string): void {
    this.db.transaction(() => {
      this.deleteBundleUnlocked(session)
      this.db.query('DELETE FROM sessions WHERE id=?').run(session)
    })()
  }
  close(): void { this.db.close() }
}
