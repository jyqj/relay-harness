import { describe, expect, it } from 'vitest'
import { extractJsts } from '../src/languages/jsts/index.ts'
import { LITERAL_CONFIDENCE, classifyLiteral } from '../src/languages/jsts/literal-classify.ts'

/**
 * The literal classifier (`jsts/literal-classify.ts`), ported from the
 * reference implementation's `classify_literal` (`jsts/extras.rs`): category
 * per regex row, first match in priority order, and the config-key key path.
 * Also pins the wiring into literal collection: only classified literals are
 * indexed.
 */

describe('classifyLiteral categories', () => {
  it.each([
    ['/api/users', 'route'],
    ['/orders-topic', 'route'],
    ['https://api.example.com', 'url'],
    ['http://svc.local:8080/health?probe=1', 'url'],
    ['orders-topic', 'topic'],
    ['user-events', 'topic'],
    ['payment.events', 'topic'],
    ['orders-queue', 'queue'],
    ['tasks-fifo', 'queue'],
    ['queue.orders', 'queue'],
    ['fifo.orders', 'queue'],
    ['DATABASE_URL', 'env_key'],
    ['API_KEY', 'env_key'],
    ['NODE_ENV', 'env_key'],
    ['app.database.host', 'config_key'],
    ['redis.connection.timeout', 'config_key'],
    ['SELECT * FROM users WHERE id = 1', 'sql'],
    ['insert into orders values (1)', 'sql'],
    ['Request timeout after 30s', 'error_string'],
    ['unauthorized access', 'error_string'],
    ['File not found', 'error_string'],
    ['request-trace', 'log_key'],
    ['event-bus', 'log_key'],
    ['logger-name', 'log_key'],
  ] as const)('%s → %s', (value, kind) => {
    expect(classifyLiteral(value)?.kind).toBe(kind)
  })
})

describe('classifyLiteral priority and gates', () => {
  it('applies the reference priority order at the overlaps', () => {
    // route beats every later row.
    expect(classifyLiteral('/queue-fifo')?.kind).toBe('route')
    // url beats topic.
    expect(classifyLiteral('https://api.example.com/orders-topic')?.kind).toBe('url')
    // topic beats env_key (case-insensitive topic suffix on an upper name).
    expect(classifyLiteral('ORDERS-TOPIC')?.kind).toBe('topic')
    // queue beats config_key for dotted names.
    expect(classifyLiteral('queue.orders')?.kind).toBe('queue')
    // env_key beats sql for upper-case words.
    expect(classifyLiteral('FROM')?.kind).toBe('env_key')
  })

  it('returns the literal itself as the config-key key path, null otherwise', () => {
    expect(classifyLiteral('app.database.host')).toEqual({ kind: 'config_key', keyPath: 'app.database.host' })
    expect(classifyLiteral('https://api.example.com')).toEqual({ kind: 'url', keyPath: null })
  })

  it('rejects literals too short to index and unclassifiable text', () => {
    expect(classifyLiteral('')).toBeNull()
    expect(classifyLiteral('ab')).toBeNull()
    // Exactly three bytes passes the gate; multibyte text measures in bytes.
    expect(classifyLiteral('log')).toMatchObject({ kind: 'log_key' })
    expect(classifyLiteral('plain text here')).toBeNull()
    expect(classifyLiteral('!@#')).toBeNull()
  })

  it('reports the reference classification confidence', () => {
    expect(LITERAL_CONFIDENCE).toBe(0.782)
  })
})

describe('literal collection wiring', () => {
  it('indexes only classified literals, carrying the enclosing symbol', async () => {
    const outcome = await extractJsts('wired.ts', `
function load() {
    const key = "DATABASE_URL";
    const plain = "nothing recognizable";
    return key + plain;
}
`, 'typescript')
    const texts = outcome.literals.map(lit => lit.literal)
    expect(texts).toContain('DATABASE_URL')
    // Unclassifiable text is not worth indexing (reference parity).
    expect(texts).not.toContain('nothing recognizable')
    for (const lit of outcome.literals) {
      expect(lit.container).toBe('load')
      expect(lit.enclosingSymbolUid).not.toBeNull()
    }
  })
})
