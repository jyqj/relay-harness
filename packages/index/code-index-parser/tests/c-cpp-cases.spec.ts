import { describe, expect, it } from 'vitest'
import { extractCCpp } from '../src/languages/c-cpp.ts'
import { isTestFile } from '../src/test-detect.ts'

/**
 * The reference implementation's 11 embedded C/C++ test cases
 * (`crates/cc-parsers/src/c_cpp.rs` `mod tests`), transcribed case by case
 * into a table. Cases whose assertions target inheritance semantic edges,
 * data-flow edges, or chunks are adapted to this phase's surface: the same
 * source parses and the surviving extraction (symbols / imports / call edges)
 * is asserted instead. Every adaptation is marked in `note`. Branch cases for
 * the walker's error-recovery paths close the file.
 */

interface CCppCase {
  readonly name: string
  readonly file: string
  readonly language: 'c' | 'cpp'
  readonly code: string
  readonly note?: string
  readonly check: (outcome: Awaited<ReturnType<typeof extractCCpp>>) => void
}

const CASES: readonly CCppCase[] = [
  {
    name: 'parse_simple_c',
    file: 'main.c',
    language: 'c',
    code: `
#include <stdio.h>
#include "myheader.h"

typedef int MyInt;

enum Color {
    RED,
    GREEN,
    BLUE
};

struct Point {
    int x;
    int y;
};

void helper(int n) {
    printf("n=%d\\n", n);
}

int main(int argc, char** argv) {
    struct Point p;
    p.x = 1;
    helper(42);
    return 0;
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('helper')
      expect(names).toContain('main')
      expect(names).toContain('Point')
      expect(names).toContain('Color')
      expect(names).toContain('MyInt')
      expect(outcome.imports).toHaveLength(2)
      // System includes ride the isNamespace flag (the available column for
      // the reference's system/local distinction).
      expect(outcome.imports.find(imp => imp.importString === 'stdio.h')).toMatchObject({ isNamespace: true, importedName: 'stdio.h' })
      expect(outcome.imports.find(imp => imp.importString === 'myheader.h')).toMatchObject({ isNamespace: false })
      expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'helper')).toBe(true)
      expect(outcome.symbols[0]).toMatchObject({ parserTier: 'tree-sitter', parserConfidence: 0.7 })
      expect(isTestFile('main.c', 'c')).toBe(false)
      expect(isTestFile('main_test.c', 'c')).toBe(true)
    },
  },
  {
    name: 'parse_simple_cpp',
    file: 'main.cpp',
    language: 'cpp',
    note: 'inheritance semantic edges are out of scope; the declarations and calls survive',
    code: `
#include <iostream>
#include <vector>

namespace mylib {

class Base {
public:
    virtual void greet() {
        std::cout << "Base" << std::endl;
    }
};

class Derived : public Base {
public:
    void greet() override {
        std::cout << "Derived" << std::endl;
    }

    int compute(int x, int y) {
        return x + y;
    }
};

} // namespace mylib

int main() {
    mylib::Derived d;
    d.greet();
    d.compute(1, 2);
    return 0;
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('mylib')
      expect(names).toContain('Base')
      expect(names).toContain('Derived')
      expect(names).toContain('main')
      expect(outcome.imports.length).toBeGreaterThanOrEqual(2)
      expect(outcome.callEdges.length).toBeGreaterThan(0)
      expect(isTestFile('main.cpp', 'cpp')).toBe(false)
      expect(isTestFile('main_test.cpp', 'cpp')).toBe(true)
    },
  },
  {
    name: 'parse_c_function_params',
    file: 'math.c',
    language: 'c',
    code: `
int add(int a, int b) {
    return a + b;
}
`,
    check: (outcome) => {
      const add = outcome.symbols.find(sym => sym.name === 'add')
      expect(add).toMatchObject({ kind: 'function', paramCount: 2, returnType: 'int' })
    },
  },
  {
    name: 'parse_cpp_method_in_class',
    file: 'calc.cpp',
    language: 'cpp',
    code: `
class Calculator {
public:
    int add(int a, int b) {
        return a + b;
    }
};
`,
    check: (outcome) => {
      const add = outcome.symbols.find(sym => sym.name === 'add')
      expect(add).toMatchObject({ kind: 'method', container: 'Calculator', qname: 'Calculator::add' })
    },
  },
  {
    name: 'parse_call_dispatch_kinds',
    file: 'calls.c',
    language: 'c',
    code: `
void helper() {}

struct Obj {
    int value;
};

int main() {
    helper();
    return 0;
}
`,
    check: (outcome) => {
      const direct = outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')
      expect(direct).toMatchObject({ dispatchKind: 'direct', callKind: 'direct', callerSymbol: 'main' })
    },
  },
  {
    name: 'parse_emits_param_pass_and_return_flow',
    file: 'flow.c',
    language: 'c',
    note: 'data-flow edges are out of scope; the in-file call from caller to callee survives',
    code: `
int callee(int v) {
    return v + 1;
}

int caller(int x) {
    return callee(x);
}
`,
    check: (outcome) => {
      const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'callee')
      expect(call).toMatchObject({ callerSymbol: 'caller', argCount: 1 })
    },
  },
  {
    name: 'parse_cpp_new_expression_constructor',
    file: 'widget.cpp',
    language: 'cpp',
    note: 'callee resolution fields have no record columns; the constructor edges themselves assert',
    code: `
class Widget {
public:
    Widget(int n) {}
};

void factory() {
    Widget* w = new Widget(5);
    Widget* d = new Widget;
}
`,
    check: (outcome) => {
      const ctors = outcome.callEdges.filter(edge => edge.calleeSymbol === 'Widget' && edge.isConstructor)
      expect(ctors).toHaveLength(2)
      const withArg = ctors.find(edge => edge.argCount === 1)
      expect(withArg).toMatchObject({
        dispatchKind: 'constructor',
        callKind: 'constructor',
        callerSymbol: 'factory',
      })
      // The paren-less `new Widget` has no arguments node, so argCount stays null.
      expect(ctors.find(edge => edge.argCount === null)).toBeDefined()
    },
  },
  {
    name: 'parse_cpp_template_call_strips_args',
    file: 'tmpl.cpp',
    language: 'cpp',
    code: `
template<typename T> T identity(T x) { return x; }

struct Box {
    template<typename T> T peek() { return T(); }
};

void use() {
    identity<int>(3);
    Box b;
    b.peek<int>();
}
`,
    check: (outcome) => {
      // Bare generic call: callee must be `identity`, not `identity<int>`.
      const bare = outcome.callEdges.find(edge => edge.calleeSymbol === 'identity')
      expect(bare).toMatchObject({ dispatchKind: 'direct', callerSymbol: 'use' })
      expect(outcome.callEdges.some(edge => edge.calleeSymbol.includes('<'))).toBe(false)
      // Member generic call: callee must be `peek`, not `peek<int>`.
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'peek')).toMatchObject({ dispatchKind: 'dynamic' })
    },
  },
  {
    name: 'parse_cpp_qualified_call_name',
    file: 'ns.cpp',
    language: 'cpp',
    note: 'callee resolution fields have no record columns; the call shape itself asserts',
    code: `
namespace util {
    int compute(int x) { return x; }
}

void run() {
    util::compute(7);
}
`,
    check: (outcome) => {
      const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'compute')
      expect(call).toMatchObject({ dispatchKind: 'direct', callerSymbol: 'run' })
    },
  },
  {
    name: 'parse_cpp_arrow_method_call',
    file: 'acct.cpp',
    language: 'cpp',
    code: `
struct Account {
    bool has_funds(int amount) { return true; }
    void withdraw(int amount) {
        this->has_funds(amount);
    }
};
`,
    check: (outcome) => {
      const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'has_funds')
      expect(call).toMatchObject({
        dispatchKind: 'dynamic',
        callerSymbol: 'withdraw',
        receiverExpr: 'this',
      })
    },
  },
  {
    name: 'parse_c_function_pointer_member_call',
    file: 'ops.c',
    language: 'c',
    code: `
struct Ops {
    int (*run)(int);
};

int driver(struct Ops o) {
    return o.run(1);
}
`,
    check: (outcome) => {
      const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'run')
      expect(call).toMatchObject({
        dispatchKind: 'dynamic',
        receiverExpr: 'o',
        callerSymbol: 'driver',
      })
    },
  },
]

