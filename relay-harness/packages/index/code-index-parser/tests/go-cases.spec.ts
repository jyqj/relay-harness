import { describe, expect, it } from 'vitest'
import { extractGo } from '../src/languages/go.ts'
import { isTestFile } from '../src/test-detect.ts'

/**
 * The reference implementation's 11 embedded Go test cases
 * (`crates/cc-parsers/src/go.rs` `mod tests`), transcribed case by case into
 * a table. Cases whose assertions target route edges, data-flow edges, HTTP
 * call edges, or in-file ref resolution are adapted to this phase's surface:
 * the same source parses and the surviving extraction (symbols / imports /
 * call edges) is asserted instead. Every adaptation is marked in `note`.
 * Branch cases for the walker's error-recovery paths close the file.
 */

interface GoCase {
  readonly name: string
  readonly file: string
  readonly code: string
  readonly note?: string
  readonly check: (outcome: Awaited<ReturnType<typeof extractGo>>) => void
}

const CASES: readonly GoCase[] = [
  {
    name: 'parse_simple_go',
    file: 'main.go',
    code: `package main

import (
    "fmt"
    "os"
)

type Greeter struct {
    Name string
}

type Reader interface {
    Read(p []byte) (n int, err error)
}

type ID = string

func (g *Greeter) Greet() string {
    return fmt.Sprintf("hello %s", g.Name)
}

func main() {
    g := Greeter{Name: "world"}
    fmt.Println(g.Greet())
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Greeter')
      expect(names).toContain('Reader')
      expect(names).toContain('Greet')
      expect(names).toContain('main')
      expect(names).toContain('ID')
      expect(outcome.imports.length).toBeGreaterThan(0)
      expect(outcome.callEdges.length).toBeGreaterThan(0)
      // Reference asserts parser_tier/chunks; tier and confidence ride every record.
      expect(outcome.symbols[0]).toMatchObject({ parserTier: 'tree-sitter', parserConfidence: 0.7 })
      expect(isTestFile('main.go', 'go')).toBe(false)
      expect(isTestFile('main_test.go', 'go')).toBe(true)
    },
  },
  {
    name: 'parse_method_receiver',
    file: 'server.go',
    code: `package main

type Server struct {}

func (s *Server) Start(addr string, port int) error {
    return nil
}
`,
    check: (outcome) => {
      const method = outcome.symbols.find(sym => sym.name === 'Start')
      expect(method).toMatchObject({
        kind: 'method',
        receiverType: 'Server',
        container: 'Server',
        qname: 'Server.Start',
        paramTypes: 'string, int',
        paramCount: 2,
        returnType: 'error',
      })
    },
  },
  {
    name: 'parse_imports',
    file: 'main.go',
    code: `package main

import "fmt"

import (
    "os"
    myalias "encoding/json"
)

func main() {}
`,
    check: (outcome) => {
      expect(outcome.imports).toHaveLength(3)
      const fmtImp = outcome.imports.find(imp => imp.importString === 'fmt')
      expect(fmtImp).toMatchObject({ importedName: 'fmt', alias: null, isNamespace: false })
      const jsonImp = outcome.imports.find(imp => imp.importString === 'encoding/json')
      expect(jsonImp).toMatchObject({ importedName: 'json', alias: 'myalias' })
    },
  },
  {
    name: 'parse_struct_embedded_field',
    file: 'embed.go',
    note: 'embedded-field semantic edges are out of scope; both struct symbols survive',
    code: `package main

type Base struct {
    ID int
}

type Derived struct {
    Base
    Name string
}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('Base')
      expect(names).toContain('Derived')
    },
  },
  {
    name: 'parse_call_dispatch_kinds',
    file: 'calls.go',
    code: `package main

import "fmt"

func helper() {}

func main() {
    helper()
    fmt.Println("hi")
}
`,
    check: (outcome) => {
      const direct = outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')
      expect(direct).toMatchObject({ dispatchKind: 'direct', callKind: 'direct', callerSymbol: 'main' })
      const dynamic = outcome.callEdges.find(edge => edge.calleeSymbol === 'Println')
      expect(dynamic).toMatchObject({ dispatchKind: 'dynamic', callKind: 'member', receiverExpr: 'fmt' })
    },
  },
  {
    name: 'parse_gin_route_edges',
    file: 'routes.go',
    note: 'route edges are out of scope; the handlers and the three registrations survive as call edges',
    code: `package main

import "github.com/gin-gonic/gin"

func setupRouter() {
    r := gin.Default()
    r.GET("/api/users", getUsers)
    r.POST("/api/users", createUser)
    r.DELETE("/api/users/:id", deleteUser)
}

func getUsers(c *gin.Context) {}
func createUser(c *gin.Context) {}
func deleteUser(c *gin.Context) {}
`,
    check: (outcome) => {
      const names = outcome.symbols.map(sym => sym.name)
      expect(names).toContain('getUsers')
      expect(names).toContain('createUser')
      expect(names).toContain('deleteUser')
      const callees = outcome.callEdges.filter(edge => edge.receiverExpr === 'r').map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['GET', 'POST', 'DELETE']))
    },
  },
  {
    name: 'parse_net_http_route_edges',
    file: 'server.go',
    note: 'route edges are out of scope; the two HandleFunc registrations survive as call edges',
    code: `package main

import "net/http"

func main() {
    http.HandleFunc("/health", healthHandler)
    http.HandleFunc("/api/data", dataHandler)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {}
func dataHandler(w http.ResponseWriter, r *http.Request) {}
`,
    check: (outcome) => {
      const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['HandleFunc', 'HandleFunc']))
    },
  },
  {
    name: 'parse_echo_route_edges',
    file: 'echo_server.go',
    note: 'route edges are out of scope; the three registrations survive as call edges',
    code: `package main

import "github.com/labstack/echo/v4"

func main() {
    e := echo.New()
    e.GET("/users", getUsers)
    e.POST("/users", createUser)
    e.PUT("/users/:id", updateUser)
}

func getUsers(c echo.Context) error { return nil }
func createUser(c echo.Context) error { return nil }
func updateUser(c echo.Context) error { return nil }
`,
    check: (outcome) => {
      const callees = outcome.callEdges.filter(edge => edge.receiverExpr === 'e').map(edge => edge.calleeSymbol)
      expect(callees).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT']))
    },
  },
  {
    name: 'test_go_env_access_getenv',
    file: 'config.go',
    note: 'data-flow edges are out of scope; the enclosing function still extracts',
    code: `package main

import "os"

func loadConfig() {
    dbUrl := os.Getenv("DATABASE_URL")
    _ = dbUrl
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'loadConfig')).toBeDefined()
    },
  },
  {
    name: 'test_go_env_access_lookupenv',
    file: 'api.go',
    note: 'data-flow edges are out of scope; the enclosing function still extracts',
    code: `package main

import "os"

func initAPI() {
    key, ok := os.LookupEnv("API_KEY")
    if !ok {
        panic("missing API_KEY")
    }
    _ = key
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'initAPI')).toBeDefined()
    },
  },
  {
    name: 'extract_outbound_http_calls',
    file: 'client.go',
    note: 'HTTP-call edges are out of scope; the enclosing function still extracts',
    code: `package main

import "net/http"

func fetchUsers() {
    http.Get("https://api.example.com/users")
    req, _ := http.NewRequest("POST", "/api/orders/123", nil)
    _ = req
    m := map[string]int{}
    _ = m["x"]
}
`,
    check: (outcome) => {
      expect(outcome.symbols.find(sym => sym.name === 'fetchUsers')).toBeDefined()
    },
  },
]

