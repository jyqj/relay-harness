import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

/**
 * Permanent behavioral documentation of `node:sqlite` BLOB binding and STRICT
 * table semantics, probed on the current runtime (Node v24.10.0).
 *
 * This suite is a contract record, not a test of owned code: R4+ (the vector
 * column and vector-math encode/decode layer) aligns its encoder on exactly
 * these observed behaviors instead of re-probing the driver. Each assertion
 * pins a decision input:
 *
 * - BLOB reads surface plain `Uint8Array`, never `Buffer` — decoders must not
 *   rely on Buffer-only methods without an explicit wrap.
 * - STRICT `BLOB` columns reject TEXT and numeric storage classes at the SQL
 *   layer; booleans/undefined are rejected at the JS binding layer before any
 *   SQLite type check runs.
 * - An empty BLOB and a NULL are distinct storage states — the vector column
 *   may use NULL as "no embedding" while zero-length remains a real value.
 * - JS `number` binds as SQLite REAL (see the `typeof` probe) — a vector
 *   dimension or byte-size written from a JS number lands as REAL, which
 *   STRICT INTEGER columns only accept when the value is losslessly integral.
 *
 * Counter-intuitive findings recorded for R4:
 * - Read-back constructor is `Uint8Array` even when a `Buffer` was written;
 *   `instanceof Buffer` is false on both sides of the round trip.
 * - Binding a JS number into a BLOB column fails with "cannot store REAL
 *   value" even for an integral input like `42`, because the binding layer
 *   tagged it REAL before STRICT rejects the storage class.
 * - `DataView` is also accepted as a BLOB binding alongside `Uint8Array`;
 *   DOM `Blob` is not a supported binding.
 */

/** Fresh in-memory database with the STRICT probe table used across cases. */
function openProbeDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE blob_probe (id INTEGER PRIMARY KEY, v BLOB NOT NULL) STRICT')
  return db
}

/** Insert one BLOB value and read the single-column row back. */
function roundTrip(db: DatabaseSync, value: Uint8Array): { v: unknown } {
  db.prepare('INSERT INTO blob_probe (v) VALUES (?)').run(value)
  return db.prepare('SELECT v FROM blob_probe ORDER BY id DESC LIMIT 1').get() as { v: unknown }
}

