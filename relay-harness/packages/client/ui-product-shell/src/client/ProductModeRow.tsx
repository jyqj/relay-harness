import type { InjectFace, PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import type {} from '@relay-harness/rlh-client-ui-settings/client'
import type { ProductMode, ProductModeView } from './mode.ts'
import css from './ProductShell.module.css'

export interface ProductModeRowInjected {
  hooks: { productMode: { getSnapshot(): ProductModeView; subscribe(listener: () => void): () => void } }
  setMode: (mode: ProductMode) => Promise<void>
}
export type ProductModeRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'productShell'> & InjectFace<ProductModeRowInjected>

/** Shared General row backed by the Host productMode Remote. */
export function ProductModeRow({ useProductMode, setMode, t }: ProductModeRowProps) {
  const state = useProductMode(value => value)
  const busy = state.status === 'loading' || state.status === 'saving'
  return <div className={css.modeRow}>
    <div><div className={css.modeTitle}>{t('mode.title')}</div><p>{t('mode.description')}</p>{state.error !== null ? <p role="alert">{t('mode.error', { message: state.error })}</p> : null}</div>
    <label className={css.switch}><input type="checkbox" role="switch" aria-label={t('mode.title')} checked={state.mode === 'developer'} disabled={busy} onChange={(event) => { void setMode(event.target.checked ? 'developer' : 'simple') }} /></label>
  </div>
}
