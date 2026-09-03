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
      CREATE INDEX IF NOT EXISTS output_session ON output(session, cursor);`)
  }
  sessions(): Session[] {
    return (this.db.query('SELECT value FROM sessions').all() as { value: string }[]).map((row) => JSON.parse(row.value))
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
      this.db.query('INSERT INTO output(session,cursor,data) VALUES (?,?,?)').run(session, cursor, data.slice(-this.sessionLimit))
      while (this.bytes(session) > this.sessionLimit) this.db.query('DELETE FROM output WHERE id=(SELECT MIN(id) FROM output WHERE session=?)').run(session)
      while (this.bytes() > this.globalLimit) this.db.exec('DELETE FROM output WHERE id=(SELECT MIN(id) FROM output)')
    })()
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
      ? this.db.query('SELECT COALESCE(SUM(length(data)),0) AS size FROM output WHERE session=?').get(session)
      : this.db.query('SELECT COALESCE(SUM(length(data)),0) AS size FROM output').get()) as { size: number }
    return row.size
  }
  deleteOutput(session: string): void { this.db.query('DELETE FROM output WHERE session=?').run(session) }
  close(): void { this.db.close() }
}