describe('node:sqlite BLOB binding under STRICT (behavior record for the vector column)', () => {
  it('binds Uint8Array into a BLOB column and reads back an equal-byte plain Uint8Array', () => {
    const db = openProbeDatabase()
    const vector = new Uint8Array([0, 1, 2, 250, 251, 255, 0, 128])
    const row = roundTrip(db, vector)

    expect(row.v).toBeInstanceOf(Uint8Array)
    expect(row.v).not.toBeInstanceOf(Buffer)
    expect(Array.isArray(row.v)).toBe(false)
    expect(Buffer.from(row.v as Uint8Array).compare(vector)).toBe(0)
    db.close()
  })

  it('rejects TEXT and numeric values in a STRICT BLOB column, naming the storage class', () => {
    const db = openProbeDatabase()
    const insert = db.prepare('INSERT INTO blob_probe (v) VALUES (?)')

    expect(() => insert.run('text')).toThrow('cannot store TEXT value in BLOB column')
    // A JS number binds as REAL even when integral, so the STRICT error names
    // REAL for both 42 and 3.5 — the binding layer never produces INTEGER.
    expect(() => insert.run(42)).toThrow('cannot store REAL value in BLOB column')
    expect(() => insert.run(3.5)).toThrow('cannot store REAL value in BLOB column')
    db.close()
  })

  it('rejects booleans and undefined at the binding layer and NULL at the NOT NULL constraint', () => {
    const db = openProbeDatabase()
    const insert = db.prepare('INSERT INTO blob_probe (v) VALUES (?)')

    // Binding-layer refusals: these never reach SQLite's type checking. The
    // driver's own types already forbid both values, so the deliberate misuse
    // needs expects-error — the runtime refusal is the behavior under record.
    // @ts-expect-error booleans are not a supported SQLite binding
    expect(() => insert.run(true)).toThrow('Provided value cannot be bound to SQLite parameter')
    // @ts-expect-error undefined is not a supported SQLite binding
    expect(() => insert.run(undefined)).toThrow('Provided value cannot be bound to SQLite parameter')
    // null binds as SQL NULL, so the failure is the column constraint instead.
    expect(() => insert.run(null)).toThrow('NOT NULL constraint failed')
    db.close()
  })

  it('distinguishes an empty BLOB from NULL as separate storage states', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE nullable_blob (id INTEGER PRIMARY KEY, b BLOB) STRICT')
    const insert = db.prepare('INSERT INTO nullable_blob (b) VALUES (?)')
    insert.run(new Uint8Array(0))
    insert.run(null)

    const rows = db.prepare('SELECT id, b, typeof(b) AS storageClass FROM nullable_blob ORDER BY id').all() as Array<{
      id: number
      b: unknown
      storageClass: string
    }>
    expect(rows).toHaveLength(2)
    const emptyRow = rows[0] as { id: number; b: Uint8Array; storageClass: string }
    const nullRow = rows[1] as { id: number; b: null; storageClass: string }
    expect(emptyRow.storageClass).toBe('blob')
    expect(emptyRow.b).toBeInstanceOf(Uint8Array)
    expect(emptyRow.b.length).toBe(0)
    expect(nullRow.storageClass).toBe('null')
    expect(nullRow.b).toBeNull()
    db.close()
  })

  it('round-trips 1KB/64KB/1MB payloads byte-for-byte (sizes logged, timings not asserted)', () => {
    const db = openProbeDatabase()
    const insert = db.prepare('INSERT INTO blob_probe (v) VALUES (?)')
    const select = db.prepare('SELECT v FROM blob_probe ORDER BY id DESC LIMIT 1')

    for (const byteLength of [1024, 65536, 1048576]) {
      const vector = new Uint8Array(byteLength)
      for (let index = 0; index < byteLength; index += 1) {
        vector[index] = index & 0xff
      }
      const writeStart = performance.now()
      insert.run(vector)
      const writeMs = performance.now() - writeStart

      const readStart = performance.now()
      const row = select.get() as { v: Uint8Array }
      const readMs = performance.now() - readStart

      expect(row.v).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(row.v).compare(vector)).toBe(0)
      // Performance awareness only: R4 sizes its batching from these orders
      // of magnitude, so the numbers stay visible in test output.
      console.log(`blob round-trip ${byteLength} bytes: write ${writeMs.toFixed(3)}ms, read ${readMs.toFixed(3)}ms`)
    }
    db.close()
  })

  it('accepts a Buffer subtype on write but still surfaces a plain Uint8Array on read', () => {
    const db = openProbeDatabase()
    const buffer = Buffer.from([9, 8, 7, 6])
    const row = roundTrip(db, buffer)

    expect(row.v).toBeInstanceOf(Uint8Array)
    expect(row.v).not.toBeInstanceOf(Buffer)
    expect(Buffer.from(row.v as Uint8Array).compare(buffer)).toBe(0)
    db.close()
  })

  it('binds DataView as BLOB and stores bigint as INTEGER, unlike JS numbers', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE binding_probe (v BLOB, n) ')
    db.prepare('INSERT INTO binding_probe (v, n) VALUES (?, ?)').run(new DataView(new ArrayBuffer(4)), 42n)

    const storage = db.prepare('SELECT typeof(n) AS storageClass FROM binding_probe').get() as { storageClass: string }
    expect(storage.storageClass).toBe('integer')

    db.prepare('INSERT INTO binding_probe (n) VALUES (?)').run(42)
    const numberStorage = db
      .prepare('SELECT typeof(n) AS storageClass FROM binding_probe ORDER BY rowid DESC LIMIT 1')
      .get() as { storageClass: string }
    // The load-bearing contrast for R4: JS numbers bind as REAL, bigint as INTEGER.
    expect(numberStorage.storageClass).toBe('real')
    db.close()
  })
})