describe('reference go cases (table-driven)', () => {
  it.each(CASES.map(testCase => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const outcome = await extractGo(testCase.file, testCase.code)
      testCase.check(outcome)
    },
    30_000,
  )
})

describe('go walker branches', () => {
  it('renders signatures, multi-name and variadic parameters, and result lists', async () => {
    const outcome = await extractGo('params.go', `package main

func plain() {}
func named(a, b int) (n int, err error) { return 0, nil }
func variadic(prefix string, rest ...int) {}
func unnamed(int) {}
func parenResult() () { return }
`)
    const plain = outcome.symbols.find(sym => sym.name === 'plain')
    expect(plain).toMatchObject({ signature: 'func plain()', paramTypes: null, paramCount: 0, returnType: null })
    // The result list keeps its full text; `a, b int` counts two parameters.
    expect(outcome.symbols.find(sym => sym.name === 'named')).toMatchObject({
      signature: 'func named(a, b int) (n int, err error)',
      paramTypes: 'int, int',
      paramCount: 2,
      returnType: '(n int, err error)',
    })
    expect(outcome.symbols.find(sym => sym.name === 'variadic')).toMatchObject({
      paramTypes: 'string, ...int',
      paramCount: 2,
    })
    // An unnamed declaration counts as one parameter.
    expect(outcome.symbols.find(sym => sym.name === 'unnamed')).toMatchObject({ paramTypes: 'int', paramCount: 1 })
    // A bare result list keeps its text verbatim (reference parity).
    expect(outcome.symbols.find(sym => sym.name === 'parenResult')).toMatchObject({ returnType: '()' })
  })

  it('maps type declarations: structs, interfaces, and aliases', async () => {
    const outcome = await extractGo('types.go', `package main

type A struct{ X int }
type B interface{ M() }
type C = string
type MyInt int
`)
    expect(outcome.symbols.find(sym => sym.name === 'A')).toMatchObject({ kind: 'class', signature: 'type A struct' })
    expect(outcome.symbols.find(sym => sym.name === 'B')).toMatchObject({ kind: 'interface', signature: 'type B interface' })
    expect(outcome.symbols.find(sym => sym.name === 'C')).toMatchObject({ kind: 'type_alias', signature: 'type C = string' })
    // A defined type that is neither struct nor interface lands as type_alias.
    expect(outcome.symbols.find(sym => sym.name === 'MyInt')).toMatchObject({ kind: 'type_alias', signature: 'type MyInt type' })
  })

  it('keeps the end line of bodyless declarations at the declaration itself', async () => {
    // A bodyless declaration is a syntax error the grammar recovers from; the
    // walker keeps the record with the node's own span.
    const outcome = await extractGo('bodyless.go', 'package main\n\nfunc noBody()\n')
    const noBody = outcome.symbols.find(sym => sym.name === 'noBody')
    expect(noBody).toBeDefined()
    expect(noBody!.endLine).toBe(noBody!.startLine)
  })

  it('skips calls the reference skips: parenthesized callees and keyword builtins', async () => {
    const outcome = await extractGo('skip.go', `package main

func main() {
    (fog)()
    len(x)
}
`)
    const callees = outcome.callEdges.map(edge => edge.calleeSymbol)
    expect(callees).not.toContain('fog')
    expect(callees).not.toContain('len')
    // The outer call of `fog()` chain is skipped; `len(x)` is a keyword.
    expect(outcome.callEdges).toHaveLength(0)
  })

  it('recovers from receivers the grammar cannot fully type', async () => {
    // `(r)` recovers as an unnamed parameter of type `r`; an empty receiver
    // skips the method symbol while its body's calls still extract caller-less.
    const outcome = await extractGo('broken.go', `package main

func helper() {}

func (r) NoType() {}

func () Anonymous() {
    helper()
}
`)
    expect(outcome.symbols.find(sym => sym.name === 'NoType')).toMatchObject({
      kind: 'method',
      receiverType: 'r',
      container: 'r',
      qname: 'r.NoType',
    })
    expect(outcome.symbols.some(sym => sym.name === 'Anonymous')).toBe(false)
    const call = outcome.callEdges.find(edge => edge.calleeSymbol === 'helper')
    expect(call).toMatchObject({ callerSymbol: null, callerSymbolUid: null })
  })
})
