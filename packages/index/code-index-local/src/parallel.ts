/** Deterministic bounded-concurrency helpers for index build stages. */

/**
 * Map inputs concurrently while preserving input order and fail-fast semantics.
 * @param items - ordered work items.
 * @param concurrency - positive worker bound.
 * @param worker - asynchronous item transform.
 * @returns results aligned exactly with `items`.
 */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive safe integer')
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}
