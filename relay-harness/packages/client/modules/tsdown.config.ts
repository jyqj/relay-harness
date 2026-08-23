import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@relay-harness/rlh-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
