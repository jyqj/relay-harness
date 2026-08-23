// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-rlh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('正在加载插件…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-rlh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--rlh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--rlh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-rlh-boot-spinner]')).toBe(spinner)
    expect(el.textContent).toContain('正在加载插件 1/2')
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--rlh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('正在加载插件 2/2')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@relay-harness/rlh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@relay-harness/rlh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@relay-harness/rlh-client-ui-layout')
    expect(el.textContent).toContain('@relay-harness/rlh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('正在加载插件')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('正在加载插件')
  })

  it('exposes boot progress and failure as data attributes for the desktop probe', () => {
    const { el, page } = mount()
    page.setTotal(2)
    page.setState('a', 'active')
    page.setState('b', 'loading')
    const boot = el.querySelector<HTMLElement>('[data-rlhd-boot-status="loading"]')
    expect(boot).toBeTruthy()
    expect(boot?.getAttribute('data-rlhd-boot-ready')).toBe('1')
    expect(boot?.getAttribute('data-rlhd-boot-total')).toBe('2')
    expect(boot?.getAttribute('data-rlhd-boot-error')).toBe('')
    page.fail('boom')
    const failedRoot = el.querySelector<HTMLElement>('[data-rlhd-boot-status="failed"]')
    expect(failedRoot).toBeTruthy()
    expect(failedRoot?.getAttribute('data-rlhd-boot-error')).toBe('boom')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})
