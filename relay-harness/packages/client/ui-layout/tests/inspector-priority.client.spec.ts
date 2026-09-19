// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { computeColumns } from '../src/client/columns.ts'
import { createLayoutStore } from '../src/client/stores.ts'
import { LayoutController } from '../src/client/service.ts'

beforeEach(() => { localStorage.clear() })
describe('explicit inspector intent', () => {
  it('opens a file surface after tool details at 1440px without an invisible open state', () => {
    const instance = createLayoutStore().create()
    const layout = new LayoutController()
    layout.attachPanels(instance.actions)
    layout.openDetails(); layout.openSurfaces()
    const state = instance.getSnapshot()
    const widths = computeColumns(1440, state.sidebar, state.details, state.surfaces, true)
    expect(widths).toEqual({ sidebar: 280, center: 620, details: 0, surfaces: 540 })
    expect(state.details).toBe(0)
    layout.openDetails()
    expect(instance.getSnapshot()).toMatchObject({ details: 360, surfaces: 0 })
    layout.openMain('work')
    expect(layout.mainNavigation.getSnapshot().page).toBe('work')
    expect(instance.getSnapshot()).toMatchObject({ details: 0, surfaces: 0, narrowExpanded: false })
  })

  it.each([320, 390, 768, 980, 1024, 1280, 1440, 1920])('keeps the chosen surface visible and within a %dpx frame', viewport => {
    const result = computeColumns(viewport, viewport < 1024 ? 0 : 280, 360, 540, true)
    expect(result.surfaces).toBeGreaterThan(0)
    expect(result.details).toBe(0)
    expect(result.center).toBeGreaterThanOrEqual(0)
    expect(result.sidebar + result.center + result.details + result.surfaces).toBe(viewport)
  })

  it('opening by toggle also dismisses tool details; closing does not resurrect them', () => {
    const { actions, getSnapshot } = createLayoutStore().create()
    actions.openDetails(); actions.toggleSurfaces()
    expect(getSnapshot()).toMatchObject({ surfaces: 540, details: 0 })
    actions.toggleSurfaces()
    expect(getSnapshot()).toMatchObject({ surfaces: 0, details: 0 })
  })
})
