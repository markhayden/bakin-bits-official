import { Database } from 'bun:sqlite'
import type { Session } from './contracts'

export class Store {
  private db: Database
  constructor(path: string, private sessionLimit = 10 * 1024 * 1024, private globalLimit = 250 * 1024 * 1024) {
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (session TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS output (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, cursor INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS output_session ON output(session, cursor);
      CREATE TABLE IF NOT EXISTS sizes (session TEXT PRIMARY KEY, bytes INTEGER NOT NULL);`)
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
  deleteOutput(session: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM output WHERE session=?').run(session)
      this.db.query('DELETE FROM sizes WHERE session=?').run(session)
    })()
  }
  deleteSession(session: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM output WHERE session=?').run(session)
      this.db.query('DELETE FROM sizes WHERE session=?').run(session)
      this.db.query('DELETE FROM cursors WHERE session=?').run(session)
      this.db.query('DELETE FROM sessions WHERE id=?').run(session)
    })()
  }
  close(): void { this.db.close() }
}
