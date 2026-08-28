import { describe, expect, it } from 'vitest'
import { parseFile } from '../src/index.ts'
import { classifyLiteral } from '../src/languages/jsts/literal-classify.ts'
import type { ParseOutcome } from '../src/types.ts'

/**
 * The reference implementation's 35 embedded JS/TS test cases
 * (`crates/cc-parsers/src/jsts/tests.rs`), transcribed case by case into a
 * table. Cases whose assertions target route edges, HTTP-call edges, broker
 * edges, dispatch sites, or literal classification are adapted to this
 * phase's surface: the same source parses and the surviving extraction
 * (symbols / imports / call edges / literals) is asserted instead. Every
 * adaptation is marked in `note`. The six cases that assert only the literal
 * classifier run as real assertions in the closing describe block below.
 */

const OPTIONS = { projectRoot: '/proj', maxFileBytes: 512_000 }

interface JstsCase {
  readonly name: string
  readonly file: string
  readonly code: string
  readonly note?: string
  readonly check: (outcome: ParseOutcome) => void
}

async function parseCase(testCase: JstsCase): Promise<ParseOutcome> {
  const outcome = await parseFile(testCase.file, testCase.code, OPTIONS)
  expect(outcome, testCase.name).not.toBeNull()
  return outcome!
}

