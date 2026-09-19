/** Primary product navigation leaves workspace and Session browsing in place. */
import { IconNewChatOutline16, IconAgentPresetOutline16, IconFolderOpenOutline16 } from '@relay-harness/rlh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type { MainNavigationSnapshot } from '@relay-harness/rlh-client-ui-layout/client'
import type { WorkSummary } from './work-projection.ts'
import css from './ProductShell.module.css'

/** Read-only navigation and current-work observables; actions stay with their owners. */
export interface ProductNavigationInjected {
  hooks: { mainNavigation: HostObservable<MainNavigationSnapshot>; work: HostObservable<WorkSummary> }
  openPage: (page: string) => void
}
export type ProductNavigationProps = PropsRuntime<'sidebar.primary'> & PropsLocale<'productShell'> & InjectFace<ProductNavigationInjected>

/** Render always-available main navigation, including a truthful current-work attention badge.
 * @param props - Sidebar geometry, product copy, and navigation callbacks.
 * @returns Primary navigation independent of the workspace list.
 */
export function ProductNavigation({ wide, useMainNavigation, useWork, openPage, t }: ProductNavigationProps) {
  const page = useMainNavigation(value => value.page)
  const attention = useWork(value => value.availability === 'ready' ? value.approvals + value.questions : 0)
  const items = [
    { key: 'conversation', label: t('nav.chat'), icon: <IconNewChatOutline16 /> },
    { key: 'work', label: t('nav.work'), icon: <IconAgentPresetOutline16 /> },
    { key: 'library', label: t('nav.library'), icon: <IconFolderOpenOutline16 /> },
  ]
  return <nav className={css.navigation} aria-label={t('nav.primary')} data-product-navigation>
    {items.map(item => <button key={item.key} type="button" aria-label={item.label} title={item.label}
      aria-current={page === item.key ? 'page' : undefined} onClick={() => { openPage(item.key) }}>
      {item.icon}{wide ? <span>{item.label}</span> : null}
      {item.key === 'work' && attention > 0 ? <span className={css.badge} aria-label={t('nav.attention', { count: attention })}>{attention}</span> : null}
    </button>)}
  </nav>
}
