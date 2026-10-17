import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { TenantConfig } from '@research-portal/core'
import {
  type MessageValues,
  portalDate,
  portalError,
  type PortalLanguage,
  portalNumber,
  portalUi,
} from './locale-messages.ts'

export { type PortalLanguage, portalUi } from './locale-messages.ts'

export function localisePortalConfig<T extends TenantConfig>(
  config: T,
  language: PortalLanguage,
): T {
  const dictionary = config.languagePolicy?.translations?.[language]
  if (!dictionary) return config
  const visibleCopy = (path: string[]): boolean => {
    const [root, field] = path
    const leaf = path[path.length - 1]
    if (root === 'searchPlaceholder' || root === 'assessmentHeading') return true
    if (root === 'copy') return true
    if (root === 'topics') return leaf === 'label' || leaf === 'description'
    if (root === 'suggestedQuestions') return leaf === 'text'
    if (root !== 'branding') return false
    if (['productName', 'organisation', 'tagline'].includes(field!)) return true
    return field === 'layout' && (
      ['heading', 'body', 'intro', 'label', 'title', 'note', 'alt'].includes(leaf!) ||
      path.includes('questions')
    )
  }
  const visit = (value: unknown, path: string[] = []): unknown => {
    if (typeof value === 'string') return visibleCopy(path) ? dictionary[value] ?? value : value
    if (Array.isArray(value)) {
      return value.map((child, index) => visit(child, [...path, String(index)]))
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          key === 'languagePolicy' && path.length === 0 ? child : visit(child, [...path, key]),
        ]),
      )
    }
    return value
  }
  return visit(config) as T
}

export type Locale = {
  language: PortalLanguage
  setLanguage: (language: PortalLanguage) => void
  ui: (text: string, values?: MessageValues) => string
  number: (value: number, options?: Intl.NumberFormatOptions) => string
  date: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string
  error: (error: unknown, englishFallback: string) => string
}

export function createPortalLocale(
  language: PortalLanguage,
  setLanguage: (language: PortalLanguage) => void = () => {},
): Locale {
  return {
    language,
    setLanguage,
    ui: (text, values) => portalUi(language, text, values),
    number: (value, options) => portalNumber(language, value, options),
    date: (value, options) => portalDate(language, value, options),
    error: (error, fallback) => portalError(language, error, fallback),
  }
}

export const PortalLocaleContext = createContext<Locale>(createPortalLocale('en'))
export const usePortalLocale = () => useContext(PortalLocaleContext)
const APP_LANGUAGE_KEY = 'corpuskit-ui-language-v1'

function savedLanguage(key: string): PortalLanguage | null {
  try {
    const saved = localStorage.getItem(key)
    return saved === 'ja' || saved === 'en' ? saved : null
  } catch {
    return null
  }
}

type SharedLocale = {
  preference: PortalLanguage | null
  active: PortalLanguage
  choose: (language: PortalLanguage) => void
  activate: (language: PortalLanguage) => void
}
const SharedLocaleContext = createContext<SharedLocale | null>(null)

/** Explicit UI language follows the user into platform, account and access screens. */
export function AppLocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(() => savedLanguage(APP_LANGUAGE_KEY))
  const [active, setActive] = useState<PortalLanguage>(() => preference ?? 'en')
  const choose = useCallback((language: PortalLanguage) => {
    setPreference(language)
    setActive(language)
    try {
      localStorage.setItem(APP_LANGUAGE_KEY, language)
    } catch { /* Language selection also works when browser storage is unavailable. */ }
  }, [])
  const shared = useMemo(() => ({ preference, active, choose, activate: setActive }), [
    preference,
    active,
    choose,
  ])
  const locale = useMemo(() => createPortalLocale(active, choose), [active, choose])
  useEffect(() => {
    document.documentElement.lang = active === 'ja' ? 'ja' : 'en-AU'
  }, [active])
  return (
    <SharedLocaleContext.Provider value={shared}>
      <PortalLocaleContext.Provider value={locale}>{children}</PortalLocaleContext.Provider>
    </SharedLocaleContext.Provider>
  )
}

/** Per-portal choices/defaults remain compatible; a deliberate app choice is also remembered. */
export function usePortalLocaleState(config: TenantConfig | undefined): Locale {
  const shared = useContext(SharedLocaleContext)
  const [choice, setChoice] = useState<{ slug: string; language: PortalLanguage } | null>(null)
  const available = config?.languagePolicy?.availableLanguages
  const preferred = shared?.preference
  const language = choice?.slug === config?.slug && available?.includes(choice!.language)
    ? choice!.language
    : preferred && (!available || available.includes(preferred))
    ? preferred
    : config?.languagePolicy?.defaultLanguage ?? shared?.active ?? 'en'
  useEffect(() => {
    if (!config?.languagePolicy) return
    const saved = savedLanguage(`corpuskit-language-v1:${config.slug}`)
    if (saved && config.languagePolicy.availableLanguages.includes(saved)) {
      setChoice({ slug: config.slug, language: saved })
    }
  }, [config?.slug])
  useEffect(() => {
    if (config) shared?.activate(language)
    document.documentElement.lang = language === 'ja' ? 'ja' : 'en-AU'
  }, [language, !!config, shared?.activate])
  const setLanguage = useCallback((next: PortalLanguage) => {
    if (!config || !available?.includes(next)) return
    setChoice({ slug: config.slug, language: next })
    shared?.choose(next)
    try {
      localStorage.setItem(`corpuskit-language-v1:${config.slug}`, next)
    } catch { /* optional */ }
  }, [config?.slug, available, shared?.choose])
  return useMemo(() => createPortalLocale(language, setLanguage), [language, setLanguage])
}

function LanguageChoices({ languages, locale }: {
  languages: readonly PortalLanguage[]
  locale: Locale
}) {
  return (
    <div
      role='group'
      aria-label={locale.ui('Display language')}
      className='rp-seg shrink-0'
    >
      {languages.map((language) => (
        <button
          key={language}
          type='button'
          lang={language}
          aria-pressed={locale.language === language}
          aria-label={language === 'ja' ? '日本語' : 'English'}
          onClick={() => locale.setLanguage(language)}
          className='rp-seg-item min-w-[2.75rem] text-sm font-semibold'
        >
          {language.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function AppLanguageSwitch() {
  return <LanguageChoices languages={['ja', 'en']} locale={usePortalLocale()} />
}

export function PortalLanguageSwitch({ config, locale }: { config: TenantConfig; locale: Locale }) {
  if (!config.languagePolicy || config.languagePolicy.availableLanguages.length < 2) return null
  return <LanguageChoices languages={config.languagePolicy.availableLanguages} locale={locale} />
}
