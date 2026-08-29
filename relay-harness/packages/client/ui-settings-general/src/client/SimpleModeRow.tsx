/**
 * Desktop-only General row for simple mode: the reduced shell for someone who
 * only wants to talk to the agent. Turning it on hides the extension-facing
 * entries — plugin market, MCP, skills — from the menu bar and tray. The change
 * takes effect the next time the shell rebuilds its menus, which the row says.
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import { desktopShell } from './desktop-shell.ts'
import css from './SimpleModeRow.module.css'

/** Full component props: the empty item owner share plus the settings locale seat. */
export type SimpleModeRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>

/** Row lifecycle: reading the persisted flag, settled, writing, or failed. */
type RowPhase = 'loading' | 'ready' | 'saving' | 'error'

/**
 * Render the simple-mode preference row.
 * @param props - composed slot props (the section supplies no owner data).
 * @returns the row element tree.
 */
export function SimpleModeRow({ t }: SimpleModeRowProps) {
  const shell = desktopShell()
  const [simpleMode, setSimpleMode] = useState(false)
  const [phase, setPhase] = useState<RowPhase>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    const load = shell?.getConfig
    if (load === undefined) return undefined
    let cancelled = false
    void load().then((config) => {
      if (cancelled) return
      setSimpleMode(config.simpleMode === true)
      setPhase('ready')
    }).catch((caught: unknown) => {
      if (cancelled) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('error')
    })
    return () => { cancelled = true }
  }, [shell])

  const save = useCallback(async (next: boolean) => {
    if (!shell?.saveConfig) return
    setSimpleMode(next)
    setPhase('saving')
    setError('')
    try {
      const saved = await shell.saveConfig({ simpleMode: next })
      setSimpleMode(saved.simpleMode === true)
      setPhase('ready')
    } catch (caught) {
      setSimpleMode(!next)
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('error')
    }
  }, [shell])

  const busy = phase === 'loading' || phase === 'saving'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('simpleMode.title')}</div>
        <div className={css.desc}>{t('simpleMode.description')}</div>
        {phase === 'error'
          ? <p className={css.status} role="alert">{t('simpleMode.error', { message: error })}</p>
          : phase === 'ready' && simpleMode
            ? <p className={css.status} role="status">{t('simpleMode.restart')}</p>
            : null}
      </div>
      <label className={css.switch}>
        <input
          type="checkbox"
          role="switch"
          checked={simpleMode}
          disabled={busy}
          aria-label={t('simpleMode.title')}
          onChange={(event) => { void save(event.target.checked) }}
        />
      </label>
    </div>
  )
}