const CASES: readonly JstsCase[] = [
  {
    name: 'parse_simple_js',
    file: 'app.js',
    code: `
function greet(name) {
    return "Hello " + name;
}

class Greeter {
    constructor(prefix) {
        this.prefix = prefix;
    }
    greet(name) {
        return this.prefix + name;
    }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('greet')
      expect(names).toContain('Greeter')
      // Methods keep their class container and qualified name.
      const greetMethod = outcome.symbols.find(sym => sym.name === 'greet' && sym.kind === 'method')
      expect(greetMethod).toMatchObject({ container: 'Greeter', qname: 'Greeter.greet' })
    },
  },
  {
    name: 'parse_typescript_arrow',
    file: 'math.ts',
    code: 'const add = (a: number, b: number): number => a + b;\n',
    check: (outcome) => {
      // Reference assertion: the arrow declarator surfaces as a function
      // symbol (param/return type info attaches only to declared
      // functions/methods, matching the reference implementation).
      const add = outcome.symbols.find(sym => sym.name === 'add')
      expect(add).toMatchObject({ kind: 'function', container: null })
    },
  },
  {
    name: 'extract_express_route',
    file: 'server.js',
    note: 'route edges are deferred; the three registrations survive as member call edges',
    code: `
const express = require("express");
const app = express();

app.get("/api/users", getUsers);
app.post("/api/users", createUser);
app.use("/api", authMiddleware);
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('app.get')
      expect(callees).toContain('app.post')
      expect(callees).toContain('app.use')
      // require("express") produced the namespace/default import record.
      expect(outcome.imports[0]).toMatchObject({ importString: 'express', isNamespace: true, isDefault: true })
    },
  },
  {
    name: 'extract_framework_roles',
    file: 'app.tsx',
    code: `
function useAuth() { return {}; }
function UserProfile() { return null; }
function processData() { return null; }
class UserController {}
class AuthService {}
`,
    check: (outcome) => {
      const roleOf = (name: string) => outcome.symbols.find(sym => sym.name === name)?.frameworkRole
      expect(roleOf('useAuth')).toBe('hook')
      expect(roleOf('UserProfile')).toBe('component')
      expect(roleOf('UserController')).toBe('controller')
      expect(roleOf('AuthService')).toBe('service')
      expect(roleOf('processData')).toBeNull()
    },
  },
  {
    name: 'detect_nextjs_route',
    file: 'app/api/users/route.ts',
    note: 'the Next.js file-route edge is deferred; the exported GET handler survives as a symbol',
    code: `
export async function GET(request) {
    return Response.json({ ok: true });
}
`,
    check: (outcome) => {
      const get = outcome.symbols.find(sym => sym.name === 'GET')
      expect(get).toBeDefined()
      expect(get).toMatchObject({ exportName: 'GET', isDefaultExport: false })
    },
  },
  {
    name: 'extract_literals',
    file: 'config.ts',
    note: 'classification (url/env_key kinds) is deferred; the literal texts are indexed verbatim',
    code: `
const url = "https://api.example.com/v1/users";
const key = "DATABASE_URL";
const query = "SELECT * FROM users WHERE id = 1";
`,
    check: (outcome) => {
      const texts = outcome.literals.map(lit => lit.literal)
      expect(texts).toContain('https://api.example.com/v1/users')
      expect(texts).toContain('DATABASE_URL')
      expect(texts).toContain('SELECT * FROM users WHERE id = 1')
      expect(outcome.literals[0]).toMatchObject({ filePath: 'config.ts', container: null })
    },
  },
  {
    name: 'extract_call_edges_with_dispatch_kind',
    file: 'main.ts',
    code: `
function main() {
    doSomething();
    obj.method();
    const x = new MyClass();
}
`,
    check: (outcome) => {
      const direct = outcome.callEdges.find(edge => edge.calleeSymbol === 'doSomething')
      expect(direct).toMatchObject({ dispatchKind: 'direct', callKind: 'direct', callerSymbol: 'main' })
      const member = outcome.callEdges.find(edge => edge.calleeSymbol === 'obj.method')
      expect(member).toMatchObject({ dispatchKind: 'dynamic', callKind: 'member', receiverExpr: 'obj' })
      const constructor = outcome.callEdges.find(edge => edge.calleeSymbol === 'MyClass')
      expect(constructor).toMatchObject({ dispatchKind: 'constructor', callKind: 'constructor', isConstructor: true })
    },
  },
  {
    name: 'extract_http_call_fetch',
    file: 'app.js',
    note: 'HTTP-call edges are deferred; the awaited fetch call edge survives',
    code: `
async function loadUsers() {
    const response = await fetch("/api/users");
    return response.json();
}
`,
    check: (outcome) => {
      const fetchCall = outcome.callEdges.find(edge => edge.calleeSymbol === 'fetch')
      expect(fetchCall).toMatchObject({ isAwaited: true, callerSymbol: 'loadUsers' })
    },
  },
  {
    name: 'extract_http_call_axios',
    file: 'orders.ts',
    note: 'HTTP-call edges are deferred; the awaited member call survives',
    code: `
import axios from 'axios';
async function createOrder(data) {
    const res = await axios.post("/api/orders", data);
    return res.data;
}
`,
    check: (outcome) => {
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'axios.post'))
        .toMatchObject({ isAwaited: true, dispatchKind: 'dynamic' })
    },
  },
  {
    name: 'extract_http_call_template_string',
    file: 'users.js',
    note: 'HTTP-call normalization is deferred; the template-argument fetch call survives',
    code: `
async function getUser(id) {
    return fetch(\`/api/users/\${id}\`);
}
`,
    check: (outcome) => {
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'fetch')).toBeDefined()
    },
  },
  {
    name: 'no_false_positive_console_log',
    file: 'test.js',
    note: 'HTTP-call edges are deferred; the member call is a plain member edge',
    code: 'console.log("/api/test");',
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('console.log')
      expect(callees.filter(callee => !callee.includes('.'))).not.toContain('fetch')
    },
  },
  {
    name: 'pending_exports_applied',
    file: 'mod.ts',
    code: `
function foo() { return 1; }
function bar() { return 2; }
export { foo, bar as baz };
export default foo;
`,
    check: (outcome) => {
      const foo = outcome.symbols.find(sym => sym.name === 'foo')
      expect(foo).toBeDefined()
      expect(foo!.isDefaultExport).toBe(true)
      const bar = outcome.symbols.find(sym => sym.name === 'bar')
      expect(bar!.exportName).toBe('baz')
    },
  },
  {
    name: 'two_step_forwarding_marks_import_as_reexport',
    file: 'a.ts',
    code: 'import { x } from \'./b\';\nexport { x };\n',
    check: (outcome) => {
      const imp = outcome.imports.find(record => record.importString === './b')
      expect(imp).toBeDefined()
      expect(imp!.isReexport).toBe(true)
    },
  },
  {
    name: 'two_step_forwarding_with_import_alias_marks_reexport',
    file: 'a.ts',
    code: 'import { x as localX } from \'./b\';\nexport { localX as y };\n',
    check: (outcome) => {
      const imp = outcome.imports.find(record => record.importString === './b')
      expect(imp).toBeDefined()
      expect(imp!.isReexport).toBe(true)
    },
  },
  {
    name: 'two_step_forwarding_export_default_of_imported_binding_marks_reexport',
    file: 'a.ts',
    code: 'import { x } from \'./b\';\nexport default x;\n',
    check: (outcome) => {
      const imp = outcome.imports.find(record => record.importString === './b')
      expect(imp).toBeDefined()
      expect(imp!.isReexport).toBe(true)
    },
  },
  {
    name: 'local_export_does_not_mark_unrelated_import_as_reexport',
    file: 'a.ts',
    code: 'import { x } from \'./b\';\nconst y = 1;\nexport { y };\n',
    check: (outcome) => {
      const imp = outcome.imports.find(record => record.importString === './b')
      expect(imp).toBeDefined()
      expect(imp!.isReexport).toBe(false)
      const y = outcome.symbols.find(sym => sym.name === 'y')
      expect(y).toBeDefined()
      expect(y!.exportName).toBe('y')
    },
  },
  {
    name: 'extract_fetch_post_method',
    file: 'orders.js',
    note: 'HTTP method inference is deferred; the awaited fetch call edge survives',
    code: `
async function createOrder(data) {
    const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(data) });
    return res.json();
}
`,
    check: (outcome) => {
      const fetchCall = outcome.callEdges.find(edge => edge.calleeSymbol === 'fetch')
      expect(fetchCall).toBeDefined()
      // The nested JSON.stringify survives through the regex fallback (the
      // reference walker does not descend into an awaited call's arguments
      // with the AST pass).
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'stringify')).toBe(true)
    },
  },
  {
    name: 'extract_fetch_default_get',
    file: 'app.js',
    note: 'HTTP method inference is deferred; the awaited fetch call edge survives',
    code: 'const data = await fetch("/api/users");',
    check: (outcome) => {
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'fetch')).toMatchObject({ isAwaited: true })
    },
  },
  {
    name: 'literal_enclosing_symbol_uid',
    file: 'config.ts',
    code: `
function loadConfig() {
    const url = "https://api.example.com/v1";
    const key = "DATABASE_URL";
}
`,
    check: (outcome) => {
      expect(outcome.literals.length).toBeGreaterThan(0)
      for (const lit of outcome.literals) {
        expect(lit.enclosingSymbolUid, `literal '${lit.literal}'`).not.toBeNull()
        expect(lit.container).toBe('loadConfig')
      }
    },
  },
  {
    name: 'extract_kafka_broker_call',
    file: 'producer.js',
    note: 'broker edges are deferred; the awaited member call survives',
    code: `
const kafka = require('kafkajs');
async function publishOrder(order) {
    await kafka.send({ topic: 'orders', messages: [{ value: JSON.stringify(order) }] });
}
`,
    check: (outcome) => {
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'kafka.send'))
        .toMatchObject({ isAwaited: true, callKind: 'member' })
      // The require() import of the broker client is still recorded.
      expect(outcome.imports[0]).toMatchObject({ importString: 'kafkajs' })
    },
  },
  {
    name: 'extract_bullmq_broker_call',
    file: 'queue.ts',
    note: 'broker edges are deferred; the awaited member call survives',
    code: `
import { Queue } from 'bullmq';
const bullQueue = new Queue('notifications');
await bullQueue.dispatch('send-email', { to: 'user@example.com' });
`,
    check: (outcome) => {
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'bullQueue.dispatch')).toBeDefined()
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'Queue')).toMatchObject({ isConstructor: true })
    },
  },
  {
    name: 'http_call_not_misclassified_as_broker',
    file: 'client.ts',
    note: 'broker/HTTP split is deferred; the plain awaited member call survives',
    code: `
import axios from 'axios';
async function getUsers() {
    const res = await axios.get('/api/users');
    return res.data;
}
`,
    check: (outcome) => {
      const get = outcome.callEdges.find(edge => edge.calleeSymbol === 'axios.get')
      expect(get).toBeDefined()
      expect(get!.callKind).toBe('member')
    },
  },
  {
    name: 'test_event_emitter_dispatch_sites',
    file: 'test.js',
    note: 'dispatch sites are deferred; the on/emit member calls survive with receivers',
    code: `
const emitter = new EventEmitter();
emitter.on('user:created', handleUser);
emitter.emit('user:created', data);
`,
    check: (outcome) => {
      const on = outcome.callEdges.find(edge => edge.calleeSymbol === 'emitter.on')
      const emit = outcome.callEdges.find(edge => edge.calleeSymbol === 'emitter.emit')
      expect(on).toMatchObject({ receiverExpr: 'emitter', argCount: 2 })
      expect(emit).toMatchObject({ receiverExpr: 'emitter' })
    },
  },
  {
    name: 'test_event_listener_variants',
    file: 'test.js',
    note: 'dispatch sites are deferred; the three listener registrations survive as member calls',
    code: `
window.addEventListener('click', handler);
bus.once('ready', onReady);
bus.subscribe('data', processData);
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['window.addEventListener', 'bus.once', 'bus.subscribe']))
    },
  },
  {
    name: 'test_event_dispatch_variants',
    file: 'test.js',
    note: 'dispatch sites are deferred; the three dispatchers survive as member calls',
    code: `
emitter.emit('start', payload);
bus.trigger('update');
el.dispatchEvent('custom');
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['emitter.emit', 'bus.trigger', 'el.dispatchEvent']))
    },
  },
  {
    name: 'test_jsx_tag_dispatch_sites',
    file: 'app.tsx',
    note: 'JSX tag sites are deferred; traversal descends through JSX and finds the component symbol',
    code: `
function App() {
    return (
        <div>
            <UserProfile name="test" />
            <Header />
            <span>text</span>
        </div>
    );
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'App')).toBeDefined()
      expect(outcome.symbols.find(sym => sym.frameworkRole === 'component')).toBeDefined()
    },
  },
  {
    name: 'test_jsx_member_expression_tag',
    file: 'app.tsx',
    note: 'JSX tag sites are deferred; the JSX-bearing component parses cleanly',
    code: `
function App() {
    return <Router.Switch><Route path="/" /></Router.Switch>;
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'App')).toBeDefined()
    },
  },
  {
    name: 'test_use_state_setter_dispatch_sites',
    file: 'counter.tsx',
    note: 'state-setter sites are deferred; destructured useState binds no symbols and the setter call survives',
    code: `
function Counter() {
    const [count, setCount] = useState(0);
    const [name, setName] = useState("");
    const handleClick = () => setCount(count + 1);
    return <button onClick={handleClick}>{count}</button>;
}
`,
    check: (outcome) => {
      // Destructured useState bindings produce no per-binding symbols.
      expect(outcome.symbols.filter(sym => sym.kind === 'variable')).toHaveLength(0)
      expect(outcome.symbols.find(sym => sym.name === 'handleClick')).toMatchObject({ kind: 'function', container: 'Counter' })
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'setCount')).toBeDefined()
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'useState')).toBeDefined()
    },
  },
  {
    name: 'test_class_set_state_dispatch_sites',
    file: 'counter.tsx',
    note: 'state-setter sites are deferred; this.setState survives as a member call with its receiver',
    code: `
class Counter extends React.Component {
    handleClick() {
        this.setState({ count: this.state.count + 1 });
    }
    render() {
        return <button onClick={this.handleClick}>{this.state.count}</button>;
    }
}
`,
    check: (outcome) => {
      const setState = outcome.callEdges.find(edge => edge.calleeSymbol === 'this.setState')
      expect(setState).toMatchObject({ receiverExpr: 'this', callKind: 'member' })
    },
  },
]

