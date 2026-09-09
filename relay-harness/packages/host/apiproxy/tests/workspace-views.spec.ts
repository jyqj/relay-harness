import { describe, expect, it } from 'vitest'
import { PresetExistsError } from '@relay-harness/rlh-agent-presets'
import { presetError } from '../src/workspace-views.ts'

describe('preset authoring wire failures', () => {
  it('retains a duplicate preset as an invalid authoring request, not an internal failure', () => {
    const cause = new PresetExistsError('existing')
    expect(presetError('existing', cause)).toEqual({
      code: 'agent-preset-invalid', message: cause.message,
      details: { agentPreset: 'existing', reason: cause.message },
    })
  })

  it('preserves an unexpected storage failure without inventing a missing-preset diagnosis', () => {
    expect(presetError('target', new Error('storage unavailable'))).toEqual({
      code: 'internal', message: 'agent preset "target": Error: storage unavailable', details: {},
    })
  })
})
