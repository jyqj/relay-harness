import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import css from './ProductShell.module.css'

export interface LibraryPageInjected {
  openFiles: () => void
  openSettings: (section: 'memory' | 'skills' | 'mcp' | 'code-index') => void
}
export type LibraryPageProps = PropsRuntime<'sidebar.page'> & PropsLocale<'productShell'> & InjectFace<LibraryPageInjected>

/** Product launcher over the real Files surface and registered Settings pages. */
export function LibraryPage({ wide, useSessions, openFiles, openSettings, t }: LibraryPageProps) {
  const hasSession = useSessions(state => state.current !== undefined)
  if (!wide) return <div className={css.railMark} aria-label={t('nav.library')}>L</div>
  return <section className={css.page}>
    <h2>{t('library.title')}</h2>
    <div className={css.libraryGrid}>
      <button type="button" disabled={!hasSession} onClick={openFiles}>{t('library.files')}</button>
      <button type="button" onClick={() => { openSettings('memory') }}>{t('library.memory')}</button>
      <button type="button" onClick={() => { openSettings('skills') }}>{t('library.skills')}</button>
      <button type="button" onClick={() => { openSettings('mcp') }}>{t('library.mcp')}</button>
      <button type="button" onClick={() => { openSettings('code-index') }}>{t('library.index')}</button>
    </div>
    {!hasSession ? <p>{t('library.noSession')}</p> : null}
  </section>
}
