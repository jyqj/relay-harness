import { Context } from '@relay-harness/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsNavigationService } from '../src/client/navigation.ts'

describe('SettingsNavigationService', () => {
  it('publishes repeated requests for the same real section', () => {
    const navigation = new SettingsNavigationService(new Context())
    navigation.open('memory')
    expect(navigation.store.getSnapshot()).toEqual({ section: 'memory', revision: 1 })
    navigation.open('memory')
    expect(navigation.store.getSnapshot()).toEqual({ section: 'memory', revision: 2 })
  })
})
