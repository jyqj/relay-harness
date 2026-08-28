import { describe, expect, it } from 'vitest'
import { parseFile } from '../src/index.ts'
import { extractPythonParamTypes } from '../src/languages/python/symbols.ts'
import type { ParseOutcome } from '../src/types.ts'

/**
 * The reference implementation's 29 embedded Python test cases
 * (`crates/cc-parsers/src/python/mod.rs`), transcribed case by case into a
 * table. Cases whose assertions target route edges, HTTP-call edges, broker
 * edges, dispatch sites, diagnostics, semantic edges, or `parent_symbol_id`
 * are adapted to this phase's surface: the same source parses and the
 * surviving extraction (symbols / imports / call edges) is asserted instead.
 * Every adaptation is marked in `note`.
 */

const OPTIONS = { projectRoot: '/proj', maxFileBytes: 512_000 }

interface PythonCase {
  readonly name: string
  readonly file: string
  readonly code: string
  readonly note?: string
  readonly check: (outcome: ParseOutcome) => void | Promise<void>
}

async function parseCase(testCase: PythonCase): Promise<ParseOutcome> {
  const outcome = await parseFile(testCase.file, testCase.code, OPTIONS)
  expect(outcome, testCase.name).not.toBeNull()
  return outcome!
}

const CASES: readonly PythonCase[] = [
  {
    name: 'parse_simple_python',
    file: 'example.py',
    code: `
import os

def hello(name: str) -> str:
    return f"Hello {name}"

class Greeter:
    def greet(self, name):
        return hello(name)
`,
    note: 'the reference also asserts greet.parent_symbol_id; this surface pins every symbol as a chunk root, so the class link is asserted via kind/container/qname',
    check: (outcome) => {
      expect(outcome.parserTier).toBe('semantic')
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('hello')
      expect(names).toContain('Greeter')
      expect(names).toContain('greet')
      const greet = outcome.symbols.find(sym => sym.name === 'greet')
      expect(greet).toMatchObject({ kind: 'method', container: 'Greeter', qname: 'Greeter.greet', receiverType: 'Greeter' })
      // The body call to hello is attributed to greet.
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'hello' && edge.callerSymbol === 'greet')).toBe(true)
    },
  },
  {
    name: 'symbol_uids_are_stable',
    file: 'f.py',
    code: 'def foo():\n    pass\n',
    check: async (outcome) => {
      const again = await parseFile('f.py', 'def foo():\n    pass\n', OPTIONS)
      expect(again).not.toBeNull()
      expect(outcome.symbols[0]!.symbolUid).toBe(again!.symbols[0]!.symbolUid)
    },
  },
  {
    name: 'extract_fastapi_routes',
    file: 'api.py',
    note: 'route edges are deferred; the decorated (async) handlers survive as symbols and the decorator registrations survive as direct call edges',
    code: `
from fastapi import FastAPI

app = FastAPI()

@app.get("/users")
def list_users():
    return []

@app.post("/users")
async def create_user(user: dict):
    return user
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('list_users')
      expect(names).toContain('create_user')
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('get')
      expect(callees).toContain('post')
    },
  },
  {
    name: 'extract_flask_route',
    file: 'app.py',
    note: 'route edges are deferred; the handler survives and the @app.route registration survives as a direct call edge',
    code: `
from flask import Flask
app = Flask(__name__)

@app.route("/hello")
def hello():
    return "Hello"
`,
    check: (outcome) => {
      expect(outcome.symbols.some(sym => sym.name === 'hello')).toBe(true)
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'route')).toBe(true)
    },
  },
  {
    name: 'extract_raise_diagnostics',
    file: 'validate.py',
    note: 'diagnostics are deferred; each raise survives as a direct call edge to the exception class',
    code: `
def validate(x):
    if x < 0:
        raise ValueError("x must be non-negative")
    if x > 100:
        raise RuntimeError("x too large")
`,
    check: (outcome) => {
      const callees = outcome.callEdges.filter(edge => edge.callerSymbol === 'validate').map(edge => edge.calleeSymbol)
      expect(callees).toContain('ValueError')
      expect(callees).toContain('RuntimeError')
    },
  },
  {
    name: 'extract_imports_detailed',
    file: 'mod.py',
    code: `
import os
import sys as system
from pathlib import Path
from collections import OrderedDict as OD
from . import utils
from ..core import Base
from typing import List, Dict
`,
    check: (outcome) => {
      // `import os` — namespace record aliasing the first dotted segment.
      expect(outcome.imports.find(imp => imp.importString === 'os')).toMatchObject({
        importedName: '*', alias: 'os', isNamespace: true,
      })
      // `import sys as system` — the alias replaces the first segment.
      expect(outcome.imports.find(imp => imp.importString === 'sys')).toMatchObject({
        importedName: '*', alias: 'system', isNamespace: true,
      })
      // `from pathlib import Path` — the alias defaults to the name itself.
      expect(outcome.imports.find(imp => imp.importString === 'pathlib')).toMatchObject({
        importedName: 'Path', alias: 'Path', isNamespace: false,
      })
      expect(outcome.imports.find(imp => imp.importString === 'collections')).toMatchObject({
        importedName: 'OrderedDict', alias: 'OD',
      })
      // Relative module paths join verbatim.
      expect(outcome.imports.find(imp => imp.importString === '.')).toMatchObject({
        importedName: 'utils', alias: 'utils',
      })
      expect(outcome.imports.find(imp => imp.importString === '..core')).toMatchObject({
        importedName: 'Base', alias: 'Base',
      })
      const typing = outcome.imports.filter(imp => imp.importString === 'typing')
      expect(typing.map(imp => imp.importedName)).toEqual(['List', 'Dict'])
      expect(outcome.imports).toHaveLength(8)
    },
  },
  {
    name: 'extract_django_urlpatterns',
    file: 'urls.py',
    note: 'route edges are deferred; module-level registrations are not function bodies, so no call edges are scanned',
    code: `
from django.urls import path
from . import views

urlpatterns = [
    path("api/users/", views.user_list),
    path("api/items/", views.item_list),
]
`,
    check: (outcome) => {
      expect(outcome.symbols).toEqual([])
      expect(outcome.callEdges).toEqual([])
      expect(outcome.imports.map(imp => imp.importString)).toContain('django.urls')
    },
  },
  {
    name: 'extract_http_call_requests',
    file: 'client.py',
    note: 'HTTP-call edges are deferred; the client verbs survive as direct callee edges inside the function body',
    code: `
import requests

def get_users():
    response = requests.get("/api/users")
    return response.json()
`,
    check: (outcome) => {
      const callees = outcome.callEdges.filter(edge => edge.callerSymbol === 'get_users').map(edge => edge.calleeSymbol)
      expect(callees).toContain('get')
      expect(callees).toContain('json')
    },
  },
  {
    name: 'extract_http_call_httpx_post',
    file: 'orders.py',
    note: 'HTTP-call edges are deferred; the client verbs survive as direct callee edges inside the function body',
    code: `
import httpx

def create_order(data):
    response = httpx.post("/api/orders", json=data)
    return response.json()
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toContain('post')
    },
  },
  {
    name: 'extract_http_call_requests_request',
    file: 'client.py',
    note: 'HTTP-call edges are deferred; the generic request call survives as a direct callee edge',
    code: `
import requests

def update_item(item_id, data):
    response = requests.request("PUT", f"/api/items/{item_id}", json=data)
    return response.json()
`,
    check: (outcome) => {
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'request')).toBe(true)
    },
  },
  {
    name: 'extract_http_call_httpx_request',
    file: 'sess.py',
    note: 'HTTP-call edges are deferred; the call sits at module level, outside every function body the call pass scans',
    code: `
import httpx

resp = httpx.request("POST", "/api/submit", json={"key": "val"})
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
    },
  },
  {
    name: 'no_false_positive_dict_get',
    file: 'test.py',
    note: 'HTTP-call edges are deferred; module-level statements are not function bodies, so no call edges are scanned at all',
    code: `
data = {"key": "value"}
result = data.get("/api/users")
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
    },
  },
  {
    name: 'function_signature_includes_return_type',
    file: 'sig.py',
    code: 'def greet(name: str) -> str:\n    return f\'Hello {name}\'\n',
    check: (outcome) => {
      const sig = outcome.symbols[0]!.signature ?? ''
      expect(sig).toContain('-> str')
      expect(sig).toBe('def greet(name: str) -> str')
    },
  },
  {
    name: 'extract_semantic_edges_inherits',
    file: 'inherit.py',
    note: 'inheritance edges are deferred; the superclass lists survive verbatim in the class signatures',
    code: `
class Animal:
    pass

class Dog(Animal):
    pass

class GuideDog(Dog, Serializable):
    pass

class Plain:
    pass

class EmptyParens():
    pass

class WithMeta(Base, metaclass=ABCMeta):
    pass

class SkipObject(object):
    pass

class SkipABC(ABC):
    pass
`,
    check: (outcome) => {
      const signatureOf = (name: string) => outcome.symbols.find(sym => sym.name === name)?.signature
      expect(signatureOf('Dog')).toBe('class Dog(Animal)')
      expect(signatureOf('GuideDog')).toBe('class GuideDog(Dog, Serializable)')
      expect(signatureOf('Plain')).toBe('class Plain')
      expect(signatureOf('EmptyParens')).toBe('class EmptyParens()')
      expect(signatureOf('WithMeta')).toBe('class WithMeta(Base, metaclass=ABCMeta)')
      expect(signatureOf('SkipObject')).toBe('class SkipObject(object)')
      expect(signatureOf('SkipABC')).toBe('class SkipABC(ABC)')
    },
  },
  {
    name: 'extract_param_types_typed_function',
    file: 'typed.py',
    code: `
def process(x: int, y: str, z: float) -> bool:
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'process')
      expect(sym).toMatchObject({ paramTypes: 'int, str, float', returnType: 'bool', paramCount: 3, receiverType: null })
    },
  },
  {
    name: 'extract_param_types_no_annotations',
    file: 'notype.py',
    code: `
def simple(a, b, c):
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'simple')
      expect(sym).toMatchObject({ paramTypes: null, returnType: null, paramCount: 3 })
    },
  },
  {
    name: 'extract_param_types_method_with_self',
    file: 'dog.py',
    code: `
class Dog:
    def bark(self, volume: int) -> str:
        return "Woof"
`,
    check: (outcome) => {
      const bark = outcome.symbols.find(sym => sym.name === 'bark')
      expect(bark).toMatchObject({
        kind: 'method', receiverType: 'Dog', paramTypes: 'int', returnType: 'str', paramCount: 1,
      })
    },
  },
  {
    name: 'extract_param_types_with_defaults',
    file: 'defaults.py',
    code: `
def greet(name: str = "World", count: int = 1) -> None:
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'greet')
      expect(sym).toMatchObject({ paramTypes: 'str, int', returnType: 'None', paramCount: 2 })
    },
  },
  {
    name: 'extract_param_types_generic_annotations',
    file: 'generic.py',
    code: `
def transform(items: List[int], mapping: Dict[str, Any]) -> Optional[str]:
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'transform')
      expect(sym).toMatchObject({ paramTypes: 'List[int], Dict[str, Any]', returnType: 'Optional[str]', paramCount: 2 })
    },
  },
  {
    name: 'extract_param_types_skip_args_kwargs',
    file: 'variadic.py',
    code: `
def variadic(a: int, *args, **kwargs) -> None:
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'variadic')
      expect(sym).toMatchObject({ paramTypes: 'int', paramCount: 1 })
    },
  },
  {
    name: 'extract_param_types_classmethod_cls',
    file: 'factory.py',
    note: 'the @classmethod decorator wraps the definition; the method is still extracted with the class as receiver',
    code: `
class Factory:
    @classmethod
    def create(cls, name: str) -> "Factory":
        pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'create')
      expect(sym).toMatchObject({
        kind: 'method', receiverType: 'Factory', paramTypes: 'str', paramCount: 1,
      })
    },
  },
  {
    name: 'extract_param_types_no_params',
    file: 'noop.py',
    code: `
def noop() -> None:
    pass
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'noop')
      expect(sym).toMatchObject({ paramTypes: null, returnType: 'None', paramCount: 0 })
    },
  },
  {
    name: 'split_respecting_brackets_basic',
    file: 'brackets.py',
    note: 'the reference unit-tests the split helper directly; this transcribes it through the public parameter-table surface (bracketed commas never split)',
    code: 'def keep(a: int, b: Dict[str, int], c: str) -> None:\n    pass\n',
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'keep')
      expect(sym).toMatchObject({ paramTypes: 'int, Dict[str, int], str', paramCount: 3 })
    },
  },
  {
    name: 'extract_param_types_tuple_return',
    file: 'tuple_ret.py',
    code: `
def divide(a: int, b: int) -> Tuple[int, int]:
    return a // b, a % b
`,
    check: (outcome) => {
      const sym = outcome.symbols.find(sym => sym.name === 'divide')
      expect(sym).toMatchObject({ paramTypes: 'int, int', returnType: 'Tuple[int, int]', paramCount: 2 })
    },
  },
  {
    name: 'extract_celery_broker_call',
    file: 'tasks.py',
    note: 'broker edges are deferred; the module-level send_task sits outside every function body, and the import is still recorded',
    code: `
import celery

celery.send_task('tasks.send_notification', args=[123])
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
      expect(outcome.imports[0]).toMatchObject({ importString: 'celery', importedName: '*', alias: 'celery', isNamespace: true })
    },
  },
  {
    name: 'extract_rabbitmq_broker_call',
    file: 'publisher.py',
    note: 'broker edges are deferred; the module-level publish sits outside every function body, and the import is still recorded',
    code: `
import pika

pika.basic_publish(exchange='', routing_key='task_queue', body='Hello')
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
      expect(outcome.imports[0]).toMatchObject({ importString: 'pika', isNamespace: true })
    },
  },
  {
    name: 'extract_throw_edges_python',
    file: 'throws.py',
    note: 'throw edges are deferred; raises survive as direct call edges to the exception classes, and a bare raise emits nothing',
    code: `
def foo():
    raise ValueError("bad value")

def bar():
    raise CustomError("msg") from original

def baz():
    try:
        pass
    except:
        raise

class Validator:
    def validate(self):
        raise ValidationError("invalid")

def multi():
    raise TypeError("type")
    raise KeyError("key")
`,
    check: (outcome) => {
      const calleesFrom = (caller: string) => outcome.callEdges
        .filter(edge => edge.callerSymbol === caller)
        .map(edge => edge.calleeSymbol)
      expect(calleesFrom('foo')).toContain('ValueError')
      expect(calleesFrom('bar')).toContain('CustomError')
      // A bare `raise` carries no callee, so baz emits only its def line.
      expect(calleesFrom('baz')).toEqual(['baz'])
      expect(calleesFrom('validate')).toContain('ValidationError')
      const multi = calleesFrom('multi')
      expect(multi).toContain('TypeError')
      expect(multi).toContain('KeyError')
    },
  },
  {
    name: 'test_pyee_event_emitter_dispatch_sites',
    file: 'events.py',
    note: 'dispatch sites are deferred; the registrations sit at module level, so only the import survives',
    code: `
from pyee import EventEmitter

ee = EventEmitter()
ee.on('user:created', handle_user)
ee.emit('user:created', data)
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
      expect(outcome.imports[0]).toMatchObject({ importString: 'pyee', importedName: 'EventEmitter', alias: 'EventEmitter' })
    },
  },
  {
    name: 'test_django_signal_dispatch_sites',
    file: 'signals.py',
    note: 'dispatch sites are deferred; the connect/send registrations sit at module level, so only the import survives',
    code: `
from django.dispatch import Signal

user_saved = Signal()
user_saved.connect('post_save', handle_save)
user_saved.send('post_save')
`,
    check: (outcome) => {
      expect(outcome.callEdges).toEqual([])
      expect(outcome.imports[0]).toMatchObject({ importString: 'django.dispatch', importedName: 'Signal', alias: 'Signal' })
    },
  },
]

