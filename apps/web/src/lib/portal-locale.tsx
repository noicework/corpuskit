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
  'Back to library': 'ライブラリに戻る',
  'Summary': '要約',
  'Key takeaways': '主な知見',
  'Quotes of interest': '注目の記述',
  'Keywords': 'キーワード',
  'Key facts': '主要事項',
  'You might also want': '関連する資料',
  'Authors': '著者',
  'Journal': '掲載誌',
  'Published': '発行年',
  'Project': '研究課題',
  'Source file': '原ファイル',
  'View original source': '出典を見る',
  'Chat with this document': 'この資料に質問',
  'Questions about this document': 'この資料についての質問',
  'Ask a question about': '質問する資料：',
  'Summarise the key findings': '主な知見を要約してください',
  'What are the main recommendations?': '主な提案は何ですか。',
  'What methods were used?': 'どの試験方法が使われましたか。',
  'Extracted text': '抽出テキスト',
  'Show extracted text': '抽出テキストを表示',
  'Hide extracted text': '抽出テキストを閉じる',
  'A machine reading of the file, for searching and copying.':
    '検索やコピーに使う、原ファイルから抽出したテキストです。',
  'A machine reading of the file, for searching and copying. Your match appears in it.':
    '検索やコピーに使う抽出テキストです。検索語に一致する箇所が含まれています。',
  'A machine reading of the file. The PDF above is the document itself.':
    '原ファイルから抽出したテキストです。上のPDFで原資料を確認できます。',
  'Generated summary': '生成された要約',
  "Written by the portal from the document's text. Check it against the document itself.":
    '資料の本文に基づいて生成された要約です。原資料と照合してください。',
  'Download original': '原ファイルをダウンロード',
  'Download file': 'ファイルをダウンロード',
  'Open in a new tab': '新しいタブで開く',
  'Original document': '原資料',
  'Showing a PDF rendition of the original document.': '原資料をPDFに変換して表示しています。',
  'This is an Office document. Browsers cannot display it in place, so download the original to read it exactly as authored.':
    'Office形式の資料です。原ファイルをダウンロードして、作成時の形式でご確認ください。',
  'The original file is not available.': '原ファイルを取得できません。',
  'Related resources could not be loaded right now.': '関連資料を読み込めませんでした。',
  'No related resources found yet.': '関連資料が見つかりません。',
  'Previous page': '前のページ',
  'Next page': '次のページ',
  'Page number': 'ページ番号',
  'Zoom out': '縮小',
  'Zoom in': '拡大',
  'Fit': '自動',
  'Fit to width': '横幅に合わせる',
  'Print': '印刷',
  'Download PDF': 'PDFをダウンロード',
  'Open PDF in a new tab': 'PDFを新しいタブで開く',
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
