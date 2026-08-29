import { Service } from '@relay-harness/cordis'

/** Service whose public annotations are intentionally absent. */
export class WritableService extends Service {
  value = 1

  echo(input = 'value') {
    return input
  }
}

declare module '@relay-harness/cordis' {
  interface Context {
    writable: WritableService
  }
}

export default WritableService
