import { afterEach, expect, test } from 'bun:test'
import { Store } from '../lib/store'
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
test('output rolls at session and global byte limits and reports gaps', () => {
  const store = new Store(':memory:', 8, 12)
  stores.push(store)
  store.append('one', Buffer.from('123456'))
  store.append('one', Buffer.from('abcdef'))
  expect(store.output('one', 0).truncated).toBe(true)
  expect(store.output('one', 0).data.toString()).toBe('abcdef')
  store.append('two', Buffer.from('ABCDEF'))
  store.append('three', Buffer.from('uvwxyz'))
  expect(store.output('one', 0).data.length).toBe(0)
  expect(store.output('one', 0).truncated).toBe(true)
  expect(store.bytes()).toBeLessThanOrEqual(12)
})
