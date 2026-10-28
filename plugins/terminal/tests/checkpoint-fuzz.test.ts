import { describe, expect, it } from 'bun:test'
import { fullState, internals, stateDiff } from '../lib/terminal-state'
import {
  apply, emulator, FuzzReplica, generate, joinCategory, missingBranches, missingCategories, prng, settled, thinDeciles,
} from './helpers/terminal-fuzz'

// Plan T32b: seeds × sizes; every joiner equals the replica at the join,
// every 25 events after, and at the end; the replica equals a one-shot
// reference fed with different chunking.
//
// FUZZ_SHARD=k/n runs every n-th stream (CI runs the matrix in parallel
// shards); FUZZ_SHARD=skip leaves it to those shards. Unset: the whole matrix.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 200)
const SHARD = process.env.FUZZ_SHARD
const [shardIndex, shardCount] = SHARD && SHARD !== 'skip' ? SHARD.split('/').map(Number) as [number, number] : [1, 1]
const fuzz = SHARD === 'skip' ? it.skip : it
const SIZES = [[80, 24], [120, 40], [40, 10]] as const
// Tiny geometry, for fewer seeds.
const TINY = { seeds: Math.min(SEEDS, 30), size: [2, 1] as const }
const SCROLLBACK = 200

async function stream(seed: number, cols: number, rows: number) {
  const { events, used, r } = generate(seed, cols, rows)
  const total = events.reduce((n, event) => n + (event.kind === 'output' ? event.bytes.length : 0), 0)
  // The one-shot reference first: the output between resizes concatenated
  // and cut afresh (so no original chunk boundary survives), its state kept
  // at every resize boundary to compare the replica there too.
  const reference = emulator(cols, rows, SCROLLBACK)
  const chunker = prng(seed ^ 0x5eed)
  const atBoundary: ReturnType<typeof fullState>[] = []
  let pending: Uint8Array[] = []
  const flush = async () => {
    const all = new Uint8Array(pending.reduce((n, part) => n + part.length, 0))
    let at = 0
    for (const part of pending) { all.set(part, at); at += part.length }
    pending = []
    for (let start = 0; start < all.length;) { const size = 1 + chunker.int(17); reference.write(all.subarray(start, start + size)); start += size }
    await settled(reference)
  }
  for (const event of events) {
    if (event.kind === 'output') { pending.push(event.bytes); continue }
    await flush()
    atBoundary.push(fullState(reference))
    apply(reference, event)
  }
  await flush()
  const replica = new FuzzReplica(cols, rows, SCROLLBACK, 120)
  // A second reference, fed as the replica goes but cut afresh, compared at every join.
  const incremental = emulator(cols, rows, SCROLLBACK)
  const incrementalChunker = prng(seed ^ 0xc0ffee)
  let incrementalPending: Uint8Array[] = []
  const catchUp = async () => {
    const all = new Uint8Array(incrementalPending.reduce((n, part) => n + part.length, 0))
    let at = 0
    for (const part of incrementalPending) { all.set(part, at); at += part.length }
    incrementalPending = []
    for (let start = 0; start < all.length;) { const size = 1 + incrementalChunker.int(23); incremental.write(all.subarray(start, start + size)); start += size }
    await settled(incremental)
  }
  let trimmed = false
  const joiners: { viewer: Awaited<ReturnType<FuzzReplica['join']>>['viewer']; offset: number; category: string }[] = []
  const categories: Record<string, number> = {}
  const cuts: number[] = []
  const problems: string[] = []
  let offset = 0
  let boundary = 0
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (event.kind === 'resize') {
      await settled(replica.term)
      const drift = stateDiff(atBoundary[boundary++]!, fullState(replica.term))
      if (drift) problems.push(`seed ${seed} ${cols}x${rows} replica vs reference before resize ${boundary}: ${drift}`)
      await catchUp()
      apply(incremental, event)
    } else incrementalPending.push(event.bytes)
    replica.apply(event)
    for (const joiner of joiners) apply(joiner.viewer, event)
    if (event.kind === 'output') offset += event.bytes.length
    if (r.int(6) === 0) {
      await Promise.all([settled(replica.term), catchUp()])
      const transient = stateDiff(fullState(incremental), fullState(replica.term))
      if (transient) problems.push(`seed ${seed} ${cols}x${rows} replica vs incremental reference @${offset}: ${transient}`)
      const lines = internals(replica.term).buffers.normal.lines
      if (lines.length === lines.maxLength) trimmed = true
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
      cuts.push(offset / total)
    }
    if (i % 25 === 24) {
      // Settled together: each settle is a timer turn.
      await Promise.all([settled(replica.term), ...joiners.map((joiner) => settled(joiner.viewer))])
      for (const joiner of joiners) {
        const difference = stateDiff(fullState(replica.term), fullState(joiner.viewer))
        if (difference) problems.push(`seed ${seed} ${cols}x${rows} join@${joiner.offset} (${joiner.category}) after @${offset}: ${difference}`)
      }
    }
  }
  await settled(replica.term)
  const drift = stateDiff(fullState(reference), fullState(replica.term))
  if (drift) problems.push(`seed ${seed} ${cols}x${rows} replica vs reference: ${drift}`)
  await Promise.all(joiners.map((joiner) => settled(joiner.viewer)))
  for (const joiner of joiners) {
    const difference = stateDiff(fullState(replica.term), fullState(joiner.viewer))
    if (difference) problems.push(`seed ${seed} ${cols}x${rows} join@${joiner.offset} (${joiner.category}) at the end: ${difference}`)
    joiner.viewer.dispose()
  }
  reference.dispose()
  incremental.dispose()
  replica.term.dispose()
  return { used, categories, cuts, problems, trimmed, attempts: replica.attempts, accepted: replica.accepted, rejected: replica.rejected }
}

