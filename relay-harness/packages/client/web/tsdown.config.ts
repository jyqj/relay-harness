import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@relay-harness/rlh-client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
