/** Brand assertions derived from an artifact-verified client build record, never the current shell environment. */
export function expectedBuiltBranding(environment: unknown): {
  wordmarkViewBox: string
  localBuildName: boolean
} {
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)
    || Object.entries(environment).some(([key, value]) => !key.startsWith('RLH_CLIENT_') || typeof value !== 'string')) {
    throw new TypeError('client build record environment is invalid')
  }
  const official = Reflect.get(environment, 'RLH_CLIENT_BUILD_PROFILE') === 'official'
  return {
    wordmarkViewBox: official ? '26 0 104.65 24' : '0 0 40.6 28.2',
    localBuildName: !official,
  }
}
