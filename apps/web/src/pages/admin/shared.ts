import { JAPANESE_MESSAGES, portalUi } from '../../lib/locale-messages.ts'
import { createPortalLocale, type Locale } from '../../lib/portal-locale.tsx'
/** Shared styling and small types used across the admin page's subcomponents. */

export const inputClass = 'rp-input'

export type Message = {
  tone: 'ok' | 'error'
  text: string
  render?: (locale: Locale) => string
}

/** Retain neutral operation data and resolve its visible copy in the current language. */
export function messageFor(tone: Message['tone'], render: (locale: Locale) => string): Message {
  return { tone, text: render(createPortalLocale('en')), render }
}

export function errorMessage(
  err: unknown,
  fallback: string,
  localise?: Locale['error'],
): string {
  return localise ? localise(err, fallback) : err instanceof Error ? err.message : fallback
}

export const englishUi: Locale['ui'] = (english, values) => portalUi('en', english, values)

/** Relative app timestamps, retaining the compact English form used by existing panels. */
export function relativeTime(iso: string, ui: Locale['ui'] = englishUi): string {
  const elapsed = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(elapsed)) return ui('Unknown date')
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 1) return ui('just now')
  if (minutes < 60) return ui('{count}m ago', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return ui('{count}h ago', { count: hours })
  return ui('{count}d ago', { count: Math.round(hours / 24) })
}

/** Stage labels are app-owned status; unrecognised service stages use an honest generic label. */
export function stageText(
  text: string,
  locale: Pick<Locale, 'language' | 'ui'>,
): string {
  const methods = /^Extracting with (\d+) methods?$/.exec(text)
  if (methods) {
    return locale.ui(
      Number(methods[1]) === 1
        ? 'Extracting with {count} method'
        : 'Extracting with {count} methods',
      { count: methods[1]! },
    )
  }
  return locale.language === 'en' || Object.hasOwn(JAPANESE_MESSAGES, text)
    ? locale.ui(text)
    : locale.ui('Processing…')
}
