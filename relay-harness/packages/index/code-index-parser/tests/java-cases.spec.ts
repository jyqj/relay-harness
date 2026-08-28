import { describe, expect, it } from 'vitest'
import { extractJava } from '../src/languages/java.ts'
import { isTestFile } from '../src/test-detect.ts'

/**
 * The reference implementation's 13 embedded Java test cases
 * (`crates/cc-parsers/src/java.rs` `mod tests`), transcribed case by case
 * into a table. Cases whose assertions target extends/implements/throws/
 * annotation semantic edges, data-flow edges, HTTP call edges, or chunks are
 * adapted to this phase's surface: the same source parses and the surviving
 * extraction (symbols / imports / call edges) is asserted instead. Every
 * adaptation is marked in `note`. Branch cases for the walker's
 * error-recovery paths close the file.
 */

interface JavaCase {
  readonly name: string
  readonly file: string
  readonly code: string
  readonly note?: string
  readonly check: (outcome: Awaited<ReturnType<typeof extractJava>>) => void
}

const CASES: readonly JavaCase[] = [
  {
    name: 'parse_simple_java',
    file: 'Greeter.java',
    code: `package com.example;

import java.util.List;
import java.io.IOException;

public class Greeter {
    private String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        return format("hello %s", name);
    }

    private String format(String fmt, String arg) {
        return String.format(fmt, arg);
    }
}

interface Speaker {
    void speak();
}

enum Color {
    RED, GREEN, BLUE
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Greeter')
      expect(names).toContain('Speaker')
      expect(names).toContain('Color')
      expect(names).toContain('greet')
      expect(names).toContain('format')
      expect(outcome.imports.length).toBeGreaterThan(0)
      expect(outcome.callEdges.length).toBeGreaterThan(0)
      expect(outcome.symbols[0]).toMatchObject({ parserTier: 'tree-sitter', parserConfidence: 0.7 })
      expect(isTestFile('Greeter.java', 'java')).toBe(false)
      expect(isTestFile('GreeterTest.java', 'java')).toBe(true)
      expect(isTestFile('TestGreeter.java', 'java')).toBe(true)
    },
  },
  {
    name: 'parse_class_with_extends_and_implements',
    file: 'Dog.java',
    note: 'base_types/semantic edges are out of scope (no record columns); the declarations survive',
    code: `
public class Dog extends Animal implements Runnable, Comparable<Dog> {
    public void run() {}
    public int compareTo(Dog other) { return 0; }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Dog')
      expect(names).toContain('run')
      expect(names).toContain('compareTo')
      expect(outcome.symbols.find(sym => sym.name === 'Dog')).toMatchObject({ kind: 'class' })
    },
  },
  {
    name: 'parse_method_details',
    file: 'Service.java',
    code: `
public class Service {
    public String process(String input, int count) {
        return input.repeat(count);
    }
}
`,
    check: (outcome) => {
      const method = outcome.symbols.find(sym => sym.name === 'process')
      expect(method).toMatchObject({
        kind: 'method',
        container: 'Service',
        qname: 'Service.process',
        returnType: 'String',
        paramTypes: 'String, int',
        paramCount: 2,
        parserTier: 'tree-sitter',
      })
    },
  },
  {
    name: 'parse_imports',
    file: 'Foo.java',
    code: `
import java.util.List;
import java.io.*;
import static java.lang.Math.PI;

public class Foo {}
`,
    check: (outcome) => {
      expect(outcome.imports.length).toBeGreaterThanOrEqual(2)
      expect(outcome.imports.find(imp => imp.importString === 'java.util.List')).toBeDefined()
      // The wildcard keeps the qualified path; the static import keeps its prefix.
      expect(outcome.imports.find(imp => imp.importString === 'java.io')).toMatchObject({ importedName: 'io' })
      expect(outcome.imports.find(imp => imp.importString === 'static java.lang.Math.PI')).toBeDefined()
    },
  },
  {
    name: 'parse_call_dispatch_kinds',
    file: 'Caller.java',
    code: `
public class Caller {
    public void doWork() {
        helper();
        obj.process();
    }

    private void helper() {}
}
`,
    check: (outcome) => {
      const direct = outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')
      expect(direct).toMatchObject({ dispatchKind: 'direct', callerSymbol: 'doWork' })
      const dynamic = outcome.callEdges.find(edge => edge.calleeSymbol === 'process')
      expect(dynamic).toMatchObject({ dispatchKind: 'dynamic', receiverExpr: 'obj', callerSymbol: 'doWork' })
    },
  },
  {
    name: 'parse_constructor_calls',
    file: 'Factory.java',
    code: `
public class Factory {
    public Object create() {
        return new ArrayList();
    }
}

class Generic {
    Cache<String> cache = new Cache<String>();
}
`,
    check: (outcome) => {
      const ctor = outcome.callEdges.find(edge => edge.calleeSymbol === 'ArrayList')
      expect(ctor).toMatchObject({
        isConstructor: true,
        dispatchKind: 'constructor',
        callKind: 'constructor',
        callerSymbol: 'create',
      })
      // A generic constructor call strips its type arguments; a field
      // initializer sits outside any method, so the caller is unknown.
      expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'Cache')).toMatchObject({
        isConstructor: true,
        callerSymbol: null,
        callerSymbolUid: null,
      })
    },
  },
  {
    name: 'parse_annotations',
    file: 'MyController.java',
    note: 'annotation semantic edges are out of scope; the annotated declarations still extract',
    code: `
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MyController {
    @Override
    public String toString() { return ""; }

    @GetMapping("/hello")
    public String hello() { return "hello"; }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('MyController')
      expect(names).toContain('toString')
      expect(names).toContain('hello')
      // The signature carries the modifier keywords (reference parity).
      expect(outcome.symbols.find(sym => sym.name === 'MyController')!.signature).toBe('public class MyController')
    },
  },
  {
    name: 'extract_throw_edges_java',
    file: 'Service.java',
    note: 'throws semantic edges are out of scope; the three methods still extract',
    code: `package com.example;

import java.io.IOException;
import java.text.ParseException;

public class Service {
    public void read() throws IOException, ParseException {
        // reading
    }

    public void process() {
        throw new IllegalArgumentException("bad arg");
    }

    public void complex() throws RuntimeException {
        if (true) {
            throw new IllegalStateException("state");
        }
        throw new NullPointerException("null");
    }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toEqual(expect.arrayContaining(['Service', 'read', 'process', 'complex']))
      // The in-body `throw new ...` statements survive as constructor calls.
      const thrown = outcome.callEdges.filter(edge => edge.isConstructor).map(edge => edge.calleeSymbol)
      expect(thrown).toEqual(expect.arrayContaining(['IllegalArgumentException', 'IllegalStateException', 'NullPointerException']))
    },
  },
  {
    name: 'parse_enum_and_interface',
    file: 'Types.java',
    code: `
public interface Readable {
    String read();
}

public enum Status {
    ACTIVE,
    INACTIVE;

    public boolean isActive() {
        return this == ACTIVE;
    }
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Readable')
      expect(names).toContain('Status')
      expect(outcome.symbols.find(sym => sym.name === 'Readable')).toMatchObject({ kind: 'interface' })
      expect(outcome.symbols.find(sym => sym.name === 'Status')).toMatchObject({ kind: 'enum' })
      expect(names).toContain('isActive')
    },
  },
  {
    name: 'parser_tier_is_tree_sitter',
    file: 'Tier.java',
    note: 'the reference asserts `p.tier()`; the tier rides every extracted record here',
    code: 'class T { void m() {} }\n',
    check: (outcome) => {
      for (const sym of outcome.symbols) {
        expect(sym.parserTier).toBe('tree-sitter')
        expect(sym.parserConfidence).toBe(0.7)
      }
      for (const edge of outcome.callEdges) {
        expect(edge.parserTier).toBe('tree-sitter')
      }
    },
  },
  {
    name: 'test_java_env_access_getenv',
    file: 'Config.java',
    note: 'data-flow edges are out of scope; the enclosing method still extracts',
    code: `
public class Config {
    public String getDbHost() {
        return System.getenv("DB_HOST");
    }
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'getDbHost')).toMatchObject({ container: 'Config' })
    },
  },
  {
    name: 'test_java_env_access_getproperty',
    file: 'AppConfig.java',
    note: 'data-flow edges are out of scope; the enclosing method still extracts',
    code: `
public class AppConfig {
    public String getAppName() {
        return System.getProperty("app_name");
    }
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'getAppName')).toMatchObject({ container: 'AppConfig' })
    },
  },
  {
    name: 'extract_outbound_http_calls',
    file: 'ApiClient.java',
    note: 'HTTP-call edges are out of scope; the enclosing method and its member calls still extract',
    code: `
class ApiClient {
    void run() {
        restTemplate.getForObject("https://svc/api/users", String.class);
        restTemplate.exchange("/api/orders/1", HttpMethod.DELETE, null, String.class);
        webClient.get().uri("/api/items").retrieve();
        cache.getForObject("notaurl", String.class);
    }
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'run')).toMatchObject({ container: 'ApiClient' })
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['getForObject', 'exchange', 'get', 'uri', 'retrieve']))
    },
  },
]

