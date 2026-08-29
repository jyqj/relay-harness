import { describe, expect, it } from 'vitest'
import { parseFile } from '../src/index.ts'
import type { ParseOutcome } from '../src/types.ts'

/**
 * The reference implementation's 32 embedded Rust test cases
 * (`crates/cc-parsers/src/rust.rs`), transcribed case by case into a table.
 * Cases whose assertions target semantic edges (implements/derives), HTTP
 * call edges, data-flow edges, symbol refs, or resolution fields are adapted
 * to this phase's surface: the same source parses and the surviving
 * extraction (symbols / imports / call edges) is asserted instead. Every
 * adaptation is marked in `note`.
 */

const OPTIONS = { projectRoot: '/proj', maxFileBytes: 512_000 }

const testCaseCode = 'fn dummy() {}\n'

interface RustCase {
  readonly name: string
  readonly file: string
  readonly code: string
  readonly note?: string
  readonly check: (outcome: ParseOutcome) => void | Promise<void>
}

async function parseCase(testCase: RustCase): Promise<ParseOutcome> {
  const outcome = await parseFile(testCase.file, testCase.code, OPTIONS)
  expect(outcome, testCase.name).not.toBeNull()
  return outcome!
}

const CASES: readonly RustCase[] = [
  {
    name: 'parse_simple_rust',
    file: 'src/lib.rs',
    code: `
use crate::db::IndexDb;

struct Greeter;

impl Greeter {
    fn greet(&self, name: &str) -> String {
        format!("hello {}", name)
    }
}

fn top_level() {}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Greeter')
      expect(names).toContain('greet')
      expect(names).toContain('top_level')
      expect(outcome.imports).not.toEqual([])
      const greet = outcome.symbols.find(sym => sym.name === 'greet')
      expect(greet).toMatchObject({ kind: 'method', container: 'Greeter', qname: 'Greeter.greet', paramTypes: '&str', paramCount: 1 })
    },
  },
  {
    name: 'pub_use_is_extracted_as_reexport_with_clean_import_string',
    file: 'src/lib.rs',
    code: `
use std::fmt;
pub use crate::engine::Engine;
pub(crate) use cc_model::parse::ParseOutcome;
pub(super) use super::helpers::helper_fn;
`,
    check: (outcome) => {
      const reexportOf = (importString: string) =>
        outcome.imports.find(imp => imp.importString === importString)?.isReexport
      expect(reexportOf('std::fmt')).toBe(false)
      expect(reexportOf('crate::engine::Engine')).toBe(true)
      expect(reexportOf('cc_model::parse::ParseOutcome')).toBe(true)
      expect(reexportOf('super::helpers::helper_fn')).toBe(true)
    },
  },
  {
    name: 'parse_impl_block_and_trait_definition',
    file: 'src/lib.rs',
    note: 'the trait body is never entered, so its method signatures produce no symbols (reference behavior)',
    code: `
trait MyTrait {
    fn do_something(&self);
    fn with_default(&self) {}
}

struct Foo;

impl Foo {
    fn bar(&self) {}
    fn baz(x: u32) -> u32 { x }
}
`,
    check: (outcome) => {
      const kindOf = (name: string) => outcome.symbols.find(sym => sym.name === name)?.kind
      expect(kindOf('MyTrait')).toBe('interface')
      expect(kindOf('Foo')).toBe('class')
      const bar = outcome.symbols.find(sym => sym.name === 'bar')
      expect(bar).toMatchObject({ kind: 'method', container: 'Foo', qname: 'Foo.bar' })
      expect(kindOf('baz')).toBe('method')
      expect(outcome.symbols.some(sym => sym.name === 'do_something' || sym.name === 'with_default')).toBe(false)
    },
  },
  {
    name: 'parse_async_fn',
    file: 'src/lib.rs',
    note: 'HTTP-call edges are deferred; the client verbs survive as plain callee edges',
    code: `
async fn fetch_data(url: &str) -> Result<String, Error> {
    let resp = reqwest::get(url).await?;
    resp.text().await
}

fn sync_fn() {}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('fetch_data')
      expect(names).toContain('sync_fn')
      const fetch = outcome.symbols.find(sym => sym.name === 'fetch_data')
      expect(fetch).toMatchObject({ kind: 'function', returnType: 'Result<String, Error>' })
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('get')
      expect(callees).toContain('text')
    },
  },
  {
    name: 'parse_macro_call_edges',
    file: 'src/main.rs',
    note: 'the reference records macro edges with call_kind "macro"; this surface\'s frozen call-kind vocabulary folds them into the direct shape',
    code: `
fn main() {
    println!("hello");
    let v = vec![1, 2, 3];
    my_macro!(v);
}
`,
    check: (outcome) => {
      expect(outcome.symbols.some(sym => sym.name === 'main')).toBe(true)
      const macroCallees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(macroCallees).toContain('println')
      expect(macroCallees).toContain('vec')
      expect(macroCallees).toContain('my_macro')
      for (const edge of outcome.callEdges) {
        expect(edge.callerSymbol).toBe('main')
        expect(edge.dispatchKind).toBe('direct')
        expect(edge.callKind).toBe('direct')
      }
    },
  },
  {
    name: 'parse_method_call_receiver',
    file: 'src/lib.rs',
    note: 'the reference also asserts the in-file callee binding of self.log_request(); resolution fields ship with the resolution phase',
    code: `
struct Server;

impl Server {
    fn handle(&self, conn: Conn) {
        conn.process();
        self.log_request();
    }

    fn log_request(&self) {}
}
`,
    check: (outcome) => {
      const process = outcome.callEdges.find(edge => edge.calleeSymbol === 'process')
      expect(process).toMatchObject({
        dispatchKind: 'dynamic', callKind: 'member', receiverExpr: 'conn',
        callerSymbol: 'handle', argCount: 0, parserConfidence: 0.7,
      })
      const log = outcome.callEdges.find(edge => edge.calleeSymbol === 'log_request')
      expect(log).toMatchObject({ receiverExpr: 'self', callerSymbol: 'handle' })
    },
  },
  {
    name: 'parse_path_and_turbofish_calls',
    file: 'src/lib.rs',
    code: `
fn caller() {
    std::mem::swap(&mut a, &mut b);
    Vec::new();
    parse::<u32>("3");
    obj.collect::<Vec<_>>();
}
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('swap')
      expect(callees).toContain('new')
      expect(callees).toContain('parse')
      const collect = outcome.callEdges.find(edge => edge.calleeSymbol === 'collect')
      expect(collect).toMatchObject({ dispatchKind: 'dynamic', receiverExpr: 'obj' })
      expect(callees.some(callee => callee.includes('<') || callee.includes(':'))).toBe(false)
    },
  },
  {
    name: 'parse_calls_ignore_strings_and_comments',
    file: 'src/lib.rs',
    code: `
fn caller() {
    // not_a_call(1);
    let s = "also_not_a_call(2)";
    real_call(3);
}
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('real_call')
      expect(callees).not.toContain('not_a_call')
      expect(callees).not.toContain('also_not_a_call')
    },
  },
  {
    name: 'parse_module_and_use_statements',
    file: 'src/lib.rs',
    code: `
use std::collections::HashMap;
use crate::bar::*;
use super::baz::Quux;

fn process() {}
`,
    check: (outcome) => {
      expect(outcome.imports).toHaveLength(3)
      expect(outcome.imports.map(imp => imp.importString)).toEqual([
        'std::collections::HashMap',
        'crate::bar::*',
        'super::baz::Quux',
      ])
    },
  },
  {
    name: 'parse_method_receiver_types',
    file: 'src/lib.rs',
    code: `
struct Widget;

impl Widget {
    fn by_ref(&self) {}
    fn by_mut_ref(&mut self) {}
    fn by_value(self) {}
    fn static_method(x: i32) -> i32 { x }
}
`,
    check: (outcome) => {
      for (const name of ['by_ref', 'by_mut_ref', 'by_value', 'static_method']) {
        const sym = outcome.symbols.find(sym => sym.name === name)
        expect(sym, name).toMatchObject({ kind: 'method', container: 'Widget', receiverType: 'Widget' })
      }
      const byRef = outcome.symbols.find(sym => sym.name === 'by_ref')
      expect(byRef!.paramCount).toBe(0)
      const staticMethod = outcome.symbols.find(sym => sym.name === 'static_method')
      expect(staticMethod).toMatchObject({ paramCount: 1, paramTypes: 'i32' })
    },
  },
  {
    name: 'parse_test_file_detection',
    file: 'src/lib.rs',
    code: 'fn dummy() {}\n',
    check: async (outcome) => {
      expect(outcome.isTestFile).toBe(false)
      const parserTest = await parseFile('src/parser_test.rs', testCaseCode, OPTIONS)
      expect(parserTest!.isTestFile).toBe(true)
      const testsDir = await parseFile('project/tests/integration.rs', testCaseCode, OPTIONS)
      expect(testsDir!.isTestFile).toBe(true)
    },
  },
  {
    name: 'parse_call_edges',
    file: 'src/lib.rs',
    note: 'the reference also asserts call refs; refs ship with the resolution phase',
    code: `
fn helper(x: i32) -> i32 {
    x + 1
}

fn caller() {
    let a = helper(42);
    let b = helper(a);
}
`,
    check: (outcome) => {
      const callerToHelper = outcome.callEdges.filter(
        edge => edge.calleeSymbol === 'helper' && edge.callerSymbol === 'caller',
      )
      expect(callerToHelper.length).toBeGreaterThanOrEqual(2)
    },
  },
  {
    name: 'parse_semantic_edges_impl_trait',
    file: 'src/lib.rs',
    note: 'implements edges are deferred; the `impl Trait for Type` container still binds the method to the type',
    code: `
trait Drawable {
    fn draw(&self);
}

struct Circle;

impl Drawable for Circle {
    fn draw(&self) {}
}
`,
    check: (outcome) => {
      const draw = outcome.symbols.find(sym => sym.name === 'draw')
      expect(draw).toMatchObject({ kind: 'method', container: 'Circle', qname: 'Circle.draw' })
    },
  },
  {
    name: 'parse_semantic_edges_impl_trait_with_generics',
    file: 'src/lib.rs',
    note: 'implements edges are deferred; the generic impl still binds fmt to MyVec, and the write! macro survives as a call edge',
    code: `
struct MyVec<T>(Vec<T>);

impl<T: Clone> std::fmt::Display for MyVec<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MyVec")
    }
}
`,
    check: (outcome) => {
      const fmt = outcome.symbols.find(sym => sym.name === 'fmt')
      expect(fmt).toMatchObject({ kind: 'method', container: 'MyVec' })
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'write')).toBe(true)
    },
  },
  {
    name: 'parse_env_var_access',
    file: 'src/config.rs',
    note: 'env-access data flow is deferred; the env reads survive as callee edges inside the function body',
    code: `
fn load_config() {
    let db_url = std::env::var("DATABASE_URL").unwrap();
    let api_key = env::var("API_KEY").expect("missing");
    let opt = env::var_os("OPTIONAL_VAR");
}
`,
    check: (outcome) => {
      const callees = outcome.callEdges.filter(edge => edge.callerSymbol === 'load_config').map(edge => edge.calleeSymbol)
      expect(callees).toContain('var')
      expect(callees).toContain('var_os')
      expect(callees).toContain('unwrap')
      expect(callees).toContain('expect')
    },
  },
  {
    name: 'parse_derive_macros',
    file: 'src/lib.rs',
    note: 'derives edges are deferred; the attributed struct and enum are still extracted',
    code: `
#[derive(Debug, Clone, Serialize)]
struct Config {
    name: String,
}

#[derive(PartialEq)]
enum Status {
    Active,
    Inactive,
}
`,
    check: (outcome) => {
      const kindOf = (name: string) => outcome.symbols.find(sym => sym.name === name)?.kind
      expect(kindOf('Config')).toBe('class')
      expect(kindOf('Status')).toBe('enum')
    },
  },
  {
    name: 'parse_enum_definition',
    file: 'src/lib.rs',
    code: `
enum Color {
    Red,
    Green,
    Blue,
}

enum Option<T> {
    Some(T),
    None,
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Color')
      expect(names).toContain('Option')
      const color = outcome.symbols.find(sym => sym.name === 'Color')
      expect(color).toMatchObject({ kind: 'enum' })
      expect(color!.signature).toContain('enum Color')
    },
  },
  {
    name: 'parse_generic_function',
    file: 'src/lib.rs',
    code: `
fn process<T: Display>(item: T) -> String {
    item.to_string()
}

fn multi_generic<T, U>(a: T, b: U) -> (T, U) {
    (a, b)
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('process')
      expect(names).toContain('multi_generic')
      const process = outcome.symbols.find(sym => sym.name === 'process')
      expect(process).toMatchObject({ kind: 'function', paramCount: 1, paramTypes: 'T' })
      const multi = outcome.symbols.find(sym => sym.name === 'multi_generic')
      expect(multi).toMatchObject({ paramCount: 2, paramTypes: 'T, U' })
    },
  },
  {
    name: 'parse_const_and_static',
    file: 'src/lib.rs',
    note: 'const/static are not extracted as symbols — the reference documents the same gap',
    code: `
const MAX: u32 = 100;
static COUNTER: u32 = 0;

fn use_them() -> u32 {
    MAX + COUNTER
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('use_them')
      expect(names).not.toContain('MAX')
      expect(names).not.toContain('COUNTER')
    },
  },
  {
    name: 'parse_return_type_extraction',
    file: 'src/lib.rs',
    code: `
fn no_return() {}

fn returns_u32() -> u32 {
    42
}

fn returns_result() -> Result<String, Error> {
    Ok("ok".to_string())
}
`,
    check: (outcome) => {
      const returnTypeOf = (name: string) => outcome.symbols.find(sym => sym.name === name)?.returnType
      expect(returnTypeOf('no_return')).toBeNull()
      expect(returnTypeOf('returns_u32')).toBe('u32')
      expect(returnTypeOf('returns_result')).toContain('Result')
    },
  },
  {
    name: 'parse_nested_impl_methods',
    file: 'src/lib.rs',
    code: `
struct Server {
    port: u16,
}

impl Server {
    fn new(port: u16) -> Self {
        Server { port }
    }

    fn start(&self) {
        self.listen();
    }

    fn listen(&self) {}
}
`,
    check: (outcome) => {
      const methodNames = outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name)
      expect(methodNames).toContain('new')
      expect(methodNames).toContain('start')
      expect(methodNames).toContain('listen')
      const newMethod = outcome.symbols.find(sym => sym.name === 'new')
      expect(newMethod!.returnType).toContain('Self')
      expect(newMethod!.paramCount).toBe(1)
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'listen')).toBe(true)
    },
  },
  {
    name: 'parse_multiple_impls_for_same_struct',
    file: 'src/lib.rs',
    note: 'the implements edge is deferred; both impl blocks still bind their methods to Point',
    code: `
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }
}

