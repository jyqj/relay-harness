import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@relay-harness/rlh-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