describe('reference c/c++ cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await extractCCpp(testCase.file, testCase.code, testCase.language)
      testCase.check(outcome)
    },
    30_000,
  )
})

describe('c/c++ walker branches', () => {
  it('extracts namespaces, nested classes, and container-qualified method qnames', async () => {
    const outcome = await extractCCpp('ns.cpp', `
namespace outer {
    class Inner {
    public:
        int value() { return 1; }
    };
}
`, 'cpp')
    expect(outcome.symbols.find(sym => sym.name === 'outer')).toMatchObject({ kind: 'namespace', signature: 'namespace outer' })
    expect(outcome.symbols.find(sym => sym.name === 'Inner')).toMatchObject({
      kind: 'class',
      container: 'outer',
      qname: 'outer::Inner',
      signature: 'class Inner',
    })
    // Members qualify by their immediate container only (reference parity:
    // the body walk passes the bare class name down).
    expect(outcome.symbols.find(sym => sym.name === 'value')).toMatchObject({ qname: 'Inner::value' })
  })

  it('extracts out-of-class definitions with qualified and destructor names', async () => {
    const outcome = await extractCCpp('qual.cpp', `
class G {
public:
    G(int n);
    ~G();
};

void ns::f() {}

G::G(int n) {}

G::~G() {}
`, 'cpp')
    // Out-of-class definitions carry no return type; the qualified name's
    // last component becomes the symbol name. With no enclosing class body
    // in the file they extract as functions (reference parity).
    const ctor = outcome.symbols.find(sym => sym.name === 'G' && sym.kind === 'function')
    expect(ctor).toMatchObject({ kind: 'function', qname: 'G', returnType: null, signature: 'G(int n)' })
    expect(outcome.symbols.find(sym => sym.name === '~G')).toMatchObject({ kind: 'function', qname: '~G' })
    expect(outcome.symbols.find(sym => sym.name === 'f')).toMatchObject({ kind: 'function', qname: 'f' })
  })

  it('unwraps template declarations and keeps struct signatures', async () => {
    const outcome = await extractCCpp('tmpl.cpp', `
template<typename T> T pick(T x) { return x; }
struct Plain { int n; };
`, 'cpp')
    // The template unwraps: the inner function extracts with the same rules.
    expect(outcome.symbols.find(sym => sym.name === 'pick')).toMatchObject({
      kind: 'function',
      returnType: 'T',
      signature: 'T pick(T x)',
    })
    expect(outcome.symbols.find(sym => sym.name === 'Plain')).toMatchObject({ kind: 'class', signature: 'struct Plain' })
  })

  it('extracts typedefs, function-pointer typedefs, and destructors', async () => {
    const outcome = await extractCCpp('misc.cpp', `
typedef int MyInt;
typedef int (*handler)(int);
class Guard {
public:
    ~Guard() {}
};
`, 'cpp')
    expect(outcome.symbols.find(sym => sym.name === 'MyInt')).toMatchObject({
      kind: 'type_alias',
      signature: 'typedef int MyInt',
    })
    // A function-pointer typedef keeps the full declarator text as its name
    // (reference parity: the declarator's own text).
    expect(outcome.symbols.find(sym => sym.name === '(*handler)(int)')).toMatchObject({ kind: 'type_alias' })
    expect(outcome.symbols.find(sym => sym.name === '~Guard')).toMatchObject({ kind: 'method', container: 'Guard' })
  })

  it('resolves template constructor calls and qualified new expressions', async () => {
    const outcome = await extractCCpp('newtmpl.cpp', `
namespace box { template<typename T> struct Holder { T item; }; }
void build() {
    Holder<int>* h = new Holder<int>();
    box::Holder<int>* q = new box::Holder<int>();
}
`, 'cpp')
    const ctors = outcome.callEdges.filter(edge => edge.isConstructor)
    // Both the bare `Holder<int>` template type and the qualified
    // `box::Holder<int>` resolve to the bare callee `Holder`.
    expect(ctors.map(edge => edge.calleeSymbol)).toEqual(['Holder', 'Holder'])
    expect(ctors[0]).toMatchObject({ callerSymbol: 'build', argCount: 0 })
  })

  it('skips keyword constructions and complex callees without crashing', async () => {
    const outcome = await extractCCpp('kw.cpp', `
void factory() {
    int* p = new int;
    (*target)(1);
}
`, 'cpp')
    // `new int` names a keyword type; a dereferenced callee is complex.
    expect(outcome.callEdges.filter(edge => edge.isConstructor)).toEqual([])
    expect(outcome.callEdges).toEqual([])
  })

  it('attributes calls outside any function to no caller', async () => {
    const outcome = await extractCCpp('global.c', 'int z = helper();\n', 'c')
    expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')).toMatchObject({
      callerSymbol: null,
      callerSymbolUid: null,
      dispatchKind: 'direct',
    })
  })

  it('keeps deep qualifier chains, template callees, and variadic parameters', async () => {
    const outcome = await extractCCpp('deep.cpp', `
namespace a {
namespace b {
    int compute(int x) { return x; }
    template<typename T> T tf(T x) { return x; }
}
}

template<typename T> struct W {};

W<int>* globalW = new W<int>();

int vprintfStyle(const char* fmt, ...) { return 0; }

template<typename... Ts> int pack(Ts... items) { return 0; }

void run() {
    a::b::compute(1);
    a::b::tf<int>(2);
}
`, 'cpp')
    // `a::b::compute` descends two qualifiers; `u::tf<int>` carries a
    // template callee under a qualifier.
    expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'compute')).toMatchObject({ dispatchKind: 'direct' })
    expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'tf')).toMatchObject({ dispatchKind: 'direct' })
    // A global `new` has no enclosing function.
    const ctor = outcome.callEdges.find(edge => edge.calleeSymbol === 'W')
    expect(ctor).toMatchObject({ isConstructor: true, callerSymbol: null })
    // The C++ grammar writes a C-style ellipsis as a bare token and a
    // template pack as a `variadic_parameter_declaration`; neither carries a
    // parameter type, so both contribute nothing (reference parity).
    expect(outcome.symbols.find(sym => sym.name === 'vprintfStyle')).toMatchObject({ paramTypes: 'char' })
    expect(outcome.symbols.find(sym => sym.name === 'pack')).toMatchObject({ paramTypes: null, paramCount: 0 })
  })

  it('reads a C-style variadic parameter as an ellipsis type', async () => {
    const outcome = await extractCCpp('varia.c', 'int vprintfStyle(const char* fmt, ...) { return 0; }\n', 'c')
    // The `type` field holds the bare type (`const` and `*` live outside it).
    expect(outcome.symbols.find(sym => sym.name === 'vprintfStyle')).toMatchObject({
      paramTypes: 'char, ...',
      paramCount: 2,
    })
  })

  it('skips forward declarations and anonymous declarations without crashing', async () => {
    const outcome = await extractCCpp('fwd.c', `
struct Forward;
enum ForwardEnum;
struct { int hidden; };
void declaredLater(int);
`, 'c')
    // Forward/variable declarations and bodyless or anonymous specifiers
    // yield nothing.
    expect(outcome.symbols).toEqual([])
  })
})
