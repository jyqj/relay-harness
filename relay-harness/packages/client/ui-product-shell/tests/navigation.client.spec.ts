/** Product deep links only select passive records, never execution authority. */
import { describe, expect, it } from 'vitest'
import { parseProductRoute, productRouteHash, ProductRouteStore } from '../src/client/navigation.ts'

describe('product routes', () => {
  it('round trips opaque Session ids and admits only known main pages', () => {
    for (const id of ['a/b', '中文 ?#%', 'session:one']) {
      const route = parseProductRoute(`#relay/record/${encodeURIComponent(id)}`)!
      expect(route).toEqual({ page: 'record', sessionId: id })
      expect(parseProductRoute(productRouteHash(route))).toEqual(route)
    }
    for (const page of ['conversation', 'work', 'library']) expect(parseProductRoute(`#relay/${page}`)).toEqual({ page })
    expect(parseProductRoute('')).toBeUndefined()
    expect(parseProductRoute('#unrelated')).toBeUndefined()
  })
  it('does not reinterpret malformed or missing sources as the currently selected Session', () => {
    for (const hash of ['#relay/record/', '#relay/record/%ZZ', '#relay/record/%00', '#relay/admin', '#relay/record/' + 'x'.repeat(1025)]) {
      expect(parseProductRoute(hash)).toEqual({ page: 'record', error: 'invalid-route' })
    }
    expect(productRouteHash({ page: 'record', error: 'invalid-route' })).toBe('#relay/invalid')
  })
  it('serializes object identity and view selection only — draft content has no route form', () => {
    const draft = 'unsent draft /msg #relay/record/leak?x=1'
    for (const hash of [
      productRouteHash({ page: 'conversation' }),
      productRouteHash({ page: 'work' }),
      productRouteHash({ page: 'library' }),
      productRouteHash({ page: 'record', sessionId: 's1' as never }),
    ]) {
      expect(hash).toMatch(/^#relay\/(conversation|work|library|record\/s1)$/)
      expect(hash.includes(encodeURIComponent(draft))).toBe(false)
    }
    // Query- or fragment-bearing drafts never widen a page route: unknown
    // suffixes parse as the explicit invalid-record state, not a page.
    expect(parseProductRoute('#relay/work?draft=abc')).toEqual({ page: 'record', error: 'invalid-route' })
  })
  it('owns only observable navigation state and withdraws listeners', () => {
    const store = new ProductRouteStore()
    let calls = 0
    const stop = store.subscribe(() => { calls += 1 })
    store.set({ page: 'work' })
    expect(store.getSnapshot()).toEqual({ page: 'work' })
    expect(calls).toBe(1)
    stop()
    store.set({ page: 'library' })
    expect(calls).toBe(1)
  })
})
