import { createContext, useContext, useEffect, useState } from 'react'
import type { TenantConfig } from '@research-portal/core'

export type PortalLanguage = 'ja' | 'en'
const JAPANESE: Record<string, string> = {
  Library: 'ライブラリ',
  Ask: '質問',
  Search: '検索',
  Sort: '並べ替え',
  'Sort by': '並べ替え',
  'Newest published': '発行日の新しい順',
  'Oldest published': '発行日の古い順',
  'Newest added': '追加日の新しい順',
  'Oldest added': '追加日の古い順',
  'Title A-Z': 'タイトル順',
  'Search the library': 'ライブラリを検索',
  'Search within the library': '資料を検索',
  Filters: '絞り込み',
  Topics: '研究分野',
  'All topics': 'すべての分野',
  'Ask a question': '質問する',
  'Ask a question about this research': '研究資料について質問する',
  "Ask a question and get an answer grounded in this portal's research.":
    '日本語と英語の研究資料を横断し、根拠とともに回答します。',
  'Ask next': '続けて質問',
  'Deep research': '詳しく調べる',
  Sessions: '履歴',
  Stop: '停止',
  Send: '送信',
  'New conversation': '新しい会話',
  'New session': '新しい会話',
  'Open menu': 'メニューを開く',
  'Close menu': 'メニューを閉じる',
  'Light mode': 'ライト表示',
  'Dark mode': 'ダーク表示',
  'Switch to light mode': 'ライト表示に切り替え',
  'Switch to dark mode': 'ダーク表示に切り替え',
  'Browse the library': 'ライブラリを見る',
  'View all': 'すべて表示',
  'Load more': 'さらに表示',
  'Show more': 'さらに表示',
  'Show less': '閉じる',
  'No resources found': '資料が見つかりません',
  'Clear filters': '絞り込みを解除',
  'Clear all': 'すべて解除',
  'Document types': '資料の種類',
  'Resource types': '資料の種類',
  'All types': 'すべての種類',
  'Unfiled': '未分類',
}

export function portalUi(language: PortalLanguage, text: string): string {
  return language === 'ja' ? JAPANESE[text] ?? text : text
}

export function localisePortalConfig<T extends TenantConfig>(
  config: T,
  language: PortalLanguage,
): T {
  const dictionary = config.languagePolicy?.translations?.[language]
  if (!dictionary) return config
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return dictionary[value] ?? value
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    }
    return value
  }
  const { languagePolicy, ...copy } = config
  return { ...visit(copy) as Omit<T, 'languagePolicy'>, languagePolicy } as T
}

type Locale = {
  language: PortalLanguage
  setLanguage: (language: PortalLanguage) => void
  ui: (text: string) => string
}
const fallback: Locale = { language: 'en', setLanguage: () => {}, ui: (text) => text }
export const PortalLocaleContext = createContext<Locale>(fallback)
export const usePortalLocale = () => useContext(PortalLocaleContext)

export function usePortalLocaleState(config: TenantConfig | undefined): Locale {
  const [choice, setChoice] = useState<{ slug: string; language: PortalLanguage } | null>(null)
  const available = config?.languagePolicy?.availableLanguages
  const language = choice?.slug === config?.slug && available?.includes(choice!.language)
    ? choice!.language
    : config?.languagePolicy?.defaultLanguage ?? 'en'
  useEffect(() => {
    if (!config?.languagePolicy) return
    try {
      const saved = localStorage.getItem(`corpuskit-language-v1:${config.slug}`)
      if (
        (saved === 'ja' || saved === 'en') &&
        config.languagePolicy.availableLanguages.includes(saved)
      ) {
        setChoice({ slug: config.slug, language: saved })
      }
    } catch { /* Browser storage may be unavailable. The configured default still works. */ }
  }, [config?.slug])
  useEffect(() => {
    document.documentElement.lang = language === 'ja' ? 'ja' : 'en-AU'
  }, [language])
  return {
    language,
    setLanguage(next) {
      if (!config || !available?.includes(next)) return
      setChoice({ slug: config.slug, language: next })
      try {
        localStorage.setItem(`corpuskit-language-v1:${config.slug}`, next)
      } catch { /* optional */ }
    },
    ui: (text) => portalUi(language, text),
  }
}

export function PortalLanguageSwitch({ config, locale }: { config: TenantConfig; locale: Locale }) {
  if (!config.languagePolicy || config.languagePolicy.availableLanguages.length < 2) return null
  return (
    <div
      role='group'
      aria-label='表示言語 / Display language'
      className='inline-flex shrink-0 rounded-[var(--rp-radius-btn)] border border-line bg-surface p-0.5'
    >
      {config.languagePolicy.availableLanguages.map((language) => (
        <button
          key={language}
          type='button'
          lang={language}
          aria-pressed={locale.language === language}
          aria-label={language === 'ja' ? '日本語' : 'English'}
          onClick={() => locale.setLanguage(language)}
          className='rp-focus min-h-10 min-w-10 rounded-[var(--rp-radius-btn)] px-2 text-sm font-semibold text-ink-2'
          style={locale.language === language
            ? { backgroundColor: 'var(--rp-primary)', color: 'var(--rp-on-primary)' }
            : undefined}
        >
          {language.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
