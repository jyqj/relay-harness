import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openCodeIndexDatabase, writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'
import type { FileUpsert } from '@relay-harness/rlh-code-index-sqlite'
import { parseFile } from '@relay-harness/rlh-code-index-parser'
import type { ParseOutcome } from '@relay-harness/rlh-code-index-parser'
import { buildGraphDelta } from '../src/store/writer.ts'

/**
 * Real corpus: this repository's parser sources. Same-key repeats (same-name
 * locals of different functions sharing a `symbolUid`) occur in these files,
 * so the chain below exercises exactly the write path that UNIQUE constraints
 * blocked before the dedupe pass.
 */
const CORPUS_ROOT = join(import.meta.dirname, '..', '..', 'code-index-parser', 'src')

/** Collect every .ts file under `dir` (recursively). */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) tsFiles(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('real-corpus parse-to-store chain', () => {
  it('writes parser-source outcomes into an in-memory store without key conflicts', async () => {
    const outcomes = new Map<string, ParseOutcome>()
    for (const full of tsFiles(CORPUS_ROOT)) {
      const relPath = full.slice(CORPUS_ROOT.length + 1)
      const outcome = await parseFile(relPath, readFileSync(full, 'utf8'), {
        projectRoot: CORPUS_ROOT,
        maxFileBytes: 1_000_000,
      })
      if (outcome !== null) outcomes.set(relPath, outcome)
    }
    expect(outcomes.size).toBeGreaterThan(10)

    const delta = buildGraphDelta(outcomes)
    // The corpus must actually contain same-key repeats, or this chain no
    // longer exercises the dedupe pass; revisit the corpus if this fails.
    expect(delta.duplicatesDropped).toBeGreaterThanOrEqual(1)

    // No deduplicated row set carries a repeating store key.
    for (const rows of delta.byFile.values()) {
      expect(new Set(rows.symbols.map(row => row.symbolId)).size).toBe(rows.symbols.length)
      expect(new Set(rows.symbols.map(row => row.symbolUid)).size).toBe(rows.symbols.length)
      expect(new Set(rows.callEdges.map(row => row.edgeId)).size).toBe(rows.callEdges.length)
      expect(new Set(rows.literals.map(row => row.literalId)).size).toBe(rows.literals.length)
    }

    const db = await openCodeIndexDatabase(':memory:')
    const upserts: FileUpsert[] = [...outcomes.entries()].map(([filePath, outcome]) => ({
      filePath,
      language: outcome.language,
      contentHash: `hash-${filePath}`,
      mtime: 1,
      size: 1,
      summary: outcome.summary,
      contentExcerpt: outcome.contentExcerpt,
      parserTier: outcome.parserTier,
      parserConfidence: outcome.parserConfidence,
      isTestFile: outcome.isTestFile,
      chunks: [],
    }))
    expect(() => writeFilesDelta(db, { removals: [], upserts, graph: delta })).not.toThrow()

    const totalSymbols = [...delta.byFile.values()].reduce((sum, rows) => sum + rows.symbols.length, 0)
    const totalLiterals = [...delta.byFile.values()].reduce((sum, rows) => sum + rows.literals.length, 0)
    const totalCallEdges = [...delta.byFile.values()].reduce((sum, rows) => sum + rows.callEdges.length, 0)
    expect(db.prepare('SELECT count(*) AS n FROM symbols').get()).toEqual({ n: totalSymbols })
    expect(db.prepare('SELECT count(*) AS n FROM literal_index').get()).toEqual({ n: totalLiterals })
    expect(db.prepare('SELECT count(*) AS n FROM call_edges').get()).toEqual({ n: totalCallEdges })
  })
})

describe('spec-driven same-key symbols through the full chain', () => {
  /**
   * A Ruby file whose keys collide: the class reopens, and `def self.build`
   * captures the bare name `build` just like a plain method — so the literal
   * `spec:<file>:<kind>:<name>` ids (and their content-derived uids) repeat.
   */
  const REOPEN_RB = [
    'class Widget',
    '  def self.build',
    '    :first',
    '  end',
    '',
    '  def describe',
    "    'first widget'",
    '  end',
    'end',
    '',
    'class Widget',
    '  def describe',
    "    'reopened widget'",
    '  end',
    '',
    '  def self.build',
    '    :second',
    '  end',
    'end',
    '',
  ].join('\n')

  async function parseReopenFixture(): Promise<ParseOutcome> {
    const outcome = await parseFile('src/widget.rb', REOPEN_RB, {
      projectRoot: '/tmp/rlh-reopen',
      maxFileBytes: 1_000_000,
    })
    expect(outcome).not.toBeNull()
    return outcome as ParseOutcome
  }

  it('absorbs same-key redefinitions at the delta exit: zero UNIQUE conflicts, first record kept', async () => {
    const outcome = await parseReopenFixture()
    // The fixture must actually collide, or this chain no longer exercises
    // the dedupe pass; revisit the fixture if this fails.
    const ids = outcome.symbols.map(symbol => symbol.symbolId)
    expect(new Set(ids).size).toBeLessThan(ids.length)

    const delta = buildGraphDelta(new Map([['src/widget.rb', outcome]]))
    expect(delta.duplicatesDropped).toBeGreaterThanOrEqual(3)

    const fileUpsert: FileUpsert = {
      filePath: 'src/widget.rb',
      language: outcome.language,
      contentHash: 'hash-widget',
      mtime: 1,
      size: 1,
      summary: outcome.summary,
      contentExcerpt: outcome.contentExcerpt,
      parserTier: outcome.parserTier,
      parserConfidence: outcome.parserConfidence,
      isTestFile: outcome.isTestFile,
      chunks: [],
    }
    const db = await openCodeIndexDatabase(':memory:')
    // A surviving repeat would violate the symbols primary key here.
    expect(() => writeFilesDelta(db, { removals: [], upserts: [fileUpsert], graph: delta })).not.toThrow()

    // The kept rows are the FIRST occurrences: Widget@1, build@2, describe@6.
    const rows = db.prepare(
      'SELECT name, start_line FROM symbols WHERE file_path = ? ORDER BY start_line ASC',
    ).all('src/widget.rb') as Array<{ name: string; start_line: number }>
    expect(rows).toEqual([
      { name: 'Widget', start_line: 1 },
      { name: 'build', start_line: 2 },
      { name: 'describe', start_line: 6 },
    ])
    db.close()
  })
})