/**
 * The six reference cases earlier phases deferred wholesale: they assert only
 * the literal classifier, which has landed. The five `classify_literal_*`
 * cases call the classifier directly (the reference does the same);
 * `literal_config_key_has_key_path` parses and — this phase's
 * `LiteralRecord` trims the kind/key_path columns — asserts the record is
 * indexed and reads the key path off the classifier.
 */
const UNLOCKED_CASES = [
  'classify_literal_env_key',
  'classify_literal_config_key',
  'classify_literal_topic',
  'classify_literal_queue',
  'classify_literal_priority',
  'literal_config_key_has_key_path',
] as const

describe('reference jsts cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await parseCase(testCase)
      testCase.check(outcome)
    },
    30_000,
  )

  it('documents the full 35-case transcription', () => {
    expect(CASES).toHaveLength(29)
    expect(UNLOCKED_CASES).toHaveLength(6)
    expect(UNLOCKED_CASES.length + CASES.length).toBe(35)
  })
})

describe('unlocked reference literal-classifier cases', () => {
  it('classify_literal_env_key', () => {
    expect(classifyLiteral('DATABASE_URL')?.kind).toBe('env_key')
    expect(classifyLiteral('API_KEY')?.kind).toBe('env_key')
    expect(classifyLiteral('NODE_ENV')?.kind).toBe('env_key')
  })

  it('classify_literal_config_key', () => {
    expect(classifyLiteral('app.database.host')?.kind).toBe('config_key')
    expect(classifyLiteral('redis.connection.timeout')?.kind).toBe('config_key')
  })

  it('classify_literal_topic', () => {
    expect(classifyLiteral('orders-topic')?.kind).toBe('topic')
    expect(classifyLiteral('user-events')?.kind).toBe('topic')
    expect(classifyLiteral('payment.events')?.kind).toBe('topic')
  })

  it('classify_literal_queue', () => {
    expect(classifyLiteral('orders-queue')?.kind).toBe('queue')
    expect(classifyLiteral('tasks-fifo')?.kind).toBe('queue')
    expect(classifyLiteral('queue.orders')?.kind).toBe('queue')
  })

  it('classify_literal_priority', () => {
    // URL takes priority over everything
    expect(classifyLiteral('https://api.example.com')?.kind).toBe('url')
    // Route takes priority
    expect(classifyLiteral('/api/users')?.kind).toBe('route')
  })

  it('literal_config_key_has_key_path', async () => {
    const outcome = await parseFile('config.ts', `
function getConfig() {
    return "app.database.host";
}
`, OPTIONS)
    expect(outcome, 'config_key literal is indexed').not.toBeNull()
    expect(outcome!.literals.some(lit => lit.literal === 'app.database.host')).toBe(true)
    expect(classifyLiteral('app.database.host')).toEqual({ kind: 'config_key', keyPath: 'app.database.host' })
  })
})
