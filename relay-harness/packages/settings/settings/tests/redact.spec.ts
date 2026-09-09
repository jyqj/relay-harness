import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { redactSecrets, settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

describe('redactSecrets', () => {
  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter as z<never>, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('passes malformed container values through untouched', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      providers: 'not-a-dict',
      fallbacks: 'not-an-array',
    })
    expect(value).toEqual({ providers: 'not-a-dict', fallbacks: 'not-an-array' })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird as z<never>, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens as z<never>, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
  })

  it('passes a union with no declared secret through untouched', () => {
    const Optional = z.object({ note: z.union([z.string(), z.number()]) })
    const { value, secrets } = redactSecrets(Optional as z<never>, { note: 'plain' })
    expect(value).toEqual({ note: 'plain' })
    expect(secrets).toEqual([])
  })

  it('passes a transform with only public object fields and rejects a root secret union', () => {
    const publicTransform = z.transform(z.object({ label: z.string() }), value => value)
    expect(redactSecrets(publicTransform as z<never>, { label: 'public' }))
      .toEqual({ value: { label: 'public' }, secrets: [] })
    const rootSecret = z.union([z.string(), z.string().role('secret')])
    expect(() => redactSecrets(rootSecret as z<never>, 'fixture-secret'))
      .toThrow(/declares a secret inside a union node at <root>/)
  })

  it('refuses to redact a value whose schema hides a secret in a union', () => {
    const Leaky = z.object({ choice: z.union([z.string(), z.string().role('secret')]) })
    expect(() => redactSecrets(Leaky as z<never>, { choice: 'maybe-secret' }))
      .toThrow(/declares a secret inside a union node at choice/)
  })

  it('refuses to redact a value whose schema hides a secret in a transform', () => {
    const Leaky = z.object({ parsed: z.transform(z.object({ key: z.string().role('secret') }), v => v) })
    expect(() => redactSecrets(Leaky as z<never>, { parsed: { key: 'x' } }))
      .toThrow(/declares a secret inside a transform node at parsed/)
  })
})

describe('describe() layers and redaction', () => {
  const NS = settingsNamespace('adapter')

  async function boot(doc?: Record<string, unknown>) {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
    return ctx
  }

  it('exposes detached base and user layers beside the resolved value', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const base = { apiKey: 'entry-key', baseURL: 'https://base' }
    ctx.settings.register(NS, Profile, { base })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor?.base).toEqual(base)
    expect(descriptor?.base).not.toBe(base)
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.value).toEqual({ apiKey: 'entry-key', baseURL: 'https://user' })
    ;(descriptor?.user as Record<string, unknown>).baseURL = 'mutated'
    expect(ctx.settings.describe()[0]?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toBeUndefined()
  })

  it('omits the layers when neither a base nor a user section exists', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
  })

  it('describes a section that became malformed after registration as having no user layer', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const provider = ctx.get('settings') as MemorySettings
    ctx.settings.register(NS, Profile, { base: { baseURL: 'https://base' } })
    provider.pushExternal({ adapter: 5 })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('user')
    // The malformed publish kept the last good resolved value.
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
  })

  it('redacts a descriptor that has neither base nor user layer', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('redacts every layer and enumerates secret slots under redactSecrets', async () => {
    const ctx = await boot({ adapter: { apiKey: 'user-key', baseURL: 'https://user' } })
    ctx.settings.register(NS, Profile, { base: { apiKey: 'entry-key' } })
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.base).toEqual({})
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    const [verbatim] = ctx.settings.describe()
    expect(verbatim?.value).toEqual({ apiKey: 'user-key', baseURL: 'https://user' })
  })
})

describe('redaction own-property boundaries', () => {
  it('preserves unknown JSON keys without invoking inherited setters', () => {
    const schema = z.object({ apiKey: z.string().role('secret') })
    const input = JSON.parse('{"__proto__":{"marker":"own-data"},"constructor":"own-constructor","toString":"own-toString","apiKey":"fixture-secret"}') as unknown
    const { value, secrets } = redactSecrets(schema as z<never>, input)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.keys(value as object)).toEqual(['__proto__', 'constructor', 'toString'])
    expect(JSON.stringify(value)).toBe('{"__proto__":{"marker":"own-data"},"constructor":"own-constructor","toString":"own-toString"}')
    expect(secrets).toEqual([{ path: ['apiKey'], set: true }])
  })

  it('redacts entries named __proto__ as ordinary dictionary data', () => {
    const schema = z.dict(z.object({ apiKey: z.string().role('secret'), label: z.string() }))
    const input = Object.fromEntries([['__proto__', { apiKey: 'fixture-secret', label: 'kept' }]])
    const { value, secrets } = redactSecrets(schema as z<never>, input)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true)
    expect(JSON.stringify(value)).toBe('{"__proto__":{"label":"kept"}}')
    expect(secrets).toEqual([{ path: ['__proto__', 'apiKey'], set: true }])
    expect(input['__proto__']).toEqual({ apiKey: 'fixture-secret', label: 'kept' })
  })

  it('preserves schema-declared __proto__ data without changing the output prototype', () => {
    const schema = z.object(Object.fromEntries([['__proto__', z.string()]]))
    const { value, secrets } = redactSecrets(schema as z<never>, Object.fromEntries([['__proto__', 'ordinary-data']]))
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.keys(value as object)).toEqual(['__proto__'])
    expect(JSON.stringify(value)).toBe('{"__proto__":"ordinary-data"}')
    expect(secrets).toEqual([])
  })

  it('does not materialize inherited configuration or report inherited secrets as set', () => {
    const schema = z.object({ apiKey: z.string().role('secret'), label: z.string() })
    const input: unknown = Object.create({ apiKey: 'fixture-inherited', label: 'not-own' })
    expect(redactSecrets(schema as z<never>, input)).toEqual({
      value: {}, secrets: [{ path: ['apiKey'], set: false }],
    })
  })
})
