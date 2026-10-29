import { describe, expect, it } from 'bun:test'
import { BUNDLE_FORMAT, PROFILE, assembleBundle, bundleHeader, bundleParts, bundleSource, finalSize, makeBundle, type Bundle } from '../lib/bundle'

const roundTrip = (bundle: Bundle, header = bundleHeader(bundle)) => assembleBundle(header, [...bundleParts(bundle)])
/** Equal as pictures: the checkpoint's text may come back in other pieces. */
const comparable = (bundle: Bundle) => ({ ...bundle, cut: { ...bundle.cut, checkpoint: { ...bundle.cut.checkpoint, data: [bundle.cut.checkpoint.data.join('')] } } })
import { Replica } from '../lib/replica'

const encode = (text: string) => new TextEncoder().encode(text)

/** A replica's cut with a checkpoint base and a tail of output, a layout and a geometry. */
async function cut() {
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {}, idleMs: 1e9 })
  let seq = 0
  await replica.event({ seq: ++seq, kind: 'seed', bytes: encode('\x1bc\x1b[31mred\x1b[0m $ '), cols: 80, rows: 24, reason: 'test', history: true })
  await replica.event({ seq: ++seq, kind: 'output', offset: 0, bytes: encode('ls\r\n') })
  await replica.event({ seq: ++seq, kind: 'layout', cols: 90, rows: 24 })
  await replica.event({ seq: ++seq, kind: 'geometry', bytes: encode('\x1bc$ '), cols: 90, rows: 24, generation: 1, history: true })
  await replica.event({ seq: seq + 1, kind: 'layout', cols: 90, rows: 30 })
  const value = replica.cut()!
  replica.close()
  return value
}

describe('bundle (plan T35b)', () => {
  it('holds the cut, the size it ended at, the versions and the fidelity, and round-trips byte for byte', async () => {
    const picture = await cut()
    expect(picture.tail.map((event) => event.kind)).toEqual(['output', 'layout', 'geometry', 'layout'])
    const bundle = makeBundle(picture, { rebuilds: { overload: 1 }, recoveries: 1 }, 1234)
    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT, profile: PROFILE, cols: 90, rows: 30, savedAt: 1234 })
    expect(PROFILE).toBe('xterm 6.0.0')
    expect(comparable(roundTrip(bundle)!)).toEqual(comparable(bundle))
    // Tail bytes come back as bytes.
    expect(roundTrip(bundle)!.cut.tail[0]).toEqual(picture.tail[0])
  })
  it('the final size follows every layout and geometry in the tail', async () => {
    const picture = await cut()
    expect(finalSize({ ...picture, tail: [] })).toEqual({ cols: picture.checkpoint.cols, rows: picture.checkpoint.rows })
    expect(finalSize(picture)).toEqual({ cols: 90, rows: 30 })
  })
  it('another bundle format, profile or checkpoint format, or a malformed header, is never decoded', async () => {
    const bundle = makeBundle(await cut(), { rebuilds: {} }, 1)
    const altered = (change: (stored: Record<string, any>) => void) => {
      const stored = JSON.parse(bundleHeader(bundle))
      change(stored)
      return roundTrip(bundle, JSON.stringify(stored))
    }
    expect(roundTrip(bundle, '{not json')).toBeUndefined()
    expect(roundTrip(bundle, '{}')).toBeUndefined()
    expect(altered((stored) => { stored.format = 2 })).toBeUndefined()
    expect(altered((stored) => { stored.profile = 'xterm 5.5.0' })).toBeUndefined()
    expect(altered((stored) => { stored.cut.checkpoint.format = 2 })).toBeUndefined()
  })
  it('as a source, it is always the same live cut and tells nothing more', async () => {
    const bundle = makeBundle(await cut(), { rebuilds: {} }, 1)
    const source = bundleSource(bundle)
    expect(source.state()).toEqual({ kind: 'live', cut: bundle.cut })
    const { state, unsubscribe } = source.subscribe({ event: () => { throw new Error('no events') }, rebuilding: () => {}, rebased: () => {}, ended: () => {} })
    expect(state).toEqual(source.state())
    unsubscribe()
  })
})
