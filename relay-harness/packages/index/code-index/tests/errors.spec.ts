import { describe, expect, it } from 'vitest'
import { HarnessError } from '@relay-harness/rlh-llm'
import { CodeIndexError } from '../src/errors.ts'
import {
  CODE_INDEX_DB_FOREIGN_APPLICATION,
  CODE_INDEX_NOT_INDEXED,
  CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
} from '../src/errors.ts'

describe('code-index structured errors', () => {
  it('carries stable SCREAMING_SNAKE codes', () => {
    expect(CODE_INDEX_DB_FOREIGN_APPLICATION).toBe('CODE_INDEX_DB_FOREIGN_APPLICATION')
    expect(CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED).toBe('CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED')
    expect(CODE_INDEX_NOT_INDEXED).toBe('CODE_INDEX_NOT_INDEXED')
  })

  it('routes as HarnessError with its own class name', () => {
    const error = new CodeIndexError('no index yet', CODE_INDEX_NOT_INDEXED)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe('CODE_INDEX_NOT_INDEXED')
    expect(error.name).toBe('CodeIndexError')
  })
})