impl std::fmt::Display for Point {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Point')
      expect(names).toContain('new')
      expect(names).toContain('fmt')
      const newSym = outcome.symbols.find(sym => sym.name === 'new')
      expect(newSym!.container).toBe('Point')
      const fmtSym = outcome.symbols.find(sym => sym.name === 'fmt')
      expect(fmtSym!.container).toBe('Point')
    },
  },
  {
    name: 'parse_parser_tier_and_confidence',
    file: 'src/lib.rs',
    code: 'fn foo() {}\n',
    check: (outcome) => {
      expect(outcome.parserTier).toBe('semantic')
      expect(outcome.parserConfidence).toBe(0.85)
    },
  },
  {
    name: 'parse_with_timeout_works',
    file: 'src/lib.rs',
    note: 'the timeout seam is a parse-runtime concern this port does not model; extraction is asserted instead',
    code: `
fn hello() -> &'static str {
    "world"
}
`,
    check: (outcome) => {
      expect(outcome.symbols.some(sym => sym.name === 'hello')).toBe(true)
    },
  },
  {
    name: 'parse_complex_use_tree',
    file: 'src/lib.rs',
    code: `
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};

fn process() {}
`,
    check: (outcome) => {
      expect(outcome.imports.length).toBeGreaterThanOrEqual(2)
      const importStrings = outcome.imports.map(imp => imp.importString)
      expect(importStrings.some(str => str.includes('HashMap') || str.includes('collections'))).toBe(true)
    },
  },
  {
    name: 'parse_call_edges_cross_function',
    file: 'src/lib.rs',
    note: 'the reference also asserts Exact/1.0 resolution on in-file callees; resolution fields ship with the resolution phase',
    code: `
fn alpha() -> i32 {
    beta() + gamma()
}

fn beta() -> i32 {
    gamma()
}

fn gamma() -> i32 {
    42
}
`,
    check: (outcome) => {
      const calleesFrom = (caller: string) => outcome.callEdges
        .filter(edge => edge.callerSymbol === caller)
        .map(edge => edge.calleeSymbol)
      expect(calleesFrom('alpha')).toContain('beta')
      expect(calleesFrom('alpha')).toContain('gamma')
      expect(calleesFrom('beta')).toContain('gamma')
    },
  },
  {
    name: 'parse_unresolved_call_edges',
    file: 'src/lib.rs',
    note: 'the reference also asserts Unresolved resolution; resolution fields ship with the resolution phase',
    code: `
fn my_fn() {
    external_call(42);
}
`,
    check: (outcome) => {
      const extCalls = outcome.callEdges.filter(edge => edge.calleeSymbol === 'external_call')
      expect(extCalls.length).toBeGreaterThan(0)
      expect(extCalls[0]).toMatchObject({ callerSymbol: 'my_fn', dispatchKind: 'direct' })
    },
  },
  {
    name: 'parse_summary_format',
    file: 'src/lib.rs',
    code: `
struct A;
struct B;
fn foo() {}
`,
    check: (outcome) => {
      expect(outcome.summary).toBe('src/lib.rs (rust, 4 lines, 3 symbols)')
    },
  },
  {
    name: 'parse_supported_languages',
    file: 'a.rs',
    note: 'the registry surface is asserted through the parse entry (the reference asserts its parser registry)',
    code: 'fn main() {}\n',
    check: (outcome) => {
      expect(outcome.language).toBe('rust')
      expect(outcome.parserTier).toBe('semantic')
    },
  },
  {
    name: 'parse_empty_file',
    file: 'src/empty.rs',
    code: '',
    check: (outcome) => {
      expect(outcome.symbols).toEqual([])
      expect(outcome.imports).toEqual([])
      expect(outcome.callEdges).toEqual([])
    },
  },
  {
    name: 'parse_emits_param_pass_and_return_flow',
    file: 'src/lib.rs',
    note: 'param-pass/return-flow data flow is deferred; the call edge the flows derive from is asserted instead',
    code: `
fn callee(v: i32) -> i32 {
    v + 1
}

fn caller(x: i32) -> i32 {
    callee(x)
}
`,
    check: (outcome) => {
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'callee' && edge.callerSymbol === 'caller')).toBe(true)
    },
  },
  {
    name: 'extract_outbound_http_calls',
    file: 'src/client.rs',
    note: 'HTTP-call edges (and the non-URL guard) are deferred; the client verbs survive as plain callee edges',
    code: `
async fn fetch() {
    let _ = reqwest::get("https://api.example.com/users").await;
    let client = reqwest::Client::new();
    let _ = client.post("/api/orders").send().await;
    let map = std::collections::HashMap::new();
    let _ = map.get("some_key");
}
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('get')
      expect(callees).toContain('post')
      expect(callees).toContain('new')
      expect(callees).toContain('send')
      const post = outcome.callEdges.find(edge => edge.calleeSymbol === 'post')
      expect(post!.receiverExpr).toBe('client')
    },
  },
]

describe('reference rust cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await parseCase(testCase)
      await testCase.check(outcome)
    },
    30_000,
  )

  it('transcribes every reference case', () => {
    expect(CASES).toHaveLength(32)
  })
})

describe('rust walker branch coverage', () => {
  it('attributes a nested function body to the enclosing function', async () => {
    const outcome = await parseFile('src/nested.rs', [
      'fn outer() {',
      '    fn inner() {}',
      '    inner();',
      '}',
    ].join('\n'), OPTIONS)
    // The declaration walk registers only top-level items, so `inner` is no
    // symbol and its body's calls bind to the enclosing function.
    expect(outcome!.symbols.map(sym => sym.name)).toEqual(['outer'])
    expect(outcome!.callEdges.find(edge => edge.calleeSymbol === 'inner'))
      .toMatchObject({ callerSymbol: 'outer' })
  })

  it('skips computed callees but keeps the inner producing call', async () => {
    const outcome = await parseFile('src/computed.rs', 'fn t() { make_adder()(5); }\n', OPTIONS)
    const callees = outcome!.callEdges.map(edge => edge.calleeSymbol)
    // The outer call's `function` is itself a call expression — no shape
    // resolves it; the inner make_adder() call is a plain direct edge.
    expect(callees).toEqual(['make_adder'])
  })

  it('resolves path-qualified macros to their trailing name', async () => {
    const outcome = await parseFile('src/macros.rs', 'fn t() { path::mac!(x); }\n', OPTIONS)
    expect(outcome!.callEdges.find(edge => edge.calleeSymbol === 'mac'))
      .toMatchObject({ dispatchKind: 'direct', callerSymbol: 't', argCount: null })
  })

  it('never emits keyword callees from constructor-style Self calls', async () => {
    const outcome = await parseFile('src/self_call.rs', [
      'struct Newtype(i32);',
      '',
      'impl Newtype {',
      '    fn make() -> Self {',
      '        Self(1)',
      '    }',
      '}',
    ].join('\n'), OPTIONS)
    expect(outcome!.callEdges.filter(edge => edge.calleeSymbol === 'Self')).toEqual([])
    expect(outcome!.callEdges.filter(edge => edge.calleeSymbol === 'self')).toEqual([])
  })
})
