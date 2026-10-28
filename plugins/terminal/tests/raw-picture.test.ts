import { describe, expect, it } from 'bun:test'
import { RawPicture, type PictureHeader, type PictureTarget } from '../components/raw-picture'

const encode = (text: string) => new TextEncoder().encode(text)
const header = (type: 'join' | 'rebase', epoch: number, text: string, extra: Record<string, unknown> = {}): PictureHeader =>
  ({ type, epoch, bytes: encode(text).length, checkpoint: { cols: 80, rows: 24, joinState: 0, penHasExtended: false, altEnteredCols: null }, ...extra })

/** Terminals that log what is done to them; writes call back when `flush` says so. */
function harness() {
  const log: string[] = []
  const pending: Array<() => void> = []
  const retired: number[] = []
  const applied: number[] = []
  const states: string[] = []
  let made = 0
  const picture = new RawPicture({
    create: (h) => {
      const id = ++made
      log.push(`create ${id} ${h.type} ${h.epoch}`)
      const target: PictureTarget = {
        write: (data, done) => { log.push(`write ${id} ${new TextDecoder().decode(data)}`); pending.push(() => { log.push(`written ${id}`); done() }) },
        resize: (cols, rows) => log.push(`resize ${id} ${cols}x${rows}`),
        finish: () => log.push(`finish ${id}`),
        live: () => log.push(`live ${id}`),
        discard: () => log.push(`discard ${id}`),
      }
      return target
    },
    retired: (total) => retired.push(total),
    applied: (epoch) => applied.push(epoch),
    display: (state) => states.push(state),
  })
  const send = (message: Record<string, unknown> & { type: string }) => picture.message(message, JSON.stringify(message))
  /** Call back the writes submitted so far (not ones they cause). */
  const flush = () => { for (const done of pending.splice(0)) done() }
  return { picture, log, retired, applied, states, send, flush, pending }
}

describe('RawPicture', () => {
  it('writes the text, then the side state, the tail and the barrier, each after the writes before it', () => {
    const h = harness()
    h.send(header('join', 1, 'ABCDEF') as never)
    h.picture.binary(encode('ABC'))
    h.picture.binary(encode('DEF'))
    h.picture.binary(encode('tail'))
    h.send({ type: 'layout', seq: 3, cols: 90, rows: 24 })
    h.picture.binary(encode('after'))
    h.send({ type: 'barrier', epoch: 1, throughSeq: 4 })
    // The side state waits for the text's writes; nothing after it is written before it ran.
    expect(h.log).toEqual(['create 1 join 1', 'write 1 ABC', 'write 1 DEF'])
    h.flush()
    expect(h.log.slice(3)).toEqual(['written 1', 'written 1', 'finish 1', 'write 1 tail'])
    h.flush()
    expect(h.log.slice(7)).toEqual(['written 1', 'resize 1 90x24', 'write 1 after'])
    expect(h.picture.ready).toBe(false)
    h.flush()
    expect(h.log.slice(10)).toEqual(['written 1', 'live 1'])
    expect(h.applied).toEqual([1])
    expect(h.picture.ready).toBe(true)
    expect(h.states).toEqual(['replaying', 'live'])
  })
  it('a checkpoint split inside a character is written as it comes (xterm carries the split)', () => {
    const h = harness()
    const bytes = encode('é👍')
    h.send(header('join', 1, 'é👍') as never)
    h.picture.binary(bytes.subarray(0, 1))
    h.picture.binary(bytes.subarray(1, 4))
    h.picture.binary(bytes.subarray(4))
    h.flush()
    expect(h.log.filter((line) => line.startsWith('finish'))).toEqual(['finish 1'])
  })
  it('retires every frame exactly once: applied, or discarded by a newer picture (written ones included)', () => {
    const h = harness()
    const join = header('join', 1, 'xxxx')
    h.send(join as never)
    h.picture.binary(encode('xx'))
    h.picture.binary(encode('xx'))
    // A rebase arrives before the old writes called back: their bytes are retired now, once.
    const rebase = header('rebase', 2, 'y')
    h.send(rebase as never)
    expect(h.log).toContain('discard 1')
    const afterRebase = h.retired.at(-1)!
    expect(afterRebase).toBe(JSON.stringify(join).length + 4 + JSON.stringify(rebase).length)
    // The old writes' late callbacks count nothing more.
    h.flush()
    expect(h.retired.at(-1)).toBe(afterRebase)
    h.picture.binary(encode('y'))
    h.flush()
    expect(h.retired.at(-1)).toBe(afterRebase + 1)
  })
  it('counts JSON frames by their UTF-8 bytes', () => {
    const h = harness()
    const join = header('join', 1, '', { session: { title: 'é'.repeat(10) } })
    h.send(join as never)
    expect(h.retired.at(-1)).toBe(new TextEncoder().encode(JSON.stringify(join)).length)
  })
  it('keeps input through a rebase, and a rebase before the first barrier stays gated until its own', () => {
    const h = harness()
    h.send(header('join', 1, '') as never)
    // Replaced before its barrier was applied.
    h.send(header('rebase', 2, '') as never)
    h.send({ type: 'barrier', epoch: 2, throughSeq: 1 })
    expect(h.picture.ready).toBe(true)
    expect(h.applied).toEqual([2])
    h.send({ type: 'rebuilding', cause: 'overload', fidelity: { rebuilds: { overload: 1 } } })
    expect(h.picture.display).toBe('rebuilding')
    h.send(header('rebase', 3, '') as never)
    expect(h.picture.ready).toBe(true)
  })
  it('a rebuilding notice waits for a barrier before it: the display ends stale, input still latches', () => {
    const h = harness()
    h.send(header('join', 1, 'abc') as never)
    h.picture.binary(encode('abc'))
    h.send({ type: 'barrier', epoch: 1, throughSeq: 1 })
    h.send({ type: 'rebuilding', cause: 'overload', fidelity: { rebuilds: { overload: 1 } } })
    h.flush()
    expect(h.states).toEqual(['replaying', 'live', 'rebuilding'])
    expect(h.picture.ready).toBe(true)
    expect(h.applied).toEqual([1])
  })
  it('a rebuilding notice before any picture is counted and shown', () => {
    const h = harness()
    const notice = { type: 'rebuilding', cause: 'overload', fidelity: { rebuilds: { overload: 1 } } }
    h.send(notice)
    expect(h.retired).toEqual([JSON.stringify(notice).length])
    expect(h.states).toEqual(['rebuilding'])
  })
  it('binary frames with no picture yet are retired, not written', () => {
    const h = harness()
    h.picture.binary(encode('stray'))
    expect(h.retired).toEqual([5])
    expect(h.log).toEqual([])
  })
})
