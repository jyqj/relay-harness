import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandWordmark } from '@relay-harness/rlh-client-ui-primitives'
import { expectedBuiltBranding } from './built-branding.ts'

it('requires official occupants for an artifact-verified official profile', () => {
  expect(expectedBuiltBranding({ RLH_CLIENT_BUILD_PROFILE: 'official', RLH_CLIENT_TITLE: 'Relay Harness' }))
    .toEqual({ wordmarkViewBox: '26 0 104.65 24', localBuildName: false })
})

it('requires the real local fallback when a valid local build declares no official profile', () => {
  expect(expectedBuiltBranding({})).toEqual({ wordmarkViewBox: '0 0 40.6 28.2', localBuildName: true })
  expect(expectedBuiltBranding({ RLH_CLIENT_BUILD_PROFILE: 'local' })).toEqual(expectedBuiltBranding({}))
})

it.each([undefined, null, [], 'official', { RLH_CLIENT_BUILD_PROFILE: 42 }, { UNDECLARED: 'value' }])(
  'rejects missing or malformed build environments rather than assuming a local artifact', (environment) => {
    expect(() => expectedBuiltBranding(environment)).toThrow('client build record environment is invalid')
  },
)

it('pins the official expectation to the actual current name artwork', () => {
  const branding = expectedBuiltBranding({ RLH_CLIENT_BUILD_PROFILE: 'official' })
  const markup = renderToStaticMarkup(createElement(BrandWordmark, { includeMark: false }))
  expect(markup).toContain(`viewBox="${branding.wordmarkViewBox}"`)
})
