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
    const agree = await compareCursor(replica, log, async () => '5 0 40 10 0')
    expect(agree).toEqual({ tmux: { x: 5, y: 0, cols: 40, rows: 10, alternate: false }, replica: { x: 5, y: 0, cols: 40, rows: 10, alternate: false } })
    expect(cursorCategory(agree!.tmux, agree!.replica)).toBeUndefined()
    for (const [reply, category] of [['6 0 40 10 0', 'cursor column'], ['5 1 40 10 0', 'cursor row'], ['5 0 41 10 0', 'size'], ['5 0 40 10 1', 'screen']] as const) {
      const views = (await compareCursor(replica, log, async () => reply))!
      expect(cursorCategory(views.tmux, views.replica)).toBe(category)
    }
    replica.close()
  })
  it('a width change still owed: that position is not compared (tmux has reflowed, the replica not yet)', async () => {
    const { replica, log } = await attached()
    log.layout(30, 10)
    for (let tries = 0; tries < 200 && !replica.geometryOwed; tries++) await Bun.sleep(1)
    expect(await compareCursor(replica, log, async () => '9 0 30 10 0')).toBeUndefined()
    replica.close()
  })
})
