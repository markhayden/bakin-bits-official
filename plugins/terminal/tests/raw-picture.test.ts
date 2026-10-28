import { describe, expect, it } from 'bun:test'
import { RawPicture, type PictureHeader, type PictureTarget } from '../components/raw-picture'

const encode = (text: string) => new TextEncoder().encode(text)
const header = (type: 'join' | 'rebase', epoch: number, text: string, extra: Record<string, unknown> = {}): PictureHeader =>
  ({ type, epoch, bytes: encode(text).length, checkpoint: { cols: 80, rows: 24, joinState: 0, penHasExtended: false, altEnteredCols: null, altEntry: null }, ...extra })

/** Terminals that log what is done to them; writes call back when `flush` says so. */
function harness() {
  const log: string[] = []
  const pending: Array<() => void> = []
  const retired: number[] = []
  const applied: number[] = []
  const states: string[] = []
  const failures: string[] = []
  let made = 0
  let sinks = 0
  /** What the next geometry's install answers. */
  const installs = { result: true }
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
        geometry: (cols, rows) => {
          const sink = ++sinks
          log.push(`geometry ${id}.${sink} ${cols}x${rows}`)
          return {
            write: (data, done) => { log.push(`scratch ${id}.${sink} ${new TextDecoder().decode(data)}`); pending.push(() => { log.push(`scratched ${id}.${sink}`); done() }) },
            install: () => { log.push(`install ${id}.${sink}`); return installs.result },
            discard: () => log.push(`drop ${id}.${sink}`),
          }
        },
      }
      return target
    },
    retired: (total) => retired.push(total),
    applied: (epoch) => applied.push(epoch),
    display: (state) => states.push(state),
    failed: (reason) => failures.push(reason),
  })
  const send = (message: Record<string, unknown> & { type: string }) => picture.message(message, JSON.stringify(message))
  /** Call back the writes submitted so far (not ones they cause). */
  const flush = () => { for (const done of pending.splice(0)) done() }
  return { picture, log, retired, applied, states, failures, installs, send, flush, pending }
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
  it("a geometry's bytes go to its scratch terminal; its install waits for every write before it, and nothing after it runs first", () => {
    const h = harness()
    h.send(header('join', 1, '') as never)
    h.send({ type: 'barrier', epoch: 1, throughSeq: 1 })
    h.picture.binary(encode('before'))
    h.send({ type: 'layout', seq: 2, cols: 60, rows: 24 })
    const geometry = { type: 'geometry', seq: 3, cols: 60, rows: 24, generation: 1, bytes: 6 }
    h.send(geometry)
    h.picture.binary(encode('tmu'))
    h.picture.binary(encode('x!!'))
    h.picture.binary(encode('after'))
    // The scratch terminal is made at its header; its writes queue in order behind the layout.
    expect(h.log.slice(3)).toEqual(['write 1 before', 'geometry 1.1 60x24'])
    h.flush()
    expect(h.log.slice(5)).toEqual(['written 1', 'resize 1 60x24', 'scratch 1.1 tmu', 'scratch 1.1 x!!'])
    h.flush()
    expect(h.log.slice(9)).toEqual(['scratched 1.1', 'scratched 1.1', 'install 1.1', 'drop 1.1', 'write 1 after'])
    // Every frame retired once: the header with its install, its bytes as they were parsed.
    h.flush()
    const total = [header('join', 1, ''), { type: 'barrier', epoch: 1, throughSeq: 1 }, { type: 'layout', seq: 2, cols: 60, rows: 24 }, geometry]
      .reduce((sum, frame) => sum + JSON.stringify(frame).length, 0) + 'before'.length + 6 + 'after'.length
    expect(h.retired.at(-1)).toBe(total)
    expect(h.failures).toEqual([])
  })
  it('a geometry a new picture cancels is dropped and retired, its late writes counting nothing', () => {
    const h = harness()
    h.send(header('join', 1, '') as never)
    h.send({ type: 'geometry', seq: 2, cols: 60, rows: 24, generation: 1, bytes: 4 })
    h.picture.binary(encode('half'))
    h.send(header('rebase', 2, '') as never)
    expect(h.log).toContain('drop 1.1')
    const retired = h.retired.at(-1)!
    h.flush()
    expect(h.retired.at(-1)).toBe(retired)
    expect(h.log.filter((line) => line.startsWith('install'))).toEqual([])
  })
  it('a geometry the viewer cannot install loses the picture: it asks for a fresh one', () => {
    const h = harness()
    h.send(header('join', 1, '') as never)
    h.installs.result = false
    h.send({ type: 'geometry', seq: 2, cols: 60, rows: 24, generation: 1, bytes: 1 })
    h.picture.binary(encode('x'))
    h.picture.binary(encode('next'))
    h.flush()
    expect(h.failures).toEqual(['geometry'])
    expect(h.log.filter((line) => line.startsWith('write 1 next'))).toEqual([])
  })
})
