// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@relay-harness/rlh-client-ui-primitives'
import {
  IconApiOutline14, IconArchiveOutline20, IconFolderClose16, IconGoalOutline16, IconSendOutline16,
} from '@relay-harness/rlh-client-ui-primitives'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('ic_rl_ icon set', () => {
  it('exports the full icon set (46 shared-library glyphs + 20 figma extracts + nine product glyphs outside those sets)', () => {
    expect(iconNames.length).toBe(77)
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutline16 size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutline14 />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderClose16 />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutline20 />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutline16 /><IconGoalOutline16 /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })
})

describe('RelayMark', () => {
  it('renders the node and both chevrons in currentColor at the native ratio', () => {
    const { container } = render(<primitives.RelayMark />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(Number(svg.getAttribute('height'))).toBeCloseTo(16.67, 1)
    expect(svg.getAttribute('viewBox')).toBe('0 0 40.6 28.2')
    expect(container.querySelectorAll('circle')).toHaveLength(1)
    expect(container.querySelectorAll('path')).toHaveLength(2)
    expect(container.innerHTML).toContain('currentColor')
  })
})

describe('BrandWordmark', () => {
  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('130.65')
    expect(svg.getAttribute('viewBox')).toBe('0 0 130.65 24')
    expect(view.container.querySelectorAll('circle')).toHaveLength(1)

    // Dropping the mark crops it out of the box rather than reflowing the word,
    // so the artwork stays pixel-aligned with the full lockup beside it.
    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(svg.getAttribute('width')).toBe('104.65')
    expect(svg.getAttribute('viewBox')).toBe('26 0 104.65 24')
    expect(view.container.querySelectorAll('circle')).toHaveLength(0)
  })

  it('draws the word as outlines so no host font can reflow it', () => {
    const { container } = render(<primitives.BrandWordmark />)
    expect(container.querySelector('text')).toBeNull()
    expect(container.innerHTML).not.toContain('font-family')
  })
})
