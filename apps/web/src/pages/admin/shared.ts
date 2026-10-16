import { portalUi } from '../../lib/locale-messages.ts'
import type { Locale } from '../../lib/portal-locale.tsx'
/** Shared styling and small types used across the admin page's subcomponents. */

export const inputClass = 'rp-input'

export type Message = { tone: 'ok' | 'error'; text: string }

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
