/** Resident conversation and lazily visited main pages share the center column. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { MainNavigationSnapshot } from './navigation.ts'
import css from './MainContent.module.css'

/** Layout navigation and registered main pages, bound by the slot renderer. */
export interface MainContentInjected {
  hooks: {
    mainNavigation: HostObservable<MainNavigationSnapshot>
    mainPages: HostObservable<readonly string[]>
  }
}
export type MainContentProps = PropsRuntime<'shell.main'>
  & PropsRenderSlots<'conversation' | 'shell.page'> & InjectFace<MainContentInjected>

/** Keep drafts and scroll state mounted while excluding hidden content from focus and accessibility.
 * @param props - Main-page navigation, registry, and authorized child slots.
 * @returns Resident center-column views.
 */
export function MainContent({ useMainNavigation, useMainPages, renderSlot }: MainContentProps) {
  const navigation = useMainNavigation(value => value)
  const pages = useMainPages(value => value)
  const page = pages.includes(navigation.page) ? navigation.page : 'conversation'
  const [visited, setVisited] = useState<readonly string[]>([])
  const host = useRef<HTMLDivElement>(null)
  const lastRevision = useRef(navigation.revision)
  useEffect(() => {
    setVisited(previous => {
      const next = previous.filter(key => pages.includes(key))
      if (page !== 'conversation' && !next.includes(page)) next.push(page)
      return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next
    })
  }, [page, pages])
  useLayoutEffect(() => {
    if (lastRevision.current === navigation.revision) return
    lastRevision.current = navigation.revision
    const active = host.current?.querySelector<HTMLElement>('[data-main-page]:not([hidden])')
    active?.focus({ preventScroll: true })
  }, [navigation.revision, page])
  return <div ref={host} className={css.root} data-main-content>
    <div className={css.conversation} hidden={page !== 'conversation'} tabIndex={-1} data-main-page="conversation">
      {renderSlot('conversation', {})}
    </div>
    {pages.filter(key => key === page || visited.includes(key)).map(key => (
      <div key={key} className={css.page} hidden={page !== key} tabIndex={-1} data-main-page={key}>
        {renderSlot('shell.page', { active: page === key }, { entryKey: key })}
      </div>
    ))}
  </div>
}