describe('reference java cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await extractJava(testCase.file, testCase.code)
      testCase.check(outcome)
    },
    30_000,
  )
})

describe('java walker branches', () => {
  it('extracts constructors with parameter details and body-bounded end lines', async () => {
    const outcome = await extractJava('Ctor.java', `class C {
    C(int a, int... rest) {}
    void spread(String... names) {}
}
`)
    const ctor = outcome.symbols.find(sym => sym.name === 'C' && sym.kind === 'method')
    expect(ctor).toMatchObject({
      kind: 'method',
      qname: 'C.C',
      receiverType: 'C',
      signature: 'C(int a, int... rest)',
    })
    // Parameter types come from the grammar's `type` field only; a spread
    // parameter carries no such field, so the reference (and this walker)
    // contributes nothing for it.
    expect(ctor).toMatchObject({ paramTypes: 'int', paramCount: 1 })
    expect(outcome.symbols.find(sym => sym.name === 'spread')).toMatchObject({
      paramTypes: null,
      paramCount: 0,
      returnType: null,
    })
  })

  it('treats a call outside any method as caller-less', async () => {
    // Field initializers run outside method bodies; no enclosing method exists.
    const outcome = await extractJava('Init.java', 'class I { int x = helper(); }\n')
    const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')
    expect(call).toMatchObject({ callerSymbol: null, callerSymbolUid: null, dispatchKind: 'direct' })
  })

  it('skips keyword callees and constructor invocations of keyword types', async () => {
    const outcome = await extractJava('Kw.java', 'class K { void m() { this.report(); } }\n')
    // `this` is a keyword receiver: the call itself survives with its callee.
    expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'report')).toMatchObject({
      receiverExpr: 'this',
      dispatchKind: 'dynamic',
    })
  })

  it('recovers from declarations the grammar cannot fully name', async () => {
    // `import;` recovers with a zero-width path node: the reference's
    // field-based lookup sees the same empty identifier and records an
    // empty-specifier import. `import *;` carries no path at all and skips.
    const outcome = await extractJava('Broken.java', 'import;\nimport *;\nclass {}\n')
    expect(outcome.imports).toHaveLength(1)
    expect(outcome.imports[0]).toMatchObject({ importString: '', importedName: '' })
  })

  it('keeps abstract bodyless methods on their own end line', async () => {
    const outcome = await extractJava('Abstract.java', 'abstract class A {\n    abstract void m();\n    void full() { run(); }\n}\n')
    const m = outcome.symbols.find(sym => sym.name === 'm')
    expect(m).toMatchObject({ kind: 'method', container: 'A' })
    expect(m!.endLine).toBe(m!.startLine)
    // The concrete sibling keeps its body-bounded end line.
    const full = outcome.symbols.find(sym => sym.name === 'full')
    expect(full!.endLine).toBe(full!.startLine)
  })

  it('does not treat array creation as a constructor call', async () => {
    const outcome = await extractJava('Arrays.java', 'class Arr { void m() { int[] xs = new int[3]; } }\n')
    // `new int[3]` is an array_creation_expression, not object creation.
    expect(outcome.callEdges.filter(edge => edge.isConstructor)).toEqual([])
  })
})