describe('checkpoint fuzz', () => {
  fuzz(`shard ${shardIndex}/${shardCount} of ${SEEDS} seeds × ${SIZES.map(([c, r]) => `${c}×${r}`).join(', ')}: joins exact, the replica equals a differently chunked reference`, async () => {
    const used: Record<string, number> = {}
    const categories: Record<string, number> = {}
    const cuts: number[] = []
    const problems: string[] = []
    const rejected = new Map<string, number>()
    let attempts = 0
    let accepted = 0
    let trimmedStreams = 0
    let tinyStreams = 0
    const start = performance.now()
    const runs: [number, number, number][] = []
    for (let seed = 1; seed <= SEEDS; seed++) for (const [cols, rows] of SIZES) runs.push([seed, cols, rows])
    for (let seed = 1; seed <= TINY.seeds; seed++) runs.push([seed, TINY.size[0], TINY.size[1]])
    const mine = runs.filter((_, i) => i % shardCount === shardIndex - 1)
    {
      for (const [seed, cols, rows] of mine) {
        const result = await stream(seed * 7919, cols, rows)
        if (result.trimmed) trimmedStreams++
        if (cols === TINY.size[0] && rows === TINY.size[1]) tinyStreams++
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
    console.log(`fuzz: ${mine.length} streams (${trimmedStreams} trimmed their scrollback, ${tinyStreams} at ${TINY.size.join('×')}, ${used['large-write'] ?? 0} with a split past xterm's parse split) in ${seconds.toFixed(1)} s; ${cuts.length} joins; checkpoints ${accepted}/${attempts}; categories ${JSON.stringify(categories)}; rejections ${JSON.stringify([...rejected].sort((a, b) => b[1] - a[1]).slice(0, 6))}`)
    expect(problems.slice(0, 5)).toEqual([])
    // About a third of a draw per stream for every branch, as across the whole matrix.
    expect(missingBranches(used, Math.ceil(mine.length / 3))).toEqual([])
    // Behaviour the branch counts cannot show.
    expect(trimmedStreams).toBeGreaterThan(0)
    expect(used['large-write'] ?? 0).toBeGreaterThan(0)
    expect(tinyStreams).toBeGreaterThan(0)
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
