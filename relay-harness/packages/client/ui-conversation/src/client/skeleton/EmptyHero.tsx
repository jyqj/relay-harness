// Hero chrome for the blank-draft phase of ConversationRoot: brand-mark headline,
// glow backdrop, the suggestion-card grid, and the workspace row. Pure
// presentation — the resident composer is NOT rendered here (it keeps its own
// stable tree position in ConversationRoot so the textarea survives the
// hero → composer flip); CSS positions it over this shell's glow area during
// the hero phase.

import { useId } from 'react'
import type { ComponentType, ReactNode, RefObject } from 'react'
import {
  RelayMark, IconChevronDownOutline14, IconCodeOutline16, IconFolderClose16, IconFolderOpen16,
  IconBranchOutline16, IconListPenOutline16, IconPlayOutline16,
} from '@relay-harness/rlh-client-ui-primitives'
import { workspaceTitleOf } from '@relay-harness/rlh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'
import suggestionsCss from './HeroSuggestions.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session. Without a
 * label the chip renders its placeholder state: closed folder + the
 * "Choose workspace" call to action. pointerdown stops here so the sibling
 * Menu's outside-close cannot race the click's reopen.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  onClick?: () => void
  t: HeroTranslate
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
      onPointerDown={(event) => { event.stopPropagation() }}
    >
      {label === undefined
        ? <IconFolderClose16 className={css.folder} size={16} />
        : <IconFolderOpen16 className={css.folder} size={16} />}
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/**
 * The soft blue backdrop ellipse (figma 313:14109). Rendered by the hero
 * owner (ConversationRoot), not HeroShell, so it can center on the input
 * card; the owner's className supplies all positioning.
 * @param props.className - positioning class from the owner.
 * @returns the blurred-ellipse svg element.
 */
export function HeroGlow({ className }: { className?: string | undefined }) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`
  return (
    <svg className={className} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
      <defs>
        <filter
          id={glowFilterId}
          x="0"
          y="0"
          width="1051"
          height="468"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
      </g>
    </svg>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Authorized renderer for the hero brand-mark slot. */
  renderSlot: ConversationSlotProps['renderSlot']
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/** One suggestion card: visible label plus the draft text its pick writes. */
interface HeroSuggestionCard {
  /** Shared primitives glyph drawn above the label (17px, single tone). */
  icon: ComponentType<{ size?: number | undefined; className?: string | undefined }>
  /** Locale key of the visible label. */
  labelKey: 'hero.suggest.resume' | 'hero.suggest.build' | 'hero.suggest.summarize' | 'hero.suggest.review'
}

/** The four shipped suggestions, Chat/Work semantics; copy rides the locale seat. */
const SUGGESTION_CARDS: readonly HeroSuggestionCard[] = [
  { icon: IconPlayOutline16, labelKey: 'hero.suggest.resume' },
  { icon: IconCodeOutline16, labelKey: 'hero.suggest.build' },
  { icon: IconListPenOutline16, labelKey: 'hero.suggest.summarize' },
  { icon: IconBranchOutline16, labelKey: 'hero.suggest.review' },
]

/**
 * The suggestion-card grid under the hero headline. A pick FILLS THE DRAFT —
 * never a send: the cards read as suggestions and sit in the cursor's path to
 * the composer, and an unrequested turn costs a request plus whatever the
 * agent does before it can be stopped (the Lyra EmptyState decision). The
 * pick replaces the whole draft: the cards are alternatives, not stacking
 * prompts. Withholding `onPick` (cold start, blocked) renders nothing —
 * a card over a composer that cannot take a draft is a dead control.
 * @param props.t - the owner's locale seat.
 * @param props.onPick - draft write + refocus performed by the owner; absent → no grid.
 * @returns the grid element, or null while picks cannot land.
 */
export function HeroSuggestions({ t, onPick }: {
  t: HeroTranslate
  onPick: ((draft: string) => void) | undefined
}) {
  if (onPick === undefined) return null
  return (
    <nav className={suggestionsCss.host} aria-label={t('hero.suggest.aria')}>
      <div className={suggestionsCss.grid}>
        {SUGGESTION_CARDS.map((card) => {
          const label = t(card.labelKey)
          const Icon = card.icon
          return (
            <button
              key={card.labelKey}
              type="button"
              className={suggestionsCss.card}
              data-hero-suggestion={card.labelKey}
              onClick={() => { onPick(t(`${card.labelKey}.draft`)) }}
            >
              <Icon size={17} className={suggestionsCss.icon} />
              <span className={suggestionsCss.label}>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/**
 * Render the hero chrome (headline only; no glow, no composer, no workspace
 * row — the glow is the owner's {@link HeroGlow}).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* figma 34:10412: mark 34×24 leading the headline, gap 10. */}
          <span className={css.markHitbox}>
            {renderSlot('conversation.hero.brand.mark', { size: 34, className: css.mark }, {
              fallback: <RelayMark size={34} className={css.mark} />,
            })}
          </span>
          <span className={css.headlineText}>{t('hero.headline')}</span>
          <span className={css.previewBadge}>{t('hero.preview')}</span>
        </div>
        <div className={css.body}>
          {/* The resident composer (ConversationRoot's root-owned scrollport;
              the workspace row rides the stack above the card) is CSS-centered
              in that scroll body during hero — see
              ConversationRoot.module.css [data-phase='hero']. */}
        </div>
      </div>
      {children}
    </div>
  )
}
