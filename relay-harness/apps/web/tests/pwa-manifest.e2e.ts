import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium } from 'playwright'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Relay Harness',
    short_name: 'RLH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it.each([
  { scheme: 'light' as const, color: 'rgb(0, 0, 0)' },
  { scheme: 'dark' as const, color: 'rgb(255, 255, 255)' },
])('paints the shipped favicon with contrasting fill and strokes in $scheme mode', async ({ scheme, color }) => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ colorScheme: scheme })
    await page.goto(`data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}`)
    const fills = await page.locator('svg circle').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).fill))
    const strokes = await page.locator('svg path').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).stroke))
    expect(fills).toEqual([color])
    expect(strokes).toEqual([color, color])
    expect(await page.locator('svg').getAttribute('viewBox')).toBe('0 0 50 50')
  } finally { await browser.close() }
})
