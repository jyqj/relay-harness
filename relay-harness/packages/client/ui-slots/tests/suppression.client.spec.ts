import { describe, expect, it } from 'vitest'
import { SlotCore } from '../src/index.ts'

declare module '../src/index.ts' {
  interface SlotMap {
    'policy.list': { kind: 'list'; scope: 'root' }
    'policy.single': { kind: 'single'; scope: 'root' }
  }
}

const Entry = () => null

describe('slot render suppression', () => {
  it('keeps the raw ledger intact and restores after the final policy releases', () => {
    const slots = new SlotCore()
    slots.register({ name: 'root', children: {
      'policy.list': { kind: 'list', scope: 'root' },
      'policy.single': { kind: 'single', scope: 'root' },
    } }, () => null)
    slots.register({ name: 'policy.list', id: 'advanced' }, Entry)
    slots.register({ name: 'policy.single' }, Entry)
    const first = slots.suppress('policy.list', 'advanced')
    const second = slots.suppress('policy.list', 'advanced')
    const single = slots.suppress('policy.single')
    expect(slots.entries('policy.list')).toHaveLength(1)
    expect(slots.entriesOfSlot('policy.list')).toEqual([])
    expect(slots.entriesOfSlot('policy.single')).toEqual([])
    first()
    expect(slots.entriesOfSlot('policy.list')).toEqual([])
    second()
    single()
    expect(slots.entriesOfSlot('policy.list')).toHaveLength(1)
    expect(slots.entriesOfSlot('policy.single')).toHaveLength(1)
  })

  it('applies a policy installed before its contribution exists', () => {
    const slots = new SlotCore()
    const release = slots.suppress('policy.list', 'advanced')
    slots.register({ name: 'root', children: { 'policy.list': { kind: 'list', scope: 'root' } } }, () => null)
    slots.register({ name: 'policy.list', id: 'advanced' }, Entry)
    expect(slots.entriesOfSlot('policy.list')).toEqual([])
    release()
    expect(slots.entriesOfSlot('policy.list')).toHaveLength(1)
  })
})
