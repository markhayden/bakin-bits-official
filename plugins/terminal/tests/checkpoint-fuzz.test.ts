import { describe, expect, it } from 'bun:test'
import { fullState, internals, stateDiff } from '../lib/terminal-state'
import {
  apply, emulator, FuzzReplica, generate, joinCategory, missingBranches, missingCategories, prng, settled, thinDeciles,
} from './helpers/terminal-fuzz'

// Plan T32b: seeds × sizes; every joiner equals the replica at the join,
// every 25 events after, and at the end; the replica equals a one-shot
// reference fed with different chunking.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 200)
const SIZES = [[80, 24], [120, 40], [40, 10]] as const
const SCROLLBACK = 200

async function stream(seed: number, cols: number, rows: number) {
  const { bytes, events, used, r } = generate(seed, cols, rows)
  const replica = new FuzzReplica(cols, rows, SCROLLBACK, 120)
  const joiners: { viewer: Awaited<ReturnType<FuzzReplica['join']>>['viewer']; offset: number; category: string }[] = []
  const categories: Record<string, number> = {}
  const cuts: number[] = []
  const problems: string[] = []
  let offset = 0
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    replica.apply(event)
    for (const joiner of joiners) apply(joiner.viewer, event)
    if (event.kind === 'output') offset += event.bytes.length
    if (r.int(6) === 0) {
      await settled(replica.term)
      const category = joinCategory(replica.term)
      const { viewer, fromCheckpoint } = await replica.join()
      categories[category] = (categories[category] ?? 0) + (fromCheckpoint ? 1 : 0)
      const core = internals(replica.term)
      if (fromCheckpoint && replica.term.buffer.active.type === 'alternate') categories['in-alt'] = (categories['in-alt'] ?? 0) + 1
      if (fromCheckpoint && (core.buffers.active.scrollTop !== 0 || core.buffers.active.scrollBottom !== replica.term.rows - 1)) categories['region-active'] = (categories['region-active'] ?? 0) + 1
      if (fromCheckpoint && core.buffers.active.x >= replica.term.cols) categories['pending-wrap'] = (categories['pending-wrap'] ?? 0) + 1
      const difference = stateDiff(fullState(replica.term), fullState(viewer))
      if (difference) problems.push(`seed ${seed} ${cols}x${rows} join@${offset} (${category}) at the join: ${difference}`)
      joiners.push({ viewer, offset, category })
      cuts.push(offset / bytes.length)
    }
    if (i % 25 === 24) {
      await settled(replica.term)
      for (const joiner of joiners) {
        await settled(joiner.viewer)
        const difference = stateDiff(fullState(replica.term), fullState(joiner.viewer))
        if (difference) problems.push(`seed ${seed} ${cols}x${rows} join@${joiner.offset} (${joiner.category}) after @${offset}: ${difference}`)
      }
    }
  }
  await settled(replica.term)
  // The one-shot reference: the same bytes, chunked differently (and the same resizes, in order).
  const reference = emulator(cols, rows, SCROLLBACK)
  const chunker = prng(seed ^ 0x5eed)
  for (const event of events) {
    if (event.kind === 'resize') { apply(reference, event); continue }
    for (let at = 0; at < event.bytes.length;) { const size = 1 + chunker.int(17); reference.write(event.bytes.subarray(at, at + size)); at += size }
  }
  await settled(reference)
  const drift = stateDiff(fullState(reference), fullState(replica.term))
  if (drift) problems.push(`seed ${seed} ${cols}x${rows} replica vs reference: ${drift}`)
  for (const joiner of joiners) {
    await settled(joiner.viewer)
    const difference = stateDiff(fullState(replica.term), fullState(joiner.viewer))
    if (difference) problems.push(`seed ${seed} ${cols}x${rows} join@${joiner.offset} (${joiner.category}) at the end: ${difference}`)
    joiner.viewer.dispose()
  }
  reference.dispose()
  replica.term.dispose()
  return { used, categories, cuts, problems, attempts: replica.attempts, accepted: replica.accepted, rejected: replica.rejected }
}

describe('checkpoint fuzz', () => {
  it(`${SEEDS} seeds × ${SIZES.map(([c, r]) => `${c}×${r}`).join(', ')}: joins exact, the replica equals a differently chunked reference`, async () => {
    const used: Record<string, number> = {}
    const categories: Record<string, number> = {}
    const cuts: number[] = []
    const problems: string[] = []
    const rejected = new Map<string, number>()
    let attempts = 0
    let accepted = 0
    const start = performance.now()
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const [cols, rows] of SIZES) {
        const result = await stream(seed * 7919, cols, rows)
        for (const [name, n] of Object.entries(result.used)) used[name] = (used[name] ?? 0) + n
        for (const [name, n] of Object.entries(result.categories)) categories[name] = (categories[name] ?? 0) + n
        cuts.push(...result.cuts)
        problems.push(...result.problems)
        attempts += result.attempts
        accepted += result.accepted
        for (const [kind, n] of result.rejected) rejected.set(kind, (rejected.get(kind) ?? 0) + n)
      }
    }
    const seconds = (performance.now() - start) / 1000
    console.log(`fuzz: ${SEEDS * SIZES.length} streams in ${seconds.toFixed(1)} s; ${cuts.length} joins; checkpoints ${accepted}/${attempts}; categories ${JSON.stringify(categories)}; rejections ${JSON.stringify([...rejected].sort((a, b) => b[1] - a[1]).slice(0, 6))}`)
    expect(problems.slice(0, 5)).toEqual([])
    expect(missingBranches(used, SEEDS)).toEqual([])
    expect(missingCategories(categories)).toEqual([])
    expect(thinDeciles(cuts, cuts.length / 30)).toEqual([])
  }, 600_000)
})

describe('checkpoint fuzz: the coverage checks have teeth', () => {
  it('a branch never drawn is reported', () => {
    expect(missingBranches({ print: 500 }, 10)).toContain('numbered')
  })
  it('a join category never served from a checkpoint is reported', () => {
    expect(missingCategories({ quiescent: 3, 'mid-CSI': 1 })).toContain('mid-OSC')
  })
  it('a decile with too few joins is reported', () => {
    expect(thinDeciles([0.05, 0.15, 0.25], 1)).toEqual([3, 4, 5, 6, 7, 8, 9])
  })
})
