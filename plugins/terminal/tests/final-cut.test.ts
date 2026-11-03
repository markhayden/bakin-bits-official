import { describe, expect, it } from 'bun:test'
import { OutputLog } from '../lib/output-log'
import { drainFinal } from '../lib/processes'
import { MAX_BACKLOG_BYTES, Replica } from '../lib/replica'

const encode = (text: string) => new TextEncoder().encode(text)

/** A replica fed by its log (as TmuxProcesses attaches them), seeded; `reseeds` hears every capture it asks for. */
async function attached() {
  const reseeds: string[] = []
  const replica = new Replica({ reseed: (reason, turn) => turn(async () => { reseeds.push(reason) }), geometry: (_generation, turn) => turn(async () => undefined), idleMs: 1e9 })
  const log = new OutputLog()
  log.attach(replica)
  log.seed(encode('\x1bc$ '), 80, 24, 'attach')
  for (let tries = 0; tries < 200 && !replica.cut(); tries++) await Bun.sleep(1)
  return { replica, log, reseeds }
}

describe('drainFinal (plan T35b)', () => {
  it('waits for the event the replica is still parsing: the cut reaches the log\'s newest event', async () => {
    const { replica, log } = await attached()
    log.output(encode('first\r\n'))
    log.flush()
    log.output(encode('last words\r\n'))
    // Not flushed yet: drainFinal flushes it, then waits for its seq.
    const cut = await drainFinal(replica, log, undefined, 1000)
    expect(cut?.throughSeq).toBe(log.lastSeq)
    expect(cut?.tail.map((event) => event.kind === 'output' ? new TextDecoder().decode(event.bytes) : event.kind).join('')).toContain('last words')
    replica.close()
  })
  it('a boundary goes first: output tmux sent before its reply is in the cut', async () => {
    const { replica, log } = await attached()
    // tmux delivers %output before the reply it precedes.
    const boundary = async () => { log.output(encode('before the reply\r\n')) }
    const cut = await drainFinal(replica, log, boundary, 1000)
    expect(cut?.tail.some((event) => event.kind === 'output' && new TextDecoder().decode(event.bytes).includes('before the reply'))).toBe(true)
    replica.close()
  })
  it('a rebuild meanwhile: its seed is the final picture when it lands in time, none when it does not', async () => {
    for (const lands of [true, false]) {
      const { replica, log, reseeds } = await attached()
      replica.pressure(MAX_BACKLOG_BYTES)
      expect(replica.cut()).toBeUndefined()
      const drained = drainFinal(replica, log, undefined, 300)
      if (lands) {
        for (let tries = 0; tries < 200 && reseeds.length === 0; tries++) await Bun.sleep(1)
        log.seed(encode('\x1bcafter the rebuild'), 80, 24, 'overload', false)
      }
      const cut = await drained
      if (lands) expect(cut?.throughSeq).toBe(log.lastSeq)
      else expect(cut).toBeUndefined()
      replica.close()
    }
  })
  it('bounded as a whole: a boundary that never answers gives none at the deadline', async () => {
    const { replica, log } = await attached()
    const started = performance.now()
    expect(await drainFinal(replica, log, () => new Promise(() => {}), 100)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(500)
    replica.close()
  })
  it('an ended replica gives none', async () => {
    const { replica, log } = await attached()
    replica.close()
    expect(await drainFinal(replica, log, undefined, 100)).toBeUndefined()
  })
})
