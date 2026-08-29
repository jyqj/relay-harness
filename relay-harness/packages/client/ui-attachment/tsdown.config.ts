import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@relay-harness/rlh-client-ui-attachment',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
