/**
 * Motion stylesheet contract: recipes transition only opacity and transform,
 * the legacy `--rl-*` duration/easing tokens stay retired, and reduced-motion
 * zeros the `--rlw-motion-*` ladder and disables every recipe.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const STYLES = new URL('../src/styles/', import.meta.url)
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, STYLES)), 'utf8')

const baseCss = read('base.css')
const motionCss = read('motion.css')

describe('motion recipes', () => {
  it('declares overlay, popover, fade, swap, and flip recipes', () => {
    expect(motionCss).toContain("[data-rlh-motion='overlay']")
    expect(motionCss).toContain("[data-rlh-motion='popover']")
    expect(motionCss).toContain("[data-rlh-motion='fade']")
    expect(motionCss).toContain("[data-rlh-motion='swap']")
    expect(motionCss).toContain("[data-rlh-motion='flip']")
    expect(motionCss).toContain('data-rlh-motion-part')
  })

  it('transitions only opacity and transform', () => {
    const transitions = [...motionCss.matchAll(/transition(?:-property)?:\s*([^;]+);/g)]
      .map(([, value = '']) => value)
      .filter(value => value.trim() !== 'none')
    expect(transitions.length).toBeGreaterThan(0)
    for (const value of transitions) {
      const properties = value
        .split(',')
        .map(part => part.trim().split(/\s+/)[0])
        .filter(name => name !== undefined && name !== 'opacity' && name !== 'transform')
      expect(properties, value).toEqual([])
    }
  })

  it('retires the legacy --rl duration and easing tokens', () => {
    expect(baseCss).not.toMatch(/--rl-transition-duration|--rl-motion-duration|--rl-ease-in-out/)
    expect(motionCss).not.toMatch(/var\(--rl-/)
  })

  it('zeros the motion ladder under prefers-reduced-motion', () => {
    expect(baseCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(baseCss).toMatch(/--rlw-motion-quick:\s*0s/)
    expect(baseCss).toMatch(/--rlw-motion-base:\s*0s/)
    expect(baseCss).toMatch(/--rlw-motion-slow:\s*0s/)
  })

  it('disables every recipe transition and animation under prefers-reduced-motion', () => {
    const reduced = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain("[data-rlh-motion='overlay'][data-state='closed']")
    expect(reduced).toContain("[data-rlh-motion='popover']")
    expect(reduced).toContain("[data-rlh-motion='fade']")
    expect(reduced).toMatch(/transition:\s*none/)
    expect(reduced).toMatch(/animation:\s*none/)
  })
})
