import { describe, expect, it } from 'bun:test'
import { OutputLog } from '../lib/output-log'
import { compareCursor, cursorCategory } from '../lib/processes'
import { Replica } from '../lib/replica'

const encode = (text: string) => new TextEncoder().encode(text)

async function attached(text = 'hello') {
  const replica = new Replica({ reseed: (_reason, turn) => turn(async () => undefined), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
  const log = new OutputLog()
  log.attach(replica)
  log.seed(encode(`\x1bc${text}`), 40, 10, 'attach')
  for (let tries = 0; tries < 200 && !replica.cut(); tries++) await Bun.sleep(1)
  return { replica, log }
}

describe('the replica against tmux (plan T37)', () => {
  it('at the reply\'s position: the views agree, or the category says how they differ', async () => {
    const { replica, log } = await attached()
    const reply = (text: string) => async () => ({ reply: text, target: log.lastSeq })
    const agree = await compareCursor(replica, reply('5 0 40 10 0 1'))
    expect(agree).toEqual({ tmux: { x: 5, y: 0, cols: 40, rows: 10, alternate: false, wrap: true }, replica: { x: 5, y: 0, cols: 40, rows: 10, alternate: false, wrap: true } })
    expect(cursorCategory(agree!.tmux, agree!.replica)).toBeUndefined()
    for (const [text, category] of [['6 0 40 10 0 1', 'cursor column'], ['5 1 40 10 0 1', 'cursor row'], ['5 0 41 10 0 1', 'size'], ['5 0 40 10 1 1', 'screen']] as const) {
      const views = (await compareCursor(replica, reply(text)))!
      expect(cursorCategory(views.tmux, views.replica)).toBe(category)
    }
    replica.close()
  })
  it('a width change still owed: that position is not compared (tmux has reflowed, the replica not yet)', async () => {
    const { replica, log } = await attached()
    log.layout(30, 10)
    for (let tries = 0; tries < 200 && !replica.geometryOwed; tries++) await Bun.sleep(1)
    expect(await compareCursor(replica, async () => ({ reply: '9 0 30 10 0 1', target: log.lastSeq }))).toBeUndefined()
    replica.close()
  })
  it('output after the reply in the same chunk is after its position: the replica moving past it is not compared', async () => {
    const { replica, log } = await attached()
    // As the control client parses it: the reply's position first, then the rest of the chunk.
    const query = async () => {
      const target = log.lastSeq
      log.output(encode('X'))
      log.flush()
      return { reply: '5 0 40 10 0 1', target }
    }
    expect(await compareCursor(replica, query)).toBeUndefined()
    replica.close()
  })
  it('autowrap off past the last column: xterm holds the cursor at cols, tmux at the last column — the same place', () => {
    const at = (x: number, wrap: boolean) => ({ x, y: 0, cols: 40, rows: 10, alternate: false, wrap })
    expect(cursorCategory(at(39, false), at(40, false))).toBeUndefined()
    // With autowrap on, both say cols for a pending wrap; a real difference is still one.
    expect(cursorCategory(at(40, true), at(40, true))).toBeUndefined()
    expect(cursorCategory(at(39, true), at(40, true))).toBe('cursor column')
  })
})
