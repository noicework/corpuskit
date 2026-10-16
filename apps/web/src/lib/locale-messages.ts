import { COMMON_JA } from './messages/common-ja.ts'
import { MANAGE_JA } from './messages/manage-ja.ts'
import { RESEARCH_JA } from './messages/research-ja.ts'
import { PLATFORM_JA } from './messages/platform-ja.ts'

export type MessageValues = Readonly<Record<string, string | number>>
export type PortalLanguage = 'ja' | 'en'

/** Conflicting feature translations are a build/test failure, never import-order dependent. */
export function combineJapaneseCatalogs(
  ...catalogs: Readonly<Record<string, string>>[]
): Readonly<Record<string, string>> {
  const messages: Record<string, string> = Object.create(null)
  for (const catalog of catalogs) {
    for (const [english, japanese] of Object.entries(catalog)) {
      if (Object.hasOwn(messages, english) && messages[english] !== japanese) {
        throw new Error(`Conflicting Japanese interface message: ${english}`)
      }
      if (!english.trim() || !japanese.trim()) throw new Error('Empty interface message')
      const parameters = (text: string) =>
        [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort().join(',')
      if (parameters(english) !== parameters(japanese)) {
        throw new Error(`Japanese interface parameters do not match: ${english}`)
      }
      messages[english] = japanese
    }
  }
  return Object.freeze(messages)
}

export const JAPANESE_MESSAGES = combineJapaneseCatalogs(
  COMMON_JA,
  MANAGE_JA,
  RESEARCH_JA,
  PLATFORM_JA,
)

/** Completeness audits must inspect missing keys instead of treating English fallback as translated. */
export function missingPortalMessages(english: Iterable<string>): string[] {
  return [...new Set(english)].filter((key) => !Object.hasOwn(JAPANESE_MESSAGES, key)).sort()
}

export function portalUi(
  language: PortalLanguage,
  english: string,
  values: MessageValues = {},
): string {
  const template = language === 'ja' ? JAPANESE_MESSAGES[english] ?? english : english
  // One pass: braces, markup and words within an authored value remain exactly as supplied.
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (whole, key: string) => Object.hasOwn(values, key) ? String(values[key]) : whole,
  )
}

export function portalNumber(
  language: PortalLanguage,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(language === 'ja' ? 'ja-JP' : 'en-AU', options).format(value)
    : '—'
}

export function portalDate(
  language: PortalLanguage,
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en-AU', options).format(date)
    : portalUi(language, 'Unknown date')
}

const errorMessages: Readonly<Record<string, string>> = {
  unauthorised: 'Sign in again to continue.',
  unauthorized: 'Sign in again to continue.',
  forbidden: 'You do not have permission to perform this action.',
  portal_suspended: 'This portal is temporarily paused.',
  not_found: 'The requested item is unavailable.',
  rate_limited: 'Too many requests. Try again shortly.',
}
const translatedMessages = new Set(Object.values(JAPANESE_MESSAGES))

/** Localise known application errors, never machine-translate an arbitrary server payload. */
export function portalError(
  language: PortalLanguage,
  error: unknown,
  englishFallback: string,
): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (language === 'en') return message || englishFallback
  if (Object.hasOwn(JAPANESE_MESSAGES, message)) return portalUi(language, message)
  if (translatedMessages.has(message)) return message
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const known = errorMessages[error.code]
    if (known) return portalUi(language, known)
  }
  return portalUi(language, englishFallback)
}
