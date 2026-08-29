import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@relay-harness/rlh-client-ui-memory-center',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
