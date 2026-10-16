import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { TenantConfigSchema } from '@research-portal/core'
import { createPortalLocale, PortalLocaleContext } from '../lib/portal-locale.tsx'
import { NotFoundPage, RootNotFound } from '../pages/NotFoundPage.tsx'
import { PortalFooter } from './PortalFooter.tsx'
import { LayoutAnchor } from './LayoutLink.tsx'
import { AccountMenu } from './AccountMenu.tsx'
import type { ReactNode } from 'react'

function render(language: 'ja' | 'en', children: ReactNode): string {
  return renderToStaticMarkup(
    <PortalLocaleContext.Provider value={createPortalLocale(language)}>
      <MemoryRouter initialEntries={['/t/example/missing']}>{children}</MemoryRouter>
    </PortalLocaleContext.Provider>,
  )
}

Deno.test('Japanese platform fallback and link controls retain routes and English identity', () => {
  const ja = render(
    'ja',
    <>
      <NotFoundPage />
      <RootNotFound />
    </>,
  )
  expect(ja).toContain('ページが見つかりません')
  expect(ja).toContain('ポータル一覧に戻る')
  expect(ja).toContain('aria-label="表示言語"')
  expect(ja).not.toContain('Page not found')
  const en = render('en', <NotFoundPage />)
  expect(en).toContain('Page not found')
  expect(en).toContain('Back to Explore')
  for (const language of ['ja', 'en'] as const) {
    const link = render(
      language,
      <LayoutAnchor href='https://example.org/original' slug='example'>
        Authored title
      </LayoutAnchor>,
    )
    expect(link).toContain('href="https://example.org/original"')
    expect(link).toContain('Authored title')
    expect(link).toContain(language === 'ja' ? '（外部サイトを開く）' : '(opens external site)')
  }
})

Deno.test('Japanese footer translates interface copy while preserving authored organisation and links', () => {
  const config = TenantConfigSchema.parse({
    slug: 'example',
    branding: {
      productName: 'Original Portal',
      organisation: 'Original Organisation',
      tagline: 'Original tagline',
      colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
      layout: {
        footer: {
          columns: [{
            heading: 'Original heading',
            links: [{ label: 'Original label', href: 'https://example.org/policy' }],
          }],
          note: 'Original note',
          poweredBy: true,
        },
      },
    },
    searchPlaceholder: '',
    topics: [],
    suggestedQuestions: [],
    entityTypes: [],
    relationTypes: [],
  })
  const html = render('ja', <PortalFooter slug={config.slug} branding={config.branding} />)
  for (
    const authored of [
      'Original Portal',
      'Original Organisation',
      'Original tagline',
      'Original heading',
      'Original label',
      'Original note',
    ]
  ) expect(html).toContain(authored)
  expect(html).toContain('aria-label="フッター"')
  expect(html).toContain('CorpusKitを使用')
  expect(html).toContain('https://example.org/policy')
  expect(render('en', <PortalFooter slug={config.slug} branding={config.branding} />)).toContain(
    'Powered by CorpusKit',
  )
})

Deno.test('account launcher keeps supplied identity label literal in Japanese', () => {
  const label = 'Profile · Jake / Original Portal'
  const html = render('ja', <AccountMenu entries={[]} label={label} onProfile={() => {}} />)
  expect(html).toContain(`aria-label="${label}"`)
  expect(html).toContain('aria-haspopup="dialog"')
  expect(html).not.toContain('aria-expanded')
  const locale = createPortalLocale('ja')
  expect(locale.ui('Sign in to {name}', { name: 'Original Portal' })).toBe(
    'Original Portalにサインイン',
  )
  expect(
    locale.ui('Entra claims checked {age} ago.', {
      age: locale.ui('{count} minutes', { count: 12 }),
    }),
  ).toBe('Entraの権限は12分前に確認されました。')
  expect(createPortalLocale('en').ui('Sign in to {name}', { name: 'Original Portal' })).toBe(
    'Sign in to Original Portal',
  )
})

Deno.test('localized delete feedback keeps an authored title literal and preserves English defaults', async () => {
  const { deletedNotice, DeleteDocumentDescription } = await import('./DeleteDocument.tsx')
  expect(deletedNotice('Original 研究 [12]', 'deleted')).toBe('Deleted “Original 研究 [12]”.')
  expect(deletedNotice('Original 研究 [12]', 'already-deleted', createPortalLocale('ja').ui)).toBe(
    '「Original 研究 [12]」はすでに削除されています。',
  )
  const html = render('ja', <DeleteDocumentDescription title='Original 研究 [12]' />)
  expect(html).toContain('「Original 研究 [12]」を削除しますか？')
  expect(html).toContain('この操作は取り消せません。')
  expect(html).not.toContain('This cannot be undone.')
})