describe('reference python cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await parseCase(testCase)
      await testCase.check(outcome)
    },
    30_000,
  )

  it('transcribes every reference case', () => {
    expect(CASES).toHaveLength(29)
  })
})

describe('python walker branch coverage', () => {
  it('extracts nested classes and keeps their records unqualified', async () => {
    const outcome = await parseFile('nested_cls.py', [
      'class Outer:',
      '    class Inner:',
      '        def member(self):',
      '            pass',
      '',
    ].join('\n'), OPTIONS)
    const inner = outcome!.symbols.find(sym => sym.name === 'Inner')
    expect(inner).toMatchObject({ kind: 'class', container: null, qname: 'Inner' })
    // A method of the nested class still binds to the nested class.
    const member = outcome!.symbols.find(sym => sym.name === 'member')
    expect(member).toMatchObject({ kind: 'method', container: 'Inner', qname: 'Inner.member' })
  })

  it('qualifies a function nested in a method under the class (reference quirk)', async () => {
    const outcome = await parseFile('nested_fn.py', [
      'class C:',
      '    def m(self):',
      '        def helper():',
      '            pass',
      '        helper()',
      '',
    ].join('\n'), OPTIONS)
    // The class stays the container while descending through the method body.
    const helper = outcome!.symbols.find(sym => sym.name === 'helper')
    expect(helper).toMatchObject({ kind: 'method', container: 'C', qname: 'C.helper', receiverType: 'C' })
    expect(outcome!.callEdges.some(edge => edge.calleeSymbol === 'helper')).toBe(true)
  })

  it('scans the def line itself, so the function name followed by `(` emits', async () => {
    const outcome = await parseFile('defline.py', 'def run(x=fallback()):\n    pass\n', OPTIONS)
    const defLine = outcome!.callEdges.find(edge => edge.calleeSymbol === 'run')
    // The reference's text scan sees `run(` on the def line: a self-edge.
    expect(defLine).toMatchObject({
      callerSymbol: 'run', dispatchKind: 'direct', callKind: 'direct',
      parserConfidence: 0.7, argCount: null, isAwaited: false,
    })
    expect(defLine!.endLine).toBe(defLine!.line)
    expect(outcome!.callEdges.some(edge => edge.calleeSymbol === 'fallback')).toBe(true)
  })

  it('never emits reserved words as callees', async () => {
    const outcome = await parseFile('keywords.py', 'def check(v):\n    return not(v)\n', OPTIONS)
    const callees = outcome!.callEdges.map(edge => edge.calleeSymbol)
    expect(callees).not.toContain('not')
  })

  it('records dotted and wildcard imports', async () => {
    const outcome = await parseFile('wild.py', [
      'import pkg.mod',
      'from m import *',
      'from typing import (List, Dict as D)',
    ].join('\n'), OPTIONS)
    expect(outcome!.imports.find(imp => imp.importString === 'pkg.mod')).toMatchObject({
      importedName: '*', alias: 'pkg', isNamespace: true,
    })
    expect(outcome!.imports.find(imp => imp.importString === 'm')).toMatchObject({
      importedName: '*', alias: null, isNamespace: true,
    })
    // Parenthesized lists flatten to one record per name.
    const typing = outcome!.imports.filter(imp => imp.importString === 'typing')
    expect(typing).toHaveLength(2)
    expect(typing.find(imp => imp.importedName === 'Dict')).toMatchObject({ alias: 'D' })
  })

  it('marks python test paths through the language heuristics', async () => {
    const testFile = await parseFile('tests/test_a.py', 'def a():\n    pass\n', OPTIONS)
    expect(testFile!.isTestFile).toBe(true)
    const source = await parseFile('pkg/a.py', 'def a():\n    pass\n', OPTIONS)
    expect(source!.isTestFile).toBe(false)
    // Python emits no literals this phase (the reference records none).
    expect(source!.literals).toEqual([])
    expect(source!.symbolRefs).toEqual([])
  })

  it('parses the parameter table for bracketed defaults directly', () => {
    expect(extractPythonParamTypes('(x: int = max(1, 2), y: List[int] = [])')).toEqual([
      'int, List[int]',
      2,
    ])
    expect(extractPythonParamTypes('()')).toEqual([null, 0])
    expect(extractPythonParamTypes('(self, /, *, flag: bool)')).toEqual(['bool', 1])
  })
})
